# peak-rate

模型命中你配置的 provider 且处于高峰计费时段时，在输入框尾部显示 🔥 2× 提醒——发起请求前就知道这轮要花双倍。

- **看一眼就知道。** 徽章只出现在 composer 尾部，高峰外完全隐藏。
- **按 provider 过滤。** 只提醒你关心的 provider（比如官方计费源），代理/内网源不受打扰。
- **有测试。** 29 个 vitest 用例守护窗口判定（工作日/周末/跨夜窗口边界）。

## 徽章长什么样

```
┌──────────────────────────────────────┐
│ Message or run a task...      🔥 2× │   ← 高峰时段，命中 provider 时
└──────────────────────────────────────┘
```

## 安装与配置

随 dsh-me 整包安装（见[根 README](../../../README.md)）。**本插件必须配置才会显示**，在 profile 层 `cordis.patch.yml` 按 id 配置：

```yaml
- id: dsh-ui-peak-rate
  disabled: false
  config:
    providers: [deepseek-official]     # 哪些 provider 的模型显示提醒
    peakWindows: [[1, 4], [6, 10]]    # [startHour, endHour) UTC，可多窗口
    multiplier: 2                      # 显示的倍率数字
```

## 细节

高峰窗口 = 工作日 UTC 窗口（周末全天低峰）；窗口外徽章隐藏。providers 列表控制哪些 provider 的模型显示提醒。纯 client 实现，随会话模型切换实时更新。
