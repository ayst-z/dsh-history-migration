// demo/live/validate-all.mjs
// Run the real DSH loader over every session in a throw-away home, one by one,
// through scripts/verify-dsh-session.mjs --run-dsh. Prints one verdict per
// session plus a summary; --quiet keeps only failures + the summary.
//
// Usage: node live/validate-all.mjs --home <DSH home> --dsh <dsh launcher> [--quiet]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSessions, parseCli } from '../../scripts/lib/dsh-session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const args = parseCli(process.argv.slice(2));
const home = args.home && args.home !== true ? args.home : null;
const dsh = args.dsh && args.dsh !== true ? args.dsh : null;
const quiet = args.quiet === true;
if (!home || !dsh) { console.error('usage: validate-all.mjs --home <DSH home> --dsh <dsh launcher> [--quiet]'); process.exit(2); }

const sessions = findSessions(home).sort((a, b) => a.id.localeCompare(b.id));
let pass = 0, fail = 0;
for (const s of sessions) {
  const short = 'session-...-' + s.id.slice(-3);
  const r = spawnSync(process.execPath, [
    join(repo, 'scripts', 'verify-dsh-session.mjs'),
    '--in', s.file, '--home', home, '--session-id', s.id,
    '--dsh', dsh, '--run-dsh', '--timeout-ms', '60000',
  ], { encoding: 'utf8', timeout: 120000 });
  const out = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/);
  const live = out.find((l) => l.includes('dsh live check')) || '';
  let verdict = 'unknown';
  if (/rejected \(format error\)/.test(live)) verdict = 'rejected (format error)';
  else if (/accepted \(format ok/.test(live)) verdict = 'accepted (format ok; preset not composed by one-shot runner)';
  else if (/accepted \(ran\)/.test(live)) verdict = 'accepted (ran)';
  const errMatch = live.match(/SessionFormatError:\s*([^(|]+)/);
  const detail = errMatch ? '  SessionFormatError: ' + errMatch[1].trim() : '';
  if (r.status === 0) { pass++; if (!quiet) console.log('[validate] ' + short + '  PASS  ' + verdict + detail); }
  else { fail++; console.log('[validate] ' + short + '  FAIL  ' + verdict + detail); }
}
console.log('[validate] sessions ' + sessions.length + ' | PASS ' + pass + ' | FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
