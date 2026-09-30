#!/usr/bin/env node
// Generate the DSH session projection cache the sidebar reads:
//   <DSH_HOME>/storages/session_projcache/sessions/<session-id>.json
//
// The cache is version 7 and holds record.identity + record.rows. The row set below
// mirrors the projection rows a real DSH home ships; only rows that describe the
// imported session are computed, the rest keep neutral defaults.
//
// Usage:
//   node generate-dsh-cache.mjs --home <DSH_HOME> (--session <session-id> | --all)
//        [--template <projcache.json>] [--out <dir>] [--force] [--json]
//
//   --template  copy row defaults from an existing projcache file (recommended when
//               the target DSH version ships more rows than the built-in defaults).
//   --out       write elsewhere than <DSH_HOME>/storages/session_projcache/sessions.
//   --force     overwrite an existing cache entry (default: skip it).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSessions, parseCli, readSession } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));

function usage() {
  console.error('Usage: node generate-dsh-cache.mjs --home <DSH_HOME> (--session <id> | --all) [--template <file>] [--out <dir>] [--force] [--json]');
}

if (args.help || !args.home) {
  usage();
  process.exit(args.help ? 0 : 2);
}
if (!args.session && !args.all) {
  usage();
  process.exit(2);
}

const row = (val) => ({ ver: 1, seq: 0, val });

function defaultRows() {
  return {
    title: row(null),
    titleInput: row({ first: null, count: 0, lastSeq: null }),
    llmRetry: row({}),
    sandboxMode: row('workspace-write'),
    goal: row({ current: null, seenGoalIds: [], failure: null }),
    tokenUsage: row({ totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, last: null }),
    contextPressure: row({ surfaceTokens: 0 }),
    contextBreakdown: row({ nodes: [], breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } }),
    turnBoundary: row({ openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 }),
    inbox: row({ 'next-turn': [], 'next-step': [] }),
    sessionStats: row({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, lastTurn: null, openStep: null, pendingCalls: {} }),
    turnOutline: row({ turns: [], draft: '' }),
    agentPreset: row('standard'),
    userQuestions: row({ inheritedEventCount: 0, timed: false, questions: { active: [], settled: [] } }),
    subagentCatalog: row({ inheritedEventCount: 0 }),
    subagentTiming: row({ descriptorSeen: false, settledMs: 0 }),
    subagent: row({}),
    permissions: row({ preset: 'workspace-write', sandbox: 'workspace-write', approval: 'never', seeded: true }),
    todos: row(null),
    plan: row({ active: false, wanted: null, running: null, activeAtLastHeader: null }),
    subagentModelSelectionPolicy: row(null),
    modelSelection: row({ lastUsed: null, pending: null }),
    sessionListMetadata: row({ blank: true, lastPromptAt: null }),
    imageLimits: row(null),
    agentTeam: row({ id: '', members: [], tasks: [], messages: [], delivered: [], nextTaskNumber: 1 }),
    timeContext: row({ lastMessageTime: null, lastInjectionTime: null, lastTurnInjectionTime: null }),
  };
}

function baseRows() {
  const rows = defaultRows();
  if (args.template && args.template !== true) {
    const tpl = JSON.parse(readFileSync(args.template, 'utf8'));
    const tplRows = tpl && tpl.record && tpl.record.rows;
    if (tplRows && typeof tplRows === 'object') {
      for (const [key, value] of Object.entries(tplRows)) {
        if (value && typeof value === 'object' && 'val' in value) rows[key] = JSON.parse(JSON.stringify(value));
      }
    }
  }
  return rows;
}

const outDir = args.out && args.out !== true
  ? args.out
  : join(args.home, 'storages', 'session_projcache', 'sessions');
mkdirSync(outDir, { recursive: true });

const targets = args.all
  ? findSessions(args.home)
  : findSessions(args.home).filter((s) => s.id === args.session);

if (targets.length === 0) {
  console.error('error: no matching session found under ' + join(args.home, 'sessions'));
  process.exit(1);
}

const written = [];
for (const target of targets) {
  const s = readSession(target.file);
  const header = s.header;
  if (!header || !header.id) {
    console.error('skip (no header): ' + target.id);
    continue;
  }
  const outFile = join(outDir, header.id + '.json');
  if (!args.force) {
    try {
      readFileSync(outFile);
      console.log('skip (cache exists, use --force): ' + header.id);
      continue;
    } catch { /* not present: write it */ }
  }

  const titleEvent = s.events.find((e) => e && e.type === 'session/title');
  let maxSeq = -1;
  let firstUserSeq = null;
  let lastUserText = '';
  let users = 0;
  let turns = 0;
  let steps = 0;
  for (const e of s.events) {
    if (typeof e.seq === 'number' && e.seq > maxSeq) maxSeq = e.seq;
    if (e.type === 'turn/start') turns++;
    if (e.type === 'step/start') steps++;
    if (e.type === 'user/message') {
      users++;
      if (firstUserSeq === null) firstUserSeq = e.seq;
      const content = e.data && Array.isArray(e.data.content) ? e.data.content : [];
      const text = content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ');
      if (text) lastUserText = text;
    }
  }
  const title = titleEvent && titleEvent.data && titleEvent.data.title
    ? titleEvent.data.title
    : (lastUserText.slice(0, 40) || 'Imported session');
  const seq = maxSeq + 1;

  const rows = baseRows();
  for (const key of Object.keys(rows)) {
    if (rows[key] && typeof rows[key] === 'object' && 'seq' in rows[key]) rows[key].seq = seq;
  }
  rows.title.val = title;
  rows.titleInput.val = {
    first: { seq: firstUserSeq === null ? 0 : firstUserSeq, text: lastUserText.slice(0, 200) },
    count: users,
    lastSeq: seq,
  };
  rows.sessionListMetadata.val = { blank: users === 0, lastPromptAt: header.createdAt || null };
  rows.sessionStats.val = {
    ...(rows.sessionStats.val || {}),
    turns, steps, lastTurn: turns, openStep: null, pendingCalls: {},
  };
  rows.turnOutline.val = { turns: [], draft: '' };
  rows.turnBoundary.val = { openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: turns };
  rows.agentPreset.val = header.agentPreset || rows.agentPreset.val;
  rows.agentTeam.val = { ...(rows.agentTeam.val || {}), id: header.id, members: [], tasks: [], messages: [], delivered: [], nextTaskNumber: 1 };
  rows.sandboxMode.val = 'workspace-write';
  rows.permissions.val = { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'never', seeded: true };
  rows.modelSelection.val = { lastUsed: null, pending: null };
  rows.timeContext.val = { lastMessageTime: header.createdAt || null, lastInjectionTime: null, lastTurnInjectionTime: null };
  rows.contextPressure.val = { surfaceTokens: 0 };
  rows.inbox.val = { 'next-turn': [], 'next-step': [] };

  const record = {
    version: 7,
    record: {
      identity: {
        formatVersion: header.version || 4,
        createdAt: header.createdAt,
        cwd: header.cwd,
        isSeeded: !!header.isSeeded,
        inheritedEventCount: 0,
      },
      rows,
    },
  };
  writeFileSync(outFile, JSON.stringify(record, null, 2));
  written.push({ id: header.id, file: outFile, title, rows: Object.keys(rows).length });
  console.log('cache: ' + header.id + '  rows=' + Object.keys(rows).length + '  title=' + JSON.stringify(title));
}

if (args.json) console.log(JSON.stringify(written, null, 2));
console.log('cache entries written: ' + written.length);
