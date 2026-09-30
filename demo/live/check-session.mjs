// demo/live/check-session.mjs — rule checker for the DSH v4 on-disk session format.
// Usage: node demo/live/check-session.mjs <session.v4.jsonl.zstd>   (exit 0 = pass)
import { readSession, allLines, NL } from './frames.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: check-session.mjs <session.v4.jsonl.zstd>'); process.exit(2); }
const { chunks, badFrames } = readSession(file);

const linesPerChunk = chunks.map((c) => c.text.split(NL).filter((l) => l.trim() !== ''));
const all = linesPerChunk.flat();
const parsed = all.map((l) => { try { return JSON.parse(l); } catch { return null; } });
const header = parsed[0] && parsed[0].type === 'session' ? parsed[0] : null;
const events = parsed.slice(1).filter((o) => o && o.type);
const seqs = events.filter((o) => typeof o.seq === 'number').map((o) => o.seq);

const checks = [];
const add = (id, name, ok, detail) => checks.push({ id, name, ok: !!ok, detail });

add('R1', 'first-frame-is-header-only', chunks.length > 0 && linesPerChunk[0].length === 1 && header, 'frame#0 lines=' + (linesPerChunk[0] ? linesPerChunk[0].length : 0));
add('R2', 'one-event-per-frame', chunks.length >= 2 && chunks.slice(1).every((c, i) => linesPerChunk[i + 1].length === 1), 'frames=' + chunks.length);
add('R3', 'seq-contiguous-from-0', seqs.length === events.length && seqs.every((s, i) => s === i), 'seq=' + (seqs.length ? seqs[0] + '..' + seqs[seqs.length - 1] : 'none'));
add('R4', 'seq-unique', new Set(seqs).size === seqs.length, 'n=' + seqs.length);
add('R5', 'every-line-valid-json', parsed.every((o) => o !== null) && badFrames.length === 0, 'lines=' + all.length + ' badFrames=' + badFrames.length);
add('R6', 'no-partial-assistant-message', !events.some((o) => o.type === 'assistant/message' && !o.data?.message?.stream), 'assistant/message kept=0');

for (const c of checks) {
  console.log('[check] ' + c.id + '  ' + c.name.padEnd(30, ' ') + (c.ok ? 'PASS' : 'FAIL') + '   ' + c.detail);
}
const failed = checks.filter((c) => !c.ok);
console.log('[check] frames=' + chunks.length + ' events=' + events.length + ' seq=' + (seqs.length ? seqs[0] + '..' + seqs[seqs.length - 1] : 'none'));
console.log('[check] RESULT ' + (failed.length === 0 ? 'PASS' : 'FAIL (' + failed.map((f) => f.id).join(',') + ')') + '  ' + String(file).replace(/\\/g, '/'));
process.exit(failed.length === 0 ? 0 : 1);
