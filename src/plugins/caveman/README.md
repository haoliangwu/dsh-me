# dsh-caveman

把 [caveman](https://github.com/JuliusBrussee/caveman) 的极简回复风格带进 dsh：全局档位开关，激活时在每个会话（含子代理）的 system prompt 末尾注入横幅 + 按档过滤后的规则集。one `/caveman` 切档，下一回合即生效。

## 事实

- **一个命令**：`/caveman`（无参 = 看状态；`/caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra` 切档；`/caveman off` 彻底关闭）
- **全局单档**：dsh 内所有会话共享一个档位，跨 host 一致
- **纯 host 插件**：无 client 半边，命令行原生渲染
- **23 个 vitest 用例**守护纯决策核心（档位词汇表、SKILL.md 过滤器、路径解析、命令分类）

## 使用

```
/caveman            → CAVEMAN level: lite (flag: ~/.dsh/.caveman-active; SKILL.md: ...; levels: ...)
/caveman full       → CAVEMAN level set to full (persisted)
/caveman off        → CAVEMAN level set to off (persisted)，注入消失
/caveman foo        → 未识别的档位「foo」；合法档位：lite、full、ultra、wenyan-lite、wenyan-full、wenyan-ultra、off
```

激活时，每个回合组装出的 system prompt 末尾会出现：

```
CAVEMAN MODE ACTIVE (full) — session ruleset applies.

（SKILL.md 按当前档过滤后的正文：Rules 全保留，
Intensity 表只留当前档行，示例只留当前档）
```

## 机制

| 决策 | 值 |
|---|---|
| 状态存储 | flag 文件 `~/.dsh/.caveman-active`（原子写，档名字符串） |
| 优先级 | flag 文件 > Config `defaultLevel`（默认 `lite`） |
| 读取时机 | **每次组装现读** — 切档/改 SKILL.md 下一回合即生效，多 host 无陈旧档，重启不丢状态 |
| 注入位置 | `ctx.systemPrompt.section`，name `dsh-caveman:rules`，order 10300（收尾位），`interpolate: false`（规则文本按字面注入） |
| 覆盖范围 | 全组装：主会话、subagent、btw 子会话 |
| SKILL.md 来源 | 渐进解析：`<cwd>/.agents/skills/caveman/SKILL.md` 优先，回落全局 `~/.agents/skills/caveman/SKILL.md` |
| `off` 语义 | 一等档位，写入 flag（真关持久）；手动删 flag 文件 = 重置回 defaultLevel |

`defaultLevel` 可在 profile 的 cordis.patch.yml 覆写（同 `dsh-caveman` 条目的 config）。切换命令会同时 emit `system-prompt/change` 广播刷新。

## 安装配置

见[根 README](../../../README.md)的「安装与更新」。无必填配置，装上即用。

## Known Limitations and Deferred Work

- **路径硬编码**：flag 与全局 SKILL.md 路径（`~/.agents/skills/caveman/SKILL.md`）不可 Config 覆写（spec 决策 7 有意取舍）；多机部署想改路径需改码。
- **项目级 SKILL.md 注入面**：任一 session cwd 下存在 `.agents/skills/caveman/SKILL.md` 即每次组装注入系统提示（无确认/白名单）。打开陌生仓库即生效，属有意设计（自标定规则），风险自知。
- **section order 10300 占位**：官方命名槽已到 persona 后缀 10200，10300 为合法尾位；若官方新增尾部位命名槽，需迁移至 `getSectionOrder`。
- **共享 SKILL.md 格式隐式耦合**：档位过滤正则只保留 `| **level** |` 表行与 `- level:` 示例行；SKILL.md 演化若引入同样式前缀行会在非当前档被静默删除（现格式安全）。
