// demo/live/frames.mjs — DSH session v4 frame reader (zstd, one frame per line).
// Reusable/copy-safe: takes a path argument, prints nothing by itself.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

export const NL = '\n';

// Walk the byte stream and return [start, end) ranges of real zstd frames.
// Skips skippable frames (magic 0x184D2A5x). Portable equivalent of the
// field-tested splitter used during the original migration.
export function splitFrames(buf) {
  const frames = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const m = buf.readUInt32LE(o);
    if (m >= 0x184d2a50 && m <= 0x184d2a5f) {
      if (o + 8 > buf.length) break;
      const sz = buf.readUInt32LE(o + 4);
      frames.push({ start: o, end: o + 8 + sz, skippable: true });
      o += 8 + sz;
      continue;
    }
    if (m !== 0xfd2fb528) { o++; continue; }
    try {
      let p = o + 4;
      const fhd = buf[p++];
      const fcsCode = (fhd >> 6) & 3, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
      if (!single) p += 1;
      p += [0, 1, 2, 4][dictFlag];
      p += fcsCode === 0 ? (single ? 1 : 0) : [2, 4, 8][fcsCode - 1];
      while (true) {
        if (p + 3 > buf.length) throw new Error('eof');
        const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16); p += 3;
        const last = h & 1, type = (h >> 1) & 3, size = h >> 3;
        if (type === 0) p += size; else if (type === 1) p += 1; else if (type === 2) p += size; else throw new Error('reserved');
        if (last) break;
      }
      if (checksum) p += 4;
      if (p > buf.length) throw new Error('eof');
      frames.push({ start: o, end: p, skippable: false });
      o = p;
    } catch { o++; }
  }
  return frames;
}

// -> { buf, frames, chunks: [{index, text}], badFrames: [n] }
export function readSession(path) {
  const buf = readFileSync(path);
  const frames = splitFrames(buf);
  const chunks = [];
  const badFrames = [];
  let i = 0;
  for (const f of frames) {
    if (f.skippable) continue;
    i++;
    try {
      chunks.push({ index: i - 1, text: zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') });
    } catch { badFrames.push(i); }
  }
  return { buf, frames, chunks, badFrames };
}

export function allLines(chunks) {
  const lines = [];
  for (const c of chunks) for (const l of c.text.split(NL)) if (l.trim() !== '') lines.push(l);
  return lines;
}

export function compressLine(line) {
  return zlib.zstdCompressSync(Buffer.from(line + NL, 'utf8'));
}
