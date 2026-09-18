# dsh-me

一个 npm 包装下我的全部 DeepSeek Harness 插件：一次安装、一次升级，每个插件仍可独立启停和配置。

- **一把装齐。** 一条 `dsh plugin add` 装完整包，新增成员只需 `pnpm build` 重新构建——不用逐个找 repo。
- **独立开关。** 每个成员保留自己的 id，profile 层 `cordis.patch.yml` 单独启停、单独传 config。
- **有测试。** 134 个 vitest 用例守护纯决策核心：寻址与深度闸、回信路由、通知映射、高峰窗口计算。

## 插件

| 插件 | id | 作用 |
|---|---|---|
| session-messenger | `dsh-session-messenger` | 同 workspace 会话间 agent 互发消息并自动路由回信：`list_sessions` 目录发现 + `relay_message` 投递（hop 深度闸 + autoWake 开关） |
| notification | `dsh-ui-notification` | 会话完成/出错/提问时（页面后台）发桌面通知，附 Web Audio 双音提示，三个触发开关独立配置 |
| peak-rate | `dsh-ui-peak-rate` | 模型命中配置的 provider 且处于高峰计费时段时，在输入框尾部显示 🔥 2× 揽钱提醒 |
| x-opencode-session-shim | `dsh-x-opencode-session-shim` | 给 opencode-go 请求补上 `x-opencode-session`，消除 Console Go 的 400 MissingSessionID |

![dsh](docs/dsh.jpg)

## 试试：两个会话让 agent 自己对话

在任意会话里让 agent 给另一个会话派活，回信自动送回——两边都以普通主 agent 身份运行，不是 subagent：

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

A 无需等待——回信会在 B 回合结束后自动送达并唤醒 A（`autoWake: false` 时改为安静入 inbox）。

## 安装与更新

仓库按本地使用维护，`lib/` 不入库，引用前先构建：

```sh
git clone git@github.com:haoliangwu/dsh-me.git
cd dsh-me
pnpm install && pnpm build   # 生成 lib/（gitignored）
dsh plugin --profile web add /path/to/dsh-me
```

重启 `dsh web`，插件即挂载。shim、notification、session-messenger 零配置装完即工作；peak-rate 需要配置才会显示，在 profile 层 `cordis.patch.yml` 按 id 配置：

```yaml
- id: dsh-ui-peak-rate
  disabled: false
  config:
    providers: [deepseek-official]
    peakWindows: [[1, 4], [6, 10]]  # [startHour, endHour) UTC
    multiplier: 2
```

更新：

```sh
git pull && pnpm build
# 重启 dsh web（host 内存里是旧 lib）
```

## 细节

**结构。** 单包多插件：包根 `cordis.patch.yml` 为每个成员写一条 insert 行（子路径 entry），node 侧各自挂载，client 侧合并为一个 `dsh.client` bundle；`package.json` exports 子路径对应各入口。

**session-messenger。** 纯 host 插件，同 workspace（`header.cwd` 相同）会话间以主 agent 身份互通：agent 工具 `list_sessions`（id+标题+运行状态，仅列本 host 有存活 agent 的可投递目标）与 `relay_message(to, text)`（寻址 = 精确 id → 唯一标题，歧义报候选；A→A 自发拒绝）。投递走 ACP 桥同款 `followup` 通道（忙时自然排队）；消息带「来自会话 <标题>」源头并计 hop（`maxHops` 默认 5，超限拒发，人类输入重置链）。回信路由：监听目标 `turn/end`，`completed`/`max-tokens` 回末轮正文（截断注明）、`error` 回错误摘要，其余 reason 不回；回信带「来自 <B> 的回复（turn N）」溯源头，`autoWake`（默认 true）为 false 时 next-turn 不唤醒入 inbox。只有真正认领 relay 的回合才回信——人类输入、后台任务完成等自然回合不回。

**notification。** 纯 client 检测：完成/错误挂在 `turn/end` 事件（`completed`/`max-tokens`→完成，`error`→错误带 LlmFailure message，`aborted`/`blocked`/`interrupted` 跳过）；提问观察 `uiSession.pendingInteractions`（平台 answerer 先注册并 claim `user-questions/request` waterfall，后注册的观察者收不到）。仅 `document.visibilityState` 隐藏时弹；`silent: true` 压系统音，改播 Web Audio 双音（880Hz→D6）；权限懒请求。开关：`notifyCompletion` / `notifyError` / `notifyQuestion` / `notifySound`（默认全 true）。

**peak-rate。** 高峰窗口 = 工作日 UTC 窗口（周末全天低峰）；窗口外徽章隐藏。providers 列表控制哪些 provider 的模型显示提醒。

**x-opencode-session-shim。** OpenCode Go 要求每个请求携带 `x-opencode-session`（pi-ai ≤0.85.1 不发送）。插件 patch host 进程 `globalThis.fetch`（cordis effect-scoped，卸载即还原），对 `https://opencode.ai/zen/go` 的请求注入当前 dsh 会话 id——agentless 调用回退固定值 `dsh`。每次请求在 host stdout 留一行日志 `[x-opencode-session-shim] opencode-go: x-opencode-session: <id>`，可直接观测发出的值。

## 插件管理

已装插件用 plugin-registry 的薄控制台管理（浏览器面板）：管理 profile 插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：

```sh
dsh plugin --profile web add <plugin-registry>/packages/plugin/console
```
