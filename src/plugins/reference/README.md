# dsh-reference

把 [OpenCode references](https://opencode.ai/v2/docs/references/) 的能力带进 dsh：命名的引用表（alias → 本地目录或 Git 仓库 + 描述 + 可见性），设置页可视化管理，Git 引用自动物化（clone/刷新）到缓存目录，@ 菜单按别名挂载，引用自动广告进系统提示（`<available_references>` XML 块）— agent 知道有哪些资料、在哪、何时该查。dsh 读操作本无路径边界，无需任何权限机制。

## 事实

- **一张全局表**：存 `$DSH_HOME/settings.yaml`（settings 命名空间 `dsh-reference`），跨 profile 共享、重启持久
- **每步组装现读**：增删改引用，下一回合广告即生效，无需重启
- **物化自动触发**：插件加载 + settings 表任何变更后后台物化 git 条目（失败仅日志，不阻塞）
- **双半部插件**：host（命名空间 schema + XOR 校验 + 物化 + 广告 section + RPC）+ client（设置页 + @ 触发源）
- **90+ 个 vitest 用例**守护纯决策核（XOR 校验、refresh 决策矩阵、git 命令组装、广告组装、候选过滤、提及序列化、选择器命令三平台分支）

## 使用

设置页左侧导航 **References**：新增/编辑（类型切换 Local / Git，字段随形态）、两步确认删除。保存的引用立即进 @ 菜单与广告。

- **Local 形态**：path + description + @ 菜单开关。path 支持绝对路径与 `~/` 开头，相对路径拒绝；指向不存在目录可保存但行内标 ⚠。「Choose folder」弹**系统原生**目录选择框（macOS osascript / Linux zenity→kdialog / Windows PowerShell FolderBrowserDialog），返回真实绝对路径。
- **Git 形态**：repository URL（必填，`file://` 拒绝）+ branch（可选）+ description + @ 菜单开关 + 「每次刷新」开关。保存后插件后台 `clone --depth 1`（branch 未填 = 默认分支）到 `<cacheDir>/<alias>`；行内展示 repository（+ branch / 每次刷新标记），不做 ⚠ 路径探测。

⚠ **「每次刷新」= fetch origin + reset --hard**：开启后每次物化都会重置到远端，**摧毁缓存目录里的本地修改** — 只对该条目生效，适合跟踪活跃分支；默认关闭（`missing-only`：缓存已存在就零网络）。

输入框打 @ 可看到引用候选（alias + 描述），选中落纯文本 `@<绝对路径>` 提及（含空格路径自动引号形态；git 引用落物化缓存路径），agent 用读工具自行访问。

每个引用都出现在每个回合系统提示的尾段（`<available_references>` XML 块，归档旧插件验证过的格式）：

```
Project references provide additional directories that can be accessed when relevant.
<available_references>
  <reference>
    <name>docs</name>
    <path>/Users/u/product-docs</path>
    <description>产品行为与术语</description>
  </reference>
  <reference>
    <name>react-source</name>
    <path>/Users/u/.cache/dsh-me/references/react-source</path>
    <description>React 源码（物化缓存路径）</description>
  </reference>
</available_references>
```

无 description 的引用仍广告（只列 name/path，省略 `<description>` 元素）；空表不注入任何内容。hidden 只把引用藏出 @ 菜单，**不**裁剪广告（OC 对齐语义）。设置页里该开关以正向语义呈现为「@ 菜单」：打开 = 出现在 @ 提及菜单，关闭 = 不再出现，广告始终不受影响。

## 机制

| 决策 | 值 |
|---|---|
| 存储 | `ctx.settings.register('dsh-reference', Schema)`；map(alias → 本地 { path } XOR Git { repository, branch?, refresh? }，description 可选，hidden 默认 false)，写经 settingsScope 走远端 settings mutate |
| 校验 | alias 禁空串、`/`、`\`、空白、反引号、逗号；path 必须 `/` 或 `~/` 开头；entry 形态 XOR（混用/缺失拒绝）；repository 禁空、`file://` 拒绝；branch 按 check-ref-format 子集（空白/`~^:?*[\`/`..`/起止或双 `/` 拒绝）— schema 层与保存层同源纯核 |
| 物化 | `git clone --depth 1`（-b branch 可选）→ `<cacheDir>/<alias>`；`missing-only`（默认）缓存存在零网络，branch marker 失配 → 删缓存重 clone；`always` → fetch origin + reset --hard（`origin/<branch||HEAD>`）；失败仅 logger，apply 与 watch 后台发起不阻塞 |
| 触发 | apply（插件加载/HMR）+ `scope.watch`（settings 表任何变更后重跑物化；missing-only 幂等，无需防抖） |
| 缓存目录 | Config `cacheDir`（默认 `~/.cache/dsh-me/references`，cordis.patch.yml 可覆写）；`/dsh-reference` channel `config` 端点把 host 解析值给 client（拉取失败回落默认） |
| 广告 | 动态 `systemPrompt.section`（name `dsh-reference:rules`，order 10400，`interpolate: false`），每步组装现读 settings |
| 挂载 | `InputTriggerSource`（trigger `@`，name `dsh-reference`），hidden 裁剪候选，codec 落纯文本提及 |
| 目录选择器 | host 侧 `/dsh-reference` RPC channel：`exists`（⚠ 探测，仅本地形态）+ `pickDirectory`（spawn 系统对话框，取消是一等回答，spawn 失败才走 Linux 兜底链）+ `config`（cacheDir/refresh 下发） |

## Out of scope（v2 之后）

per-profile 过滤字段、目录清单快照挂载、git 凭据管理（SSH key/https 凭据由系统 git 自理）、OC 的 24h 自动后台刷新与时间戳持久化（missing-only/always 已覆盖需求）。

## 安装配置

见[根 README](../../../README.md)的「安装与更新」。无必填配置，装上即用（空表无注入内容）。
