#!/usr/bin/env node
// Retitle a DSH session the safe way: APPEND a session/title event, never renumber seq.
//
// Usage:
//   node retitle-dsh-session.mjs --home <DSH_HOME> --session-id <id> --title "<text>" [--json]
//   node retitle-dsh-session.mjs --in <session.v4.jsonl.zstd> --title "<text>" [--cache <path>]
//
// Why append-only (this bites hard):
//   `seq` is a shared coordinate space. Many fields are references into it —
//   `sourceEventSeqs`, `throughSeq`, `headerSeq`, `startSeq`/`endSeq`, `shadowedSeqs`,
//   `messageSeqs` — and they all hold *earlier* seq numbers. If you delete an old
//   `session/title` and renumber the survivors to close the gap, every reference past the
//   deletion point is repointed (or becomes `>= own seq`), and DSH refuses the log with:
//     corrupt session log: invalid committed event at line N:
//     sourceEventSeqs ranges must contain unique earlier seqs
//   The last `session/title` event wins for display, so older ones can simply stay put.
//
// Do NOT run this against a session that is currently streaming — DSH appends concurrently.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSessions, parseCli, readSession, writeSession } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));

function usage() {
  console.error('Usage: node retitle-dsh-session.mjs (--in <file> | --home <DSH_HOME> --session-id <id>) --title "<text>" [--cache <projcache.json>] [--json]');
}

if (args.help || !args.title || (!args.in && !(args.home && args.sessionId))) {
  usage();
  process.exit(args.help ? 0 : 2);
}

let file = args.in && args.in !== true ? args.in : null;
if (!file) {
  const found = findSessions(args.home).find((s) => s.id === args.sessionId);
  if (!found) {
    console.error('session not found: ' + args.sessionId + ' under ' + args.home);
    process.exit(2);
  }
  file = found.file;
}

const session = readSession(file);
const lastSeq = session.events.reduce((max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max), -1);
const previous = [...session.events].reverse().find((e) => e.type === 'session/title');
const event = {
  type: 'session/title',
  seq: lastSeq + 1,
  time: Date.now(),
  data: {
    title: args.title,
    messageSeqs: (previous && previous.data && previous.data.messageSeqs) || [],
    source: { kind: 'fallback' },
  },
};

if (args.dryRun) {
  console.log(JSON.stringify({ file, appended: event, wouldBeSeq: lastSeq + 1 }, null, 2));
  process.exit(0);
}

const written = writeSession(file, session.header, [...session.events, event]);

let cachePath = args.cache && args.cache !== true ? args.cache : null;
if (!cachePath && args.home && args.sessionId) {
  cachePath = join(args.home, 'storages', 'session_projcache', 'sessions', args.sessionId + '.json');
}
let cacheUpdated = false;
if (cachePath && existsSync(cachePath)) {
  const record = JSON.parse(readFileSync(cachePath, 'utf8'));
  const row = record && record.record && record.record.rows && record.record.rows.title;
  if (row) {
    row.val = args.title;
    writeFileSync(cachePath, JSON.stringify(record));
    cacheUpdated = true;
  }
}

const result = { file, events: written.lines - 1, appendedSeq: lastSeq + 1, title: args.title, cache: cachePath, cacheUpdated };
if (args.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log('retitled: ' + args.title);
  console.log('  file:   ' + file);
  console.log('  events: ' + result.events + ' (appended session/title at seq ' + result.appendedSeq + ')');
  if (cachePath) console.log('  cache:  ' + cachePath + (cacheUpdated ? ' (updated)' : ' (no title row)'));
}
