# dsh-ui-shortcuts

dsh web UI 的键盘快捷键插件：监听 document keydown，把安全键位映射到布局与
帮助浮层动作。全程零 DOM 代理——动作经注入的 Cordis 服务调用
（`ctx.layout` / `ctx.sidebarRight` / `shell.overlay` slot）。

## 功能

| 动作 | 默认绑定 | 行为 | 实现 |
| --- | --- | --- | --- |
| 侧边栏 | `CmdOrCtrl+B` | 收/展左侧栏 | `ctx.layout.toggleSidebar()` |
| 右面板 | `CmdOrCtrl+I` | 开/关右面板 | `ctx.sidebarRight.toggleExpanded()` |
| 帮助浮层 | `Shift+?` | 打开/关闭快捷键帮助 | `shell.overlay` slot 注册的 Modal |

`CmdOrCtrl` 平台中立：macOS 上等同 `⌘`，Windows/Linux 上等同 `Ctrl`。帮助浮层
内显示当前平台符号（macOS 显示 ⌘，其余显示 Ctrl）。

> **聚焦 composer 动作（`/`）不在本版本**：pinned `0.1.5-rc.2` 的
> `SessionInput` 没有 `focus()`，按前置验证结论整条砍掉，不引入 DOM hack。等
> pinned 版本补上 `SessionInput.focus()` 后随依赖升级回归。

## 守卫（guard）

- **IME 组字**：`isComposing`、自维护 composition flag、以及 compositionend 后
  0ms 窗口内的抑制标记三者命中任一，整次按键全部跳过（同时覆盖 WebKit
  compositionend 先于最终 keydown、Chrome/Firefox 相反两种事件顺序）。
- **IME 全角标点**：中文输入法直接上屏的全角字符（如 Shift+/ 的 `？` U+FF1F，
  无组字事件）按 Unicode 全角→半角折叠后匹配——半角绑定的 `?` 照常触发。
- **单键绑定**（无修饰键）：事件目标或 `document.activeElement` 是
  input / textarea / contentEditable 时跳过——打字时不抢键。
- **修饰键组合**：无论焦点在哪照常触发（策略 B，VS Code 同款）——聊天焦点常驻
  composer，全跳则快捷键形同虚设。
- Escape 键：帮助浮层打开时关闭浮层并 `preventDefault`/`stopPropagation`
  （document capture 层，赢过其他 document Escape 处理器）。

## 改键（部署者）

profile 层按插件 id 配置，语法与默认值写库：

```yaml
# cordis.patch.yml 或用户 profile
plugins:
  dsh-ui-shortcuts:
    bindings:
      sidebar: CmdOrCtrl+B      # 默认
      rightbar: CmdOrCtrl+I     # 默认
      help: Shift+?             # 默认
```

语法：`Modifier+Modifier+Key`，最后一个 token 是键。修饰键大小写不敏感：
`CmdOrCtrl`（macOS=⌘，其余=Ctrl）、`Cmd`/`Meta`、`Ctrl`、`Shift`、
`Alt`/`Option`。键可以是单个字符（`?`、`/`、`b`……）或命名键
（`Escape`、`Enter`、`ArrowUp`、`F5`、`Space`……）。绑定了语法错误会在**启动期**
报错（Config 层抛 `z.ValidationError`），不会静默失效。

## 浏览器/OS 保留键避雷清单

保留组合（reserved combo）在页面看到按键之前就被浏览器或 OS 消费，改绑定时避开
下列实例：

| 组合 | 谁吃掉 |
| --- | --- |
| `Cmd/Ctrl+W`（关标签）`T`（新标签）`N`（新窗口）`Q`（退出）`M`（最小化）`H`（隐藏，macOS）`L`（地址栏）`D`（收藏）`1-9`（切标签） | 浏览器/OS |
| 裸 `⌘+字母` | macOS Safari 内大量组合被浏览器保留 |
| 大多数 `Cmd` 组合 | macOS 平台最严 |

经验法则：改绑定时优先 `CmdOrCtrl+Shift+字母` 或无默认键位的普通字母。浏览器
拦截严格度：Firefox 几乎全部组合可拦截（最宽松），Chrome/Edge 居中，Safari
最严。本插件不做保留组合 denylist 校验——清单随平台/浏览器漂移，永不完备，所以
避雷责任放在 README。

## 实现分层

- `pure.ts`：纯绑定语法解析器与匹配器（host Config 校验与浏览器引擎共享）。
- `index.ts`：host half——`/shortcuts` RPC 通道（`config` 端点），走
  Connection-RPC 信封（POST-only、JSON client-request/server-response）。
- `client/`：浏览器 half——`shortcuts-engine.ts`（document keydown +
  composition 监听、守卫、派发）、`ShortcutsHelp.tsx`（`shell.overlay` Modal
  浮层）。所有注册（监听器、slot、locale、store）都在 `ctx.effect` 内，fiber
  拆除即还原（HMR 安全）。