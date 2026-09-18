/**
 * dsh-session-messenger, node half.
 *
 * Registers two agent tools. `list_sessions`: the same-workspace deliverable
 * catalog (session id, title, 运行中/空闲 status). `relay_message(to, text)`:
 * delivers a sourced relay user message into a same-workspace target session
 * and the target starts a turn as a normal main agent — the ACP-bridge
 * delivery path (`ctx.agents.get(targetId) → agent.followup(message)` =
 * next-turn inbox + wake; a busy target naturally queues). Relay messages
 * carry a hop counter (only plugin deliveries accumulate; human input resets
 * the chain) that is depth-gated send-side against `maxHops`. When a relay's
 * turn ends on the target, the reply routes back to the sender through the
 * same delivery seam (autoWake=true wakes; false parks in the next-turn
 * inbox). `autoWake` is consumed by that reply routing.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  MESSAGE_SOURCE_KIND,
  assistantTextOfTurn,
  deliveryCatalog,
  hopOfLastUserMessage,
  planDelivery,
  planReply,
  sameWorkspace,
  type CatalogSessionEntry,
  type SessionEventLike,
  type TargetLike,
  type TurnEndReasonShape,
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
  readonly status: 'idle' | 'running'
  followup(message: RelayMessage): void
  send(message: RelayMessage, target: 'next-turn', wakeup: boolean): void
}

/** The service slices this plugin reads (structural). */
interface MessengerCtx {
  agents: { get(id: string): AgentLike | undefined }
  sessions: { list(): readonly SessionLike[] }
  on(event: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): () => void
  on(event: 'session/disposed', listener: (session: SessionLike) => void): () => void
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

/** Build one relay user message with the plugin's source kind and chain hop. */
function relayMessageFor(body: string, hop: number): RelayMessage {
  return {
    id: messageId(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: { kind: MESSAGE_SOURCE_KIND, hop },
  }
}

/**
 * Mount the `list_sessions` and `relay_message` tools for every session agent
 * (standing registration, the ask-user pattern).
 * @param ctx - host plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const scoped = ctx as unknown as MessengerCtx

  // The shared same-workspace catalog both tools read: sessions whose
  // header.cwd equals the caller's, self included. running reflects the
  // session agent's live status ('running' = mid-turn); an absent or idle
  // agent reads as 空闲 (delivery to an agentless target errors later).
  const catalogFor = (cwd: string | undefined): CatalogSessionEntry[] => sameWorkspace(scoped.sessions.list(), cwd)
    .map(session => ({
      sessionId: session.id,
      title: titleOf(session),
      running: scoped.agents.get(session.id)?.status === 'running',
    }))

  // ── reply routing (ticket 03) ─────────────────────────────────────────────
  // One watch per delivered relay, keyed by the relay message id: when the
  // target session logs that message (its turn claimed the relay) `seen`
  // flips, and the next `turn/end` of that session routes the reply back to
  // the sender (spec policy via planReply) then removes the watch. Human-typed
  // turns never trigger replies — only turns that claimed one of our relays
  // can flip `seen`. Entries are effect-scoped (plugin unload disposes the
  // listeners) and also dropped when the target session is disposed.
  interface RelayWatch {
    readonly senderId: string
    readonly targetId: string
    readonly messageId: string
    readonly hop: number
    seen: boolean
  }
  const watches = new Map<string, RelayWatch>()
  const deliverReply = (watch: RelayWatch, session: SessionLike, turn: number, reason: TurnEndReasonShape): void => {
    const targetTitle = titleOf(session)
    const plan = planReply({
      reason,
      turn,
      target: { sessionId: session.id, title: targetTitle },
      assistantText: assistantTextOfTurn(session.snapshotEvents(), turn),
      sourceHop: watch.hop,
      maxHops: config.maxHops as number,
    })
    if (plan.kind === 'none') {
      // Over-limit or non-replying reason: skip silently for the turn, never
      // throw into it — replies are best-effort background routing (spec).
      ctx.logger.info(`[session-messenger] no reply for ${watch.messageId} (turn ${String(turn)})`)
      return
    }
    const sender = scoped.agents.get(watch.senderId)
    if (sender === undefined) {
      // Sender is no longer live on this host: skip (spec).
      ctx.logger.info(`[session-messenger] sender ${watch.senderId} not live; reply skipped`)
      return
    }
    const message = relayMessageFor(plan.body, plan.hop)
    if (config.autoWake !== false) {
      sender.followup(message)
    } else {
      // autoWake=false: durable next-turn delivery WITHOUT wakeup — the reply
      // sits in the sender's next-turn inbox until the next natural drive.
      sender.send(message, 'next-turn', false)
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      const id = (event.data as { id?: unknown } | undefined)?.id
      if (typeof id !== 'string') return
      const watch = watches.get(id)
      if (watch !== undefined) watch.seen = true
      return
    }
    if (event.type !== 'turn/end') return
    const data = event.data as { turn?: unknown; reason?: TurnEndReasonShape } | undefined
    if (data === undefined || typeof data.turn !== 'number' || data.reason === undefined) return
    // Only turns that claimed one of our delivered relays flip `seen`; human
    // turns never trigger a reply. The relay message is the sole ordinary
    // message of its own turn, so at most one watch can be seen per turn.
    const watch = [...watches.values()].find(candidate => candidate.targetId === session.id && candidate.seen)
    if (watch === undefined) return
    watches.delete(watch.messageId)
    deliverReply(watch, session, data.turn, data.reason)
  })
  // Drop watches whose relay target was disposed before the relay was claimed;
  // listener teardown on plugin unload covers the rest (effect-scoped, no leaks).
  ctx.on('session/disposed', (session) => {
    for (const [messageId, watch] of watches) {
      if (watch.targetId === session.id) watches.delete(messageId)
    }
  })

  ctx.tools.register(defineTool({
    name: 'list_sessions',
    // dsh-tools' schema compiler requires `parameters` to be an object of
    // value schemas; a no-params tool must pass an empty object, not omit it.
    parameters: {},
    description:
      '列出同一工作区（同一 cwd）内所有可投递会话：session id、标题、状态（运行中/空闲）。'
      + '投递前先调用本工具确认目标存在与状态；运行中的会话收到消息会排队，空闲的会话会立即开回合。',
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                status: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { sessions: readonly { sessionId: string; title?: string; status?: string }[] }) => [{
        type: 'text',
        // The model must see every row (id + title + status) to address relay_message.
        text: JSON.stringify(value.sessions),
      }],
    },
    async execute(_args: Record<string, never>, exec: { agent?: AgentLike; signal?: AbortSignal }) {
      const caller = exec.agent
      if (caller === undefined) {
        throw new Error('list_sessions 需要调用方 agent（exec.agent 为空）')
      }
      exec.signal?.throwIfAborted()
      return { sessions: deliveryCatalog(catalogFor(caller.session.header.cwd)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_message',
    description:
      '把一条消息投递给同一工作区（同一 cwd）的另一个会话，目标会话会以普通主 agent 身份开回合处理这条消息。'
      + '先调用 list_sessions 查看可投递目标的 session id 与状态。'
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
      const candidates: TargetLike[] = catalogFor(caller.session.header.cwd)
        .map(entry => ({ sessionId: entry.sessionId, title: entry.title }))
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
      const message = relayMessageFor(plan.body, plan.hop)
      // next-turn inbox + wake: an idle target starts a turn, a busy target
      // queues and consumes the message after its current turn (spec).
      target.followup(message)
      // Arm the reply route: watch the target for the turn this relay starts.
      watches.set(message.id, {
        senderId: caller.id,
        targetId: plan.targetId,
        messageId: message.id,
        hop: plan.hop,
        seen: false,
      })
      return { delivered: true, sessionId: plan.targetId }
    },
  }))
}