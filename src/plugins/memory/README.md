# memory

跨会话记忆插件：同 workspace 的 compaction checkpoint 自动收割进本地 sqlite，收割时按持久节**分段**入库（段 = 预算原子），新会话开工时按**双池**（compaction 组 + manual 条）裁剪后作为持久化 context `user/message` 行注入（plugin source + digest，不占 system prompt 字节）；`memory_write` / `memory_list` / `memory_forget` 三个工具支持主动沉淀与清理。零额外 LLM 调用、零 compaction 干预——纯事件观察者。

- **自动收割。** 监听 `session/event` 流的 checkpoint 消息（`user/message` 事件，`data.source` 标记 compact 插件；`compaction/summary` 只是元数据事件，不作为收割点），把摘要**按持久节分段**存进本地库（幂等：同一事件 seq + 段序只入一次，重放/重启不重复）。子代理会话的 checkpoint 同 workspace 也收割。
- **收割分段。** 只收持久节（Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Critical Context），丢掉 Pending Jobs / Current Work / Next Step 这类死会话瞬时状态；节（含标题）≤ `maxEntryChars` 整节一段，超帽按顶层 bullet 贪心装箱（`(cont. i/N)` 标注），非列表节按段落切，单块仍超帽按 ``` fence 边界拆，再超才硬截断并标注 `[segment truncated: N chars omitted]`——全系统唯一数据丢失路径。解析不出已知标题时整条原样入段，永不丢数据。切分是 (text, cap) 纯函数，重收割确定性幂等。
- **双池注入预算。** manual（global → workspace → session，各自新→旧）与 compaction（checkpoint 组新→旧）分开计数互不挤占：compaction 池按**整组准入**（一个 checkpoint 的全部段同进同出，绝不腰斩），超出从最旧整组丢；manual 池按单条丢最旧。池装不下时块尾标注 `(N older memories omitted)`。
- **空白归一（渲染层）。** 注入前折叠连续空行、剥行尾空白；代码 fence 内原样不动。store 永存原文，digest 对归一化后的整块计算。
- **链式 compaction 去重。** 新 summary 的 shadowed seqs 命中旧 checkpoint 时，旧组的全部段标记 superseded、不再注入。
- **上下文注入。** 挂在 `agent/pre-step`（每次 step 开始前，晚于 inbox claim 与 system prompt 组装），把记忆块做成一行引导语 + 块文本的持久化 context `user/message` 行，source 为 `{kind: 'plugin', plugin: 'dsh-memory', digest: sha256(归一化全文)}`。
  - **为什么不用 systemPrompt section**：动态 section 每次组装都改 system prompt 字节，store 一变整段前缀缓存失效。持久行只在记忆真正变化时才原位替换（`surfaceOp: replace`，startSeq=endSeq=原行 seq），system prompt 字节恒定，provider prefix cache 大部分 step 全程命中。
  - **首次注入**：surface 上无 dsh-memory 行且记忆块非空 → 本 step 的 enter 消息尾部追加该行（与 harness RuntimeContextProjection / magic-context m0/m1 同一投递路径；循环会把 enter 消息持久化成 durable user/message）。
  - **变更生效**：已有行 + digest 不同 + 块非空 → 原位替换该行（位置不变，内容与 digest 即刻更新）。工具「立即生效」语义不变：下个 pre-step 的 digest 比较即触发替换。行不存在或 digest 相同 → 无操作。
  - **空块永不注入**；若 surface 上已有旧行，会留到会话结束（边界：记忆全清后旧行不再刷新，token 代价是注入一次历史块；重开会话即消失）。
  - **故障隔离**：注入路径与收割同纪律——全部 try/catch，失败只记 warning，绝不向 waterfall 抛错。
- **三级记忆。** `global`（跨 workspace，用户偏好类）/ `workspace`（默认，按 cwd 隔离）/ `session`（会话笔记：跨 compaction 存活，会话结束自动清除）。

## 工具用法

```text
memory_write content="用户偏好极简回复" scope="global"     # 跨 workspace 长期偏好
memory_write content="本项目用 pnpm + tsdown 构建"          # 默认 workspace 级
memory_write content="当前会话的临时结论" scope="session"    # 只在本会话注入，会话结束清除
memory_list                                                 # 查当前可见的全部记忆
memory_list keyword="pnpm"                                  # 关键词过滤（LIKE）
memory_forget id=3                                          # 按 id 删除（id 见 memory_list）
```

工具描述明确要求：只存跨会话有用的持久知识（项目事实、踩坑修复、用户偏好），不存一次性细节。`memory_write` 内容超 `maxEntryChars` 时写入即截断并标注同款 `[segment truncated: N chars omitted]`。

## 数据位置与清除

记忆存单一 sqlite 文件：

```text
$DSH_HOME/dsh-memory/memory.db     # DSH_HOME 有设置时
~/.dsh/dsh-memory/memory.db        # 默认
```

清除方式：停掉插件后删除该目录即可（`rm -rf ~/.dsh/dsh-memory`）。会话结束自动清掉该会话的 session 级行；checkpoint 属于 workspace，不随来源会话删除。

## 配置

| 参数 | 默认 | 说明 |
|---|---|---|
| `maxEntryChars` | `2500` | 段帽：收割分段阈值 + `memory_write` 截断阈值。改配置不重切已入库段（重收割被幂等挡住），可删库重来 |
| `maxCompactionSummaries` | `2` | compaction 池大小：整组准入，最旧整组丢弃（同组全部段同进同出） |
| `maxManualEntries` | `10` | manual 池大小：单条计数（global → workspace → session 各自新→旧），最旧丢弃 |

示例（profile 层 cordis.patch.yml）：

```yaml
- id: dsh-memory
  name: dsh-me/plugins/memory
  config:
    maxCompactionSummaries: 3
    maxManualEntries: 20
```

细节：宿主半边 `src/index.ts`（`name: dsh-memory`）只注入 `tools` 一个服务；注入挂在 `agent/pre-step`（读取 payload 上的 live session，无需 sessions 服务），收割与注入全部 try/catch 只记 warning 日志，绝不向宿主事件流或 waterfall 抛错。存储与纯逻辑见 `store.ts` / `pure.ts`，测试覆盖见 `pure.spec.ts` / `store.spec.ts` / `index.spec.ts`。
