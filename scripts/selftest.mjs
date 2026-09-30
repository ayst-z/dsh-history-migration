#!/usr/bin/env node
// End-to-end self test for the DSH history-migration scripts.
//
// Creates a throw-away DSH home in the OS temp directory, then runs:
//   privacy scan -> build -> decode -> list -> verify (offline) -> negative control
//   -> generate cache -> verify (live, optional) -> export smoke tests
//
// Usage:
//   node selftest.mjs [--dsh <path to dsh launcher>] [--keep] [--timeout-ms 30000]
//
// The live DSH check is skipped (not failed) when no launcher is given. Point --dsh at
// the installed launcher, e.g. <DSH_INSTALL>/resources/runtime/cli/bin/dsh.cmd, or set
// DSH_CLI. Nothing is written outside the temp directory (unless --keep keeps it).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseCli, readSession, sessionFilePath, writeSession } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const dsh = (args.dsh && args.dsh !== true) ? args.dsh : (process.env.DSH_CLI || null);
const timeoutMs = Number(args.timeoutMs) || 30000;

const root = mkdtempSync(join(tmpdir(), 'dsh-selftest-'));
const dshHome = join(root, 'dsh-home');
const workspace = join(root, 'workspace');
mkdirSync(dshHome, { recursive: true });
mkdirSync(workspace, { recursive: true });
const sessionId = 'session-' + randomUUID();

const results = [];
function run(label, script, scriptArgs) {
  const res = spawnSync(node, [join(here, script), ...scriptArgs], { encoding: 'utf8', timeout: 120000 });
  const ok = res.status === 0;
  results.push({ label, ok, status: res.status });
  const head = (res.stdout || '').trim().split(/\r?\n/).slice(0, 4).join('\n    ');
  const err = (res.stderr || '').trim().split(/\r?\n/).slice(0, 3).join('\n    ');
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  [exit ' + res.status + ']');
  if (head) console.log('    ' + head);
  if (!ok && err) console.log('    stderr: ' + err);
  return { ok, res };
}

function check(label, condition, detail) {
  results.push({ label, ok: !!condition });
  console.log((condition ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  -- ' + detail : ''));
  return !!condition;
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

console.log('self-test root: ' + root);
console.log('DSH home:       ' + dshHome);
console.log('workspace cwd:  ' + workspace);
console.log('session id:     ' + sessionId);
console.log('');

// 0. privacy scan: no hard-coded personal paths anywhere in the scripts folder.
// Markers are assembled at runtime so this file does not itself contain them literally.
const markers = ['C:' + '\\' + 'Users', 'AppData' + '\\' + 'Local' + '\\' + 'Programs', '%USER' + 'PROFILE%'];
const offenders = [];
for (const full of walkFiles(here)) {
  const name = full.slice(here.length + 1);
  if (!/\.(mjs|js|md|ps1)$/.test(name)) continue;
  const text = readFileSync(full, 'utf8').toLowerCase();
  for (const marker of markers) if (text.includes(marker.toLowerCase())) offenders.push(name + ' contains ' + JSON.stringify(marker));
}
check('privacy scan: no hard-coded personal paths', offenders.length === 0, offenders.join('; ') || 'clean');

// 1. build a minimal session into the standard DSH location.
const messagesFile = join(root, 'messages.txt');
writeFileSync(messagesFile, 'first self-test message\nsecond self-test message\n', 'utf8');
run('build session (2 user messages)', 'build-dsh-session.mjs', [
  '--home', dshHome, '--cwd', workspace, '--id', sessionId,
  '--input', messagesFile, '--title', 'Self-test session', '--time', '2020-01-01T00:00:00Z',
]);
const sessionFile = sessionFilePath(dshHome, workspace, sessionId);
check('session file exists at the standard location', statSync(sessionFile).isFile(), sessionFile);

// 2. decode it back.
const decodedFile = join(root, 'decoded.jsonl');
run('decode session', 'decode-dsh-session.mjs', ['--in', sessionFile, '--out', decodedFile]);
const decodedLines = readFileSync(decodedFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
const decodedHeader = JSON.parse(decodedLines[0]);
check('decoded header round-trips', decodedHeader.id === sessionId, 'id=' + decodedHeader.id);
check('decoded JSONL line count = 1 header + 15 events', decodedLines.length === 16, decodedLines.length + ' lines');

// 3. list sessions under the temp DSH home.
const listed = run('list sessions (json)', 'list-dsh-sessions.mjs', ['--home', dshHome, '--json']);
let listedRows = [];
try { listedRows = JSON.parse(listed.res.stdout); } catch { /* reported as failure below */ }
check('list finds the built session', listedRows.some((r) => r.id === sessionId), listedRows.length + ' row(s)');

// 4. offline verification.
const offline = run('verify session (offline)', 'verify-dsh-session.mjs', ['--in', sessionFile]);
check('offline verification passes', offline.ok, 'exit ' + offline.res.status);

// 5. negative control: a seq gap must be rejected.
const s = readSession(sessionFile);
s.events[5].seq = 99;
const badFile = join(root, 'bad-session.v4.jsonl.zstd');
writeSession(badFile, s.header, s.events);
const negative = spawnSync(node, [join(here, 'verify-dsh-session.mjs'), '--in', badFile], { encoding: 'utf8' });
check('negative control: seq gap is rejected', negative.status === 1, 'exit ' + negative.status);

// 6. projection cache generation.
run('generate projection cache', 'generate-dsh-cache.mjs', ['--home', dshHome, '--session', sessionId]);
const cacheFile = join(dshHome, 'storages', 'session_projcache', 'sessions', sessionId + '.json');
let cacheJson = null;
try { cacheJson = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* reported below */ }
check('cache has version 7 and the session title',
  !!cacheJson && cacheJson.version === 7 && cacheJson.record.rows.title.val === 'Self-test session',
  cacheJson ? 'rows=' + Object.keys(cacheJson.record.rows).length : 'missing');

// 7. live validator (optional).
if (dsh) {
  const live = run('verify session (live dsh loader)', 'verify-dsh-session.mjs', [
    '--in', sessionFile, '--home', dshHome, '--session-id', sessionId,
    '--dsh', dsh, '--run-dsh', '--timeout-ms', String(timeoutMs),
  ]);
  const liveLine = (live.res.stdout || '').split(/\r?\n/).find((l) => l.includes('dsh live check')) || '';
  if (liveLine) console.log('    ' + liveLine.trim());
  check('live check reports a format-accepted verdict', live.ok, liveLine.trim());
} else {
  console.log('SKIP  live dsh loader check (pass --dsh <launcher> or set DSH_CLI)');
}

// 8. export smoke tests, driven by synthetic fixtures only.
const vscodeSrc = join(root, 'vscode-chatSessions');
mkdirSync(vscodeSrc, { recursive: true });
writeFileSync(join(vscodeSrc, 'fixture.jsonl'), JSON.stringify({
  kind: 0,
  v: {
    sessionId: 'fixture-session',
    creationDate: 1600000000000,
    responderUsername: 'tester',
    requests: [{ message: { text: 'synthetic question' }, response: [{ kind: 'markdownContent', content: { value: 'synthetic answer' } }], modelId: 'test-model', timestamp: 1600000000000 }],
  },
}) + '\n', 'utf8');
const vscodeOut = join(root, 'vscode-out');
run('export VS Code chat (fixture)', 'export-vscode-chat.mjs', ['--src', vscodeSrc, '--out', vscodeOut]);
let vscodeJson = null;
try { vscodeJson = JSON.parse(readFileSync(join(vscodeOut, 'vscode-sessions.json'), 'utf8')); } catch { /* reported below */ }
check('vscode export keeps the fixture session',
  !!vscodeJson && vscodeJson.length === 1 && vscodeJson[0].sessionId === 'fixture-session' && vscodeJson[0].requests.length === 1,
  vscodeJson ? JSON.stringify(vscodeJson[0]).slice(0, 120) : 'missing');

try {
  const { DatabaseSync } = await import('node:sqlite');
  const dbDir = join(root, 'mimo-db');
  mkdirSync(dbDir, { recursive: true });
  const rc = new DatabaseSync(join(dbDir, 'rolechat.db'));
  rc.exec('create table role_chat_record (updated_at text, session_id text, name text, purpose text, workspace text, task text, task_status text)');
  rc.prepare('insert into role_chat_record values (?,?,?,?,?,?,?)').run('2020-01-01 00:00:00', 's1', 'fixture-task', 'purpose', 'workspace', 'task', 'done');
  rc.close();
  const ar = new DatabaseSync(join(dbDir, 'artifacts.db'));
  ar.exec('create table artifact (created_at text, session_id text, kind text, role text, title text, local_path text)');
  ar.prepare('insert into artifact values (?,?,?,?,?,?)').run('2020-01-01 00:00:00', 's1', 'file', 'output', 'fixture-artifact', 'C:/fixture/out.txt');
  ar.close();
  const mimoOut = join(root, 'mimo-out');
  run('export MiMo records (fixture)', 'export-mimo.mjs', ['--db-dir', dbDir, '--out', mimoOut, '--skip-git']);
  const roleText = readFileSync(join(mimoOut, '开发事务.md'), 'utf8');
  const artText = readFileSync(join(mimoOut, '产物清单.md'), 'utf8');
  check('mimo export keeps the fixture rows', roleText.includes('fixture-task') && artText.includes('fixture-artifact'), 'rolechat + artifacts markdown written');
} catch (e) {
  console.log('SKIP  MiMo export smoke test (node:sqlite unavailable: ' + String(e.message || e) + ')');
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log('RESULT: ' + (failed.length === 0 ? 'PASS' : 'FAIL') + '  (' + (results.length - failed.length) + '/' + results.length + ' checks)');
if (failed.length) for (const f of failed) console.log('  failed: ' + f.label);

if (args.keep) console.log('kept temp root: ' + root);
else rmSync(root, { recursive: true, force: true });

process.exit(failed.length === 0 ? 0 : 1);
