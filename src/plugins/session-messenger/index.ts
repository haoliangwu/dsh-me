/**
 * dsh-session-messenger, node half.
 *
 * Registers the `relay_message(to, text)` agent tool: it delivers a sourced
 * relay user message into a same-workspace target session and the target
 * starts a turn as a normal main agent — the ACP-bridge delivery path
 * (`ctx.agents.get(targetId) → agent.followup(message)` = next-turn inbox +
 * wake; a busy target naturally queues). Relay messages carry a hop counter
 * (only plugin deliveries accumulate; human input resets the chain) that is
 * depth-gated send-side against `maxHops`. Ticket 02 adds `list_sessions`;
 * ticket 03 adds reply routing. `autoWake` is declared now (default true)
 * and consumed by ticket 03 only.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  MESSAGE_SOURCE_KIND,
  hopOfLastUserMessage,
  planDelivery,
  type TargetLike,
} from './decision.ts'

/** Cordis plugin name. */
export const name = 'dsh-session-messenger'

/** Required services: the tool registry, the agents registry, and the host session store. */
export const inject = ['agents', 'sessions', 'tools']

/** Plugin config: chain depth ceiling and (ticket 03) reply wake policy. */
export interface Config {
  /** Maximum relay chain depth; deliveries exceeding it are refused send-side (default: 5). */
  maxHops?: number
  /** Wake the sender for an injected reply when idle (default: true; consumed by reply routing, ticket 03). */
  autoWake?: boolean
}

export const Config = z.object({
  maxHops: z.number().step(1).min(1).default(5),
  autoWake: z.boolean().default(true),
})

/** Structural user message as the agent runtime consumes it. */
interface RelayMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { type: 'text'; text: string }[]
  readonly source: { readonly kind: typeof MESSAGE_SOURCE_KIND; readonly hop: number }
}

/** Structural host Session (title fold + cwd + event log). */
interface SessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
  snapshotEvents(): readonly { readonly type: string; readonly data?: unknown }[]
}

/** Structural live Agent. */
interface AgentLike {
  readonly id: string
  readonly session: SessionLike
  followup(message: RelayMessage): void
}

/** The service slices this plugin reads (structural). */
interface MessengerCtx {
  agents: { get(id: string): AgentLike | undefined }
  sessions: { list(): readonly SessionLike[] }
}

/** Fold the latest logged title like the session-title service does. */
function titleOf(session: SessionLike): string | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'session/title') continue
    const title = (event.data as { title?: unknown } | undefined)?.title
    if (typeof title === 'string' && title !== '') return title
  }
  return undefined
}

/** Stable opaque message id (crypto uuid with a degraded fallback). */
function messageId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID()
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Mount the `relay_message` tool for every session agent (standing
 * registration, the ask-user pattern).
 * @param ctx - host plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const scoped = ctx as unknown as MessengerCtx

  ctx.tools.register(defineTool({
    name: 'relay_message',
    description:
      '把一条消息投递给同一工作区（同一 cwd）的另一个会话，目标会话会以普通主 agent 身份开回合处理这条消息。'
      + '`to` 接受精确的 session id，或标题全等且唯一命中的会话标题（多个会话同标题会报歧义错误并列出候选）。'
      + '`text` 是交给目标会话的完整指令。不要发给当前会话自己。',
    parameters: {
      to: {
        type: 'string',
        required: true,
        description: '目标会话：精确 session id，或标题全等唯一命中的会话标题',
      },
      text: {
        type: 'string',
        required: true,
        description: '要投递给目标会话的完整消息内容（作为对方的完整指令）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          sessionId: { type: 'string', required: true },
        },
      },
      render: (_args, value: { delivered: boolean; sessionId: string }) => [{
        type: 'text',
        text: value.delivered ? `已投递到会话 ${value.sessionId}` : '投递未完成',
      }],
    },
    async execute(args: { to: string; text: string }, exec: { agent?: AgentLike; signal?: AbortSignal }) {
      const caller = exec.agent
      if (caller === undefined) {
        throw new Error('relay_message 需要调用方 agent（exec.agent 为空）')
      }
      // Alive check, the ACP-bridge pattern: only the exact live instance may deliver.
      if (scoped.agents.get(caller.id) !== caller) {
        throw new Error('调用方 agent 已不在存活列表，请重试')
      }
      exec.signal?.throwIfAborted()

      // Same-workspace catalog: sessions sharing the caller's cwd, self included.
      const cwd = caller.session.header.cwd
      const candidates: TargetLike[] = scoped.sessions.list()
        .filter(session => session.header.cwd === cwd)
        .map(session => ({ sessionId: session.id, title: titleOf(session) }))
      const sourceHop = hopOfLastUserMessage(caller.session.snapshotEvents())
      const plan = planDelivery({
        to: args.to,
        self: { sessionId: caller.id, title: titleOf(caller.session) },
        candidates,
        sourceHop,
        maxHops: config.maxHops as number,
        text: args.text,
      })
      exec.signal?.throwIfAborted()
      if (plan.kind === 'blocked') throw new Error(plan.error)

      const target = scoped.agents.get(plan.targetId)
      if (target === undefined) {
        throw new Error(`目标会话 ${plan.targetId} 无存活 agent（无法开回合），请稍后重试`)
      }
      const message: RelayMessage = {
        id: messageId(),
        role: 'user',
        content: [{ type: 'text', text: plan.body }],
        source: { kind: MESSAGE_SOURCE_KIND, hop: plan.hop },
      }
      // next-turn inbox + wake: an idle target starts a turn, a busy target
      // queues and consumes the message after its current turn (spec).
      target.followup(message)
      return { delivered: true, sessionId: plan.targetId }
    },
  }))
}