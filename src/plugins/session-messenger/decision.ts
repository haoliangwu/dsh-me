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
    return byTitle[0]?.sessionId === self.sessionId
      ? { kind: 'self' }
      : { kind: 'target', targetId: byTitle[0]?.sessionId as string }
  }
  return { kind: 'ambiguous', candidates: byTitle }
}

/** One session-log event as the hop reader needs it (structural). */
export interface SessionEventLike {
  readonly type: string
  readonly data?: { readonly source?: { readonly kind?: unknown; readonly hop?: unknown } }
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
    const source = event.data?.source
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