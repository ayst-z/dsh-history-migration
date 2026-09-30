# demo 分镜 —— DSH 历史迁移：原理 + 实测（task-4 版）

- 规格：1920x1080 / 30fps / H.264 (High) / yuv420p / 时长 115 秒 / 中文字幕
- 内容源：`content.json`（画面文案）+ `captured/*.txt`（**现场真实**终端输出）
- 旁白以底部字幕条呈现，无音轨
- 脱敏：捕获的真实输出先替换再画帧 / 落盘 —— 用户名与用户路径 → `<workspace>`，
  临时目录 → `<tmp>`，DSH 启动器路径 → `<cli>`，非 demo 会话 id → `session-<id>`

## 总览（13 屏）

| # | 分镜 | 类型 | 时长 | 画面内容 |
|---|---|---|---|---|
| 01 | 封面 | cover | 6s | 标题「把对话历史迁进 DSH / 一条条过校验器」 |
| 02 | 为什么要做 | list | 7s | 历史分散在 VS Code / MiMo，DSH 不兼容导出 |
| 03 | 迁移流水线 | flow | 8s | 抽取 → 生成 → 按帧压缩 → 校验 → 缓存 → 注册 |
| 04 | 磁盘格式 | code | 8s | `session.v4.jsonl.zstd`：header 独占帧 #0，事件各占一帧 |
| 05 | 硬性要求 1/2 | list | 8s | ① cwd ② sessionIds ③ session/title ④ seq 连续 |
| 06 | 硬性要求 2/2 | list | 8s | ⑤ 首帧只装 header ⑥ 逐轮配对 turn ⑦ 模型流 ⑧ projcache |
| 07 | 实测 1/6 复现旧导入 | terminal | 12s | 9 条旧布局：**8 FAIL / 1 PASS**，报 turn/start does not open the expected turn |
| 08 | 实测 2/6 修 R9 | terminal | 11s | 逐轮配对 turn/start → turn/end（turn 1..N）→ **9/9 PASS** |
| 09 | 实测 3/6 补 AI 回复 | terminal | 11s | assistant/message + 合规 stream → 仍然 **9/9 PASS** |
| 10 | 实测 4/6 技能自测 | terminal | 11s | `node scripts/selftest.mjs --dsh <cli>` → **RESULT: PASS (19/19 checks)** |
| 11 | 实测 5/6 技能校验器 | terminal | 10s | `verify-dsh-session.mjs --require-cache --run-dsh` → **RESULT: PASS (11 checks)** |
| 12 | 实测 6/6 隐私 | terminal | 8s | `node privacy-scan.mjs .` → **hits: 0** |
| 13 | 收尾 | list | 7s | 交付物清单与脱敏说明 |

合计 115 秒。

## 原理部分（6 屏）

### 01 封面（6s）
- 画面：大标题 + 副标题「原理 6 屏 + 实测 6 步 · 115 秒」+ 规格徽标
- 旁白：这次实测全部来自本机真实运行：旧布局会话、DSH 自带校验器、技能自测与隐私扫描。

### 02 为什么要做（7s）
- VS Code Copilot Chat：38 个会话 / 1270 轮对话
- MiMo Studio：66 次文件快照 / 365 项产物
- DSH 只认自己的一种会话格式，不兼容任何导出
- 目标：旧对话变成 DSH 能加载、侧栏能看到的会话

### 03 迁移流水线（8s）
- 6 个步骤方框：抽取源记录 → 生成事件流 → 按帧压缩 → 逐条校验 → 生成会话缓存 → 注册工作区
- 旁白：关键在中间三步：会话文件由 zstd 帧串成，格式不对 DSH 会直接拒绝加载。

### 04 磁盘格式（8s）
- 帧布局示意（frame #0 = header，其余事件各一帧），末行列出事件词汇
- 旁白：DSH 不把整段对话压成一帧：帧边界必须与行一一对应。

### 05 硬性要求 1/2（8s）
- ① header.cwd 用单反斜杠，且与工作区账本逐字符一致
- ② session id 要写进对应工作区的 sessionIds
- ③ 显示名由 session/title 事件决定，不是文件名
- ④ 事件 seq 从 0 连续递增，跳号直接报 seq gap

### 06 硬性要求 2/2（8s）
- ⑤ 第一个 zstd 帧必须恰好只装 header 一行
- ⑥ 每一轮自成一对 turn/start → turn/end，turn 必须 1..N 递增（R9）
- ⑦ assistant/message 必须带完整模型流 stream（R10）
- ⑧ 侧栏还需要投影缓存 projcache；agentPreset 要在 profile 组装范围内
- 旁白：旧导入 9 条里 8 条坏在第 ⑥ 条：单轮会话看不出问题，多轮才被校验器抓出来。

## 实测部分（6 步，全部现场真实运行）

由 `live/capture.mjs` 依次执行，stdout 原样写入 `captured/*.txt` 后画进终端画面：

| 步骤 | 命令（参数已脱敏显示） | 期望退出码 | 真实输出 |
|---|---|---|---|
| 1 | `node live/legacy-fixture.mjs --home <tmp> --ws <tmp>` | 0 | `captured/01-fixture.txt` |
| 1 | `node live/validate-all.mjs --home <tmp> --dsh <cli>` | 1 | `captured/02-validate-legacy.txt` |
| 2 | `node live/repair-turns.mjs --home <tmp>` | 0 | `captured/03-repair.txt` |
| 2 | `node live/validate-all.mjs --home <tmp> --dsh <cli> --quiet` | 0 | `captured/04-validate-fixed.txt` |
| 3 | `node live/rebuild-with-assistant.mjs --home <tmp>` | 0 | `captured/05-assistant.txt` |
| 3 | `node live/validate-all.mjs --home <tmp> --dsh <cli> --quiet` | 0 | `captured/06-validate-assistant.txt` |
| 4 | `node scripts/selftest.mjs --dsh <cli>` | 0 | `captured/07-selftest.txt` |
| 5 | `node scripts/generate-dsh-cache.mjs --home <tmp> --session <id>` | 0 | `captured/08-cache.txt` |
| 5 | `node scripts/verify-dsh-session.mjs --in <tmp>/… --require-cache --home <tmp> --dsh <cli> --run-dsh` | 0 | `captured/09-verify.txt` |
| 6 | `node privacy-scan.mjs .` | 0 | `captured/10-privacy.txt` |

关键真实数字（逐字来自上述 stdout，未编造）：

- 旧布局：`[validate] session-...-001..008 FAIL ... SessionFormatError: turn/start does not open the expected turn`，
  唯一单轮会话 PASS；汇总 `[validate] sessions 9 | PASS 1 | FAIL 8`
- 修复后：`[validate] sessions 9 | PASS 9 | FAIL 0`
- 补 AI 回复：9 条共 27 个 assistant/message（build-dsh-session.mjs 四段 stream），复查仍是 `PASS 9 | FAIL 0`
- 技能自测：`RESULT: PASS  (19/19 checks)`
- 技能校验器：`RESULT: PASS (11 checks)`（含 `3 assistant/message event(s), 0 without stream`）
- 隐私扫描：`scanned: N files | hits: 0`

## 隐私与事实边界

- 9 条会话是**合成 fixture**：id 固定为 `session-00000000-0000-4000-8000-00000000000N`，
  正文是「第 k 轮：示例用户指令」，不含任何真实聊天内容；它们复现的是旧导入的**布局缺陷**（turn 编号不递增）。
- 校验全部由本机真实 DSH 加载器（`dsh headless --session-id <id> "x"`）逐条执行，错误文案为原样输出。
- 画面与仓库文本中无真实用户名、用户绝对路径、真实会话 id、密钥。
