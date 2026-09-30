// demo/live/fix-frames.mjs — repair framing + renumber seq, in place.
// Mirrors the field steps: split frames, renumber seq 0..N-1, one event per frame.
// Usage: node demo/live/fix-frames.mjs <session.v4.jsonl.zstd>
import { readFileSync, writeFileSync } from 'node:fs';
import { readSession, allLines, compressLine, NL } from './frames.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: fix-frames.mjs <session.v4.jsonl.zstd>'); process.exit(2); }
const { chunks } = readSession(file);
const lines = allLines(chunks);
const objs = lines.map((l) => JSON.parse(l));
const header = objs[0];
const events = objs.slice(1).filter((o) => o.type !== 'session');
const before = events.map((o) => o.seq).join(',');
for (let i = 0; i < events.length; i++) events[i].seq = i;
// keep messageSeqs honest after renumbering
const titleEv = events.find((o) => o.type === 'session/title');
const firstUser = events.find((o) => o.type === 'user/message');
if (titleEv && firstUser) titleEv.data.messageSeqs = [firstUser.seq];

const out = Buffer.concat([header, ...events].map((o) => compressLine(JSON.stringify(o))));
writeFileSync(file, out);
console.log('[fix] input     ' + String(file).replace(/\\/g, '/'));
console.log('[fix] seq before ' + before);
console.log('[fix] seq after  ' + events.map((o) => o.seq).join(','));
console.log('[fix] reframed   ' + (events.length + 1) + ' frames (1 header + ' + events.length + ' events)');
console.log('[fix] bytes      ' + out.length);
console.log('[fix] wrote      ' + String(file).replace(/\\/g, '/'));
