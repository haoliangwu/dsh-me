# notification

dsh 会话完成、出错、向你提问、或工具申请权限审批时，页面在后台就发桌面通知——不用一直盯着窗口等长任务跑完。

- **四种触发独立开关。** 完成 / 错误 / 提问 / 审批各自可单独关，默认全开。
- **前台零打扰。** 仅 `document.visibilityState` 隐藏时弹；你正看着页面时静默。
- **有声提示。** vitest 用例守护事件映射与截断；系统音被 `silent: true` 压掉，改播 Web Audio 双音（880Hz→D6），开关独立配置。

## 通知长什么样

```
[dsh] 完成：重构验证讨论          ← 标题 = 事件类型 + 会话名
全部通过：42 passed, 0 failed    ← 正文 = 末轮回复前 200 字符（错误时为 LlmFailure message）

[dsh] 审批：重构验证讨论
bash：需要写入 /tmp/x           ← 正文 = 申请工具名 + 审批原因
```

点击通知聚焦 dsh 窗口。首次触发时浏览器请求通知权限（点一次「允许」即可）。

## 安装与配置

随 dsh-me 整包安装（见[根 README](../../../README.md)）。零配置装完即工作，可选开关：

```yaml
- id: dsh-ui-notification
  config:
    notifyCompletion: true   # completed / max-tokens（截断会在正文注明）
    notifyError: true       # error，正文带 LlmFailure message
    notifyQuestion: true    # agent 提问 / 计划确认
    notifyApproval: true    # 权限审批申请（body = 工具名 + 原因）
    notifySound: true      # 双音提示；false 则完全静音
```

## 细节

纯 client 检测，host 只做两件事：RPC 返回开关、desktop 代发原生通知。完成/错误挂在 `turn/end` 事件（`completed`/`max-tokens`→完成，`error`→错误，`aborted`/`blocked`/`interrupted` 跳过）；提问/审批观察 `uiSession.sessionStatus`（平台 answerer 先注册并 claim `user-questions/request` 与 `approval/request` waterfall，后注册的观察者收不到，所以走 0.1.7 的 pending-interaction face：每会话状态行的 `pendingInteraction`，`PendingQuestion` kind `question` / `PendingApproval` kind `approval`）。

**桌面 (Electron) 通道**：桌面壳里渲染进程的 HTML5 `new Notification()` 不弹 macOS 通知（壳主进程才有原生 `Notification`，且无 IPC 桥），所以 client 在非 http 协议（`dsh-*://`）下把每条通知 POST 到 host `/notification` 端点 `notify`，host 用 `osascript display notification` 弹原生横幅；提示音仍在渲染进程播 Web Audio 双音。浏览器 profile（web）不受影响，走渲染进程 Notification API。macOS 通知正文上限 256 字节，host 先把标题/正文截断到 48/192 字符再交系统（超出部分系统再截断）。

正文截断按 UTF-16 code point 计算不切 surrogate 对。Web Audio 用模块级懒加载 `AudioContext`，`resume()` 兼容 autoplay 策略，失败静默。
