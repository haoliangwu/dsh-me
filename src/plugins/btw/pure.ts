/**
 * dsh-btw pure decision core: command-input parsing, target resolution,
 * snapshot head/tail budgeting and packing, and answer extraction.
 * Dependency-free so vitest covers every branch without harness fixtures.
 */

/** Canonical composer @-mention: `@[label](dsh-session:sessionId)`. */
export const MENTION_SOURCE_PATTERN = /@\[[^\]]*\]\(dsh-session:([^)]+)\)/

/** Resolved target channel of one `/btw` invocation. */
export type BtwInputTarget =
  | { readonly kind: 'default' }
  | { readonly kind: 'mention'; readonly sessionId: string }
  | { readonly kind: 'title'; readonly title: string }

/** Result of parsing one raw input. */
export type ParsedBtwInput =
  | { readonly kind: 'parsed'; readonly target: BtwInputTarget; readonly question: string }
  | { readonly kind: 'error'; readonly text: string }

/**
 * Parse the `rawInput` target/request dual channel (spec):
 * - a canonical session mention wins and yields its exact session id;
 * - otherwise a `::` separator yields `标题 :: 问题`;
 * - neither → the default main-session path.
 * The question is the raw input with the target fragment removed; an empty
 * question after extraction is an error. A mix of both channels keeps the
 * mention and treats the remainder (including any `::`) as the question.
 * @param rawInput - the command invocation's raw input.
 * @returns the target channel and question, or a readable error.
 */
export function parseBtwInput(rawInput: string): ParsedBtwInput {
  const mention = rawInput.match(MENTION_SOURCE_PATTERN)
  if (mention?.[1] !== undefined && mention.index !== undefined) {
    const sessionId = mention[1]
    const question = (rawInput.slice(0, mention.index) + rawInput.slice(mention.index + mention[0].length)).trim()
    if (question === '') {
      return { kind: 'error', text: '/btw needs a question after the mentioned session' }
    }
    return { kind: 'parsed', target: { kind: 'mention', sessionId }, question }
  }
  const separator = rawInput.indexOf('::')
  if (separator >= 0) {
    const title = rawInput.slice(0, separator).trim()
    const question = rawInput.slice(separator + 2).trim()
    if (title === '') return { kind: 'error', text: '/btw has an empty target title before ::' }
    if (question === '') return { kind: 'error', text: '/btw needs a question after ::' }
    return { kind: 'parsed', target: { kind: 'title', title }, question }
  }
  const question = rawInput.trim()
  if (question === '') return { kind: 'error', text: '/btw needs a question' }
  return { kind: 'parsed', target: { kind: 'default' }, question }
}

/** One title-matchable session candidate. */
export interface TitleCandidate {
  readonly sessionId: string
  readonly title: string | undefined
}

/** Result of resolving a `::` title within one workspace. */
export type TitleResolution =
  | { readonly kind: 'target'; readonly sessionId: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly TitleCandidate[] }

/**
 * Resolve an exact session title: a unique match within the caller's
 * workspace wins; zero matches is not-found; more than one is ambiguous with
 * every candidate (id + title) listed for the error.
 * @param title - the address supplied before `::`.
 * @param candidates - same-workspace sessions with folded titles.
 * @returns the resolution.
 */
export function resolveTitleTarget(title: string, candidates: readonly TitleCandidate[]): TitleResolution {
  const matches = candidates.filter(candidate => candidate.title === title)
  if (matches.length === 0) return { kind: 'not-found' }
  if (matches.length === 1) return { kind: 'target', sessionId: matches[0].sessionId }
  return { kind: 'ambiguous', candidates: matches }
}

/** One projected conversation message of a snapshot source. */
export interface SnapshotMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Head/tail retention result for one snapshot. */
export interface SnapshotSegments {
  readonly head: string
  readonly tail: string
  readonly headBytes: number
  readonly tailBytes: number
  readonly omittedBytes: number
  /** Number of whole messages neither fully in head nor fully in tail. */
  readonly omittedMessages: number
  readonly truncated: boolean
}

/** UTF-8 byte length (code-point safe via TextEncoder). */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Keep only a code-point-safe prefix of `text` within `maxBytes` UTF-8 bytes. */
export function sliceByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let index = 0
  for (const char of text) {
    const size = utf8Length(char)
    if (bytes + size > maxBytes) break
    bytes += size
    index += char.length
  }
  return text.slice(0, index)
}

/** Whole-line prefix consumption within one byte budget. */
function takeBefore(lines: readonly string[], budget: number): {
  kept: readonly string[]
  partial: string
  consumedLines: number
} {
  let used = 0
  let consumed = 0
  const kept: string[] = []
  for (const line of lines) {
    const bytes = utf8Length(`${line}\n`)
    if (used + bytes > budget) break
    used += bytes
    kept.push(line)
    consumed += 1
  }
  const rest = lines[consumed]
  return {
    kept,
    partial: rest === undefined || used >= budget ? '' : sliceByBytes(rest, budget - used),
    consumedLines: consumed,
  }
}

/**
 * Split one projected conversation into labeled head/tail segments within a
 * UTF-8 byte budget (spec: 头+尾预算): each side gets half (head ceil, tail
 * floor), whole lines first, then a byte-exact prefix/suffix fill of the
 * boundary line. An over-budget middle is reported exactly (bytes and whole
 * messages omitted).
 * @param messages - projected user/assistant messages in order.
 * @param maxBytes - total head+tail budget.
 * @returns the retained head/tail texts and omission stats.
 */
export function selectSnapshotSegments(messages: readonly SnapshotMessage[], maxBytes: number): SnapshotSegments {
  if (messages.length === 0) {
    return { head: '', tail: '', headBytes: 0, tailBytes: 0, omittedBytes: 0, omittedMessages: 0, truncated: false }
  }
  const lines = messages.map(message => `${message.role}: ${message.text}`)
  const totalBytes = utf8Length(lines.join('\n'))
  if (totalBytes <= maxBytes) {
    const head = lines.join('\n')
    return { head, tail: '', headBytes: totalBytes, tailBytes: 0, omittedBytes: 0, omittedMessages: 0, truncated: false }
  }
  const headBudget = Math.ceil(maxBytes / 2)
  const tailBudget = Math.floor(maxBytes / 2)
  const head = takeBefore(lines, headBudget)
  const tail = takeBefore([...lines].reverse(), tailBudget)

  const headKept = head.kept.join('\n')
  const headText = headKept + (head.partial !== '' && headKept !== '' ? '\n' : '') + head.partial
  const tailKept = [...tail.kept].reverse().join('\n')
  const tailText = tail.partial + (tail.partial !== '' && tailKept !== '' ? '\n' : '') + tailKept
  const headBytes = utf8Length(headText)
  // Each side renders at or under its allocation: kept lines account one
  // newline each and render K-1 joins, and the partial/kept separator only
  // exists when both parts are present, so head+tail total never exceeds
  // maxBytes by construction.
  const tailBytes = utf8Length(tailText)

  const headExhausted = head.consumedLines >= lines.length
  const tailEnd = lines.length - tail.consumedLines
  // Middle starts after the head's wholly-kept lines. When head ended without
  // a partial (either a whole line is still unread, or nothing is left), there
  // is no partially-kept boundary line to step over.
  const middleFrom = head.consumedLines + (head.partial === '' && headExhausted ? 0 : 1)
  const middleTo = tailEnd - (tail.partial === '' ? 0 : 1)
  const omittedMessages = Math.max(0, middleTo - middleFrom)

  return {
    head: headText,
    tail: tailText,
    headBytes,
    tailBytes,
    omittedBytes: totalBytes - headBytes - tailBytes,
    omittedMessages,
    truncated: true,
  }
}

/** Session identity carried into a snapshot block. */
export interface SnapshotMeta {
  readonly sessionId: string
  readonly title: string | undefined
  readonly cwd: string | undefined
}

/** Escape the five XML-significant characters for tag attribute text. */
function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Pack one `<referenced-sessions>`-style structured block: session meta
 * (id/title/cwd), separately labeled head and tail segments with their byte
 * counts, an explicit truncation declaration when content outside the budget
 * was omitted, and a standing note that this is a READ-ONLY snapshot of
 * another session — not the current conversation history (spec).
 * @param meta - the referenced session's identity.
 * @param messages - the referenced session's projected conversation.
 * @param maxBytes - head+tail byte budget.
 * @returns the packed model-facing block.
 */
export function packSessionSnapshot(meta: SnapshotMeta, messages: readonly SnapshotMessage[], maxBytes: number): string {
  const segments = selectSnapshotSegments(messages, maxBytes)
  const parts: string[] = ['<referenced-sessions>']
  parts.push('  '
    + `<session id="${escapeXml(meta.sessionId)}" title="${escapeXml(meta.title ?? meta.sessionId)}"`
    + (meta.cwd === undefined ? '' : ` cwd="${escapeXml(meta.cwd)}"`) + '>')
  if (segments.head !== '') {
    parts.push(`    <head bytes="${String(segments.headBytes)}">`)
    parts.push(segments.head.split('\n').map(line => `      ${line}`).join('\n'))
    parts.push('    </head>')
  }
  if (segments.tail !== '') {
    parts.push(`    <tail bytes="${String(segments.tailBytes)}">`)
    parts.push(segments.tail.split('\n').map(line => `      ${line}`).join('\n'))
    parts.push('    </tail>')
  }
  if (segments.truncated) {
    parts.push('    '
      + `<omitted bytes="${String(segments.omittedBytes)}" messages="${String(segments.omittedMessages)}">`
      + 'Conversation content outside the head/tail byte budget was omitted from this snapshot.'
      + '</omitted>')
  }
  parts.push('  </session>')
  parts.push('</referenced-sessions>')
  parts.push('')
  parts.push(`This is a read-only snapshot of another session (${meta.sessionId}), NOT the current conversation history.`)
  return parts.join('\n')
}

/** One derived message as answer/parent-context readers consume it. */
export interface MessageLike {
  readonly role: string
  readonly content: readonly { readonly type?: string; readonly text?: string }[]
}

/**
 * Project `sessionQuery.readSurface().events` (a `SurfaceEvent[]`) into the
 * snapshot's user/assistant messages. Runtime events are `{ type, data }`:
 * `user/message` carries `data.content` + `data.source` (kept only when
 * `source.kind === 'user'`, mirroring the platform's session-reference
 * projection — context injections and other plugin-sourced rows are noise);
 * `assistant/message` carries the message body under `data.message.content`.
 * @param events - surface events of the referenced session.
 * @returns projected user/assistant messages with non-empty text.
 */
export function surfaceEventMessages(events: readonly unknown[]): readonly SnapshotMessage[] {
  const snapshot: SnapshotMessage[] = []
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const record = event as Record<string, unknown>
    const data = record.data
    if (typeof data !== 'object' || data === null) continue
    const payload = data as Record<string, unknown>
    if (record.type === 'user/message') {
      const source = payload.source
      if (typeof source !== 'object' || source === null
        || (source as Record<string, unknown>).kind !== 'user') continue
      const text = textBlocks(payload.content)
      if (text !== '') snapshot.push({ role: 'user', text })
    } else if (record.type === 'assistant/message') {
      const message = payload.message
      if (typeof message !== 'object' || message === null) continue
      const text = textBlocks((message as Record<string, unknown>).content)
      if (text !== '') snapshot.push({ role: 'assistant', text })
    }
  }
  return snapshot
}

/** Join the text blocks of a content array, or '' when it has none. */
function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()
}

/** Join a message's text blocks into one plain string. */
function messageText(message: MessageLike): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * The child agent's answer: the last non-empty assistant text in its derived
 * surface history (`agent.session.deriveMessages()`), per spec.
 * @param messages - the child's derived message history.
 * @returns the final assistant text, or '' when none.
 */
export function extractLastAssistantText(messages: readonly MessageLike[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = messageText(message).trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * Default-path parent context (existing behavior preserved): the last
 * `limit` user/assistant messages of the parent session rendered as
 * `user:`/`assistant:` lines, newest last.
 * @param messages - the parent session's derived message history.
 * @param limit - how many recent messages to carry.
 * @returns the context text, or '' when no text-bearing message exists.
 */
export function parentContextLines(messages: readonly MessageLike[], limit = 10): string {
  const lines = messages
    .map(message => {
      const text = messageText(message).trim()
      if (text === '') return undefined
      const label = message.role === 'user' ? 'user' : 'assistant'
      return `${label}: ${text}`
    })
    .filter((line): line is string => line !== undefined)
  return lines.slice(-limit).join('\n')
}