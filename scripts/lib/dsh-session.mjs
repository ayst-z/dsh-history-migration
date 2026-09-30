// Shared helpers for DSH session tooling.
//
// A DSH session log is a file named "session.v4.jsonl.zstd":
//   * a concatenation of independent Zstandard frames;
//   * the FIRST frame holds EXACTLY ONE line: the JSON session header;
//   * every following frame holds exactly one JSON event (one line);
//   * the header has no "seq"; every event has a "seq" running 0,1,2,... with no gaps.
//
// This module deliberately contains no personal paths and no session content:
// every path is passed in by the caller.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

export const ZSTD_MAGIC = 0xfd2fb528;
export const SKIPPABLE_MIN = 0x184d2a50;
export const SKIPPABLE_MAX = 0x184d2a5f;
export const NL = '\n';
export const SESSION_FILE_NAME = 'session.v4.jsonl.zstd';

/** Split a buffer into Zstandard frame [start,end) ranges, skipping skippable frames. */
export function splitZstdFrames(buf) {
  const frames = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const m = buf.readUInt32LE(o);
    if (m >= SKIPPABLE_MIN && m <= SKIPPABLE_MAX) {
      if (o + 8 > buf.length) break;
      const size = buf.readUInt32LE(o + 4);
      o += 8 + size;
      continue;
    }
    if (m !== ZSTD_MAGIC) { o++; continue; }
    try {
      let p = o + 4;
      const fhd = buf[p++];
      const fcsCode = (fhd >> 6) & 3;
      const single = (fhd >> 5) & 1;
      const checksum = (fhd >> 2) & 1;
      const dictFlag = fhd & 3;
      if (!single) p += 1;
      p += [0, 1, 2, 4][dictFlag];
      p += fcsCode === 0 ? (single ? 1 : 0) : [2, 4, 8][fcsCode - 1];
      for (;;) {
        if (p + 3 > buf.length) throw new Error('truncated frame header');
        const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
        p += 3;
        const last = h & 1;
        const type = (h >> 1) & 3;
        const size = h >> 3;
        if (type === 0) p += size;
        else if (type === 1) p += 1;
        else if (type === 2) p += size;
        else throw new Error('reserved block type');
        if (last) break;
      }
      if (checksum) p += 4;
      if (p > buf.length) throw new Error('truncated frame');
      frames.push([o, p]);
      o = p;
    } catch {
      o++;
    }
  }
  return frames;
}

/** Decompress each Zstandard frame to text. */
export function decompressFrames(buf) {
  const frames = splitZstdFrames(buf);
  const texts = [];
  const badFrames = [];
  for (let i = 0; i < frames.length; i++) {
    const [a, b] = frames[i];
    try {
      texts.push(zlib.zstdDecompressSync(buf.subarray(a, b)).toString('utf8'));
    } catch {
      texts.push('');
      badFrames.push(i);
    }
  }
  return { frames, texts, badFrames };
}

/** Read a session file into { header, events, errors, ... } without throwing on corruption. */
export function readSession(file) {
  const buf = readFileSync(file);
  const { frames, texts, badFrames } = decompressFrames(buf);
  const frameLines = texts.map((t) => t.split(NL).filter((l) => l.trim() !== ''));
  const errors = [];
  if (frames.length === 0) errors.push('no Zstandard frames found');
  if (badFrames.length) errors.push('frames failed to decompress: ' + badFrames.join(','));
  let header = null;
  const events = [];
  if (frameLines.length > 0) {
    if (frameLines[0].length !== 1) {
      errors.push('first frame must contain exactly one header line (found ' + frameLines[0].length + ')');
    }
    for (let i = 0; i < frameLines.length; i++) {
      for (const line of frameLines[i]) {
        let obj;
        try { obj = JSON.parse(line); } catch (e) {
          errors.push('frame ' + i + ': invalid JSON: ' + e.message);
          continue;
        }
        if (i === 0 && header === null) { header = obj; continue; }
        events.push(obj);
      }
    }
    if (header && header.type !== 'session') errors.push('header type is "' + header.type + '", expected "session"');
  }
  return { file, buf, bytes: buf.length, frames, texts, frameLines, header, events, errors };
}

/** Write a session file, one JSON line per Zstandard frame (header first). */
export function writeSession(file, header, events, options = {}) {
  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + NL, 'utf8')));
  const payload = Buffer.concat(frames);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, payload);
  if (options.alsoJsonl) writeFileSync(options.alsoJsonl, lines.join(NL) + NL);
  return { bytes: payload.length, frames: frames.length, lines: lines.length, linesText: lines };
}

/** Map a workspace cwd to the folder name DSH uses under <DSH_HOME>/sessions. */
export function encodeWorkspaceDir(cwd) {
  let s = String(cwd).replace(/\//g, '\\').replace(/\\+$/, '');
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === ':') continue;
    if (ch === '\\') out += '-';
    else if (code < 0x20 || code > 0x7e) out += '~' + code.toString(16).toUpperCase().padStart(4, '0') + '~';
    else out += ch;
  }
  return '--' + out + '--';
}

/** Standard on-disk location of one session under a DSH home. */
export function sessionFilePath(home, cwd, sessionId) {
  return join(home, 'sessions', encodeWorkspaceDir(cwd), sessionId, SESSION_FILE_NAME);
}

/** Enumerate every session file under a DSH home. */
export function findSessions(home) {
  const root = join(home, 'sessions');
  const out = [];
  let workspaceDirs = [];
  try {
    workspaceDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const ws of workspaceDirs) {
    let sessionDirs = [];
    try {
      sessionDirs = readdirSync(join(root, ws), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const id of sessionDirs) {
      const file = join(root, ws, id, SESSION_FILE_NAME);
      try { if (statSync(file).isFile()) out.push({ home, workspaceDir: ws, id, file }); } catch { /* ignore */ }
    }
  }
  return out;
}

/** Count events by type, most frequent first. */
export function eventTypeHistogram(events) {
  const hist = new Map();
  for (const e of events) {
    const t = e && e.type ? e.type : '?';
    hist.set(t, (hist.get(t) || 0) + 1);
  }
  return [...hist.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

/** Minimal "--key value / --flag / --key=value" argument parser.
 *  Every dashed option is also exposed under its camelCase name (--max-user -> maxUser). */
export function parseCli(argv) {
  const out = { _: [] };
  const set = (key, value) => {
    out[key] = value;
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (camel !== key && !(camel in out)) out[camel] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { set(key, next); i++; }
        else set(key, true);
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function fileExists(p) {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
}
