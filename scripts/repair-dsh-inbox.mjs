#!/usr/bin/env node
// Repair inconsistent \`agent/inbox/spliced\` bookkeeping in a DSH session log.
//
// Symptom
//   dsh: failed to project session "<id>": invalid persisted inbox splice at session seq N
//   (the loader folds every agent/inbox/spliced event over two lists, "next-turn" and
//    "next-step"; a splice that removes more entries than the list holds, or that re-inserts
//    a message id which is already pending, aborts the whole projection.)
//
// Why it happens
//   inbox splices are positional (start / removedCount / inserted). Delete or lose an earlier
//   event that carried the matching insert, and a later removal points past the end of a list
//   that is now shorter than the log assumes.
//
// What this does
//   Replays the same fold the loader uses, and rewrites ONLY the offending splice fields:
//     start        → clamped into [0, len]
//     removedCount → clamped so start + removedCount <= len
//     inserted     → drops messages whose id is already pending (the loader's own rule)
//   Everything else (event seq, order, payload) is left alone.
//
// Usage:
//   node repair-dsh-inbox.mjs --home <DSH_HOME> (--session-id <id> | --all) [--apply] [--json]

import { copyFileSync } from 'node:fs';
import { findSessions, parseCli, readSession, writeSession } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));
function usage() { console.error('Usage: node repair-dsh-inbox.mjs --home <DSH_HOME> (--session-id <id> | --all) [--apply] [--json]'); }
if (args.help || !args.home || (!args.all && !args.sessionId)) { usage(); process.exit(args.help ? 0 : 2); }

function fold(events, repair) {
  const state = { 'next-turn': [], 'next-step': [] };
  const issues = [];
  for (const e of events) {
    if (e.type !== 'agent/inbox/spliced') continue;
    const sp = e.data || {};
    const target = sp.target;
    if (target !== 'next-turn' && target !== 'next-step') { issues.push('seq ' + e.seq + ': unknown target ' + String(target)); continue; }
    const list = state[target];
    const snapshot = list.map((m) => m && m.id);
    let start = sp.start;
    let removedCount = sp.removedCount == null ? 0 : sp.removedCount;
    const inserted = Array.isArray(sp.inserted) ? sp.inserted : [];
    if (!Number.isSafeInteger(start) || start < 0) start = 0;
    if (start > list.length) start = list.length;
    if (!Number.isSafeInteger(removedCount) || removedCount < 0) removedCount = 0;
    if (start + removedCount > list.length) removedCount = list.length - start;
    const other = state[target === 'next-turn' ? 'next-step' : 'next-turn'];
    const seen = new Set([...list, ...other].map((m) => m && m.id).filter(Boolean));
    const kept = [];
    for (const m of inserted) {
      const id = m && m.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      kept.push(m);
    }
    const changed = start !== sp.start || removedCount !== (sp.removedCount == null ? 0 : sp.removedCount) || kept.length !== inserted.length;
    if (changed) {
      issues.push('seq ' + e.seq + ' target=' + target + ' start=' + sp.start + ' removed=' + (sp.removedCount == null ? 0 : sp.removedCount) + ' inserted=' + inserted.length + ' -> start=' + start + ' removed=' + removedCount + ' kept=' + kept.length);
      if (repair) { e.data.start = start; if (removedCount !== (sp.removedCount == null ? 0 : sp.removedCount)) e.data.removedCount = removedCount; e.data.inserted = kept; }
    }
    const next = list.slice();
    next.splice(start, removedCount, ...kept);
    const ids = new Set();
    for (const m of (target === 'next-turn' ? [...next, ...state['next-step']] : [...state['next-turn'], ...next])) {
      if (m && m.id && ids.has(m.id)) issues.push('seq ' + e.seq + ': duplicate pending id ' + m.id);
      if (m && m.id) ids.add(m.id);
    }
    state[target] = next;
    void snapshot;
  }
  return { state, issues };
}

const found = findSessions(args.home).filter((s) => (args.all ? true : s.id === args.sessionId));
if (!found.length) { console.error('no session matched'); process.exit(2); }

const out = [];
for (const f of found) {
  const session = readSession(f.file);
  const before = fold(session.events, false);
  if (!before.issues.length) continue;
  const events = session.events.slice();
  fold(events, true);
  if (args.apply) {
    copyFileSync(f.file, f.file + '.bak-inbox');
    writeSession(f.file, session.header, events);
    const after = fold(readSession(f.file).events, false);
    out.push({ id: f.id, fixed: before.issues.length, remaining: after.issues.length, issues: before.issues });
  } else out.push({ id: f.id, fixed: before.issues.length, remaining: before.issues.length, issues: before.issues });
}
if (args.json) console.log(JSON.stringify(out, null, 2));
else if (!out.length) console.log('no inconsistent inbox splice found');
else for (const r of out) console.log((args.apply ? 'repaired ' : 'would repair ') + r.id + ': ' + r.fixed + ' splice(s), remaining ' + r.remaining);
