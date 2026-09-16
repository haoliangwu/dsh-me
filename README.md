<h1 align="center">dsh-me</h1>

<p align="center">haoliangwu 的 DSH 插件合集——一个 bundle 装齐我的所有插件。首个成员：peak-rate 高峰时段 🔥 2× 徽章。</p>

## 安装

```sh
dsh plugin --profile web add github:haoliangwu/dsh-me
```

装完重启 web。开发期本地安装：`dsh plugin --profile web add /path/to/dsh-me`。

## 插件

单包多插件：`cordis.patch.yml` 为每个成员插件写一条 insert 行（独立 id，可在 profile 层单独启停/配置），client 侧合并为一个 `dsh.client` bundle。

| 插件 | id | 说明 |
|---|---|---|
| peak-rate | `dsh-ui-peak-rate` | 会话模型命中配置的 provider 列表且处于高峰计费时段（工作日 UTC 窗口，周末全天低峰）时，在输入框尾部显示 🔥 2× 徽章 |
| x-opencode-session-shim | `dsh-x-opencode-session-shim` | OpenCode Go（`opencode-go` provider）要求每个请求携带 `x-opencode-session`（否则 400 MissingSessionID），而 pi-ai 与 dsh 的 llm-pi-ai 均无此 header。插件 patch host 进程 `globalThis.fetch`（effect-scoped 可恢复），对 `https://opencode.ai/zen/go` 的请求注入当前 dsh 会话 id；agentless 调用回退固定值 `dsh`。无配置项。 |

![peak-rate badge](docs/peak-rate-badge.png)

### peak-rate 配置

profile 层 `cordis.patch.yml` 中按 id `dsh-ui-peak-rate` 配置：

```yaml
- id: dsh-ui-peak-rate
  disabled: false
  config:
    providers: [deepseek-official]
    peakWindows: [[1, 4], [6, 10]]  # [startHour, endHour) UTC
    multiplier: 2
```

## 插件管理

已装插件用 plugin-registry 的**薄控制台**管理（浏览器面板）：管理 profile
插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：
`dsh plugin --profile web add <plugin-registry>/packages/plugin/console`
