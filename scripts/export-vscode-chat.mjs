#!/usr/bin/env node
// Export VS Code (Copilot Chat) workspace chat sessions into a structured JSON + index.
//
// VS Code stores one .jsonl file per chat session under a workspaceStorage folder.
// Its first record with "kind": 0 carries the session object ("v"). This script reads
// only that record and extracts per-request user text and assistant markdown.
//
// Usage:
//   node export-vscode-chat.mjs --src <...\workspaceStorage\<hash>\chatSessions> --out <outDir>
//        [--max-user 3000] [--max-assistant 1500]
//
// Outputs:
//   <outDir>/vscode-sessions.json   [{ file, sessionId, created, responder, requests: [{ts, model, mode, user, assistant}] }]
//   <outDir>/vscode-index.txt       one human-readable line per session
//
// Paths are always given on the command line; nothing machine-specific is embedded.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCli } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));

function usage() {
  console.error('Usage: node export-vscode-chat.mjs --src <chatSessions dir> --out <outDir> [--max-user 3000] [--max-assistant 1500]');
}

if (args.help || !args.src || !args.out) {
  usage();
  process.exit(args.help ? 0 : 2);
}

const maxUser = Number(args.maxUser) || 3000;
const maxAssistant = Number(args.maxAssistant) || 1500;
const src = args.src;
const outDir = args.out;
mkdirSync(outDir, { recursive: true });

const files = readdirSync(src).filter((f) => f.endsWith('.jsonl'));
const out = [];

for (const file of files) {
  let v = null;
  try {
    for (const line of readFileSync(join(src, file), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.kind === 0 && parsed.v) { v = parsed.v; break; }
      } catch { /* skip malformed lines */ }
    }
  } catch (e) {
    out.push({ file, error: String(e.message || e).slice(0, 200) });
    continue;
  }
  if (!v) { out.push({ file, error: 'no kind=0 record' }); continue; }

  const requests = (v.requests || []).map((r) => {
    let user = (r.message && r.message.text) || '';
    if (Array.isArray(user)) user = user.map((x) => (x && x.text) || '').join('\n');
    let assistant = '';
    if (Array.isArray(r.response)) {
      assistant = r.response
        .filter((x) => x && (x.kind === 'markdownContent' || x.kind === 'text'))
        .map((x) => (x.content && (x.content.value || x.content.text)) || '')
        .join('\n');
    }
    return {
      ts: r.timestamp || null,
      model: r.modelId || null,
      mode: (r.modeInfo && r.modeInfo.modeId) || null,
      user: String(user).slice(0, maxUser),
      assistant: String(assistant).slice(0, maxAssistant),
    };
  });

  out.push({
    file,
    sessionId: v.sessionId || file.replace(/\.jsonl$/, ''),
    created: v.creationDate || null,
    responder: v.responderUsername || null,
    requests,
  });
}

writeFileSync(join(outDir, 'vscode-sessions.json'), JSON.stringify(out));

const indexRows = out.map((s) => {
  const date = s.created ? new Date(s.created).toISOString().slice(0, 10) : '?';
  const count = (s.requests || []).length;
  const first = (((s.requests || [])[0] || {}).user || s.error || '').replace(/\s+/g, ' ').slice(0, 90);
  const models = [...new Set((s.requests || []).map((r) => r.model).filter(Boolean))].join('|');
  return [date, String(count).padStart(3), String(s.file).slice(0, 8), models.slice(0, 28), first].join('  ');
}).sort();
writeFileSync(join(outDir, 'vscode-index.txt'), indexRows.join('\n'));

const totalRequests = out.reduce((sum, s) => sum + (s.requests || []).length, 0);
const errors = out.filter((s) => s.error).length;
console.log('source files:  ' + files.length);
console.log('sessions:      ' + out.length + '   requests: ' + totalRequests + '   unreadable: ' + errors);
console.log('written:       ' + join(outDir, 'vscode-sessions.json'));
console.log('written:       ' + join(outDir, 'vscode-index.txt'));
