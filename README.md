# dsh-me

我的全部 DeepSeek Harness 插件，一个 npm 包：一次安装升级，成员各自独立启停与配置。595 个 vitest 用例守护纯决策核心。

## 插件

| 插件 | id | 作用 |
|---|---|---|
| [reference](src/plugins/reference/README.md) | `dsh-reference` | 命名外部目录引用（本地/Git，git 自动物化），@ 挂载 + 自动进系统提示 |
| [memory](src/plugins/memory/README.md) | `dsh-memory` | 跨会话记忆：compaction 自动收割 + 手动记录，过滤后注入持久 context 行；Memory tab 查看 |
| [undo](src/plugins/undo/README.md) | `dsh-undo` | 消息撤销/重做（surface replacement，不动 session 日志） |
| [shortcuts](src/plugins/shortcuts/README.md) | `dsh-ui-shortcuts` | 键盘快捷键：侧栏 / 右栏 / 帮助浮层 |
| [caveman](src/plugins/caveman/README.md) | `dsh-caveman` | `/caveman` 极简回复风格，档位过滤规则注入 |
| [session-messenger](src/plugins/session-messenger/README.md) | `dsh-session-messenger` | 会话间 agent 互发消息与回信路由 |
| [btw](src/plugins/btw/README.md) | `dsh-btw` | `/btw` 顺带一问，主日志零污染 |
| [notification](src/plugins/notification/README.md) | `dsh-ui-notification` | 页面后台时桌面通知：完成 / 出错 / 提问 |
| [peak-rate](src/plugins/peak-rate/README.md) | `dsh-ui-peak-rate` | 高峰计费时段 🔥 2× 提醒 |

功能、示例与配置细节见各自 README。

![dsh](docs/dsh.jpg)

## 安装与更新

`lib/` 不入库，引用前先构建：

```sh
git clone git@github.com:haoliangwu/dsh-me.git
cd dsh-me && pnpm install && pnpm build
dsh plugin --profile web add /path/to/dsh-me
```

重启 `dsh web` 即挂载。更新：`git pull && pnpm build`，再重启 `dsh web`（host 内存里是旧 lib）。

## 结构

包根 `cordis.patch.yml` 为每个成员写一条 insert 行：node 侧各自挂载，client 侧合并为一个 `dsh.client` bundle。实现与测试在 `src/plugins/<name>/`。

## 插件管理

浏览器面板（plugin-registry 薄控制台）管理 profile 插件安装态，无需手改配置：

```sh
dsh plugin --profile web add <plugin-registry>/packages/plugin/console
```
