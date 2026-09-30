# DSH 会话存储格式参考

本文记录"把外部历史写成 DSH 会话"所需的物理与逻辑格式。**官方文档没有会话导入章节**，以下目录布局与 JSONL/zstd 细节是实测结论；逻辑模型（事件词汇、seq、成员资格）以官方文档为准，链接见文末。

所有路径用占位符：\<DSH_HOME\>、\<workspace\>、\<session-id\>。

## 1. 目录布局

    <DSH_HOME>/
      sessions/
        <encoded-workspace>/            # 由工作区路径编码出的目录名
          <session-id>/
            session.v4.jsonl.zstd       # 会话正文（唯一真源）
      storages/
        workspace.json                  # 工作区账本（成员资格）
        workspace.json.bak-*            # 修改前的备份（操作纪律）
        session_projcache/              # 逐会话投影缓存（列表渲染用）
          sessions/
            <session-id>.json
        session_projcache.json          # 投影缓存的领域 KV 表

实测的目录名编码：把工作区绝对路径里的分隔符和冒号替换为连字符，整体用双连字符包边；非 ASCII 字符按 UTF-16 码元转成 ~XXXX~ 形式。例如一条位于用户目录下 Documents 的路径，其目录名形如 --C-Users-...-Documents--。**目录名只是物理寻址，工作区归属由 header.cwd 决定**（见第 6 节）。如果拿不准，就用 DSH 自己为原生会话创建的目录名做参照。

## 2. 物理格式：session.v4.jsonl.zstd

文件是**一串独立的 zstd 帧直接拼接**，没有外层容器。

- 帧头魔数：标准 zstd 帧为 0xFD2FB528（小端写入文件）；
- **可跳过帧**：0x184D2A50 ~ 0x184D2A5F 是 skippable frame，读的时候要整段跳过，不能当成正文解压；
- 每个正文帧解压出来是一行 JSON（末尾带换行）；
- **第 1 帧必须恰好只装 header 一行；此后每个事件各占一帧。**
- 解码时先按魔数切帧，再逐帧 zstd 解压，最后按行拼成 JSONL。

一个够用的切帧思路：从偏移 0 扫描；遇到 skippable 帧读 4 字节长度并跳过；遇到标准帧就解析帧头（Frame_Header_Descriptor 的 FCS/DictID/Checksum 位、可选窗口描述字节），再顺次读 block header 直到 last block 位为 1，必要时跳过 4 字节校验和，得到帧尾。帧头解析出错时按字节前进重试。伪代码级别的实现见 scripts/ 中的解码工具。

重写会话时的顺序是：先构造完整 JSONL 文本 → 逐行 zstd 压缩 → 按行序拼接 Buffer 落盘。

### header 行（第一行，无 seq）

    {"type":"session","version":4,"id":"session-<uuid>","createdAt":<epoch_ms>,"cwd":"<workspace>","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}

字段：

| 字段 | 说明 |
|---|---|
| type | 固定为 session，标志这是 header 而不是事件 |
| version | 会话格式版本，当前为 4（对应文件名 v4） |
| id | 会话 id，\<session-id\>；落盘后不可变，且必须与目录名一致 |
| createdAt | 创建时刻，epoch 毫秒 |
| cwd | 工作目录绝对路径；**工作区成员资格以它为准** |
| isSeeded | 是否继承自 fork 前缀；全新导入应为 false |
| delegationDepth | 委派深度；顶层会话为 0 |
| agentPreset | 组装 preset 名；必须落在目标 profile 的组装范围内（见 SKILL.md R8） |
| parentSession / origin | 可选，分叉或子代理会话才出现 |

header 的 cwd 是"日志旁的元数据"，**不属于事件日志**，也不参与 seq 编号。

## 3. 事件信封

每个事件一行 JSON，信封字段：

| 字段 | 说明 |
|---|---|
| type | 事件类型（见第 4 节） |
| seq | 逻辑序号，见第 5 节 |
| time | 事件时刻，epoch 毫秒 |
| data | 类型相关负载 |
| surfaceOp | 可选；出现在会产生模型可见表面的消息事件上（如 user/message、assistant/message、tool/result） |
| sourceEventSeqs | 可选；部分事件引用先前事件的 seq |

## 4. 事件词汇

会话日志是仅追加的 SessionEventMap。核心成员（官方 session.md）：

| 事件 | data 关键字段 | 作用 |
|---|---|---|
| turn/start | turn | 开启一个 turn |
| turn/end | turn, reason | 关闭 turn；reason 形如 { kind: 'completed' } |
| step/start | turn, step | 开启一步（一次模型调用及其工具执行） |
| step/end | turn, step | 关闭一步 |
| user/message | content, source, role, id | 用户/注入消息，导入时唯一保留的内容 |
| system/message | turn, step, message | 渲染后的系统提示 |
| developer/message | turn, step, message, headerSeq? | 增量会话变更 |
| assistant/message | turn, step, message, stream, usage?, interrupted? | 一步的助手消息；**stream 必填** |
| assistant/attempt | turn, step, stream | 未产生可见消息的模型尝试 |
| tool/call | turn, step, callId, name, arguments | 工具调用请求 |
| tool/result | turn, step, message, error?, meta? | 工具结果 |
| request/header | header, reason, startsSeries? | 下一次请求的完整 header（仅记录） |
| request/context | provider, model, contextWindow, systemPromptUpdate | 路由元数据快照 |
| session/end-seed | inherited? | 区分继承前缀与后续生命周期工作 |
| session/title | title, messageSeqs, source | 显示名来源 |

实测还见到 permission/preset、sandbox/mode、approval/policy、agent/inbox/spliced 等编排事件，以及插件合并扩展的类型（如 compaction/*、hook/*）。导入最小骨架通常写成：header → permission/preset → sandbox/mode → approval/policy → session/end-seed →（turn/start → step/start → user/message×N → step/end）→ session/title → turn/end。**这条骨架是实测可用；其中若干编排事件是否"严格必需"未逐项证明**，但缺 seq 连续或帧规则一定失败。

## 5. seq 规则

- 首个事件的 seq 为 0，其后每个事件依次 +1；
- **不得跳号、不得重复**，否则报 has seq gap；
- header 行没有 seq；
- 删除或精简事件（例如去掉所有 assistant/message）后**必须整体重新编号**；
- 重新编号后要同步修正引用 seq 的字段，例如 session/title 的 messageSeqs。

session/title 的 messageSeqs 通常指向首条 user/message 的 seq。

## 6. workspace.json：成员资格

结构（顶层 unit/global/tables，工作区表以 id 为键）：

    {
      "unit": {...},
      "global": null,
      "tables": {
        "workspaces": {
          "<workspace-uuid>": {
            "path": "<workspace>",
            "title": "<显示标题>",
            "sessionIds": ["session-<uuid>", "..."],
            "createdAt": "<ISO-8601>",
            "updatedAt": "<ISO-8601>"
          }
        }
      }
    }

成员资格需要**同时**满足两条：

1. \<session-id\> 出现在该工作区的 sessionIds 数组中；
2. 会话 header 的 cwd 规范路径等于工作区的 path。

读取时账本上的候选项会被同步过滤：header 缺失、cwd 无效或不匹配的都不会返回，并在下一次工作区写入时被持久剪除。修改前先备份 workspace.json（保留一份 .bak-*），追加 id 后更新 updatedAt。**分组修复只动两处：header.cwd 或账本 sessionIds**，其它字段一律不要顺手改——问题几乎总在这两处的字符串本身。

## 7. 投影缓存：session_projcache

两处存储，作用不同：

- **storages/session_projcache/sessions/\<session-id\>.json** —— 侧栏列表直接渲染的逐会话缓存。实测结构：

      {
        "version": 7,
        "record": {
          "identity": { "formatVersion": 4, "createdAt": <epoch_ms>, "cwd": "<workspace>", "isSeeded": false, "inheritedEventCount": 0 },
          "rows": {
            "title": { "ver": <n>, "seq": <n>, "val": {...} },
            "titleInput": { "ver": <n>, "seq": <n>, "val": {...} },
            "sessionListMetadata": { "ver": <n>, "seq": <n>, "val": {...} },
            "sessionStats": { "ver": <n>, "seq": <n>, "val": {...} },
            ...
          }
        }
      }

  每个 row 是 { ver, seq, val }：ver 是该投影单元的状态版本，seq 是水位线（可用会话最大 seq + 1），val 是完整值。identity 必须与 header 的 cwd/createdAt 对齐，否则缓存会被判为不属于这条日志。缺少这份文件时，日志能校验通过但侧栏不显示。缓存值只是列表的加速读模型，会被后续真实日志覆盖；写错 val 不会污染会话真源。

- **storages/session_projcache.json** —— 投影缓存的领域 KV 表（unit 名 session_projcache，实测 unit.version=3），按会话 id 存 identity + rows 的持久化副本。

缓存行由投影单元（session-projection seam）定义，字段会随版本演进；**复制一条同 profile 原生会话的缓存作为骨架是实测可行的做法，但模板属于本机私有素材**，通用工具应按字段生成而不是把模板文件带进仓库。

## 8. 校验

无 UI 依赖的真校验器：

    dsh headless --session-id <session-id> "x"

- 未知 id 是错误；会话格式错误会立刻报出（如 has seq gap、first frame is not exactly one header line）；
- **报"agent preset 不组装"之类的编排错误不算格式错误**：headless 不组装 standard preset，换 Web/desktop 或改 preset 后复验；
- DSH 的日志是单写者所有：会话正在被进程持有时应避免写它的文件，改完重启 DSH 生效。

仅本地自检（不启动 DSH）：用 scripts/verify-dsh-session.mjs 检查帧数 = 事件数 + 1、首帧仅 header、seq 连续、header.cwd 与预期一致。

## 9. 官方文档与源码

- 会话（事件词汇与真源模型）：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session.md
- 持久化（header、句柄、崩溃恢复）：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/persistence.md
- 工作区（成员资格）：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/workspace.md
- 会话投影（投影缓存与投影单元）：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-projection.md
- 使用 Web UI（快速上手）：https://deepseek-harness.github.io/deepseek-harness/guide/quickstart.md
- 源码包：packages/core/session/src/types.ts（SessionEventMap）、packages/session/session-persistence-jsonl、packages/workspace/workspace。
