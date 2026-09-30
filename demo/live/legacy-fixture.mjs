// demo/live/legacy-fixture.mjs
// Build 9 throw-away sessions that reproduce the legacy import layout behind R9:
// every round repeats turn/start {turn:1} instead of counting 1,2,3..., so the
// DSH loader rejects the 8 multi-round sessions ("turn/start does not open the
// expected turn"); the single-round one cannot show the bug and passes.
//
// All content is synthetic; session ids use the all-zero demo uuid so they can
// never be confused with a real session.
//
// Usage: node live/legacy-fixture.mjs --home <tmp DSH home> --ws <workspace dir>
import { mkdirSync } from 'node:fs';
import { parseCli, sessionFilePath, writeSession } from '../../scripts/lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));
const home = args.home && args.home !== true ? args.home : null;
const ws = args.ws && args.ws !== true ? args.ws : null;
if (!home || !ws) { console.error('usage: legacy-fixture.mjs --home <DSH home> --ws <workspace dir>'); process.exit(2); }
mkdirSync(ws, { recursive: true });

const rounds = [3, 4, 2, 5, 3, 2, 4, 3, 1];
const T = 1790000000000;
let totalRounds = 0;

rounds.forEach((n, index) => {
  const nn = String(index + 1).padStart(3, '0');
  const id = 'session-00000000-0000-4000-8000-0000000000' + String(index + 1).padStart(2, '0');
  let seq = 0;
  const events = [];
  const push = (type, data, extra) => events.push({ type, seq: seq++, time: T + seq * 10, data, ...(extra || {}) });

  push('permission/preset', { preset: 'workspace-write' });
  push('sandbox/mode', { mode: 'workspace-write' });
  push('approval/policy', { policy: 'never' });
  push('session/end-seed', {});
  const userSeqs = [];
  for (let k = 1; k <= n; k++) {
    push('turn/start', { turn: 1 });            // legacy bug: turn number never increments
    push('step/start', { turn: 1, step: 1 });
    userSeqs.push(seq);
    push('user/message', {
      content: [{ type: 'text', text: '第 ' + k + ' 轮：示例用户指令' }],
      source: { kind: 'user' }, role: 'user', id: 'user-' + nn + '-' + k,
    }, { surfaceOp: 'append' });
    push('step/end', { turn: 1, step: 1 });
    push('turn/end', { turn: 1, reason: { kind: 'completed' } });
  }
  const title = 'legacy-' + nn + ' · ' + n + ' round' + (n > 1 ? 's' : '');
  push('session/title', { title, messageSeqs: [userSeqs[0]], source: { kind: 'fallback' } });

  const header = { type: 'session', version: 4, id, createdAt: T, cwd: ws, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  writeSession(sessionFilePath(home, ws, id), header, events);
  totalRounds += n;
});

console.log('[fixture] home      ' + home);
console.log('[fixture] cwd       ' + ws);
console.log('[fixture] sessions  9  (8 multi-round + 1 single-round)');
console.log('[fixture] layout    legacy: every round repeats turn/start {turn:1}');
console.log('[fixture] ids       session-00000000-0000-4000-8000-000000000001 .. 009');
console.log('[fixture] rounds    ' + totalRounds + ' rounds across 9 sessions');
console.log('[fixture] wrote     9 x session.v4.jsonl.zstd');
