#!/usr/bin/env node
// List DSH sessions stored under a DSH home.
//
// Usage:
//   node list-dsh-sessions.mjs --home <DSH_HOME> [--cwd <workspace path>] [--json] [--all-workspaces]
//
// Reads only session headers/events; nothing is written.

import { findSessions, parseCli, readSession } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));

function usage() {
  console.error('Usage: node list-dsh-sessions.mjs --home <DSH_HOME> [--cwd <workspace path>] [--json] [--all-workspaces]');
}

if (args.help || !args.home) {
  usage();
  process.exit(args.help ? 0 : 2);
}

const rows = [];
for (const found of findSessions(args.home)) {
  let s;
  try { s = readSession(found.file); } catch (e) {
    rows.push({ id: found.id, file: found.file, error: String(e.message || e) });
    continue;
  }
  const header = s.header || {};
  if (args.cwd && header.cwd !== args.cwd) continue;
  const titleEvent = s.events.find((e) => e && e.type === 'session/title');
  let lastPromptAt = null;
  let users = 0;
  let turns = 0;
  for (const e of s.events) {
    if (e && e.type === 'user/message') {
      users++;
      if (typeof e.time === 'number' && (lastPromptAt === null || e.time > lastPromptAt)) lastPromptAt = e.time;
    }
    if (e && e.type === 'turn/start') turns++;
  }
  rows.push({
    id: header.id || found.id,
    workspaceDir: found.workspaceDir,
    cwd: header.cwd || null,
    title: titleEvent && titleEvent.data ? titleEvent.data.title : null,
    createdAt: header.createdAt || null,
    lastPromptAt,
    agentPreset: header.agentPreset || null,
    turns,
    users,
    events: s.events.length,
    frames: s.frames.length,
    bytes: s.bytes,
    file: found.file,
    errors: s.errors,
  });
}

rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('sessions: ' + rows.length);
  for (const r of rows) {
    const when = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '?';
    console.log(
      when + '  ' + String(r.events).padStart(5) + 'ev  ' + String(r.users).padStart(4) + 'msg  ' +
      (r.id || '?') + '  ' + JSON.stringify(r.title) + '  cwd=' + r.cwd,
    );
  }
}
