#!/usr/bin/env node
// Export MiMo Studio history: git version-store commits, rolechat.db transactions,
// and artifacts.db inventory. Node 24's built-in node:sqlite is used, so Python is
// not required.
//
// Usage:
//   node export-mimo.mjs --store <git-version-store dir> --db-dir <dir with rolechat.db + artifacts.db>
//        --out <outDir> [--skip-git] [--skip-db]
//
// Outputs (UTF-8 Markdown):
//   <outDir>/版本库提交记录.md   git log of the version-store repository
//   <outDir>/开发事务.md         role_chat_record rows
//   <outDir>/产物清单.md         artifact rows
//
// All paths are command-line arguments; no machine-specific path is embedded.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCli } from './lib/dsh-session.mjs';

const args = parseCli(process.argv.slice(2));

function usage() {
  console.error('Usage: node export-mimo.mjs --store <git-version-store dir> --db-dir <dir> --out <outDir> [--skip-git] [--skip-db]');
}

if (args.help || (!args.store && !args.skipGit) || !args.out) {
  usage();
  process.exit(args.help ? 0 : 2);
}

const outDir = args.out;
mkdirSync(outDir, { recursive: true });

const cell = (v, max = 150) => (v === null || v === undefined ? '' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, max));
const has = (flag) => flag === true;

if (!has(args.skipGit)) {
  if (!args.store || args.store === true) {
    console.error('error: --store is required unless --skip-git is given');
    process.exit(2);
  }
  let log = '';
  try {
    log = execFileSync('git', ['-C', args.store, 'log', '--date=iso', '--pretty=format:%h|%ad|%s%n%b%n---GITLOG---'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.error('error: git log failed: ' + String(e.message || e));
    process.exit(1);
  }
  const lines = ['# MiMo Studio 版本库提交记录', '', '> 来源：--store 指定的 git-version-store（每次提交即一份「present: 文件 (+N source)」快照）。', ''];
  for (const raw of log.split('---GITLOG---')) {
    const block = raw.trim();
    if (!block) continue;
    const [head, ...rest] = block.split(/\r?\n/);
    const parts = head.split('|');
    if (parts.length < 3) continue;
    const [hash, date, subject] = [parts[0], parts[1], parts.slice(2).join('|')];
    lines.push('## ' + date + '  ' + hash, '', subject, '');
    const body = rest.join('\n').trim();
    if (body) lines.push(body, '');
  }
  writeFileSync(join(outDir, '版本库提交记录.md'), lines.join('\n'), 'utf8');
  console.log('written: ' + join(outDir, '版本库提交记录.md'));
}

if (!has(args.skipDb)) {
  if (!args.dbDir || args.dbDir === true) {
    console.error('error: --db-dir is required unless --skip-db is given');
    process.exit(2);
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (e) {
    console.error('error: node:sqlite is unavailable in this Node runtime: ' + String(e.message || e));
    process.exit(1);
  }
  const open = (name) => new DatabaseSync(join(args.dbDir, name), { readOnly: true });

  const rolechat = open('rolechat.db');
  const roles = rolechat.prepare('select updated_at, session_id, name, purpose, workspace, task, task_status from role_chat_record order by updated_at').all();
  rolechat.close();
  const roleLines = ['# MiMo Studio 开发事务（rolechat.db）', '', '| 时间 | session | 名称 | 用途 | 工作区 | 任务 | 状态 |', '|---|---|---|---|---|---|---|'];
  for (const r of roles) {
    roleLines.push('| ' + [r.updated_at, r.session_id, r.name, r.purpose, r.workspace, r.task, r.task_status].map((v) => cell(v, 120)).join(' | ') + ' |');
  }
  writeFileSync(join(outDir, '开发事务.md'), roleLines.join('\n'), 'utf8');

  const artifacts = open('artifacts.db');
  const arts = artifacts.prepare('select created_at, session_id, kind, role, title, local_path from artifact order by created_at').all();
  artifacts.close();
  const artLines = ['# MiMo Studio 产物清单（artifacts.db，共 ' + arts.length + ' 项）', '', '| 时间 | session | 类型 | 角色 | 标题 | 本地路径 |', '|---|---|---|---|---|---|'];
  for (const a of arts) {
    artLines.push('| ' + [a.created_at, a.session_id, a.kind, a.role, a.title, a.local_path].map((v) => cell(v)).join(' | ') + ' |');
  }
  writeFileSync(join(outDir, '产物清单.md'), artLines.join('\n'), 'utf8');

  console.log('rolechat rows: ' + roles.length);
  console.log('artifacts:     ' + arts.length);
  for (const r of roles) console.log('  ' + cell(r.updated_at, 30) + ' | ' + cell(r.name, 40) + ' | ' + cell(r.workspace, 40));
  console.log('written: ' + join(outDir, '开发事务.md'));
  console.log('written: ' + join(outDir, '产物清单.md'));
}
