# dsh-me

一个 npm 包装下我的全部 DeepSeek Harness 插件：一次安装、一次升级，每个插件仍可独立启停和配置。

- **一把装齐。** 一条 `dsh plugin add` 装完整包，新增成员只需 `pnpm build` 重新构建——不用逐个找 repo。
- **独立开关。** 每个成员保留自己的 id，profile 层 `cordis.patch.yml` 单独启停、单独传 config。
- **有测试。** 293 个 vitest 用例守护纯决策核心：寻址与深度闸、回信路由、通知映射、高峰窗口计算、caveman 档位与规则过滤、引用表 XOR 校验与 git 物化决策、广告组装。

## 插件

| 插件 | id | 作用 |
|---|---|---|
| [reference](src/plugins/reference/README.md) | `dsh-reference` | OC references 同款：设置页管理命名外部目录（本地或 Git 仓库，git 自动物化到缓存），@ 挂载落纯文本路径，引用自动进系统提示 |
| [caveman](src/plugins/caveman/README.md) | `dsh-caveman` | `/caveman` 全局切换极简回复风格：横幅 + 按档过滤的规则集注入 system prompt，主会话与子代理全覆盖 |
| [session-messenger](src/plugins/session-messenger/README.md) | `dsh-session-messenger` | 同 workspace 会话间 agent 互发消息并自动路由回信（主 agent 对等，非 subagent） |
| [btw](src/plugins/btw/README.md) | `dsh-btw` | `/btw` 顺带一问：子 agent 全 markdown 回答、主日志零污染；`@`/`标题 ::` 可问其他会话的上下文 |
| [notification](src/plugins/notification/README.md) | `dsh-ui-notification` | 会话完成/出错/提问时（页面后台）发桌面通知 + 双音提示 |
| [peak-rate](src/plugins/peak-rate/README.md) | `dsh-ui-peak-rate` | 高峰计费时段在输入框尾部显示 🔥 2× 揽钱提醒 |
| [x-opencode-session-shim](src/plugins/x-opencode-session-shim/README.md) | `dsh-x-opencode-session-shim` | 给 opencode-go 请求补上 `x-opencode-session`，消除 Console Go 的 400 |

每个插件的功能、示例与配置细节见各自目录下的 README。

![dsh](docs/dsh.jpg)

## 安装与更新

仓库按本地使用维护，`lib/` 不入库，引用前先构建：

```sh
git clone git@github.com:haoliangwu/dsh-me.git
cd dsh-me
pnpm install && pnpm build   # 生成 lib/（gitignored）
dsh plugin --profile web add /path/to/dsh-me
```

重启 `dsh web`，插件即挂载。shim、notification、session-messenger 零配置装完即工作；peak-rate 需要配置才会显示（见其 README）。

更新：

```sh
git pull && pnpm build
# 重启 dsh web（host 内存里是旧 lib）
```

## 结构

单包多插件：包根 `cordis.patch.yml` 为每个成员写一条 insert 行（子路径 entry），node 侧各自挂载，client 侧合并为一个 `dsh.client` bundle；`package.json` exports 子路径对应各入口。每个成员的实现与测试在 `src/plugins/<name>/`，文档在其 README。

## 插件管理

已装插件用 plugin-registry 的薄控制台管理（浏览器面板）：管理 profile 插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：

```sh
dsh plugin --profile web add <plugin-registry>/packages/plugin/console
```
