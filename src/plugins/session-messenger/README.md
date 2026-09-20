# session-messenger

同 workspace 的 dsh 会话之间，让 agent 互相发消息、互相派活——两边都以普通主 agent 身份运行，不是 subagent。

- **主 agent 对等。** 收到消息的会话自己开回合干活，拥有全部工具与完整上下文，不是受限的子代理。
- **回信自动路由。** 对方回合结束后，回复带溯源头自动送回你的会话（`autoWake: false` 时安静入 inbox）。
- **有防护。** 55 个 vitest 用例守护纯决策核心：目标寻址（id/标题/歧义）、深度闸（`maxHops`）、回信路由策略。

## 试试

在任意会话里让 agent 给另一个会话派活：

```
A 会话「重构验证」                          B 会话「跑测试」

> 请把回归测试交给跑测试会话
  （agent 调用 relay_message）
    to: "跑测试"
    text: "跑一下全量回归，完成后告诉我"
  已投递到会话 session-9f2c…                来自会话 重构验证：
                                           跑一下全量回归，完成后告诉我
                                           …（B 开回合工作）…
来自 跑测试 的回复（turn 3）：              134 passed, 0 failed
134 passed, 0 failed
```

A 无需等待——回信在 B 回合结束后自动送达并唤醒 A。B 忙时消息自然排队，不打断进行中的回合。

## 安装与配置

随 dsh-me 整包安装（见[根 README](../../../README.md)）。零配置装完即工作，可选配置：

```yaml
- id: dsh-session-messenger
  config:
    maxHops: 5       # 消息链深度上限，超出拒发（防 A↔B 乒乓循环），人类输入重置计数
    autoWake: true   # false 时回信 next-turn 入 inbox 不唤醒发送方
```

## 细节

纯 host 插件，同 workspace（`header.cwd` 相同）会话间互通。agent 工具两个：

- **`list_sessions`** — 列可投递目标（session id + 标题 + 运行状态；仅列本 host 有存活 agent 的会话）。
- **`relay_message(to, text)`** — 寻址 = 精确 id → 唯一标题，歧义报候选；A→A 自发拒绝。

投递走 ACP 桥同款 `followup` 通道，消息带「来自会话 <标题>」源头并计 hop（超限拒发）。回信路由监听目标 `turn/end`：`completed`/`max-tokens` 回末轮正文（截断注明）、`error` 回错误摘要，其余 reason（aborted/blocked/interrupted）不回；回信带「来自 <B> 的回复（turn N）」溯源头。只有真正认领 relay 的回合才回信——人类输入、后台任务完成等自然回合不回。

回信以 `role: 'user'` + `source.kind: 'session-messenger'` 落进会话日志，web UI 呈现为可展开的「Context injection」折叠行——呈现层按来源分类（机器投递 ≠ 人类输入），消息本体对模型是完全正常的用户消息。hop 计数正依赖这个 source kind，人类输入（kind 'user'）天然重置链。
