// demo/live/decode-session.mjs — split frames, decompress, summarise.
// Usage: node demo/live/decode-session.mjs <session.v4.jsonl.zstd>
import { readSession, allLines, NL } from './frames.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: decode-session.mjs <session.v4.jsonl.zstd>'); process.exit(2); }
const { frames, chunks, badFrames } = readSession(file);
const lines = allLines(chunks);
const objs = [];
for (const l of lines) { try { objs.push(JSON.parse(l)); } catch {} }
const header = objs.find((o) => o.type === 'session');
const events = objs.filter((o) => o.type !== 'session');
const seqs = events.filter((o) => typeof o.seq === 'number').map((o) => o.seq);
const types = {};
for (const o of events) types[o.type] = (types[o.type] || 0) + 1;
const title = events.find((o) => o.type === 'session/title');

const showPath = String(file).replace(/\\/g, '/');
console.log('[decode] file    ' + showPath);
console.log('[decode] frames  ' + frames.length + '  (bad ' + badFrames.length + ', skippable ' + frames.filter((f) => f.skippable).length + ')');
console.log('[decode] lines   ' + lines.length + '  (header ' + (header ? 1 : 0) + ' + events ' + events.length + ')');
console.log('[decode] seq     ' + seqs.join(' '));
const typeList = Object.keys(types).map((t) => t + ' x' + types[t]);
let row = '';
for (const t of typeList) { if ((row + '  ' + t).length > 74) { console.log('[decode] types   ' + row.trim()); row = ''; } row += '  ' + t; }
if (row.trim()) console.log('[decode] types   ' + row.trim());
if (header) console.log('[decode] header  version=' + header.version + ' cwd=' + header.cwd + ' preset=' + header.agentPreset);
console.log('[decode] id      ' + (header ? header.id : '(none)'));
console.log('[decode] title   ' + (title ? title.data.title : '(none)'));
