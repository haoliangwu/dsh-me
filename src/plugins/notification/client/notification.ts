/**
 * dsh-ui-notification browser-core: pure, dependency-free decision and
 * payload logic. The apply half feeds real session windows, visibility,
 * config, and the Notification API through these functions; specs exercise
 * every branch here without any harness fixtures.
 */

/** The reason payload of a durable `turn/end` event (structural). */
export interface TurnEndReasonShape {
  readonly kind: string
  readonly error?: { readonly message?: string }
}

/** One entry of the client session event window (structural). */
export interface SessionEventLikeEntryShape {
  readonly type: 'event' | 'transient'
  readonly event: {
    readonly type: string
    readonly data?: unknown
  }
}

/** What a `turn/end` reason maps to, per spec. */
export type TurnEndOutcome =
  | { readonly type: 'completion'; readonly truncated: boolean }
  | { readonly type: 'error'; readonly message: string }

/** Notification title marker per trigger type (spec: 事件类型 + 会话名). */
export type TriggerKind = 'completion' | 'error' | 'question'

/** Appended when `max-tokens` ended the turn (spec: 正文注明截断). */
export const TRUNCATION_NOTE = '（已达 max-tokens，输出被截断）'

/** Fallback body when an error reason carries no message. */
export const ERROR_FALLBACK = 'LLM 调用失败'

/**
 * Map a `turn/end` reason to a notification outcome per the spec:
 * `error` → error notification (body = reason.error.message),
 * `completed` → completion, `max-tokens` → completion with truncation note,
 * `aborted` / `blocked` / `interrupted` (and unknown merge-extensible kinds)
 * → nothing.
 * @param reason - the `turn/end` reason payload.
 * @returns the outcome, or null when the reason must not notify.
 */
export function turnEndOutcome(reason: TurnEndReasonShape): TurnEndOutcome | null {
  switch (reason?.kind) {
    case 'completed':
      return { type: 'completion', truncated: false }
    case 'max-tokens':
      return { type: 'completion', truncated: true }
    case 'error':
      return { type: 'error', message: reason.error?.message ?? ERROR_FALLBACK }
    default:
      return null
  }
}

/**
 * The visibility gate (spec: 仅 `document.visibilityState !== 'visible'` 时弹)
 * combined with the trigger's config toggle.
 * @param visibility - the document visibility state.
 * @param enabled - the config toggle for this trigger type.
 * @returns true iff a notification may fire.
 */
export function shouldNotify(visibility: DocumentVisibilityState, enabled: boolean): boolean {
  return enabled && visibility !== 'visible'
}

/**
 * Code-point-safe truncation: the first `max` code points, ellipsized once
 * cut. Never splits surrogate pairs.
 * @param text - the text to bound.
 * @param max - the maximum length in code points.
 * @returns the bounded text.
 */
export function truncate(text: string, max = 200): string {
  if (text.length <= max) return text
  return `${Array.from(text).slice(0, max).join('')}…`
}

/**
 * Plain-text join of the final `assistant/message` of one turn's `content`
 * text blocks (spec: 最后回复前 ~200 字; simple text-chunk join is fine).
 * @param entries - the event window entries.
 * @param turn - the closed turn number.
 * @returns the turn's final assistant text, or '' when none.
 */
export function assistantTurnText(entries: readonly SessionEventLikeEntryShape[], turn: number): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type !== 'event' || entry.event.type !== 'assistant/message') continue
    const data = entry.event.data as { turn?: unknown; message?: { content?: unknown } } | undefined
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
 * Assemble a turn/end notification body: error message verbatim, completion
 * text truncated to ~200 code points with the truncation note appended when
 * the turn hit `max-tokens`.
 * @param outcome - the mapped turn/end outcome.
 * @param text - the turn's final assistant text (raw, unbounded).
 * @returns the notification body.
 */
export function bodyForTurnEnd(outcome: TurnEndOutcome, text: string): string {
  if (outcome.type === 'error') return outcome.message
  const body = truncate(text)
  if (!outcome.truncated) return body
  return body === '' ? TRUNCATION_NOTE : `${body} ${TRUNCATION_NOTE}`
}

/**
 * Question notification body: the questions' texts joined by ` / `.
 * @param items - the request's question items.
 * @returns the body, or '' when no question text exists.
 */
export function questionBody(items: readonly { question?: string }[]): string {
  return items
    .map(item => item.question)
    .filter((question): question is string => typeof question === 'string' && question !== '')
    .join(' / ')
}

/**
 * Notification title: type marker + session name (spec).
 * @param kind - the trigger type.
 * @param sessionName - the session's display title.
 * @returns the title.
 */
export function titleFor(kind: TriggerKind, sessionName: string): string {
  const marker = kind === 'completion' ? '完成' : kind === 'error' ? '错误' : '提问'
  return `[dsh] ${marker}：${sessionName}`
}

/** Notification emitter injected by the apply half. */
export type NotifyFn = (title: string, body: string) => void

/** One Session pending interaction (structural; the question domain's value carries `questions`). */
export interface PendingInteractionShape {
  readonly key: string
  readonly kind: string
  readonly sessionId: string
  readonly questions?: readonly { question?: string }[]
}

/** A question-notification candidate selected from one pending-interactions snapshot. */
export interface PendingQuestionFire {
  readonly sessionId: string
  readonly questions: readonly { question?: string }[]
}

/**
 * Diff a pending-interactions snapshot against the already-handled keys:
 * every not-yet-seen key is reported for marking, and among those, entries of
 * the question domains (`question` / `plan-review`) become notification
 * candidates. Unknown kinds are marked seen without firing — a later snapshot
 * must never re-deliver them. Keys absent from the previous run re-fire only
 * on a genuinely new key.
 * @param seen - keys already handled (index seeds this from the startup snapshot).
 * @param snapshot - the current pending-interactions map (keyed by session id).
 * @returns keys to mark seen and the question notifications to fire.
 */
export function pendingQuestionNotifications(
  seen: ReadonlySet<string>,
  snapshot: ReadonlyMap<string, PendingInteractionShape>,
): { keys: string[]; fired: PendingQuestionFire[] } {
  const keys: string[] = []
  const fired: PendingQuestionFire[] = []
  for (const interaction of snapshot.values()) {
    if (seen.has(interaction.key)) continue
    keys.push(interaction.key)
    if (interaction.kind !== 'question' && interaction.kind !== 'plan-review') continue
    fired.push({ sessionId: interaction.sessionId, questions: interaction.questions ?? [] })
  }
  return { keys, fired }
}

/** The Web Audio surface `playChime` needs (structural). */
export interface AudioContextLike {
  readonly currentTime: number
  readonly destination: unknown
  createOscillator(): {
    connect(node: unknown): void
    start(when?: number): void
    stop(when?: number): void
    frequency: { value: number }
  }
  createGain(): {
    gain: {
      setValueAtTime(v: number, t: number): void
      exponentialRampToValueAtTime(v: number, t: number): void
    }
    connect(node: unknown): void
  }
}

/**
 * Synthesize the two-tone notification chime on a Web Audio graph: sine tone A
 * (880 Hz) over `at`..`at+0.09`, tone B (1174.66 Hz, D6) over
 * `at+0.10`..`at+0.19`, each with a 10 ms attack and exponential decay to
 * silence. Pure over the context-like so the scheduling is unit-testable.
 * @param ac - the (real or fake) audio context.
 * @param at - the chime's start in context seconds (defaults to now).
 */
export function playChime(ac: AudioContextLike, at = ac.currentTime): void {
  const tone = (frequency: number, start: number, end: number): void => {
    const oscillator = ac.createOscillator()
    oscillator.frequency.value = frequency
    const gain = ac.createGain()
    gain.connect(ac.destination)
    oscillator.connect(gain)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    oscillator.start(start)
    oscillator.stop(end)
  }
  tone(880, at, at + 0.09)
  tone(1174.66, at + 0.1, at + 0.19)
}