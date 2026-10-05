# dsh-subagent-oc

OpenCode CLI 一次性 subagent provider：每次委托把任务文本喂给 `opencode run --standalone`，
在父会话工作目录起一个独立 OpenCode 进程，跑完回收输出并结算为标准的
`SubagentResult`。与官方 `subagent-codex` / `subagent-claude-code` 同属
out-of-process（CLI 传输）一族，但只依赖本机 `opencode` 可执行文件，无 wire 协议。

## 用法

1. 装 OpenCode CLI（已在 PATH 或配置 `binPath` 绝对路径）。
2. profile patch 挂 provider 条目 + `tool-subagent` 实例（`provider: oc`,
   `toolName: subagent_oc`），模型端即出现 `subagent_oc` 委托工具。
3. 模型选择 `subagent_oc` 时，任务提交给 OpenCode 的 orchestrator agent 执行。

## 配置（`dsh-subagent-oc` 条目）

| 键 | 默认 | 说明 |
|---|---|---|
| `providerName` | `oc` | `ctx.subagents` 上的 provider 名 |
| `binPath` | `opencode` | CLI 可执行文件；绝对路径或 PATH 解析，apply 时 fail loud |
| `model` | 无 | `provider/model#variant`；省略则用 opencode 自身配置 |
| `agent` | `orchestrator` | opencode agent（persona）名 |
| `autoApprove` | `false` | 非交互权限：默认 false 表示被拒即失败；true = `--auto` |
| `showThinking` | `false` | `--thinking` 把思考块并入输出 |
| `env` | `{}` | 显式环境覆盖（拼在 scrub 之后的 overlay 上） |
| `envFromProcess` | `[]` | 从宿主 env 转发的变量名；子进程 seam 会 scrub 凭据形状变量，必须靠这里显式转发（如 `RAKUTEN_IN_HOUSE_LLM_API_KEY`） |
| `disposeGraceMs` | `3000` | 终止分级宽限 |

## 语义

- `NO_START_CAPABILITIES`：`agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/`persona`
  在 seam 层被拒，工具实例配 `maxDepth: provider-managed`。
- exit 0 → `completed`，stdout 为结果文本；非零 → `error`，`diagnostic` 只含安全 facts
  （product/stage/exit code/signal）；abort → 终止子进程 → `aborted`。
- stdout 超 1MB 时 collect 保留尾部并追加固定截断标记，绝不静默丢头。
- 每次 run 一个全新独立会话，不续旧、不 fork；`--standalone` 起私有 server，不碰后台 daemon。

## 已知限制

- 任务经 argv 传递（`opencode run` 无 stdin 选项）：同机 `ps` 可见任务文本；超长任务会
  触发 E2BIG（包装成 startup failure，信息少）。敏感任务留意。
- model 无 key 的 provider 会在子进程里直接 auth 失败——配置 `model` 时选已认证通道
  （`opencode auth list` 确认）。
- 每次 run 会在 opencode 数据目录落一个会话记录（CLI 固有个数限制的留存行为）。
- `--format` 未指定（默认纯文本）；默认输出的「非消息 chrome」未逐版本保证。冒烟验证
  （v2.0.23）输出即回答文本。