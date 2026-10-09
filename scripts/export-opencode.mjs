#!/usr/bin/env node
// Extract opencode chat sessions (local SQLite store, opencode.db) into the
// [{user, assistant}] turns.json shape that build-dsh-session.mjs consumes.
//
// Usage:
//   node export-opencode.mjs --db <opencode.db> --out <dir>
//        [--top-only] [--session <id> ...]
//
//   --db <file>      path to opencode.db (copy it first if opencode is running)
//   --out <dir>      directory for <session-id>.turns.json + opencode-index.json
//   --top-only       only sessions without a parent (skip forks / sub-tasks)
//   --session <id>   explicit session id; repeatable
//
// Message mapping: user text -> turn.user; assistant text parts -> turn.assistant
// (reasoning, tool calls, idle/synthetic/compaction/system records are skipped).
// No personal paths or session content are embedded anywhere in this file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.error('Usage: node export-opencode.mjs --db <opencode.db> --out <dir> [--top-only] [--session <id>]');
  process.exit(0);
}
function flagValues(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--' + name) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) out.push(next);
    } else if (argv[i].startsWith('--' + name + '=')) {
      out.push(argv[i].slice(name.length + 3));
    }
  }
  return out;
}
function hasFlag(name) { return argv.includes('--' + name); }

const dbPath = flagValues('db')[0];
const outDir = flagValues('out')[0];
const onlyIds = flagValues('session');
if (!dbPath || !outDir) {
  console.error('Usage: node export-opencode.mjs --db <opencode.db> --out <dir> [--top-only] [--session <id>]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const db = new DatabaseSync(dbPath, { readOnly: true });
const projects = new Map(
  db.prepare('SELECT id, worktree FROM project').all().map((r) => [r.id, r.worktree])
);
const sessions = db.prepare(
  'SELECT id, project_id, directory, title, parent_id, time_created, time_updated FROM session_v2 ORDER BY time_created'
).all();

const selected = sessions.filter((s) => {
  if (onlyIds.length) return onlyIds.includes(s.id);
  if (hasFlag('top-only')) return s.parent_id == null;
  return true;
});

const index = [];
for (const s of selected) {
  const rows = db.prepare(
    'SELECT type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq'
  ).all(s.id);

  const turns = [];
  let skipped = 0;
  for (const row of rows) {
    let d;
    try { d = JSON.parse(row.data); } catch { skipped++; continue; }
    if (row.type === 'user') {
      const text = typeof d.text === 'string' && d.text.trim() ? d.text
        : (d.metadata && typeof d.metadata.displayText === 'string' ? d.metadata.displayText : '');
      if (!text.trim()) { skipped++; continue; }
      turns.push({ user: text, assistant: '' });
    } else if (row.type === 'assistant') {
      const parts = Array.isArray(d.content) ? d.content : [];
      const text = parts
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim())
        .map((p) => p.text)
        .join('\n\n');
      if (!text.trim()) { skipped++; continue; }
      if (turns.length === 0) turns.push({ user: '（原会话开头没有用户消息，以下为助手回复）', assistant: text });
      else {
        const last = turns[turns.length - 1];
        last.assistant = last.assistant ? last.assistant + '\n\n' + text : text;
      }
    } else {
      skipped++; // idle / synthetic / compaction / system / model-switched
    }
  }

  const kept = turns.filter((t) => t.user.trim() || t.assistant.trim());
  if (kept.length === 0) continue;

  const file = join(outDir, s.id + '.turns.json');
  writeFileSync(file, JSON.stringify(kept, null, 2));
  const entry = {
    id: s.id,
    title: (s.title || '').trim(),
    parent: s.parent_id || null,
    projectRoot: projects.get(s.project_id) || null,
    directory: s.directory,
    createdAt: s.time_created,
    updatedAt: s.time_updated,
    messages: rows.length,
    turns: kept.length,
    withAssistant: kept.filter((t) => t.assistant.trim()).length,
    skipped,
    file,
  };
  index.push(entry);
  console.error(
    'extracted ' + s.id + ' | title="' + entry.title + '" | turns=' + entry.turns +
    ' (assistant=' + entry.withAssistant + ') | messages=' + entry.messages + ' skipped=' + skipped
  );
}

writeFileSync(join(outDir, 'opencode-index.json'), JSON.stringify(index, null, 2));
console.log(JSON.stringify({ sessions: index.length, turns: index.reduce((n, e) => n + e.turns, 0), out: outDir }));
db.close();
