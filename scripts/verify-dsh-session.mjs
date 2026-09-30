#!/usr/bin/env node
// Verify a DSH session log offline and (optionally) against the real DSH loader.
//
// Offline checks:
//   header frame holds exactly one line; every later frame holds exactly one event line;
//   every event JSON parses and has a continuous seq starting at 0;
//   no assistant/message without a model stream (imports should stay user-only);
//   session/title exists and its messageSeqs point at real events.
//
// Optional live check:
//   node verify-dsh-session.mjs --in <file> --home <DSH_HOME> --dsh <path to dsh launcher> --run-dsh
//   Runs:  <dsh> headless --session-id <id> "x"   with DSH_HOME=<home>.
//   A well-formed session that the one-shot runner refuses to compose (message contains
//   "does not compose" / "agent preset") counts as PASS: the log format was accepted.
//
// Usage:
//   node verify-dsh-session.mjs --in <session.v4.jsonl.zstd> [--home <DSH_HOME>] [--session-id <id>]
//        [--require-cache] [--dsh <path>] [--run-dsh] [--timeout-ms <n>] [--json]

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSession, parseCli } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));

function usage() {
  console.error('Usage: node verify-dsh-session.mjs --in <session.v4.jsonl.zstd> [--home <DSH_HOME>] [--session-id <id>] [--require-cache] [--dsh <path>] [--run-dsh] [--timeout-ms <n>] [--json]');
}

if (args.help || !args.in) {
  usage();
  process.exit(args.help ? 0 : 2);
}

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

const s = readSession(args.in);

record('file readable', s.bytes > 0, s.bytes + ' bytes, ' + s.frames.length + ' zstd frames');
record('first frame = exactly one header line', s.frameLines.length > 0 && s.frameLines[0].length === 1,
  s.frameLines.length ? 'first frame has ' + s.frameLines[0].length + ' line(s)' : 'no frames');
const badFrameLines = s.frameLines.slice(1).filter((l) => l.length !== 1);
record('one event per frame', badFrameLines.length === 0, badFrameLines.length + ' frame(s) hold a different line count');
record('header parses as a session header', !!s.header && s.header.type === 'session',
  s.header ? 'id=' + s.header.id + ' version=' + s.header.version : 'missing');
record('header id present', !!(s.header && typeof s.header.id === 'string' && s.header.id.startsWith('session-')),
  s.header ? String(s.header.id) : '(none)');
record('header cwd present', !!(s.header && typeof s.header.cwd === 'string' && s.header.cwd.length > 0),
  s.header ? String(s.header.cwd) : '(none)');

const seqs = [];
for (const e of s.events) if (typeof e.seq === 'number' && Number.isInteger(e.seq)) seqs.push(e.seq);
const seqOk = s.events.length > 0 && seqs.length === s.events.length && seqs.every((v, i) => v === i);
record('seq continuous from 0', seqOk, 'events=' + s.events.length + ' seqs=' + (seqOk ? '0..' + (s.events.length - 1) : JSON.stringify(seqs.slice(0, 12))));

const assistantEvents = s.events.filter((e) => e.type === 'assistant/message');
const assistantWithoutStream = assistantEvents.filter((e) => {
  const d = e.data || {};
  return !(d.stream || (d.message && d.message.stream));
});
record('no assistant/message without a model stream', assistantWithoutStream.length === 0,
  assistantEvents.length + ' assistant/message event(s), ' + assistantWithoutStream.length + ' without stream');

const title = s.events.find((e) => e.type === 'session/title');
const seqSet = new Set(seqs);
const messageSeqs = title && title.data && Array.isArray(title.data.messageSeqs) ? title.data.messageSeqs : [];
record('session/title present with valid messageSeqs', !!title && messageSeqs.every((q) => seqSet.has(q)),
  title ? JSON.stringify(title.data.title) + ' messageSeqs=' + JSON.stringify(messageSeqs) : 'missing');

const sessionId = (args.sessionId && args.sessionId !== true) ? args.sessionId : (s.header ? s.header.id : null);

if (args.home && args.home !== true) {
  const cache = join(args.home, 'storages', 'session_projcache', 'sessions', sessionId + '.json');
  const present = existsSync(cache);
  record('projcache entry ' + (args.requireCache ? 'present' : 'informational'), present || !args.requireCache,
    cache + (present ? ' (exists)' : ' (missing)'));
}

if (args.runDsh) {
  if (!args.dsh || args.dsh === true) {
    record('dsh live check', false, '--run-dsh needs --dsh <path to dsh launcher>');
  } else if (!args.home || args.home === true) {
    record('dsh live check', false, '--run-dsh needs --home <DSH_HOME> so the loader can find the session');
  } else {
    const timeoutMs = Number(args.timeoutMs) || 30000;
    const command = '"' + args.dsh + '" headless --session-id ' + sessionId + ' "x"';
    const started = Date.now();
    const res = spawnSync(command, {
      shell: true,
      cwd: process.cwd(),
      env: { ...process.env, DSH_HOME: args.home },
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    const ms = Date.now() - started;
    const stdout = res.stdout || '';
    const stderr = res.stderr || '';
    const text = stdout + '\n' + stderr;
    const formatError = /corrupt|seq gap|invalid committed event|not exactly one header line|failed validation|invalid frame magic|unknown id/i.test(text);
    const presetRefusal = /does not compose|agent preset/i.test(text);
    const timedOut = !!(res.error && /timed?out/i.test(String(res.error.code || res.error.message)));
    let verdict;
    if (formatError) verdict = 'rejected (format error)';
    else if (res.status === 0) verdict = 'accepted (ran)';
    else if (presetRefusal) verdict = 'accepted (format ok; preset not composed by one-shot runner)';
    else if (timedOut) verdict = 'unknown (timed out; no format error seen)';
    else verdict = 'unknown (exit ' + res.status + ')';
    const ok = !formatError && (res.status === 0 || presetRefusal);
    record('dsh live check', ok, verdict + ' in ' + ms + 'ms | ' + text.trim().split(/\r?\n/).slice(0, 3).join(' || '));
  }
}

const failed = checks.filter((c) => !c.ok);
if (args.json) {
  console.log(JSON.stringify({ file: s.file, sessionId, checks, pass: failed.length === 0 }, null, 2));
} else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? '  -- ' + c.detail : ''));
  console.log(failed.length === 0 ? '\nRESULT: PASS (' + checks.length + ' checks)' : '\nRESULT: FAIL (' + failed.length + '/' + checks.length + ')');
}
process.exit(failed.length === 0 ? 0 : 1);
