---
name: history-migration-to-dsh
description: 把外部平台的历史对话迁移进 DeepSeek Harness（DSH）。覆盖三条来源路径——VS Code Copilot Chat 本地 chatSessions（可完整导出，含 AI 回复）、MiMo Studio 桌面版（本地只有文件快照/产物/任务卡与日志元数据，对话正文本地不落地）、MiMo AI Studio 网页版（用 userscript 导出，是拿到 MiMo 正文的唯一路径）——以及 DSH 会话日志的全部硬性格式要求、校验器用法与失败对照。当用户提到 迁移对话历史、导入会话到 DSH、跨平台记录、VS Code/MiMo 历史、把旧对话变成 DSH 会话、history migration 时使用。
---

# 外部对话历史 → DSH 迁移（单文件技能）

## 核心事实

DSH 的会话是**仅追加事件日志**：`$DSH_HOME/sessions/<工作区编码>/session-<id>/session.v4.jsonl.zstd`（每个事件一个 zstd 帧）。它**不是聊天记录的转储**，而是可回放的模型交互日志——所以「导入」= 造出合法事件序列，且必须同时满足账本与投影缓存两处登记。

## 三条来源路径

| 来源 | 本地能拿到什么 | 结论 |
|---|---|---|
| **VS Code Copilot Chat** | `%APPDATA%\Code\User\workspaceStorage\<ws>\chatSessions\*.jsonl`：请求/回复全文、thinking、toolInvocationSerialized、textEditGroup（代码）| ✅ 可完整迁移（含 AI 回复） |
| **MiMo Studio 桌面版** | `git-version-store`（文件快照 66 次）、`db\artifacts.db`(365)、`db\rolechat.db`(8)、`logs\*.log`（只有 sessionId/assistantId 等元数据）；`evolve-transcript.db` **0 行** | ⚠️ 对话正文**本地不落地**（在服务端）。只能迁旁证 + 从日志统计出会话清单 |
| **MiMo AI Studio 网页版** | 页面 DOM | ✅ 用 userscript `yl985211/mimo-export`（GPLv3）导出 HTML/MD/TXT；`scripts/import-mimo-export.mjs` **自适应四种格式**（`###` 标题式 / `**角色**` 粗体式 / HTML `message-row` 式 / 无标记按 `---` 交替），产出 turns.json 直接喂给 builder |

## DSH 会话格式：10 条硬性要求

| # | 要求 | 违反时的报错 |
|---|---|---|
| R1 | `header.cwd` 与工作区**规范路径逐字符相等**（Windows 用反斜杠） | 侧栏「工作文件夹未分组」 |
| R2 | session id 必须在该工作区 `workspace.json` 的 `sessionIds` 里 | 会话不归属任何工作区 |
| R3 | **第一个 zstd 帧只装 header 一行**，其后每个事件一帧 | `first frame is not exactly one header line` |
| R4 | `seq` 从 0 连续递增 | `has seq gap (expected n, got m)` |
| R5 | `assistant/message` 必须带完整模型流 `stream` | `invalid settlement fields` |
| R6 | 事件 source 形状合法（模型来源需 kind/provider/model） | `message must have model source` |
| R7 | 必须有投影缓存 `storages/session_projcache/sessions/<id>.json`（version 7） | 侧栏看不到 |
| R8 | `agentPreset` 要在目标 profile 组装范围内（headless 不组装 standard） | `runs under agent preset … not composed` |
| R9 | **每轮自成一对** `turn/start … turn/end`，`turn` 递增 | `turn/start does not open the expected turn` |
| R10 | `assistant/message` 的 `stream` 已实测的最小形态：`block-start → text-delta → block-end(tool-call 可选) → finish` | 同上 |

## 最小流程

```bash
node scripts/export-vscode-chat.mjs <chatSessions 目录> out/          # 抽 VS Code 原始会话
node scripts/import-mimo-export.mjs <mimo导出.md> --out out/          # 抽 MiMo 网页导出（mimo-export 产物 → turns.json）
node scripts/build-dsh-session.mjs --home "$DSH_HOME" --cwd "<工作区>" \
     --title "<标题>" --input turns.json                              # turns.json = [{user, assistant}]
node scripts/generate-dsh-cache.mjs --home "$DSH_HOME" --session <id> # 补投影缓存
"$DSH_INSTALL/resources/runtime/cli/bin/dsh.cmd" headless --session-id <id> x   # 校验器
```

**校验判读**：只报 `agent preset … does not compose` = **格式已通过**；报 `corrupt / seq gap / must have / expected` = 真失败。

## 失败对照

| 现象 | 根因 | 修复 |
|---|---|---|
| 未分组 | cwd 形式不对（正斜杠/双反斜杠） | R1 |
| 列表里没有 | 缺账本或缺缓存 | R2 / R7 |
| first frame … | 整段压成一帧 | R3 |
| seq gap | 删改事件后没重编号 | R4 |
| invalid settlement | assistant 少了 stream | R5 / R10 |
| 多轮才报错 | 每轮没配对 turn/end | R9 |

## 迁移纪律（血泪版）

1. **一次导入 ≥2 条时逐条过校验器**——单轮样本通过不代表多轮通过。
2. **批处理脚本里，清理旧文件只能删「已知的旧路径」**，不要遍历删除「所有可能目录」——本仓库作者就因此误删了一个 9200 行的原生会话。
3. 上传/交付前跑隐私扫描：真实用户名、本机路径、真实会话 id、密钥一律占位。

## 边界

- **不能**迁：MiMo 桌面版的对话正文（本地不存在）、VS Code 的模型原始工具入参（只存渲染后的 invocationMessage）、真正的 diff（textEditGroup 只有新文本）。
- **可近似迁**：工具调用与代码写入（建议折叠成正文里的 `▸ 名称(参数)` + 代码块，零校验风险）。
