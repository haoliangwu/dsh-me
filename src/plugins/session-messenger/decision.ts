/**
 * dsh-session-messenger delivery decision core: pure, dependency-free target
 * resolution and hop-gate logic. The host wiring feeds live session catalog,
 * calling-message hop, and config through these functions; specs exercise
 * every branch here without any harness fixtures.
 */

/** Message-source kind stamped on every relay delivered by this plugin. */
export const MESSAGE_SOURCE_KIND = 'session-messenger'

/** One addressable delivery candidate (structural session identity + title). */
export interface TargetLike {
  readonly sessionId: string
  readonly title: string | undefined
}

/** Target resolution result. */
export type TargetResolution =
  | { readonly kind: 'target'; readonly targetId: string }
  | { readonly kind: 'self' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly TargetLike[] }
  | { readonly kind: 'not-found' }

/**
 * Resolve a `to` address: exact session id wins, then an exact-and-unique
 * title; >1 title matches is ambiguous (candidates listed for the error),
 * zero is not-found, and a resolution landing on the calling session itself
 * is rejected as self-send. No fuzzy or partial matching (spec).
 * @param to - the address supplied to the tool.
 * @param self - the calling session.
 * @param candidates - the same-workspace catalog (includes self).
 * @returns the resolution.
 */
export function resolveTarget(
  to: string,
  self: TargetLike,
  candidates: readonly TargetLike[],
): TargetResolution {
  if (to === self.sessionId) return { kind: 'self' }
  for (const candidate of candidates) {
    if (candidate.sessionId === to) return { kind: 'target', targetId: to }
  }
  const byTitle = candidates.filter(candidate => candidate.title === to)
  if (byTitle.length === 0) return { kind: 'not-found' }
  if (byTitle.length === 1) {
    const match = byTitle[0] as TargetLike
    return match.sessionId === self.sessionId
      ? { kind: 'self' }
      : { kind: 'target', targetId: match.sessionId }
  }
  return { kind: 'ambiguous', candidates: byTitle }
}

/** One session-log event as the decision readers need it (structural). */
export interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

/**
 * Hop of the message that started the calling session's current turn: the
 * latest logged `user/message`, scanned backwards. A relay message carries
 * its chain depth; any other source (human input, tools) resets the chain to
 * the start. A relay with a malformed hop is defensively read as 0.
 * @param events - the calling session's event log.
 * @returns the source hop, or undefined when the turn started from non-relay input.
 */
export function hopOfLastUserMessage(events: readonly SessionEventLike[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'user/message') continue
    const source = (event.data as { source?: { kind?: unknown; hop?: unknown } } | undefined)?.source
    if (source?.kind !== MESSAGE_SOURCE_KIND) return undefined
    return typeof source.hop === 'number' && Number.isSafeInteger(source.hop) && source.hop >= 0
      ? source.hop
      : 0
  }
  return undefined
}

/**
 * Compute the hop for one delivery and whether it is admissible: human input
 * starts a chain at 1, every relay delivery adds +1; a delivery that would
 * EXCEED maxHops is refused send-side.
 * @param sourceHop - the calling message's chain hop (undefined = human start).
 * @param maxHops - configured chain ceiling.
 * @returns the hop that would be stamped, or undefined to refuse.
 */
export function nextHop(sourceHop: number | undefined, maxHops: number): number | undefined {
  const hop = (sourceHop ?? 0) + 1
  return hop > maxHops ? undefined : hop
}

/**
 * One relay-candidate session as the catalog needs it (structural).
 */
export interface CatalogCandidateLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
}

/**
 * Same-workspace scope (spec): strict `header.cwd` equality with the caller,
 * self included — a session with a different or defined-but-mismatched cwd
 * is not an addressable target.
 * @param candidates - every live session.
 * @param cwd - the calling session's cwd.
 * @returns the same-workspace subset.
 */
export function sameWorkspace(
  candidates: readonly CatalogCandidateLike[],
  cwd: string | undefined,
): readonly CatalogCandidateLike[] {
  return candidates.filter(candidate => candidate.header.cwd === cwd)
}

/** One catalog row input: identity, title, and live running flag. */
export interface CatalogSessionEntry {
  readonly sessionId: string
  readonly title: string | undefined
  readonly running: boolean
}

/** One deliverable catalog row as the tool returns it. */
export interface CatalogRow {
  readonly sessionId: string
  readonly title: string
  readonly status: '运行中' | '空闲'
}

/**
 * Shape the deliverable catalog: session id, 标题 ('' when the session has
 * none yet), and 状态 — 运行中 when its agent is mid-turn, 空闲 otherwise
 * (a session without a live agent lists as 空闲; delivery to it errors
 * later with 无存活 agent).
 * @param entries - same-workspace sessions with running flags.
 * @returns the tool's catalog rows.
 */
export function deliveryCatalog(entries: readonly CatalogSessionEntry[]): readonly CatalogRow[] {
  return entries.map(entry => ({
    sessionId: entry.sessionId,
    title: entry.title ?? '',
    status: entry.running ? '运行中' : '空闲',
  }))
}

/**
 * Deliverable message body: the sourced header line 「来自会话 <title>」 plus
 * the caller's text (spec), falling back to the session id when the sender
 * has no title yet.
 * @param senderTitle - the calling session's title (if any).
 * @param senderSessionId - the calling session's id.
 * @param text - the tool's message text.
 * @returns the full user-message text.
 */
export function relayBody(senderTitle: string | undefined, senderSessionId: string, text: string): string {
  return `来自会话 ${senderTitle ?? senderSessionId}\n\n${text}`
}

/** Final delivery decision input. */
export interface DeliveryPlanInput {
  readonly to: string
  readonly self: TargetLike
  /** Same-workspace catalog including self. */
  readonly candidates: readonly TargetLike[]
  /** Hop of the calling turn's message; undefined for human input. */
  readonly sourceHop: number | undefined
  readonly maxHops: number
  readonly text: string
}

/** Final delivery decision: deliverable payload or a blocked tool error. */
export type DeliveryPlan =
  | { readonly kind: 'deliver'; readonly targetId: string; readonly body: string; readonly hop: number }
  | { readonly kind: 'blocked'; readonly error: string }

/**
 * The whole send-side decision (spec's relay_message decision surface): the
 * hop gate runs first (send-side interception), then target resolution; a
 * resolve to self, ambiguity (with the candidate list), or no target is a
 * blocked tool error, and a valid target becomes a deliverable relay message.
 * @param input - address, catalog, chain hop, config, and text.
 * @returns deliverable payload or the readable tool error.
 */
export function planDelivery(input: DeliveryPlanInput): DeliveryPlan {
  const hop = nextHop(input.sourceHop, input.maxHops)
  if (hop === undefined) {
    return {
      kind: 'blocked',
      error: `消息链深度已达上限（maxHops=${String(input.maxHops)}），投递被拦截：请让用户手动转发消息以重置链起点`,
    }
  }
  const resolution = resolveTarget(input.to, input.self, input.candidates)
  switch (resolution.kind) {
    case 'target':
      return {
        kind: 'deliver',
        targetId: resolution.targetId,
        body: relayBody(input.self.title, input.self.sessionId, input.text),
        hop,
      }
    case 'self':
      return {
        kind: 'blocked',
        error: '不能把消息发送给自己（A→A 被禁止）：请直接在当前会话继续',
      }
    case 'ambiguous':
      return {
        kind: 'blocked',
        error: `目标标题「${input.to}」不唯一，命中 ${String(resolution.candidates.length)} 个会话：`
          + resolution.candidates
            .map(candidate => `${candidate.sessionId}「${candidate.title ?? '(无标题)'}」`)
            .join('，')
          + '；请改用 session id 精确定位',
      }
    case 'not-found':
      return {
        kind: 'blocked',
        error: `未找到目标会话「${input.to}」：它不是已知的 session id，也没有唯一的标题与之匹配`,
      }
  }
}

// ── reply routing (ticket 03) ────────────────────────────────────────────────

/** The reason payload of a durable `turn/end` event (structural). */
export interface TurnEndReasonShape {
  readonly kind: string
  readonly error?: { readonly message?: string }
}

/** Which end-reason policy a reply follows (conservative: only the three spec'd kinds reply). */
export type ReplyPolicy = 'assistant' | 'error' | 'none'

/**
 * Reply policy for one `turn/end` reason: `completed` and `max-tokens` reply
 * with the turn's final assistant text (max-tokens carries a truncation
 * note), `error` replies with the LlmFailure message. Everything else —
 * `aborted` with any internal cause (user/parent/hook/disposed/legacy),
 * `blocked`, `interrupted`, and unknown merge-extensible kinds — never
 * replies (conservative: an unhandled reason must not fabricate a response).
 * @param reason - the `turn/end` reason payload.
 * @returns the reply policy.
 */
export function replyPolicy(reason: TurnEndReasonShape): ReplyPolicy {
  switch (reason?.kind) {
    case 'completed':
    case 'max-tokens':
      return 'assistant'
    case 'error':
      return 'error'
    default:
      return 'none'
  }
}

/** Appended when the reply turn ended at the output-token ceiling (spec: 注明截断). */
export const REPLY_TRUNCATION_NOTE = '（已达 max-tokens，输出被截断）'

/** Fallback content when an error turn carries no failure message. */
export const REPLY_ERROR_FALLBACK = '目标会话回合失败（无错误详情）'

/**
 * Plain-text join of one turn's final `assistant/message` text blocks (the
 * same fold the notification plugin uses; the reply needs the target's last
 * reply text, spec: 末轮 assistant 文本).
 * @param events - the target session's event log.
 * @param turn - the ended turn number.
 * @returns the turn's final assistant text, or '' when none.
 */
export function assistantTextOfTurn(events: readonly SessionEventLike[], turn: number): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const data = event.data as { turn?: unknown; message?: { content?: unknown } } | undefined
    if (data?.turn !== turn) continue
    const content = Array.isArray(data.message?.content) ? data.message.content : []
    const blocks = content.filter((block): block is { type: 'text'; text: string } => {
      if (typeof block !== 'object' || block === null) return false
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    return blocks.map(block => block.text).join(' ').trim()
  }
  return ''
}

/**
 * Reply body with its provenance header (spec): 「来自 <target title> 的回复
 * （turn N）」 over the assistant text (or error summary), titled by the
 * replier's title or fallback id.
 * @param targetTitle - the replier session's title (if any).
 * @param targetSessionId - the replier session's id.
 * @param turn - the ended turn number.
 * @param content - the reply content (assistant text or error summary).
 * @param truncated - whether the turn hit `max-tokens` (appends the note).
 * @returns the full reply body.
 */
export function replyBody(
  targetTitle: string | undefined,
  targetSessionId: string,
  turn: number,
  content: string,
  truncated: boolean,
): string {
  const header = `来自 ${targetTitle ?? targetSessionId} 的回复（turn ${turn}）`
  const note = truncated ? REPLY_TRUNCATION_NOTE : ''
  if (content.length === 0) return note === '' ? header : `${header}\n\n${note}`
  return note === '' ? `${header}\n\n${content}` : `${header}\n\n${content} ${note}`
}

/** Reply routing decision input (per ended relay turn). */
export interface ReplyPlanInput {
  readonly reason: TurnEndReasonShape
  readonly turn: number
  /** The replier (the relay's target session). */
  readonly target: TargetLike
  /** The ended turn's final assistant text ('' for error turns). */
  readonly assistantText: string
  /** Chain hop stamped on the delivered relay (the turn's leading message). */
  readonly sourceHop: number
  readonly maxHops: number
}

/** Reply routing decision: deliverable reply payload or silence. */
export type ReplyPlan =
  | { readonly kind: 'reply'; readonly body: string; readonly hop: number }
  | { readonly kind: 'none' }

/**
 * The whole reply decision: policy (assistant/error/none), content
 * selection (assistant text vs. error message), and the same hop gate as
 * delivery — the reply hop is relay hop + 1, and an over-limit chain is
 * refused silently (returns none; the wiring logs, never throws into the
 * target's turn — replies are best-effort background routing).
 * @param input - reason, turn, replier identity, text, and chain/config values.
 * @returns the reply payload or none.
 */
export function planReply(input: ReplyPlanInput): ReplyPlan {
  const policy = replyPolicy(input.reason)
  if (policy === 'none') return { kind: 'none' }
  const hop = nextHop(input.sourceHop, input.maxHops)
  if (hop === undefined) return { kind: 'none' }
  const content = policy === 'error'
    ? (input.reason.error?.message ?? REPLY_ERROR_FALLBACK)
    : input.assistantText
  return {
    kind: 'reply',
    body: replyBody(input.target.title, input.target.sessionId, input.turn, content, policy === 'assistant' && input.reason.kind === 'max-tokens'),
    hop,
  }
}