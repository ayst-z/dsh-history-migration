#!/usr/bin/env node
// Re-synchronise the "surface" metadata of a DSH session log.
//
// Symptom it fixes (any of):
//   SessionFormatError: <type> shadowedSeqs do not name an exact current surface span
//   SessionFormatError: <type> replacement range is not on the current surface
//   SessionFormatError: <type> replacement sourceEventSeqs omit a shadowed surface node
//   corrupt Zstandard session log: complete frame contains a torn JSONL record   (seq gap)
//
// Background (read from the DSH loader itself)
//   DSH keeps a *surface*: an ordered list of event seqs. An event with `surfaceOp`
//   appends itself ('append') or replaces a range ({op:'replace',startSeq,endSeq}).
//   compaction/summary and compaction/prune also carry shadowedRange{start,end} +
//   shadowedSeqs, and the loader demands shadowedSeqs === surface.slice(indexOf(start),
//   indexOf(end)+1). All of those numbers are seqs, i.e. they live in the same coordinate
//   space as `seq`. Delete events and renumber the survivors → every one of them is stale.
//
// Modes
//   shift (default, lossless): every surface number is shifted by the same (threshold, delta)
//     as the renumbering, e.g. `x > 15 ? x - 2 : x`. The pair is found by brute force:
//     the first combination whose surface simulation is exactly consistent wins.
//   drop (lossy fallback): downgrade replace ops to 'append' and rewrite compaction/* in
//     place into inert session/title events. Keeps the conversation, loses compaction.
//
// Both modes fill seq gaps with an inert session/title event (a gap reads as a torn record)
// and never renumber anything.
//
// Usage:
//   node resync-dsh-surface.mjs --home <DSH_HOME> (--session-id <id> | --all) [--mode auto|shift|drop] [--apply] [--json]

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSessions, parseCli, readSession, writeSession } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));
function usage() { console.error('Usage: node resync-dsh-surface.mjs --home <DSH_HOME> (--session-id <id> | --all) [--mode auto|shift|drop] [--apply] [--json]'); }
if (args.help || !args.home || (!args.all && !args.sessionId)) { usage(); process.exit(args.help ? 0 : 2); }
const mode = args.mode && args.mode !== true ? String(args.mode) : 'auto';

const found = findSessions(args.home).filter((s) => (args.all ? true : s.id === args.sessionId));
if (!found.length) { console.error('no session matched'); process.exit(2); }

function simulate(events, mapFn) {
  let surface = [];
  let summaryBad = 0, replaceBad = 0, sourceBad = 0, checked = 0;
  for (const e of events) {
    if (e.type === 'compaction/summary' || e.type === 'compaction/prune') {
      const r = e.data && e.data.shadowedRange;
      const seqs = (e.data && e.data.shadowedSeqs) || [];
      const a = surface.indexOf(mapFn(r && r.start));
      const b = surface.indexOf(mapFn(r && r.end));
      const exp = a < 0 || b < a ? [] : surface.slice(a, b + 1);
      checked++;
      if (exp.length !== seqs.length || exp.some((x, i) => x !== mapFn(seqs[i]))) summaryBad++;
    }
    const op = e.surfaceOp;
    if (op === undefined) continue;
    if (op === 'append') { surface.push(e.seq); continue; }
    if (op && op.op === 'replace') {
      const a = surface.indexOf(mapFn(op.startSeq));
      const b = surface.indexOf(mapFn(op.endSeq));
      if (a < 0 || b < a) { replaceBad++; surface.push(e.seq); continue; }
      const sh = surface.slice(a, b + 1);
      const src = new Set((e.sourceEventSeqs || []).map(mapFn));
      if (sh.some((x) => !src.has(x))) sourceBad++;
      surface = [...surface.slice(0, a), e.seq, ...surface.slice(b + 1)];
      continue;
    }
    surface.push(e.seq);
  }
  return { summaryBad, replaceBad, sourceBad, checked, surfaceLen: surface.length };
}

function findShift(events) {
  const hasSurfaceWork = events.some((e) => (e.type || '').startsWith('compaction/') || (e.surfaceOp && typeof e.surfaceOp === 'object'));
  if (!hasSurfaceWork) return { ok: true, T: 0, M: 0, stat: null };
  for (let M = 0; M <= 8; M++) {
    for (let T = -1; T <= 26; T++) {
      const mapFn = (x) => (typeof x !== 'number' ? x : (x > T ? Math.max(0, x - M) : x));
      const r = simulate(events, mapFn);
      if (r.summaryBad === 0 && r.replaceBad === 0 && r.sourceBad === 0) return { ok: true, T, M, stat: r };
    }
  }
  return { ok: false };
}

function applyShift(events, T, M) {
  const mapFn = (x) => (typeof x !== 'number' ? x : (x > T ? Math.max(0, x - M) : x));
  for (const e of events) {
    if (e.data && e.data.shadowedRange) e.data.shadowedRange = { start: mapFn(e.data.shadowedRange.start), end: mapFn(e.data.shadowedRange.end) };
    if (e.data && Array.isArray(e.data.shadowedSeqs)) e.data.shadowedSeqs = e.data.shadowedSeqs.map(mapFn);
    if (e.surfaceOp && typeof e.surfaceOp === 'object') e.surfaceOp = { ...e.surfaceOp, startSeq: mapFn(e.surfaceOp.startSeq), endSeq: mapFn(e.surfaceOp.endSeq) };
    if (Array.isArray(e.sourceEventSeqs)) e.sourceEventSeqs = e.sourceEventSeqs.map(mapFn);
  }
}

function applyDrop(events) {
  let replaced = 0, compacted = 0;
  const titles = events.filter((e) => e.type === 'session/title');
  const last = titles[titles.length - 1];
  const firstUser = events.find((e) => e.type === 'user/message');
  const messageSeqs = last && last.data && Array.isArray(last.data.messageSeqs) && last.data.messageSeqs.length ? last.data.messageSeqs : (firstUser ? [firstUser.seq] : []);
  const inert = (seq, time) => ({ type: 'session/title', seq, time, data: { title: (last && last.data && last.data.title) || '会话', messageSeqs, source: { kind: 'fallback' } } });
  for (const e of events) {
    if (e.surfaceOp && typeof e.surfaceOp === 'object') { e.surfaceOp = 'append'; replaced++; }
    if ((e.type || '').startsWith('compaction/')) { const r = inert(e.seq, e.time); e.type = r.type; e.data = r.data; compacted++; }
  }
  return { replaced, compacted };
}

function fillGaps(events) {
  const last = [...events].reverse().find((e) => e.type === 'session/title');
  const firstUser = events.find((e) => e.type === 'user/message');
  const messageSeqs = last && last.data && Array.isArray(last.data.messageSeqs) && last.data.messageSeqs.length ? last.data.messageSeqs : (firstUser ? [firstUser.seq] : []);
  const title = (last && last.data && last.data.title) || '会话';
  let gaps = 0, i = 0;
  while (i < events.length) {
    if (events[i].seq !== i) { events.splice(i, 0, { type: 'session/title', seq: events[i].seq - 1, time: events[i].time - 1, data: { title, messageSeqs, source: { kind: 'fallback' } } }); gaps++; }
    i++;
  }
  return gaps;
}

const results = [];
for (const f of found) {
  const session = readSession(f.file);
  const events = session.events.slice();
  const gaps = fillGaps(events);
  const shift = findShift(events);
  let used = null;
  if (shift.ok && (mode === 'auto' || mode === 'shift')) { applyShift(events, shift.T, shift.M); used = 'shift T=' + shift.T + ' M=' + shift.M; }
  else if (mode === 'drop' || (mode === 'auto' && !shift.ok)) { const d = applyDrop(events); used = 'drop replace=' + d.replaced + ' compaction=' + d.compacted; }
  else { used = 'none (no consistent shift found; re-run with --mode drop)'; }
  // 只有在真的需要动时才写：M === 0 时映射是恒等（T 取什么值都一样），写盘纯属多余，
  // 而且会与正在运行的会话并发写、丢掉它刚追加的事件。
  const changed = gaps + (shift.ok && shift.M > 0 ? 1 : 0);
  if (args.apply && changed) {
    copyFileSync(f.file, f.file + '.bak-surface');
    writeSession(f.file, session.header, events);
  }
  results.push({ id: f.id, gaps, shiftOk: shift.ok, used, applied: !!(args.apply && changed) });
}

if (args.json) console.log(JSON.stringify(results, null, 2));
else for (const r of results) console.log((r.applied ? 'OK   ' : '     ') + r.id + '  gaps=' + r.gaps + '  ' + r.used);
