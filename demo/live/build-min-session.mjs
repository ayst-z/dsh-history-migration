// demo/live/build-min-session.mjs — build a minimal, privacy-safe DSH v4 session.
// Layout: zstd frame #0 holds exactly the header line; every later event owns one frame.
// Usage: node demo/live/build-min-session.mjs --out <dir> [--seq-gap] [--one-frame]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compressLine, NL } from './frames.mjs';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const out = opt('--out', 'live/scratch/min-session');
const cwd = opt('--cwd', '<workspace>');
const seqGap = argv.includes('--seq-gap');
const oneFrame = argv.includes('--one-frame');

const SID = 'session-00000000-0000-4000-8000-000000000001';
const base = 1790000000000;
const lines = [];
const push = (o) => lines.push(JSON.stringify(o));

push({ type: 'session', version: 4, id: SID, createdAt: base, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' });
let seq = 0;
push({ type: 'permission/preset', seq: seq++, time: base, data: { preset: 'workspace-write' } });
push({ type: 'sandbox/mode', seq: seq++, time: base, data: { mode: 'workspace-write' } });
push({ type: 'approval/policy', seq: seq++, time: base, data: { policy: 'never' } });
push({ type: 'session/end-seed', seq: seq++, time: base, data: {} });
push({ type: 'turn/start', seq: seq++, time: base + 1000, data: { turn: 1 } });
push({ type: 'step/start', seq: seq++, time: base + 1000, data: { turn: 1, step: 1 } });
const firstUserSeq = seq;
push({ type: 'user/message', seq: seq++, time: base + 2000, data: { content: [{ type: 'text', text: '把 VS Code 会话导入 DSH' }], source: { kind: 'user' }, role: 'user', id: 'user-0001' }, surfaceOp: 'append' });
push({ type: 'session/title', seq: seq++, time: base + 3000, data: { title: '示例 · 迁移最小会话', messageSeqs: [firstUserSeq], source: { kind: 'fallback' } } });
push({ type: 'step/end', seq: seq++, time: base + 4000, data: { turn: 1, step: 1 } });
push({ type: 'turn/end', seq: seq++, time: base + 4000, data: { turn: 1, reason: { kind: 'completed' } } });

if (seqGap) {
  // Deliberately skip numbers after the header to reproduce the "has seq gap" failure.
  for (let i = 7; i < lines.length; i++) { const o = JSON.parse(lines[i]); o.seq += 3; lines[i] = JSON.stringify(o); }
}

let buf;
let frames;
if (oneFrame) {
  buf = zlib.zstdCompressSync(Buffer.from(lines.join(NL) + NL, 'utf8'));
  frames = 1;
} else {
  const parts = lines.map(compressLine);
  buf = Buffer.concat(parts);
  frames = parts.length;
}

mkdirSync(out, { recursive: true });
const file = join(out, 'session.v4.jsonl.zstd');
writeFileSync(file, buf);

console.log('[build] session  ' + SID);
console.log('[build] cwd      ' + cwd);
console.log('[build] events   ' + (lines.length - 1) + ' (+1 header)');
console.log('[build] frames   ' + frames + ' (header alone in frame #0)');
console.log('[build] seq      ' + (seqGap ? 'gapped on purpose' : '0..' + (lines.length - 2)));
console.log('[build] bytes    ' + buf.length);
console.log('[build] wrote    ' + file.replace(/\\/g, '/'));
