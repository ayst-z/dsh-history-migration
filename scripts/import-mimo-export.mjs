#!/usr/bin/env node
// 把 mimo-export（https://github.com/yl985211/mimo-export, GPLv3）的导出产物转成
// build-dsh-session.mjs 可消费的 turns.json（[{user, assistant}]）。
//
// 自适应多种导出格式：
//   A. Markdown 标题式：# 标题 + ### 用户 / ### MiMo AI（脚本默认输出）
//   B. 粗体角色式：**用户** / **MiMo AI**（或 ## / #### 等级）
//   C. HTML 行式：<div class="message-row user-row|ai-row">…（脚本的 HTML 导出版）
//   D. 无角色标记：按 --- 分隔符交替 用户/助手
// 用法：node import-mimo-export.mjs <导出文件...> [--out <dir>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help')) { console.error('Usage: node import-mimo-export.mjs <export.md|html|txt> [...] [--out <dir>]'); process.exit(argv.includes('--help') ? 0 : 2); }
const oi = argv.indexOf('--out');
const outDir = oi >= 0 ? argv[oi + 1] : '.';
const files = argv.filter((a, i) => i !== oi && i !== oi + 1);
mkdirSync(outDir, { recursive: true });
const USER_RE = /(用户|提问|user|you|human|你)$/i;
const stripTags = (h) => h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
function pair(sections) {
  const turns = []; let cur = null;
  for (const s of sections) {
    if (USER_RE.test(s.role)) { if (cur) turns.push(cur); cur = { user: s.body, assistant: '' }; }
    else { if (!cur) cur = { user: '', assistant: '' }; cur.assistant = cur.assistant ? cur.assistant + '\n\n' + s.body : s.body; }
  }
  if (cur) turns.push(cur);
  return turns;
}
function parseHtml(text) {
  const sections = [];
  const re = /<div[^>]*class="[^"]*message-row[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*message-row|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const isUser = /user-row/.test(m[0].slice(0, m[0].indexOf('>')));
    sections.push({ role: isUser ? '用户' : 'MiMo AI', body: stripTags(m[1]) });
  }
  return sections;
}
function parseText(text) {
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : '';
  let sections = [];
  const markRe = /^(?:#{1,4}\s*|\*\*)\s*(.+?)\s*(?:\*\*)?\s*$/gm;
  const marks = []; let m;
  while ((m = markRe.exec(text)) !== null) {
    const role = m[1].trim();
    if (/^(用户|提问|user|you|human|你|mimo|mimo ai|助手|assistant|ai|model)$/i.test(role)) marks.push({ role, start: m.index + m[0].length });
  }
  if (marks.length >= 2) {
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
      const stop = i + 1 < marks.length ? marks[i + 1].start : text.length;
      let body = text.slice(marks[i].start, stop);
      if (i + 1 < marks.length) { const cut = body.lastIndexOf('#'); if (cut > 0 && /#/.test(text.slice(marks[i + 1].start - 30, marks[i + 1].start))) body = body.slice(0, body.lastIndexOf(String.fromCharCode(10))); }
      sections.push({ role: marks[i].role, body: body.replace(/^\s*-{3,}\s*$/gm, '').trim() });
    }
  } else {
    const blocks = text.split(/^\s*-{3,}\s*$/m).map(b => b.replace(/^#.*$/gm, '').trim()).filter(Boolean);
    sections = blocks.map((b, i) => ({ role: i % 2 === 0 ? '用户' : 'MiMo AI', body: b }));
  }
  return { title, sections };
}
let total = 0;
for (const f of files) {
  if (!existsSync(f)) { console.error('skip (not found): ' + f); continue; }
  const text = readFileSync(f, 'utf8');
  let title = '', sections = [];
  if (/message-row|class="[^"]*user-row/.test(text)) { const t = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i); title = t ? stripTags(t[1]) : ''; sections = parseHtml(text); }
  else { const r = parseText(text); title = r.title; sections = r.sections; }
  const turns = pair(sections).filter(t => t.user.trim() || t.assistant.trim());
  const out = join(outDir, basename(f).replace(/\.[^.]+$/, '') + '.turns.json');
  writeFileSync(out, JSON.stringify(turns, null, 2));
  total += turns.length;
  console.error('parsed ' + basename(f) + ' | title="' + title + '" | turns=' + turns.length + ' (assistant=' + turns.filter(t => t.assistant.trim()).length + ') -> ' + out);
  console.log(JSON.stringify({ file: f, title, out, turns: turns.length }));
}
console.error('total turns: ' + total);