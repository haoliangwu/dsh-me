# dsh-undo

Opencode 风格的消息撤销（rewind）与重做（redo），通过官方 surface replacement
机制实现，不修改 session 日志、不 fork 会话、不 monkey-patch。

设计文档：`.scratch/dsh-undo/design.md`（机制、边界情况、源码坐标）。

## 功能

- **撤销**：assistant turn 尾部（`conversation.chat.assistant-actions` slot）的撤销
  按钮。点击后该 turn 从模型上下文中移除（`session.append` 一个空 content 的
  `system/message` tombstone，携带 `surfaceOp replace`），界面隐藏对应行，并把
  被撤销的用户消息原文回填输入框（`setDraft`），可修改后重新发送。
- **重做**：turn 尾部 actions 条（`conversation.chat.assistant-actions` slot）的
  「重做」icon 按钮，仅在对应 turn 处于已撤销（undone）态时显示——撤销后原始行被
  隐藏，而 actions 条所在的行（`turn-tail` 行）不被隐藏引擎隐藏，重做按钮正好补位
  撤销按钮腾出的同一位置。点击后按原 surface 顺序向日志纯 append 重放该 turn 的
  全部事件（用户消息、assistant 回复、工具调用与结果，fake turn ≥ 1_000_000），
  模型上下文恢复原样，界面重新显示该轮内容，**不重新执行 LLM run**。
- **级联撤销**：撤销最后一个 turn 后，倒数第二个 turn 成为新的尾部，可继续撤销。
- 状态全部由日志事件派生：重启、刷新、翻页后撤销/重做状态保持一致。

## 交互限制

| 限制 | 说明 |
| --- | --- |
| 仅最后一个 turn 可撤销 | surface replacement 只能作用于当前 surface 尾部区间 |
| 重做仅对最近撤销的 turn | 发送新消息后，更早的重做入口永久失效 |
| agent 运行中拒绝 | 先等 turn 结束再撤销 |
| 图片输入不回填 | 撤销后回填文本，图片需手动重新附加 |
| sdk-minimal profile 不支持 | 该 profile 的 session invariant 会拒绝本插件的 append，fail loud |

## 实现分层

- `pure.ts`：纯决策核（turn 定位、shadowed 区间、tombstone 与重放计划构造、
  surface 视角 tail 判定）。
- `index.ts`：host half——`/dsh-undo` RPC 通道（undo / redo 端点）、idle 与
  tail 校验、per-session 串行队列。
- `client/`：浏览器 half——撤销/重做按钮、日志单遍扫描的状态派生
  （`undo-state.ts`）、行隐藏引擎（`undo-engine.ts`，DOM 内联 `display:none`
  + MutationObserver 重打）。两个按钮经 slot inject 的 `hooks` 区把
  per-session `UndoSurface` 绑定为 `useUndo` selector hook 读状态——组件自治，
  不再发布 conversation location data（0.1.5-rc.2 assembler 要求 published data
  的 key 必须等于 definition kind）。
