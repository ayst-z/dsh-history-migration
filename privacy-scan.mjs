import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
const root = process.argv[2] || '.';
const TEXT = new Set(['.md','.mjs','.js','.py','.ps1','.yml','.yaml','.json','.txt','.ts','.sh','.csv']);
const BS = String.fromCharCode(92);
const rules = [
  [new RegExp('[A-Za-z]:' + BS + BS + 'Users' + BS + BS + '(?!<)', 'i'), '绝对用户路径'],
  [new RegExp(BS + 'bZMF' + BS + 'b'), '本机用户名'],
  [/session-(?!0{8}-0{4}-4000-8000)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, '疑似真实会话 id'],
  [/(sk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]{12,})/, '疑似密钥'],
  [/(apiKey|api_key|secret|password)\s*[:=]\s*['\"]?[A-Za-z0-9._-]{16,}/i, '疑似硬编码凭据'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '邮箱'],
  [/微信图片|南京、滁州|常州地铁规划图|新建 文本文档/, '个人内容'],
  [/ayst-z/, 'GitHub 账号名'],
];
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (['node_modules','.git'].includes(e.name) ? [] : walk(join(d, e.name))) : [join(d, e.name)]);
let files = 0, hits = 0;
for (const f of walk(root)) {
  if (f.endsWith('privacy-scan.mjs')) continue;
  if (!TEXT.has(extname(f).toLowerCase())) continue;
  files++;
  readFileSync(f, 'utf8').split(String.fromCharCode(10)).forEach((line, i) => {
    for (const [re, name] of rules) if (re.test(line)) { hits++; console.log(f.replace(root, '.'), ':' + (i+1), '[' + name + ']', line.trim().slice(0, 100)); }
  });
}
console.log('---');
console.log('scanned:', files, 'files | hits:', hits);