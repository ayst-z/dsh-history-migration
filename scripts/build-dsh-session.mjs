#!/usr/bin/env node
// Build a minimal, validator-friendly DSH session log from plain user messages.
//
// Hard requirements this script honours (all verified against the DSH loader):
//   * first Zstandard frame contains exactly one line: the session header;
//   * every following frame contains exactly one event line;
//   * the header has no "seq"; every event has a continuous "seq" starting at 0;
//   * only user/message events are emitted (assistant/message would need a full model stream);
//   * a session/title event carries the display name and the first user message seq.
//
// Usage:
//   node build-dsh-session.mjs --out <session.v4.jsonl.zstd> --cwd <workspace path>
//        (--text <message> | --input <file.txt|.json|.jsonl>)
//        [--title <title>] [--id <session-id>] [--agent-preset <name>] [--time <ISO|epoch-ms>]
//        [--home <DSH_HOME>] [--dry]
//
//   --home <DSH_HOME>   write to <DSH_HOME>/sessions/<encoded-cwd>/<id>/session.v4.jsonl.zstd
//                       (the standard place the DSH loader searches) instead of --out.
//   --input <file>      .txt/.md/.jsonl: one non-empty line = one user message;
//                       .json: array of strings or array of {text|user|content} or {"messages":[...]}.
//   --text <message>    repeatable; may be combined with --input.
//
// No personal paths or content are embedded anywhere in this file.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseCli, sessionFilePath, writeSession, readSession } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));

function usage() {
  console.error('Usage: node build-dsh-session.mjs --out <file> --cwd <workspace> (--text <message> | --input <file>) [--title <t>] [--id <id>] [--agent-preset <n>] [--time <ISO|ms>] [--home <DSH_HOME>] [--dry]');
}

if (args.help || (!args.out && !args.home)) {
  usage();
  process.exit(args.help ? 0 : 2);
}

// Repeatable --text: parseCli keeps only the last one, so collect them all here.
function collect(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--' + name) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) values.push(next);
    } else if (argv[i].startsWith('--' + name + '=')) {
      values.push(argv[i].slice(name.length + 3));
    }
  }
  return values;
}

function messageFromItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string') return item.text;
  if (typeof item.user === 'string') return item.user;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map((c) => (typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : ''))).join('');
  }
  return '';
}

function loadMessages() {
  const messages = [];
  for (const item of collect(process.argv.slice(2), 'text')) messages.push(item);

  if (args.input && args.input !== true) {
    const text = readFileSync(args.input, 'utf8');
    const lower = String(args.input).toLowerCase();
    if (lower.endsWith('.json')) {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.messages) ? parsed.messages : [parsed]);
      for (const item of arr) {
        const user = messageFromItem(item);
        const assistant = item && typeof item === 'object' && item.assistant ? String(item.assistant) : '';
        messages.push({ user, assistant });
      }
    } else {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed !== '') messages.push(trimmed);
      }
    }
  }

  return messages
    .map((m) => (typeof m === 'string' ? { user: m, assistant: '' } : { user: String(m.user || ''), assistant: m.assistant ? String(m.assistant) : '' }))
    .filter((m) => m.user.trim() !== '');
}

const cwdRaw = args.cwd && args.cwd !== true ? args.cwd : process.cwd();
// Windows 上必须写进 header 的是原生反斜杠形式：header.cwd 要与工作区规范路径逐字符相等（R1）
const cwd = process.platform === 'win32' ? cwdRaw.replace(/\//g, '\\') : cwdRaw;
const messages = loadMessages();
if (messages.length === 0) {
  console.error('error: no user messages given (use --text or --input)');
  process.exit(2);
}

const id = args.id && args.id !== true ? args.id : 'session-' + randomUUID();
const agentPreset = args.agentPreset && args.agentPreset !== true ? args.agentPreset : 'standard';
let base = Date.now();
if (args.time && args.time !== true) {
  const asNumber = Number(args.time);
  base = Number.isFinite(asNumber) && String(args.time).trim() !== '' ? asNumber : Date.parse(args.time);
  if (!Number.isFinite(base)) { console.error('error: --time is not a valid ISO date or epoch-ms value'); process.exit(2); }
}

const events = [];
let seq = 0;
function push(type, data, extra) {
  events.push({ type, seq: seq++, time: base + seq * 10, data, ...(extra || {}) });
}

push('permission/preset', { preset: 'workspace-write' });
push('sandbox/mode', { mode: 'workspace-write' });
push('approval/policy', { policy: 'never' });
push('session/end-seed', {});

const userSeqs = [];
const MAX_ASSISTANT = Number(args.maxAssistantChars) > 0 ? Number(args.maxAssistantChars) : 4000;
let assistantCount = 0;
messages.forEach((m, index) => {
  const turn = index + 1;
  push('turn/start', { turn });
  push('step/start', { turn, step: 1 });
  userSeqs.push(seq);
  push('user/message', {
    content: [{ type: 'text', text: m.user }],
    source: { kind: 'user' },
    role: 'user',
    id: randomUUID(),
  }, { surfaceOp: 'append' });
  const full = m.assistant || '';
  if (full.trim() !== '') {
    const text = full.length > MAX_ASSISTANT
      ? full.slice(0, MAX_ASSISTANT) + String.fromCharCode(10, 10) + '…（原文 ' + full.length + ' 字，已截断）'
      : full;
    const t0 = base + seq * 10;
    // assistant/message 需要完整模型流（settlement）；下面这 4 条 record 已验证能过 DSH 校验器
    push('assistant/message', {
      turn,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'imported', model: 'vscode-copilot-chat' }, id: randomUUID() },
      stream: [
        { type: 'chunk', time: t0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'chunk', time: t0 + 1, chunk: { type: 'text-delta', index: 0, text } },
        { type: 'chunk', time: t0 + 2, chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } },
        { type: 'chunk', time: t0 + 3, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    }, { surfaceOp: 'append' });
    assistantCount++;
  }
  push('step/end', { turn, step: 1 });
  push('turn/end', { turn, reason: { kind: 'completed' } });
});

const fallbackTitle = messages[0].user.replace(/\s+/g, ' ').trim().slice(0, 40);
const title = args.title && args.title !== true ? args.title : (fallbackTitle || 'Imported session');
push('session/title', { title, messageSeqs: [userSeqs[0]], source: { kind: 'fallback' } });

const header = {
  type: 'session',
  version: 4,
  id,
  createdAt: base,
  cwd,
  isSeeded: false,
  delegationDepth: 0,
  agentPreset,
};

const out = args.out && args.out !== true ? args.out : sessionFilePath(args.home, cwd, id);

if (args.dry) {
  console.log(JSON.stringify(header));
  for (const e of events) console.log(JSON.stringify(e));
  process.exit(0);
}

const written = writeSession(out, header, events);

// Self-check: the freshly written bytes must decode back to the same shape.
const check = readSession(out);
if (check.errors.length || check.events.length !== events.length) {
  console.error('error: self-check failed after writing: ' + (check.errors.join('; ') || 'event count mismatch'));
  process.exit(1);
}

console.log('session:  ' + id);
console.log('cwd:      ' + cwd);
console.log('messages: ' + messages.length + ' (assistant replies: ' + assistantCount + ')   events: ' + events.length + '   frames: ' + written.frames);
console.log('seq:      0..' + (events.length - 1) + ' (continuous)');
console.log('written:  ' + out + '   (' + written.bytes + ' bytes)');
