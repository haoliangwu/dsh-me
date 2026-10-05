# dsh-ui-notification

dsh 会话在后台结束时给你发提醒：跑完、出错、问你问题、或一个工具等着你批准。你不用一直盯着窗口看长任务，页面藏在后台时它负责叫醒你——而且**完成、失败、审批用三种不同的提示音**，耳朵一听就知道该回来、该着急、还是该去点一下。

- **四个触发，独立开关。** `notifyCompletion` / `notifyError` / `notifyQuestion` / `notifyApproval`，默认全开。
- **三种音型，一听即辨。** 完成=双音上行（A5→D6）、错误=双音下行（A4→E4）、审批=三连音上行（A5→D6→G6）。
- **前台零打扰。** 仅当页面隐藏时弹；你正在看页面时完全静默。
- **Desktop 也能弹 OS 横幅。** Electron 渲染进程的 HTML5 `Notification` 在 macOS 不弹窗，本插件在桌面壳内改走 host `osascript` 原生通道；浏览器 profile 走标准 Notification API。
- **56 个 vitest 用例**守护事件映射、截断与音型调度。

## 效果

```
[dsh] 完成：重构验证讨论             ← 标题 = 事件类型 + 会话名
全部通过：42 passed, 0 failed       ← 正文 = 末轮回复前 200 字符

[dsh] 审批：重构验证讨论
bash：需要写入 /tmp/x              ← 正文 = 申请工具 + 审批原因
```

点击通知会聚焦回 dsh 窗口。浏览器下首次触发会请求通知权限（点一次「允许」即可）。

## 安装

随 `dsh-me` 整包安装（见[根 README](../../../README.md)）。零配置装完即工作；可选开关写入 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-ui-notification
  config:
    notifyCompletion: true   # completed / max-tokens（截断会在正文注明）
    notifyError: true        # error，正文带 LlmFailure message
    notifyQuestion: true     # agent 提问 / 计划确认
    notifyApproval: true     # 权限审批申请（正文 = 工具名 + 原因）
    notifySound: true        # 音型提示；false 则完全静音
```

## 触发规则

| 触发 | 事件来源 | 音型 |
| --- | --- | --- |
| 完成 | `turn/end` reason `completed` / `max-tokens` | 双音上行 |
| 错误 | `turn/end` reason `error`（LlmFailure message） | 双音下行 |
| 提问 | `sessionStatus.pendingInteraction` kind `question` / `plan-review` | 双音上行 |
| 审批 | `sessionStatus.pendingInteraction` kind `approval` | 三连音上行 |
| 跳过 | `aborted` / `blocked` / `interrupted` | — |

## 工作原理

- 完成/错误：遍历镜像会话，watch `session.eventSource` 的 `append` 扫描 `turn/end`，按 reason 映射结果。
- 提问/审批：读 `uiSession.sessionStatus` 的 pending-interaction 面——平台 answerer 先注册并 claim `user-questions/request` 与 `approval/request` waterfall，后注册的观察者收不到，所以从这里取（`PendingQuestion` kind `question` / `PendingApproval` kind `approval`）。已有 pending 的条目启动时不补弹，未知域静默。
- 声音：`silent: true` 压掉系统音，改播 Web Audio 合成音型；懒加载 `AudioContext`，`resume()` 兼容 autoplay 策略，失败静默。
- 桌面通道：`dsh-*://` 协议（Electron 壳）下每条通知经 RPC `/notification` 端点 `notify` 交给 host，host 用 `osascript display notification` 弹原生横幅，并把标题/正文截到 48/192 字符以适配 macOS 256 字节上限；提示音仍在渲染进程播放。

## 已知限制

- 原生横幅仅在 macOS 生效（osascript）；其他平台的桌面壳静默降级为只剩提示音。
- 审批正文用的是工具侧原始 `reason`，未做本地化。
- 通知身份显示为 `osascript`（macOS 通知中心归属），介意可换 `terminal-notifier` 或等官方通道。