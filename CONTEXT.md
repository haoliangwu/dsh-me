# CONTEXT.md

Domain glossary for dsh-me. Terms resolve here; implementation details stay in specs and code.

## 插件形态

- **Plugin**: dsh-me 导出的子路径插件，保持独立 plugin id（profile 层可单独开关/配置）。
- **Host half**: 插件的 Node 侧（`index.ts`）。
- **Client half**: 插件的浏览器侧（`client/index.ts`），经 dsh.client 挂载；浏览器能力（UI、Web API）归这一半。

## 通知域（dsh-notification）

- **通知触发**: 会话生命周期中值得弹桌面通知的三个时刻：提问、完成、错误。
- **提问**: agent 通过 user-questions 机制向用户发起的询问（`user-questions/request`，agent 专属 ask 事件）。与回合结束无关，回合中途也会发生。
- **完成**: agent 回合正常结束（`turn/end`，completed；max-tokens 视为完成但注明截断）。
- **错误**: agent 回合以失败告终（`turn/end`，error，携带 LlmFailure）。
- **静默策略**: 页面可见时不打扰 — 仅在页面隐藏/失焦时弹通知。
