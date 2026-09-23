/**
 * Shared assistant-text fold: plain-text join of the final `assistant/message`
 * of one turn's content text blocks. Both the notification browser-core and
 * the session-messenger decision core need this same projection (specs:
 * 最后回复前 ~200 字 / 末轮 assistant 文本); the fold lives here once and
 * stays dependency-free so both halves can import it freely.
 */

/** One session-log event as the shared fold needs it (structural). */
export interface AssistantMessageEventLike {
  readonly type: string
  readonly data?: unknown
}

/**
 * The last `assistant/message` of a turn, joined from its text blocks.
 * @param events - the session's event log, newest last.
 * @param turn - the closed turn number.
 * @returns the turn's final assistant text, or '' when none.
 */
export function assistantTextOfTurn(events: readonly AssistantMessageEventLike[], turn: number): string {
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
