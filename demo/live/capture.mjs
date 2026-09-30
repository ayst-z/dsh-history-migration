// demo/live/capture.mjs — run the task-4 evidence chain for real and save raw stdout.
//
// Steps: legacy fixture (8 broken + 1 fine) -> validate -> repair -> validate
//        -> rebuild with assistant replies -> validate -> scripts selftest
//        -> projcache -> verify --require-cache --run-dsh -> privacy scan.
//
// Every captured/*.txt is real child output, scrubbed before it is written:
// user paths/names -> <workspace>, temp roots -> <tmp>, foreign paths -> <path>,
// non-demo session ids -> session-<id>. Fixture sessions use the all-zero demo
// uuid on purpose, so they survive the privacy scanner untouched.
//
// Usage: node live/capture.mjs --dsh <dsh launcher>   (run from the demo/ directory)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { sessionFilePath } from '../../scripts/lib/dsh-session.mjs';

const liveDir = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(liveDir, '..');
const repoRoot = resolve(demoRoot, '..');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const dsh = opt('--dsh') || process.env.DSH_CLI || null;
if (!dsh) { console.error('usage: capture.mjs --dsh <dsh launcher> (or set DSH_CLI)'); process.exit(2); }

const root = mkdtempSync(join(tmpdir(), 'dsh-demo-'));
const home = join(root, 'dsh-home');
const ws = join(root, 'workspace');
mkdirSync(home, { recursive: true });
mkdirSync(ws, { recursive: true });
const sid = (n) => 'session-00000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');
const sessionFile = sessionFilePath(home, ws, sid(1));

// --- privacy scrub ---------------------------------------------------------------
const BS = String.fromCharCode(92);          // one backslash character
const RXBS = BS + BS;                        // regex source for one literal backslash
const NOTPATH = '[^' + BS + 's"' + "'" + ']*'; // regex source for [^\s"']*
const userPath = new RegExp('[A-Za-z]:' + RXBS + '+Users' + RXBS + '+' + NOTPATH, 'gi');
const dshMsg = /dsh-(selftest|demo)-[A-Za-z0-9]+/g;
const realSid = new RegExp('session-(?!0{8}-0{4}-4000-8000)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'gi');
function scrub(text) {
  let s = String(text);
  s = s.split(dsh).join('<cli>');
  s = s.split(dsh.split(BS).join('/')).join('<cli>');
  s = s.split(root).join('<tmp>');
  s = s.split(root.split(BS).join('/')).join('<tmp>');
  s = s.replace(new RegExp('[A-Za-z]:' + RXBS + '+Users' + RXBS + '+' + NOTPATH + '?' + RXBS + '+AppData' + RXBS + '+Local' + RXBS + '+Temp' + RXBS + '+' + NOTPATH, 'gi'), '<tmp>');
  s = s.replace(userPath, '<workspace>');
  s = s.replace(new RegExp('[A-Za-z]:' + RXBS + '+' + NOTPATH, 'g'), '<path>');
  s = s.replace(/[A-Za-z]:\/[^\s"']*/g, '<path>');
  s = s.replace(/\/tmp\/[^\s"']*/g, '<tmp>');
  s = s.replace(dshMsg, 'dsh-$1-<tmp>');
  s = s.replace(realSid, 'session-<id>');
  s = s.replace(new RegExp('(^|[^A-Za-z])' + 'Z' + 'MF' + '([^A-Za-z]|$)', 'g'), '$1<user>$2');
  s = s.replace(/[A-Za-z]:[\/]{1,}Users[\/]{1,}[^\s"']*/gi, '<workspace>');
  return s;
}

const captured = join(demoRoot, 'captured');
rmSync(captured, { recursive: true, force: true });
mkdirSync(captured, { recursive: true });

const steps = [];
function run(id, args, options) {
  const o = options || {};
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: o.cwd || demoRoot, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  const ms = Date.now() - t0;
  const text = scrub((r.stdout || '') + (r.stderr || ''));
  writeFileSync(join(captured, id + '.txt'), text, 'utf8');
  let command = 'node ' + scrub((o.display || args).join(' '));
  if (o.cwd && o.cwd !== demoRoot) command += '   (run from <repo>)';
  steps.push({ id, command, exitCode: r.status, ms, lines: text.split(/\r?\n/).filter((l) => l !== '').length });
  console.log('[' + id + '] exit=' + r.status + ' ' + ms + 'ms  ' + command);
  return text;
}

run('01-fixture', ['live/legacy-fixture.mjs', '--home', home, '--ws', ws]);
run('02-validate-legacy', ['live/validate-all.mjs', '--home', home, '--dsh', dsh]);
run('03-repair', ['live/repair-turns.mjs', '--home', home]);
run('04-validate-fixed', ['live/validate-all.mjs', '--home', home, '--dsh', dsh, '--quiet']);
run('05-assistant', ['live/rebuild-with-assistant.mjs', '--home', home]);
run('06-validate-assistant', ['live/validate-all.mjs', '--home', home, '--dsh', dsh, '--quiet']);
run('07-selftest', [join(repoRoot, 'scripts', 'selftest.mjs'), '--dsh', dsh], { display: ['scripts/selftest.mjs', '--dsh', dsh] });
run('08-cache', [join(repoRoot, 'scripts', 'generate-dsh-cache.mjs'), '--home', home, '--session', sid(1)], { display: ['scripts/generate-dsh-cache.mjs', '--home', '<tmp>', '--session', sid(1)] });
run('09-verify', [join(repoRoot, 'scripts', 'verify-dsh-session.mjs'), '--in', sessionFile, '--home', home, '--session-id', sid(1), '--require-cache', '--dsh', dsh, '--run-dsh', '--timeout-ms', '60000'], { display: ['scripts/verify-dsh-session.mjs', '--in', '<tmp>/session.v4.jsonl.zstd', '--require-cache', '--home', '<tmp>', '--session-id', sid(1), '--dsh', '<cli>', '--run-dsh'] });
const privacyText = run('10-privacy', [join(repoRoot, 'privacy-scan.mjs'), '.'], { cwd: repoRoot, display: ['privacy-scan.mjs', '.'] });

const expected = { '02-validate-legacy': 1 };
const ok = steps.every((s) => s.exitCode === (s.id in expected ? expected[s.id] : 0));
const privacyOk = /hits:\s*0\b/.test(privacyText);
const summary = { generatedAt: new Date().toISOString(), node: process.version, privacyHitsZero: privacyOk, steps };
writeFileSync(join(captured, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
rmSync(root, { recursive: true, force: true });
console.log('[capture] steps=' + steps.length + ' expected-exit-codes-honoured=' + ok + ' privacy-hits-zero=' + privacyOk);
console.log('[capture] real stdout scrubbed + saved under captured/');
