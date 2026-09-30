// demo/live/rebuild-with-assistant.mjs
// Rebuild every fixture session through the real scripts/build-dsh-session.mjs,
// now pairing each user message with an assistant/message that carries the
// 4-record settlement stream (R10). Keeps the same id/cwd/title so the loader
// looks at the same path.
//
// Usage: node live/rebuild-with-assistant.mjs --home <DSH home>
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSessions, parseCli, readSession } from '../../scripts/lib/dsh-session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const args = parseCli(process.argv.slice(2));
const home = args.home && args.home !== true ? args.home : null;
if (!home) { console.error('usage: rebuild-with-assistant.mjs --home <DSH home>'); process.exit(2); }

const sessions = findSessions(home).sort((a, b) => a.id.localeCompare(b.id));
const tmpJson = join(tmpdir(), 'dsh-demo-assistant-input.json');
let replies = 0;
console.log('[assistant] rebuild via scripts/build-dsh-session.mjs (R10 stream, 4 records)');
for (const s of sessions) {
  const { header, events } = readSession(s.file);
  const users = events.filter((e) => e.type === 'user/message');
  const title = events.find((e) => e.type === 'session/title');
  const input = users.map((u, i) => ({
    user: (u.data.content || []).map((c) => c.text || '').join(''),
    assistant: '（示例 AI 回复）已按第 ' + (i + 1) + ' 轮指令处理。',
  }));
  writeFileSync(tmpJson, JSON.stringify(input), 'utf8');
  const r = spawnSync(process.execPath, [
    join(repo, 'scripts', 'build-dsh-session.mjs'),
    '--home', home, '--cwd', header.cwd, '--id', header.id,
    '--input', tmpJson, '--title', title && title.data ? title.data.title : 'rebuilt session',
    '--time', String(header.createdAt),
  ], { encoding: 'utf8', timeout: 60000 });
  const out = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/);
  const line = out.find((l) => l.startsWith('messages:')) || ('rebuild failed (exit ' + r.status + ')');
  const short = s.id.replace(/^session-00000000-0000-4000-8000-0*/, '');
  console.log('[assistant] ' + short + '  ' + line);
  replies += input.length;
}
rmSync(tmpJson, { force: true });
console.log('[assistant] rebuilt ' + sessions.length + ' sessions, ' + replies + ' assistant/message events with compliant stream');
