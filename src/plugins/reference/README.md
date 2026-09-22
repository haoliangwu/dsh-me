# dsh-reference

把 [OpenCode references](https://opencode.ai/v2/docs/references/) 的能力带进 dsh：命名的引用表（alias → 外部目录 + 描述 + 可见性），设置页可视化管理，@ 菜单按别名挂载，引用自动广告进系统提示（`<available_references>` XML 块）— agent 知道有哪些资料、在哪、何时该查。dsh 读操作本无路径边界，无需任何权限机制。

## 事实

- **一张全局表**：存 `$DSH_HOME/settings.yaml`（settings 命名空间 `dsh-reference`），跨 profile 共享、重启持久
- **每步组装现读**：增删改引用，下一回合广告即生效，无需重启
- **双半部插件**：host（命名空间 schema + 广告 section + 原生目录选择器 RPC）+ client（设置页 + @ 触发源）
- **38+ 个 vitest 用例**守护纯决策核（校验、广告组装、候选过滤、提及序列化、选择器命令三平台分支）

## 使用

设置页左侧导航 **References**：新增（alias + path + description + @ 菜单可见性开关）、行内编辑、两步确认删除。path 支持绝对路径与 `~/` 开头，相对路径拒绝；指向不存在目录可保存但行内标 ⚠。path 输入框旁的「Choose folder」弹**系统原生**目录选择框（macOS osascript / Linux zenity→kdialog / Windows PowerShell FolderBrowserDialog），返回真实绝对路径。

输入框打 @ 可看到引用候选（alias + 描述），选中落纯文本 `@<绝对路径>` 提及（含空格路径自动引号形态），agent 用读工具自行访问。

每个引用都出现在每个回合系统提示的尾段（`<available_references>` XML 块，归档旧插件验证过的格式）：

```
Project references provide additional directories that can be accessed when relevant.
<available_references>
  <reference>
    <name>docs</name>
    <path>/Users/u/product-docs</path>
    <description>产品行为与术语</description>
  </reference>
</available_references>
```

无 description 的引用仍广告（只列 name/path，省略 `<description>` 元素）；空表不注入任何内容。hidden 只把引用藏出 @ 菜单，**不**裁剪广告（OC 对齐语义）。设置页里该开关以正向语义呈现为「@ 菜单」：打开 = 出现在 @ 提及菜单，关闭 = 不再出现，广告始终不受影响。

## 机制

| 决策 | 值 |
|---|---|
| 存储 | `ctx.settings.register('dsh-reference', Schema)`；map(alias → { path 必填, description 可选, hidden 默认 false })，写经 settingsScope 走远端 settings mutate |
| 校验 | alias 禁空串、`/`、`\`、空白、反引号、逗号；path 必须 `/` 或 `~/` 开头 — schema 层与保存层同源纯核 |
| 广告 | 动态 `systemPrompt.section`（name `dsh-reference:rules`，order 10400，`interpolate: false`），每步组装现读 settings |
| 挂载 | `InputTriggerSource`（trigger `@`，name `dsh-reference`），hidden 裁剪候选，codec 落纯文本提及 |
| 目录选择器 | host 侧 `/dsh-reference` RPC channel：`exists`（⚠ 探测）+ `pickDirectory`（spawn 系统对话框，取消是一等回答，spawn 失败才走 Linux 兜底链） |
| 类型 | 表单预留 Local / Git(v2) 类型切换 — Git 置灰 |

## Out of scope（v2）

Git 仓库形态（repository/branch、clone/refresh/缓存物化）、per-profile 过滤字段、目录清单快照挂载。旧 `dsh-me:references` 插件（含 git 物化实现）归档于 `archive/legacy-references-plugin` 分支，git 半部将移植回归。

## 安装配置

见[根 README](../../../README.md)的「安装与更新」。无必填配置，装上即用（空表无注入内容）。
