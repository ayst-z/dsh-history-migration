#!/usr/bin/env node
// Repair the "surface" metadata of a DSH session log so the loader accepts it again.
//
// When to use
//   DSH refuses a log with any of:
//     SessionFormatError: <type> shadowedSeqs do not name an exact current surface span
//     SessionFormatError: <type> replacement range is not on the current surface
//     corrupt Zstandard session log: complete frame contains a torn JSONL record
//   …typically because the log was edited by hand (events deleted/inserted, seqs renumbered).
//
// Why those errors happen
//   DSH keeps a "surface": an ordered list of seqs. Each event with a `surfaceOp` either
//   appends itself or **replaces a range of the surface**:
//     surfaceOp: 'append' | { op: 'replace', startSeq, endSeq }
//   `compaction/summary` / `compaction/prune` additionally carry
//     shadowedRange: { start, end }  and  shadowedSeqs: [...]
//   and the loader demands `shadowedSeqs === surface.slice(indexOf(start), indexOf(end)+1)`.
//   Any change to the event set or to seq numbering breaks that equality, and a replace whose
//   range fell off the surface throws too.
//
// What this script does (no seq renumbering, ever)
//   1. fills seq gaps with an inert `session/title` event (a gap reads as a torn record);
//   2. downgrades every `{op:'replace',…}` surfaceOp to `'append'`;
//   3. rewrites every `compaction/*` event in place into an inert `session/title`
//      (its seq is kept) and saves the dropped summary text to --summaries <file>.
//   The conversation itself is untouched: only DSH's context-compaction bookkeeping and the
//   summary text it produced are dropped, and the raw events the summary referred to are
//   still in the log.
//
// Usage:
//   node repair-dsh-surface.mjs --home <DSH_HOME> --session-id <id> [--summaries <dir>] [--apply]
//   node repair-dsh-surface.mjs --home <DSH_HOME> --all [--summaries <dir>] [--apply] [--json]

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { findSessions, parseCli, readSession, writeSession } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));
function usage() {
  console.error('Usage: node repair-dsh-surface.mjs --home <DSH_HOME> (--session-id <id> | --all) [--summaries <dir>] [--apply] [--json]');
}
if (args.help || !args.home || (!args.all && !args.sessionId)) { usage(); process.exit(args.help ? 0 : 2); }

const found = findSessions(args.home).filter((s) => (args.all ? true : s.id === args.sessionId));
if (!found.length) { console.error('no session matched'); process.exit(2); }

function summarize(list) {
  const text = [];
  for (const e of list) {
    if (e.type !== 'compaction/summary') continue;
    const s = e.data && e.data.summary;
    const chunks = Array.isArray(s) ? s.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : '';
    if (chunks.trim()) text.push('### seq ' + e.seq + '\n\n' + chunks.trim());
  }
  return text.join('\n\n');
}

function repair(file) {
  const session = readSession(file);
  const events = session.events.slice();
  const firstUser = events.find((e) => e.type === 'user/message');
  const title = [...events].reverse().find((e) => e.type === 'session/title');
  const messageSeqs = title && title.data && Array.isArray(title.data.messageSeqs) && title.data.messageSeqs.length
    ? title.data.messageSeqs
    : (firstUser ? [firstUser.seq] : []);
  const inert = (seq, time) => ({
    type: 'session/title',
    seq,
    time,
    data: { title: (title && title.data && title.data.title) || '会话', messageSeqs, source: { kind: 'fallback' } },
  });

  let gaps = 0;
  let i = 0;
  while (i < events.length) {
    if (events[i].seq !== i) {
      const at = events[i].seq - 1;
      events.splice(i, 0, inert(at, events[i].time - 1));
      gaps++;
    }
    i++;
  }
  let replaced = 0;
  let compacted = 0;
  for (const e of events) {
    if (e.surfaceOp && typeof e.surfaceOp === 'object') { e.surfaceOp = 'append'; replaced++; }
    if ((e.type || '').startsWith('compaction/')) { const r = inert(e.seq, e.time); e.type = r.type; e.data = r.data; compacted++; }
  }
  return { session, events, gaps, replaced, compacted, summaryText: summarize(session.events) };
}

const results = [];
for (const f of found) {
  const r = repair(f.file);
  const changed = r.gaps + r.replaced + r.compacted;
  if (!args.apply) { results.push({ id: f.id, changed, gaps: r.gaps, replaced: r.replaced, compacted: r.compacted, applied: false }); continue; }
  if (!changed) { results.push({ id: f.id, changed: 0, applied: false }); continue; }
  copyFileSync(f.file, f.file + '.bak-surface');
  writeSession(f.file, r.session.header, r.events);
  if (r.summaryText && args.summaries && args.summaries !== true) {
    mkdirSync(args.summaries, { recursive: true });
    writeFileSync(join(args.summaries, f.id + '.md'), r.summaryText, 'utf8');
  }
  results.push({ id: f.id, changed, gaps: r.gaps, replaced: r.replaced, compacted: r.compacted, applied: true, backup: f.file + '.bak-surface' });
}

if (args.json) console.log(JSON.stringify(results, null, 2));
else {
  const touched = results.filter((r) => r.changed);
  console.log((args.apply ? 'repaired ' : 'would repair ') + touched.length + ' session(s) of ' + found.length);
  for (const r of touched) console.log('  ' + r.id + '  gap=' + (r.gaps || 0) + ' replace=' + (r.replaced || 0) + ' compaction=' + (r.compacted || 0));
}
