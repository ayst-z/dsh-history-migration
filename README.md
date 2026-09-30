# dsh-history-migration

把 **MiMo Studio / VS Code Copilot Chat 的历史对话**迁移进 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的一套**可迁移技能 + 工具链**。

> 主题标签：`dsh-plugin`

## 它解决什么

DSH 的会话是 `$DSH_HOME/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd`，官方文档没有「导入外部会话」这一节。把别的平台的对话搬进来，踩点全在格式上——本仓库把这套经验固化下来：

1. **抽取**：从 VS Code Copilot Chat 的 `chatSessions/*.jsonl` 与 MiMo Studio 的 `git-version-store` / SQLite 库里把对话与产物导出成结构化数据；
2. **生成**：按 DSH 的事件日志格式造出合法会话（首帧仅 header、每事件一帧、seq 连续）；
3. **登记**：写入工作区账本 `workspace.json` 并补一条投影缓存 `session_projcache/sessions/<id>.json`，会话才会出现在侧栏；
4. **校验**：用 `dsh headless --session-id <id>` 当校验器，不依赖 UI。

## 目录

| 路径 | 内容 |
|---|---|
| [SKILL.md](SKILL.md) | 技能本体（何时使用、流程、8 条硬性要求、失败模式） |
| [references/dsh-session-format.md](references/dsh-session-format.md) | DSH 会话存储格式参考 |
| `scripts/` | 可复用工具链（导出 → 生成 → 校验），见其 README |
| `mimo/` | 顺带给 DSH 加 MiMo 提供商的补丁（**密钥留空**） |
| `demo/` | 原理 + 实测演示视频与渲染脚本 |
| [privacy-scan.mjs](privacy-scan.mjs) | 上传前的隐私扫描器 |

## 8 条硬性要求（摘要）

| # | 要求 | 违反时报错 |
|---|---|---|
| R1 | 工作区路径与 `header.cwd` 逐字符相等（单反斜杠） | UI 显示「工作文件夹未分组」 |
| R2 | session id 必须写进该工作区的 `sessionIds` | 会话不归属任何工作区 |
| R3 | **首帧恰好只装 header 一行**，其后每事件一帧 | `first frame is not exactly one header line` |
| R4 | `seq` 从 0 连续递增 | `has seq gap (expected n, got m)` |
| R5 | `assistant/message` 必须带完整模型流 `stream` | `invalid settlement fields` |
| R6 | 事件 source 形状合法（模型来源要有 kind/provider/model） | `message must have model source` |
| R7 | 补 `session_projcache/sessions/<id>.json` | 侧栏看不到该会话 |
| R8 | `agentPreset` 在目标 profile 的组装范围内 | `runs under agent preset … not composed` |
| R9 | 每一轮自成一对 `turn/start` → `turn/end`，`turn` 递增 | `turn/start does not open the expected turn` |
| R10 | `assistant/message` 要带 `source{kind,provider,model}` + 完整 `stream` | `must have model source` / `invalid settlement fields` |

## 快速开始

`~powershell
node scripts/export-vscode-chat.mjs <chatSessions 目录> out/
node scripts/build-dsh-session.mjs out/ --cwd '<workspace>' --title '<标题>'
node scripts/generate-dsh-cache.mjs --session <session-id>
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" headless --session-id <session-id> "ok"   # 格式校验器
`~

详见 [SKILL.md](SKILL.md) 与 `scripts/README.md`。

## 隐私

- 仓库内只保留**可迁移规律**：真实用户名、本机绝对路径、真实会话 id、密钥一律用 `<DSH_HOME>` / `<workspace>` / `<session-id>` 占位符；
- `$DSH_HOME/.credentials.yaml` 永不复制、永不上传；
- 上传前跑：`node privacy-scan.mjs .`（0 命中才推）。

## 许可

MIT
