# dsh-me

一个 npm 包装下我的全部 DeepSeek Harness 插件：一次安装、一次升级，每个插件仍可独立启停和配置。

- **一把装齐。** 一个包一条 `dsh plugin add` 装完整包，新增成员只需重新构建——不用逐个找 repo。
- **独立开关。** 每个成员插件保留自己的 id，profile 层 `cordis.patch.yml` 可单独启停、单独传 config。
- **有测试。** 79 个 vitest 用例；本地使用：clone 后 `pnpm install && pnpm build` 生成 `lib/`（构建产物不入库）。

## 本地引用与构建

仓库按本地使用维护，`lib/` 不入库，引用前先构建：

```sh
git clone git@github.com:haoliangwu/dsh-me.git
cd dsh-me
pnpm install
pnpm build          # 生成 lib/（gitignored）
```

引用进 profile（本地路径，`link:` 语义，改动 `pnpm build` 后重启 host 即生效）：

```sh
dsh plugin --profile web add /path/to/dsh-me
```

更新：

```sh
git pull && pnpm build
# 重启 dsh web（host 内存里是旧 lib）
```

## 插件

| 插件 | id | 作用 |
|---|---|---|
| peak-rate | `dsh-ui-peak-rate` | 模型命中配置的 provider 且处于高峰计费时段时，在输入框尾部显示 🔥 2× 揽钱提醒 |
| x-opencode-session-shim | `dsh-x-opencode-session-shim` | 给 opencode-go 请求补上 `x-opencode-session`，消除 Console Go 的 400 MissingSessionID |
| notification | `dsh-ui-notification` | 会话完成/出错/提问时（页面后台）发桌面通知，附 Web Audio 双音提示，三个触发开关独立配置 |

![peak-rate badge](docs/peak-rate-badge.png)

## 快速上手

1. 构建并安装（见上文「本地引用与构建」）：

   ```sh
   pnpm install && pnpm build
   dsh plugin --profile web add /path/to/dsh-me
   ```

2. 重启 `dsh web`，插件即挂载。

3. peak-rate 需要配置才会显示（shim、notification 零配置，装完即工作）。在 profile 层 `cordis.patch.yml` 按 id 配置：

   ```yaml
   - id: dsh-ui-peak-rate
     disabled: false
     config:
       providers: [deepseek-official]
       peakWindows: [[1, 4], [6, 10]]  # [startHour, endHour) UTC
       multiplier: 2
   ```

## 细节

**结构。** 单包多插件：包根 `cordis.patch.yml` 为每个成员写一条 insert 行（子路径 entry），node 侧各自挂载，client 侧合并为一个 `dsh.client` bundle；`package.json` exports 子路径对应各入口。

**peak-rate。** 高峰窗口 = 工作日 UTC 窗口（周末全天低峰）；窗口外徽章隐藏。providers 列表控制哪些 provider 的模型显示提醒。

**x-opencode-session-shim。** OpenCode Go 要求每个请求携带 `x-opencode-session`（pi-ai ≤0.85.1 不发送）。插件 patch host 进程 `globalThis.fetch`（cordis effect-scoped，卸载即还原），对 `https://opencode.ai/zen/go` 的请求注入当前 dsh 会话 id——agentless 调用回退固定值 `dsh`。每次请求在 host stdout 留一行日志 `[x-opencode-session-shim] opencode-go: x-opencode-session: <id>`，可直接观测发出的值。

**notification。** 纯 client 检测：完成/错误挂在 `turn/end` 事件（`completed`/`max-tokens`→完成，`error`→错误带 LlmFailure message，`aborted`/`blocked`/`interrupted` 跳过）；提问观察 `uiSession.pendingInteractions`（平台 answerer 先注册并 claim `user-questions/request` waterfall，后注册的观察者收不到）。仅 `document.visibilityState` 隐藏时弹；`silent: true` 压系统音，改播 Web Audio 双音（880Hz→D6）；权限懒请求。开关：`notifyCompletion` / `notifyError` / `notifyQuestion` / `notifySound`（默认全 true）。

## 插件管理

已装插件用 plugin-registry 的薄控制台管理（浏览器面板）：管理 profile 插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：

```sh
dsh plugin --profile web add <plugin-registry>/packages/plugin/console
```
