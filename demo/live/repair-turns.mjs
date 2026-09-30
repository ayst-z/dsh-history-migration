// demo/live/repair-turns.mjs
// R9 fix: rebuild every session so each round is its own turn/start -> turn/end
// pair with turn = 1,2,3..., then renumber seq and re-frame (one event per frame).
//
// Usage: node live/repair-turns.mjs --home <DSH home>
import { join } from 'node:path';
import { findSessions, parseCli, readSession, writeSession } from '../../scripts/lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));
const home = args.home && args.home !== true ? args.home : null;
if (!home) { console.error('usage: repair-turns.mjs --home <DSH home>'); process.exit(2); }

const sessions = findSessions(home).sort((a, b) => a.id.localeCompare(b.id));
const seedTypes = new Set(['permission/preset', 'sandbox/mode', 'approval/policy', 'session/end-seed']);
let rounds = 0;
for (const s of sessions) {
  const { header, events } = readSession(s.file);
  const seed = events.filter((e) => seedTypes.has(e.type));
  const users = events.filter((e) => e.type === 'user/message');
  const title = events.find((e) => e.type === 'session/title');
  const out = [];
  let seq = 0;
  const push = (type, data, extra) => out.push({ type, seq: seq++, time: header.createdAt + seq * 10, data, ...(extra || {}) });
  for (const e of seed) push(e.type, e.data, e.surfaceOp ? { surfaceOp: e.surfaceOp } : undefined);
  const userSeqs = [];
  users.forEach((u, i) => {
    const turn = i + 1;
    push('turn/start', { turn });
    push('step/start', { turn, step: 1 });
    userSeqs.push(seq);
    push('user/message', u.data, u.surfaceOp ? { surfaceOp: u.surfaceOp } : undefined);
    push('step/end', { turn, step: 1 });
    push('turn/end', { turn, reason: { kind: 'completed' } });
  });
  push('session/title', {
    title: title && title.data ? title.data.title : 'repaired session',
    messageSeqs: [userSeqs[0]],
    source: { kind: 'fallback' },
  });
  writeSession(s.file, header, out);
  rounds += users.length;
}
console.log('[repair] sessions  ' + sessions.length);
console.log('[repair] rounds    ' + rounds + '  (each round = turn/start -> turn/end, turn 1..N)');
console.log('[repair] titles    ' + sessions.length + ' x session/title kept, messageSeqs re-pointed');
console.log('[repair] seq       0..N-1 per session, reframed 1 header + 1 event/frame');
console.log('[repair] wrote     ' + sessions.length + ' x session.v4.jsonl.zstd');
