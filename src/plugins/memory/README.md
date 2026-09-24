# memory

跨会话记忆插件：同 workspace 的 compaction checkpoint 自动收割进本地 sqlite，新会话开工时按持久节过滤、按预算裁剪后作为持久化 context `user/message` 行注入（plugin source + digest，不占 system prompt 字节）；`memory_write` / `memory_list` / `memory_forget` 三个工具支持主动沉淀与清理。零额外 LLM 调用、零 compaction 干预——纯事件观察者。

- **自动收割。** 监听 `session/event` 流的 checkpoint 消息（`user/message` 事件，`data.source` 标记 compact 插件；`compaction/summary` 只是元数据事件，不作为收割点），把摘要全文存进本地库（幂等：同一事件 seq 只入一次）。子代理会话的 checkpoint 同 workspace 也收割。
- **节过滤 + 预算裁剪。** 注入时只保留持久节（Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Critical Context），丢掉 Pending Jobs / Current Work / Next Step 这类死会话瞬时状态；超预算从尾部（最旧 checkpoint）丢弃并标注 `(N older memories omitted)`。解析不出已知标题时整条原样注入，永不丢数据。
- **链式 compaction 去重。** 新 summary 的 shadowed seqs 命中旧 checkpoint 时，旧条目标记 superseded、不再注入。
- **上下文注入。** 挂在 `agent/pre-step`（每次 step 开始前，晚于 inbox claim 与 system prompt 组装），把记忆块做成一行引导语 + 块文本的持久化 context `user/message` 行，source 为 `{kind: 'plugin', plugin: 'dsh-memory', digest: sha256(全文)}`。
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

工具描述明确要求：只存跨会话有用的持久知识（项目事实、踩坑修复、用户偏好），不存一次性细节。

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
| `maxBlockChars` | `6000` | 注入记忆块的最大字符数；超出从最旧 checkpoint 起丢弃并标注省略数量 |

示例（profile 层 cordis.patch.yml）：

```yaml
- id: dsh-memory
  name: dsh-me/plugins/memory
  config:
    maxBlockChars: 4000
```

细节：宿主半边 `src/index.ts`（`name: dsh-memory`）只注入 `tools` 一个服务；注入挂在 `agent/pre-step`（读取 payload 上的 live session，无需 sessions 服务），收割与注入全部 try/catch 只记 warning 日志，绝不向宿主事件流或 waterfall 抛错。存储与纯逻辑见 `store.ts` / `pure.ts`，测试覆盖见 `pure.spec.ts` / `store.spec.ts` / `index.spec.ts`。