# dsh-history-migration

把**外部平台的对话历史**迁移进 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（DSH）的一套**可迁移技能 + 工具链**。

> GitHub 话题：`dsh-plugin` ｜ 许可：MIT ｜ 依赖：Node 24+（无需第三方包）

## 功能

| 能力 | 说明 |
|---|---|
| **三条来源** | ① VS Code Copilot Chat 本地 `chatSessions`（最完整，含 AI 回复）② MiMo Studio 桌面版（文件快照 / 产物 / 任务卡 / 日志元数据）③ MiMo AI Studio 网页版（userscript 导出，拿到正文的唯一路径） |
| **抽取 → 生成 → 登记 → 校验** | 一条流水线把任意来源变成 DSH 可打开的会话 |
| **自带校验器** | `dsh headless --session-id <id>` 即可判定格式，不依赖 UI |
| **自带隐私扫描器** | `privacy-scan.mjs` 交付前一键自查（真实用户名/路径/会话 id/密钥） |
| **格式自适应导入** | `import-mimo-export.mjs` 自动识别 4 种导出排版 |
| **顺带扩展 DSH 模型** | `mimo/` 提供 MiMo 提供商补丁（端点 / 协议 / 模型齐备，**密钥留空**） |
| **演示录像** | `demo/demo.mp4`：115 秒，原理 + 真实实测 |

## 快速开始

```powershell
# 0) 抽取
node scripts/export-vscode-chat.mjs <chatSessions 目录> out/            # VS Code
node scripts/import-mimo-export.mjs <mimo导出.md> --out out/            # MiMo 网页导出（自适应 4 种格式）

# 1) 生成 DSH 会话（out/ 里是 [{user, assistant}] 的 turns.json）
node scripts/build-dsh-session.mjs --home "$env:USERPROFILE\.dsh" --cwd "<工作区路径>" \
     --title "<标题>" --input out/turns.json

# 2) 登记侧栏缓存
node scripts/generate-dsh-cache.mjs --home "$env:USERPROFILE\.dsh" --session <session-id>

# 3) 校验（报 “agent preset … does not compose” = 格式已通过）
node scripts/verify-dsh-session.mjs --in <session.v4.jsonl.zstd> --require-cache --run-dsh --dsh <dsh 启动器>
```

## 设计：四步流水线

| 步骤 | 脚本 | 产出 |
|---|---|---|
| 抽取 | `export-vscode-chat.mjs` / `import-mimo-export.mjs` / `export-mimo.mjs` | `turns.json`、`vscode-sessions.json`、MiMo 三份 Markdown |
| 生成 | `build-dsh-session.mjs` | `session.v4.jsonl.zstd`（首帧仅 header、每事件一帧、seq 连续、逐轮 turn 配对） |
| 登记 | `generate-dsh-cache.mjs` + 手改 `workspace.json` 的 `sessionIds` | 侧栏可见 |
| 校验 | `verify-dsh-session.mjs` / `list-dsh-sessions.mjs` / `selftest.mjs` | PASS / FAIL |

## DSH 会话格式：9 条硬性要求

| # | 要求 | 违反时报错 |
|---|---|---|
| R1 | `header.cwd` 与工作区规范路径逐字符相等（Windows 用反斜杠） | UI 显示「工作文件夹未分组」 |
| R2 | session id 必须写进该工作区 `workspace.json` 的 `sessionIds` | 会话不归属任何工作区 |
| R3 | **首帧恰好只装 header 一行**，其后每事件一帧 | `first frame is not exactly one header line` |
| R4 | `seq` 从 0 连续递增 | `has seq gap (expected n, got m)` |
| R5 | `assistant/message` 必须带完整模型流 `stream`（最小形态：`block-start → text-delta → block-end → finish`） | `invalid settlement fields` |
| R6 | 事件 source 形状合法（模型来源需 `kind/provider/model`） | `message must have model source` |
| R7 | 必须有投影缓存 `storages/session_projcache/sessions/<id>.json`（version 7） | 侧栏看不到该会话 |
| R8 | `agentPreset` 要在目标 profile 组装范围内（headless 不组装 `standard`） | `runs under agent preset … not composed` |
| R9 | **每轮自成一对** `turn/start … turn/end`，`turn` 递增 | `turn/start does not open the expected turn` |

## 可扩展性

1. **接新来源**：只要产出 `[{user, assistant}]` 的 `turns.json` 即可接入流水线。参照 `import-mimo-export.mjs`——它是纯解析器，加一种排版只需加一个 `parseXxx()`。
2. **加新检查**：`verify-dsh-session.mjs` 与 `selftest.mjs` 的检查项都是独立断言，照抄一条即可扩展（例如「必须带 tool/result 配对」）。
3. **接新模型提供商**：`mimo/cordis.patch.yml` 是模板，改 `providers.<id>` 的 `baseURL` / `api` / `models` 就能接任意 OpenAI 兼容端点；DSH 侧落在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。
4. **换目标环境**：所有脚本的 `--home` / `--cwd` / `--dsh` 全部参数化，不写死路径，可在 CI 或别的机器上跑。
5. **共享库**：`scripts/lib/dsh-session.mjs` 封装 zstd 帧分割/编码、工作区目录编码、参数解析，被所有脚本复用——扩功能优先改库，而不是复制代码。

## 目录

| 路径 | 内容 |
|---|---|
| `SKILL.md` / `SKILL-single.md` | 技能本体（单文件版可直接丢进 skills 目录） |
| `references/dsh-session-format.md` | DSH 会话存储格式参考 |
| `scripts/` | 工具链 + 共享库 + selftest（见其 README） |
| `mimo/` | 给 DSH 加 MiMo 提供商（密钥留空） |
| `demo/` | 演示片、分镜、可复跑渲染脚本、真实运行的 captured/ |
| `privacy-scan.mjs` | 交付前隐私扫描 |
| `项目说明.md` | 迁移范围、不能迁移的边界、事故教训 |

## 演示

`demo/demo.mp4` —— 115 秒 1080p30：原理 6 屏 + 实测 6 屏 + 收尾。实测段是现场真跑：**8 条坏 → 修好 → 9/9 通过 → 补 AI 回复 → 仍 9/9 通过**，并附 `selftest 19/19`、`verify 11 checks`、`privacy hits 0`。可用 `demo/render.ps1` 复跑重制。

## 隐私与安全

- 仓库只保留**可迁移规律**：真实用户名、本机绝对路径、真实会话 id、密钥一律用 `<DSH_HOME>` / `<workspace>` / `<session-id>` 占位；
- `$DSH_HOME/.credentials.yaml` 永不复制、永不上传；
- 交付前：`node privacy-scan.mjs .` → **0 命中**才推；
- 演示片录制时统一脱敏（用户名→`<workspace>`、临时目录→`<tmp>`、启动器→`<cli>`、真实 id→`session-<id>`）。

## 许可

MIT。