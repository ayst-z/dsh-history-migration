#!/usr/bin/env node
// Decode a DSH session log (.v4.jsonl.zstd) into plain JSONL and a summary.
//
// Usage:
//   node decode-dsh-session.mjs --in <session.v4.jsonl.zstd> [--out <decoded.jsonl>] [--json]
//
// Exit code 1 when the file does not decode cleanly.

import { writeFileSync } from 'node:fs';
import { eventTypeHistogram, parseCli, readSession } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));

function usage() {
  console.error('Usage: node decode-dsh-session.mjs --in <session.v4.jsonl.zstd> [--out <decoded.jsonl>] [--json]');
}

if (args.help || !args.in) {
  usage();
  process.exit(args.help ? 0 : 2);
}

const s = readSession(args.in);
if (s.header) {
  const lines = [JSON.stringify(s.header), ...s.events.map((e) => JSON.stringify(e))];
  if (args.out) writeFileSync(args.out, lines.join('\n') + '\n');
}

const summary = {
  file: s.file,
  bytes: s.bytes,
  frames: s.frames.length,
  events: s.events.length,
  sessionId: s.header ? s.header.id : null,
  cwd: s.header ? s.header.cwd : null,
  createdAt: s.header ? s.header.createdAt : null,
  agentPreset: s.header ? s.header.agentPreset : null,
  eventTypes: Object.fromEntries(eventTypeHistogram(s.events)),
  errors: s.errors,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('file:    ' + summary.file);
  console.log('bytes:   ' + summary.bytes + '   frames: ' + summary.frames + '   events: ' + summary.events);
  if (s.header) {
    const at = s.header.createdAt ? new Date(s.header.createdAt).toISOString() : '(none)';
    console.log('session: ' + summary.sessionId);
    console.log('cwd:     ' + summary.cwd);
    console.log('created: ' + at + '   agentPreset: ' + summary.agentPreset);
  }
  for (const [type, n] of eventTypeHistogram(s.events)) {
    console.log(String(n).padStart(6) + '  ' + type);
  }
  for (const err of s.errors) console.error('error: ' + err);
  if (args.out) console.log('decoded JSONL: ' + args.out);
}

process.exit(s.errors.length ? 1 : 0);
