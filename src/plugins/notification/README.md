# notification

dsh 会话完成、出错、向你提问时，页面在后台就发桌面通知——不用一直盯着窗口等长任务跑完。

- **三种触发独立开关。** 完成 / 错误 / 提问各自可单独关，默认全开。
- **前台零打扰。** 仅 `document.visibilityState` 隐藏时弹；你正看着页面时静默。
- **有声提示。** 42 个 vitest 用例守护事件映射与截断；系统音被 `silent: true` 压掉，改播 Web Audio 双音（880Hz→D6），四档开关独立配置。

## 通知长什么样

```
[dsh] 完成：重构验证讨论          ← 标题 = 事件类型 + 会话名
全部通过：42 passed, 0 failed    ← 正文 = 末轮回复前 200 字符（错误时为 LlmFailure message）
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
    notifySound: true      # 双音提示；false 则完全静音
```

## 细节

纯 client 检测，不动 host。完成/错误挂在 `turn/end` 事件（`completed`/`max-tokens`→完成，`error`→错误，`aborted`/`blocked`/`interrupted` 跳过）；提问观察 `uiSession.pendingInteractions`（平台 answerer 先注册并 claim `user-questions/request` waterfall，后注册的观察者收不到，所以走这个快照 seam）。正文截断按 UTF-16 code point 计算不切 surrogate 对。Web Audio 用模块级懒加载 `AudioContext`，`resume()` 兼容 autoplay 策略，失败静默。
