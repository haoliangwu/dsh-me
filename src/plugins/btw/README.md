# btw

`/btw` 顺带一问：子 agent 用完整 markdown 回答，主会话日志保持干净。还能 `@` 或 `标题 ::` 定位同 workspace 的**其他会话**，问它的上下文。

- **主会话零污染。** `recordInput: false`，问题只进子 agent，主日志不落一行。
- **三形态输入。** `/btw 问题`（默认带主会话近 10 条上下文）；`/btw @[标题](dsh-session:id) 问题`（@ 提及**替换**为靶会话快照）；`/btw 标题 :: 问题`（标题兜底，唯一命中否则报歧义候选）。
- **只读快照。** 靶会话经 `sessionQuery.readSurface` 取头尾合计 16KB 的结构化快照（仅人类输入 + assistant 文本，注入行过滤），同 workspace 才可读，跨域直接拒绝。
- **37 个 vitest 用例**守护纯决策核心：双通道解析、目标寻址、字节预算切片、快照打包。

## 试试

```text
你： /btw 这个会话既定的任务是什么？用一句话回答
     # 子 agent 基于主会话上下文回答，渲染为 markdown 卡片，主日志零新增事件

你： /btw @[暗号建立确认](dsh-session:session-xxx) 那个会话记住的暗号是什么？
     # 子 agent 只看得到那个会话的只读快照，答案来自靶会话而非主会话

你： /btw 暗号建立确认 :: 暗号是什么？
     # 同上，按唯一标题定位；撞名时报错列出全部候选 id
```

## 安装与配置

随 dsh-me 整包安装（见[根 README](../../../README.md)）。零配置装完即工作。

要点：命令输入内 `@` 会话选择器不弹（app 层限制），@ 通道手打 canonical 链接 `@[标题](dsh-session:id)` 即可；提交走输入框 **Commands 按钮 → 选 btw**（打字式 `/btw` 提交存在间歇性派发失败）。

## 细节

- 宿主半边 `src/index.ts`（`name: dsh-btw`）注册 `commands.register({ name: 'btw', recordInput: false })`：解析 `rawInput`（`pure.ts` 纯函数）→ 命中目标通道则 `filterSessions({ kind: 'cwd' })` 做 workspace 闸 → `readSurface` 打包快照；子 agent 用 `agents.create`（镜像 `agentDefaultModel.currentSelection()`）+ followup 驱动、`whenIdle` 等待、`deriveMessages()` 取回答，`finally` 中释放句柄。
- 浏览器半边 `client/` 注册 `btw` 词条（zh/en）与 `conversation.chat.commandview` 键控行 → `BtwCommandCard`（MarkdownText 渲染，320px 滚动体）。
- 已知限制：btw 子会话（`btw-<uuid>`）继承父 cwd 并持久化，会进入 `::` 标题解析语料——派生标题撞名时触发歧义报错（用 @ 精确定位即可）。
