---
name: dsh-history-migration
description: 把其它应用的对话历史（VS Code / Copilot Chat、MiMo Studio、opencode 等）迁移成 DSH 能加载、能在侧栏正确显示的本地会话。涵盖 DSH 会话存储契约（仅追加事件日志 + header 元数据 + 投影缓存三件套）、8 条硬性格式要求及各自的报错判定、以及可复用的抽取/生成/解码/校验流程。当用户说「迁移对话历史、导入会话、跨平台记录、MiMo/VS Code/opencode 历史、DSH 会话、把旧记录搬进 DSH」时使用。
---

# DSH 历史迁移

这里只写**可迁移的机制**：任何主机名、用户名、绝对路径、来源会话 id 都不属于本技能，而是运行时的角色参数。文档中一律用占位符表示，真实值从项目配置或命令行读入。

| 占位符 | 含义 |
|---|---|
| \<DSH_HOME\> | DSH 用户数据根目录（默认是用户主目录下的 .dsh） |
| \<workspace\> | 目标工作区目录的**规范绝对路径**（等价于 fs.realpath 的结果） |
| \<session-id\> | DSH 会话 id，形如 session-\<uuid\>，落盘后即不可变 |
| \<chat-session-id\> | 来源应用的会话标识（VS Code 会话 id / MiMo 记录 id） |
| \<source-app\> | 来源应用（VS Code Copilot Chat / MiMo Studio / opencode / 其它） |
| \<工具链目录\> | 本技能 scripts/ 所在目录 |

## 核心主张

**跨应用对话历史可以整段迁移进 DSH，但只能"按 DSH 的契约落盘"，不能伪造一份看起来像的 JSONL。** 可迁移的是事件日志的物理格式、序号不变量与成员资格规则；不可迁移的是来源应用自己的私有存储布局。

三件套缺一不可，每件失败的表现各不相同：

1. **仅追加的事件日志**（真源）—— seq 必须连续，否则报 seq gap；
2. **日志旁的 header 元数据** —— cwd 决定工作区归属，写错就显示为未分组；
3. **投影缓存** —— 侧栏列表拿它渲染，缺了就"会话在、但列不出来"。

最小可过校验的形态是**只保留 user/message 的会话**。assistant/message 必须带完整的模型流（stream）和 source 的 kind/provider/model，手工合成成本远高于收益，因此导入时应主动丢弃它。

## 总体流程

1. **抽取**（读来源、不改来源）：用 \<工具链目录\>/export-vscode-chat.mjs、export-mimo.mjs 或 export-opencode.mjs 把每个来源会话导出为结构化 JSON（会话 id + 时间 + 逐轮 user/assistant）。来源目录只读。
2. **选定落点**：确定目标 \<workspace\>，并拿到它的规范路径。规范化只走 realpath 一套规则（尾斜杠、..、符号链接都被解析），字符串比较即唯一性判定。
3. **生成会话**：build-dsh-session.mjs 生成 session-\<uuid\> 的事件流——header 一行 + 事件各一帧；事件只保留 user/message，seq 从 0 连续；末尾以 session/title 定名。
4. **补投影缓存**：generate-dsh-cache.mjs 写 storages/session_projcache/sessions/\<session-id\>.json（version 7，identity + rows）。
5. **登记成员资格**：把 \<session-id\> 追加进工作区账本的 sessionIds（先备份 workspace.json）。
6. **校验**：verify-dsh-session.mjs 本地自检 + dsh headless --session-id 真校验；再用 list-dsh-sessions.mjs 核对事件数与标题。
7. **生效**：重启 DSH（写会话文件期间不要让 DSH 持有同一会话的写句柄）。

## 8 条硬性格式要求（每条给出触发条件、失败外观、判定方法与修复）

**R1 · header.cwd 必须与工作区路径逐字符一致，且是单反斜杠**
- **触发**：手工拼接或从其它语言写 JSON 时对反斜杠做了二次转义。
- **失败外观**：会话本身能加载，但侧栏显示为未分组（工作文件夹未分组），像是"没导入成功"。
- **判定**：解码日志首行，比较 header.cwd 与工作区账本里的 path 字符串；不要用规范化以外的方式比较（尾斜杠、大小写都不是问题，符号链接和 .. 才是）。
- **修复**：以工作区账本里存的那份 path 为唯一基准原样写入 header。

**R2 · session id 必须进入对应工作区的 sessionIds 账本**
- **触发**：只写了会话目录，忘了改工作区存储。
- **失败外观**：日志文件存在且格式正确，但列表里没有它。成员资格是"账本里有 id"**且**"header 规范 cwd 等于工作区 path"两个条件同时成立。
- **判定**：读工作区账本，确认 id 在 sessionIds 中；再确认 header.cwd 相等。
- **修复**：备份后把 id 追加进 sessionIds，并更新时间戳；不要从 cwd 反推账本。

**R3 · 显示名由 session/title 事件决定，不是文件名**
- **触发**：以为目录名或 header 里有标题。
- **失败外观**：会话能加载，但列表显示为无标题/默认名。
- **判定**：解码后查找 type 为 session/title 的事件，看 data.title 与 data.messageSeqs。
- **修复**：补一条 session/title 事件（放在用户消息之后即可），并让 messageSeqs 指向首条 user/message 的 seq。

**R4 · 事件 seq 必须从 0 开始、连续递增、不跳号**
- **触发**：**从零构造/导入**一段日志时编号写错——从 1 开始、跳号、或删掉事件后没重编号。
- **失败外观**：校验器直接报 has seq gap。
- **判定**：把全部事件的 seq 取出来，断言等于 0..N-1 且无重复；header 行本身没有 seq，不参与编号。
- **修复（只适用于你自己新建的日志）**：按最终事件顺序从 0 编号，并同步修正任何引用了 seq 的字段（例如 session/title 的 messageSeqs）。
- ⚠️ **对已有的真实会话日志，这一条反过来**：删事件后**不要重排**，因为在用的日志里到处是引用旧编号的字段（见 R11）。那时宁可留着序号空洞，也不要重排。

**R5 · 第一个 zstd 帧必须恰好只装 header 一行，其后每个事件各占一帧**
- **触发**：图省事把整段 JSONL 压成一个 zstd 帧。
- **失败外观**：校验器报 first frame is not exactly one header line。
- **判定**：用帧切分器（见 references/dsh-session-format.md）数帧数，应等于 事件数 + 1；再逐帧解压，确认第 1 帧只有 header 一行、其后每帧一行 JSON。
- **修复**：逐行压缩，再按顺序拼接。压缩级别和是否带校验和都不影响可读性。

**R6 · assistant/message 必须带完整模型流，所以导入时只保留 user/message**
- **触发**：为保留原文而手工合成 assistant/message。
- **失败外观**：要么校验直接失败，要么记录里缺 source 的 kind/provider/model 或 stream 而语义不完整。
- **判定**：assistant/message 的 data 必须同时有 message、stream（及可选的 usage）；source 必须带 kind/provider/model。缺任一即视为不合格。
- **修复**：不要合成。精简为仅 user/message 是实测能过校验的最简形态；需要保留的原文可以并入 user 消息正文或以纯文本附件形式另存。
- **注意**：精简只允许发生在**你自己新建、还没有任何 seq 引用字段**的日志上（这时才按 R4 从 0 重排）。要在真实的已有会话上做任何事（改名、分类…），一律**只追加、不重排**（R11）。

**R7 · 必须补投影缓存 storages/session_projcache/sessions/\<session-id\>.json**
- **触发**：只写了日志。日志（真源）与列表缓存是两套独立存储。
- **失败外观**：会话能通过校验，但侧栏不出现或信息为空。
- **判定**：确认该文件存在、顶层 version 为 7、且 record.identity 的 cwd/createdAt 与 header 一致、record.rows 至少能提供 title 与 sessionListMetadata。
- **修复**：从一条同 profile 原生会话的缓存复制骨架，改 identity、title、统计与时间字段；rows 是 { ver, seq, val } 结构，且要与其投影单元语义一致。
- **提醒**：复制模板属于本机私有素材，入库时应改为按字段生成的通用代码。

**R8 · session 的 agentPreset 必须落在目标 profile 的组装范围内**
- **触发**：导入时写了某个 preset（如 standard），却用不组装它的 profile 去校验。
- **失败外观**：报"agent preset 不组装"之类的非格式错误——**这不是格式错误**，日志本身可能是好的。
- **判定**：明确校验用哪个 profile。headless 不组装 standard，Web/desktop 可以；显示效果应回到 Web 验证。
- **修复**：选择目标 profile 支持的 preset，或改用会组装该 preset 的 profile 做端到端验证。

**R9 · 每一轮必须自成一对 turn/start → … → turn/end**
- **触发**：多轮会话只用一次 turn/end 收尾（把 N 轮串成一个大 turn）。
- **失败外观**：`SessionFormatError: turn/start does not open the expected turn`（单轮会话看不出问题，多轮才炸）。
- **判定**：数一数 `turn/start` 与 `turn/end` 的数量是否相等、`turn` 是否 1,2,3… 递增。
- **修复**：第 k 轮固定发 `turn/start{turn:k}` → `step/start{turn:k,step:1}` → 消息 → `step/end` → `turn/end{turn:k,reason:{kind:'completed'}}`，逐轮重复。

> **导入纪律**：一次导入 ≥2 条会话时，**每条都要单独过一遍 CLI 校验器**——单轮样本通过不能代表多轮通过（本仓库实测：9 条里单轮那条通过、另外 8 条多轮全部因 R9 失败）。

**R10 · assistant/message 必须带完整模型流，否则只能用 user/message**
- **触发**：想把 AI 回复也导入，却只写了 message 字段。
- **失败外观**：assistant/message ... must have model source（缺 provider/model）或 invalid settlement fields（缺 stream）。
- **判定**：assistant/message.data 必须同时有 message{role,content,source{kind:'model',provider,model},id} 与 **stream（settlement）**。
- **已验证的最小 stream**（4 条 record，实机通过 DSH 校验器）：
  [{"type":"chunk","time":T,"chunk":{"type":"block-start","index":0,"blockType":"text"}},
   {"type":"chunk","time":T+1,"chunk":{"type":"text-delta","index":0,"text":"<正文>"}},
   {"type":"chunk","time":T+2,"chunk":{"type":"block-end","index":0,"block":{"type":"text","text":"<正文>"}}},
   {"type":"chunk","time":T+3,"chunk":{"type":"finish","reason":{"kind":"stop"}}}]
- **修复**：按上面补齐；只想导用户侧就干脆不发 assistant/message。

> **导入纪律**：一次导入 ≥2 条会话时，**每条都要单独过一遍 CLI 校验器**——单轮样本通过不能代表多轮通过（本仓库实测：9 条里单轮那条通过、另外 8 条多轮全部因 R9 失败）。

**R11 · seq 是所有引用字段的坐标系：只许追加，绝不许重排**
- **触发**：删掉某个已有事件（典型：旧的 `session/title`）后，为了让 seq 保持 0..n-1 连续，把后面的事件逐个重排。
- **失败外观**：DSH 打开会话即报
  `corrupt session log: invalid committed event at line N: sourceEventSeqs ranges must contain unique earlier seqs`
  （本工作区实测：一次「改名」操作重排后 **74 / 98** 条会话中招，界面显示「历史加载失败…大部分对话报错」）
- **根因**：`sourceEventSeqs`、`throughSeq`、`headerSeq`、`startSeq` / `endSeq`、`shadowedSeqs`、`messageSeqs` 里存的都是**旧编号下的 seq**。重排只改了事件自己的 `seq` 字段，这些引用一个字都没动 ⇒ 越过自身 seq、或悄悄指向别的事件。
- **判定**：跑 `verify-dsh-session.mjs`，看 `seq-typed fields point at earlier, unique seqs`；逐事件检查所有名字含 `seq` 的字段（`seq` 本身除外）值 ≤ 自身 seq 且无重复。
- **正确做法**：**只在末尾追加**新事件，`seq = max(seq)+1`。改标题就**追加**一条新的 `session/title`（最后一条生效），旧的原封不动 —— 直接用 `scripts/retitle-dsh-session.mjs`。
- **已经重排坏了怎么救**：把越界/重复的引用钳回 `≤ 自身 seq` 并去重（对 `throughSeq` / `headerSeq` 这类「截至本事件」的字段就是钳到自身 seq）。语义会略偏，但会话能重新加载；**旧编号无法完美还原**——所以一开始就别重排。

## 失败模式速查

| 现象 | 根因 | 判定/修复 |
|---|---|---|
| has seq gap | 删改事件后 seq 不连续 | **导入新建的日志**才需要从 0 重新编号（R4）；**已有日志删了事件后不要重排**——引用旧编号的字段会一起坏掉（R11） |
| corrupt … sourceEventSeqs ranges must contain unique earlier seqs | 重排过 seq，引用字段还停在旧坐标系 | 追加而不重排（R11）；已坏的把越界引用钳回并去重 |
| first frame is not exactly one header line | 整段压成一帧 | 拆成 header 帧 + 每事件一帧（R5） |
| 工作文件夹未分组 | header.cwd 与工作区 path 不一致 | 原样写入账本 path（R1） |
| 会话在磁盘上但列表没有 | 未登记 sessionIds，或缺投影缓存 | 补账本（R2）与缓存（R7） |
| 列表有会话但没标题 | 缺 session/title 事件 | 补事件并填 messageSeqs（R3） |
| 校验失败但不是格式问题 | preset 不在该 profile 组装范围 | 换 profile 验证（R8） |
| 改完看不到变化 | DSH 正在运行、缓存/日志被进程持有 | 重启 DSH；写文件期间避免 DSH 打开该会话 |
| 解压读不出完整事件 | zstd 帧切分把可跳过帧当正文 | 切帧器需识别两种魔数（见 references） |

## 可迁移边界

| 属于本机私有（不得写进技能/仓库） | 属于可复用规律（本技能的主体） |
|---|---|
| 真实用户名、主机名、绝对路径 | 路径规范化与成员资格的比较规则 |
| 具体来源应用的存储路径（如编辑器 workspaceStorage 的哈希目录、应用数据库文件） | "只读抽取 → 结构化中间格式 → 生成事件流"的分层做法 |
| 真实会话 id、来源会话 id、时间戳 | 事件信封字段、seq 不变量、帧规则 |
| 真实标题与对话正文 | 最小可过校验形态（仅 user/message）与投影缓存字段要求 |
| 某条会话缓存模板文件 | 校验器命令与"格式错误 vs 非格式错误"的区分 |
| 账号、密钥、令牌 | 备份-修改-重启的操作纪律 |

## 校验（可复现命令）

本地自检（生成后立即跑，不依赖 DSH）：

    node "<工具链目录>/verify-dsh-session.mjs" "<session-dir>"

真校验器（无 UI 依赖，格式错会立刻报错；未知 id 也是错误）：

    dsh headless --session-id <session-id> "x"

判据：**只要不出现格式错误即视为通过**。若只报 agent preset 不组装之类的编排错误，按 R8 换 profile 复验，不要据此判定迁移失败。显示效果最终以 Web 侧栏为准。

## 参考

- references/dsh-session-format.md —— 目录布局、帧规则、事件词汇、seq 规则、投影缓存、工作区成员资格与校验命令。
- 官方文档：会话模型、持久化、工作区、会话投影（链接见 references 文末）。
- scripts/ —— 抽取、生成、解码、缓存、校验的通用工具链（用法见 scripts/README.md）。
