# x-opencode-session-shim

给 opencode-go 的请求补上缺失的 `x-opencode-session` 头——消除 OpenCode Console Go 的 400 MissingSessionID。

- **无感修复。** 装完即工作，不改任何使用方式；pi-ai ≤0.85.1 不发送这个头的问题被透明补齐。
- **可观测。** 每次注入在 host stdout 留一行日志，可直接核对发出的值。
- **干净卸载。** fetch patch 是 cordis effect-scoped，插件卸载即还原全局。

## 日志长什么样

```
[x-opencode-session-shim] opencode-go: x-opencode-session: session-9f2c1a…
```

## 安装与配置

随 dsh-me 整包安装（见[根 README](../../../README.md)）。零配置，装完即工作。

## 细节

OpenCode Go 要求每个请求携带 `x-opencode-session`。插件 patch host 进程 `globalThis.fetch`，仅拦截 `https://opencode.ai/zen/go` 的请求，注入当前 dsh 会话 id；agentless 调用（无会话上下文）回退固定值 `dsh`。8 个 vitest 用例覆盖头部注入与回退分支。
