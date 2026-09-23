/**
 * dsh-undo browser-core: the pure, dependency-free state derivation (design
 * §4.3). One pass over the client session event window decides every undo
 * fact the UI reads — which turns are currently undone, which chat rows the
 * original (shadowed) rows map to, whether the agent is idle, and
 * message/turn lookups — so restart and pagination are lossless and the
 * derive call is trivially testable.
 *
 * No imports: the input is the structural event-window entry shape, so the
 * browser bundle stays free of the session/llm packages.
 */

/** Replayed turns are renumbered to `FAKE_TURN_BASE + turn` (design §2.2). */
const FAKE_TURN_BASE = 1_000_000

/** The `kind` the chat uses for input rows; keys are `${kind.length}:${kind}${id}`. */
const KIND_INPUT_MESSAGE = 'input-message'

/** The `kind` the chat uses for assistant rows; keys embed `turn:step`. */
const KIND_ASSISTANT_STEP = 'assistant-step'

/** The `kind` the chat uses for tool call/result rows; keys are the callId. */
const KIND_TOOL_CALL = 'tool-call'

/** The `kind` the chat uses for turn-tail rows; never hidden (actions strip anchor). */
const KIND_TURN_TAIL = 'turn-tail'

/** Stable collision-free node key, mirroring the conversation engine's `conversationContextKey`. */
export function nodeKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}

/** Key prefix of every turn-tail row (`${'turn-tail'.length}:turn-tail`). */
export const TURN_TAIL_KEY_PREFIX = nodeKey(KIND_TURN_TAIL, '')

/** One entry of the client session event window (structural). */
export interface SessionEventLikeEntryShape {
  readonly type: 'event' | 'transient'
  readonly event: {
    readonly seq: number
    readonly type: string
    readonly data?: unknown
    readonly surfaceOp?: unknown
    readonly sourceEventSeqs?: readonly number[] | undefined
  }
}

/** Facts of one currently-undone turn (design §4.3 `undoneTurns`). */
export interface UndoneTurnFacts {
  /** The shadowed turn number (a redone fake turn keeps its ≥1e6 value). */
  readonly turn: number
  /** The turn's last user message id (for the composer refill), when any. */
  readonly userMessageId: string | undefined
  /** The turn's last user text, plain-joined ('' when the input had no text). */
  readonly userText: string
}

/** Full derived undo state of one session (design §4.3). */
export interface UndoState {
  /** The highest turn with a `turn/start` in the window. */
  readonly lastTurn: number | undefined
  /** Whether the agent is idle: the last turn is closed and no live chunk is streaming. */
  readonly idle: boolean
  /** Turns currently shadowed by a dsh-undo tombstone that was not redone. */
  readonly undoneTurns: ReadonlyMap<number, UndoneTurnFacts>
  /** Chat node keys of every tombstone-shadowed original row (never re-shown). */
  readonly hiddenKeys: ReadonlySet<string>
  /** Finalized assistant message id → its turn (undo button target lookup). */
  readonly messageTurn: ReadonlyMap<string, number>
  /** Last user text per turn (composer refill after undo). */
  readonly userTextByTurn: ReadonlyMap<number, string>
}

/** Hidden until a real window is read. */
export const EMPTY_UNDO_STATE: UndoState = {
  lastTurn: undefined,
  idle: true,
  undoneTurns: new Map(),
  hiddenKeys: new Set(),
  messageTurn: new Map(),
  userTextByTurn: new Map(),
}

/** The empty-content system message the host mounts to shadow a turn (design §2.1). */
export function isUndoTombstoneShape(event: {
  readonly type: string
  readonly data?: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
}): boolean {
  if (event.type !== 'system/message') return false
  const surfaceOp = event.surfaceOp as { op?: unknown } | undefined
  if (surfaceOp?.op !== 'replace' || event.sourceEventSeqs === undefined) return false
  const marker = (event.data as { message?: { content?: unknown; source?: unknown } } | undefined)?.message
  if (marker === undefined) return false
  const content = marker.content
  if (!Array.isArray(content) || content.length !== 0) return false
  const source = marker.source as { kind?: unknown; plugin?: unknown } | undefined
  return source?.kind === 'plugin' && source.plugin === 'dsh-undo'
}

/** The chat node key one shadowed event's row renders under (design §4.2). */
function nodeKeyOfEvent(event: {
  readonly type: string
  readonly data?: unknown
}): string | undefined {
  const data = event.data as Record<string, unknown> | undefined
  switch (event.type) {
    case 'user/message':
      return typeof data?.id === 'string'
        ? nodeKey(KIND_INPUT_MESSAGE, data.id)
        : undefined
    case 'assistant/message':
      return typeof data?.turn === 'number' && typeof data?.step === 'number'
        ? nodeKey(KIND_ASSISTANT_STEP, `${String(data.turn)}:${String(data.step)}`)
        : undefined
    case 'tool/call':
      return typeof data?.callId === 'string'
        ? nodeKey(KIND_TOOL_CALL, data.callId)
        : undefined
    case 'tool/result': {
      const callId = (data?.message as { source?: { callId?: unknown } } | undefined)?.source?.callId
      return typeof callId === 'string' ? nodeKey(KIND_TOOL_CALL, callId) : undefined
    }
    default:
      return undefined
  }
}

/** Plain-joined text blocks of one message content. */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => {
      if (typeof block !== 'object' || block === null) return false
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    .map(block => block.text)
    .join('')
}

/**
 * Derive every undo fact from one event window (design §4.3): locate
 * tombstones, detect redo copies after each, and map shadowed seqs to chat
 * node keys. Original rows stay hidden for EVERY tombstone (redone or not) —
 * redo renders fresh copies and the shadowed rows must never re-appear.
 * @param entries - the session's event window entries.
 * @returns the derived undo facts.
 */
export function deriveUndoState(entries: readonly SessionEventLikeEntryShape[]): UndoState {
  const events = entries
    .filter((entry): entry is SessionEventLikeEntryShape & { readonly type: 'event' } => entry.type === 'event')
    .map(entry => entry.event)
  const eventsBySeq = new Map<number, (typeof events)[number]>()
  for (const event of events) eventsBySeq.set(event.seq, event)

  const tombstones = events.filter(isUndoTombstoneShape)
  const hiddenKeys = new Set<string>()
  const undoneTurns = new Map<number, UndoneTurnFacts>()
  const messageTurn = new Map<string, number>()
  const userTextByTurn = new Map<number, string>()
  let lastTurn: number | undefined
  let lastTurnStartSeq = -1
  let lastTurnEndSeq = -1
  let currentTurn: number | undefined
  // Redo markers, collected during the scan (seqs ascend): the last fake
  // turn/start per restored original turn (the authoritative recognition
  // rule, design §2.3), plus the last legacy plugin-copied user message
  // (turn-agnostic — the copy carries no turn field; the source marker is
  // retired, kept only as legacy fallback for old rows).
  const fakeTurnStartLastSeq = new Map<number, number>()
  let lastPluginUserCopySeq = -1

  for (const event of events) {
    const data = event.data as { turn?: unknown } | undefined
    if (event.type === 'turn/start' && typeof data?.turn === 'number') {
      lastTurn = data.turn
      lastTurnStartSeq = event.seq
      lastTurnEndSeq = -1
      currentTurn = data.turn
      if (data.turn >= FAKE_TURN_BASE) fakeTurnStartLastSeq.set(data.turn - FAKE_TURN_BASE, event.seq)
    } else if (event.type === 'turn/end' && typeof data?.turn === 'number' && data.turn === lastTurn) {
      lastTurnEndSeq = event.seq
    } else if (event.type === 'user/message') {
      // user/message carries no turn field (host log shape): attribute the
      // text to the turn whose start is the closest earlier boundary. The
      // data IS the message (flat content, no nested message envelope).
      // Genuine user input (source.kind 'user') refills the draft — context
      // splices (magic-context, skill catalogs) never do — and redo copies
      // qualify too: NEW-style copies keep the original kind:'user' source
      // (they sit under a fake turn ≥ FAKE_TURN_BASE, design §2.3), while
      // LEGACY copies carry the retired dsh-undo plugin marker (also only
      // ever under a fake turn). In-turn plugin context rows in a real turn
      // stay excluded.
      const userData = event.data as { content?: unknown; source?: { kind?: unknown; plugin?: unknown } } | undefined
      const legacyCopy = userData?.source?.kind === 'plugin'
        && userData.source.plugin === 'dsh-undo'
        && currentTurn !== undefined && currentTurn >= FAKE_TURN_BASE
      if (currentTurn !== undefined && (userData?.source?.kind === 'user' || legacyCopy)) {
        userTextByTurn.set(currentTurn, messageText(userData?.content))
      }
      if (userData?.source?.plugin === 'dsh-undo') lastPluginUserCopySeq = event.seq
    } else if (event.type === 'assistant/message') {
      // surfaceOp is the string 'append' for plain appends and the object
      // {op:'replace', ...} for replacements (rc.2 runtime wire shape).
      const op = event.surfaceOp as string | { op?: unknown } | undefined
      if (op === 'append') {
        const assistantData = event.data as { turn?: unknown; message?: { id?: unknown } } | undefined
        if (typeof assistantData?.turn === 'number' && typeof assistantData.message?.id === 'string') {
          messageTurn.set(assistantData.message.id, assistantData.turn)
        }
      }
    }
  }
  const lastEntry = entries.at(-1)
  const hasTurns = lastTurnStartSeq >= 0
  const idle = lastEntry?.type !== 'transient' && (!hasTurns || lastTurnEndSeq >= lastTurnStartSeq)

  for (const tombstone of tombstones) {
    const tombstoneTurn = (tombstone.data as { turn?: unknown } | undefined)?.turn
    const turn = typeof tombstoneTurn === 'number' ? tombstoneTurn : undefined
    const shadowed = tombstone.sourceEventSeqs ?? []
    let userMessageId: string | undefined
    for (const seq of shadowed) {
      const shadowedEvent = eventsBySeq.get(seq)
      if (shadowedEvent === undefined) continue
      const key = nodeKeyOfEvent(shadowedEvent)
      if (key !== undefined) hiddenKeys.add(key)
      if (shadowedEvent.type === 'user/message') {
        const shadowedEventData = shadowedEvent.data as
          | { id?: unknown; source?: { kind?: unknown; plugin?: unknown } }
          | undefined
        const shadowedSource = shadowedEventData?.source
        // New-style copies keep the original kind:'user' source; legacy
        // plugin copies count only when the shadowing tombstone sits on a
        // fake turn (undo-of-redo) — never in a real turn.
        const legacyCopy = shadowedSource?.kind === 'plugin'
          && shadowedSource.plugin === 'dsh-undo'
          && turn !== undefined && turn >= FAKE_TURN_BASE
        if ((shadowedSource?.kind === 'user' || legacyCopy) && typeof shadowedEventData?.id === 'string') {
          userMessageId = shadowedEventData.id
        }
      }
    }
    if (turn === undefined) continue
    // Redone: a replayed fake-turn boundary for this turn follows the
    // tombstone. Fake-turn attribution is the AUTHORITATIVE recognition rule
    // (design §2.3): the replay plan appends `turn/start = FAKE_TURN_BASE +
    // turn` before its copies, and a genuine new turn always opens with a
    // real boundary. The retired plugin-copied user-message marker remains
    // as a turn-agnostic legacy fallback for rows written before it was
    // retired. Markers were collected during the scan; seqs ascend, so
    // comparing the LAST marker against the tombstone decides existence
    // after it.
    if ((fakeTurnStartLastSeq.get(turn) ?? -1) > tombstone.seq || lastPluginUserCopySeq > tombstone.seq) continue
    // The draft text comes from the scan's turn attribution — the tombstone
    // carries no extra metadata (its source must stay schema-clean for the
    // persistence admission; the undoId lesson of 2026-09-23).
    const userText = userTextByTurn.get(turn)
    undoneTurns.set(turn, {
      turn,
      userMessageId,
      userText: userText ?? '',
    })
  }

  return {
    lastTurn,
    idle,
    undoneTurns,
    hiddenKeys,
    messageTurn,
    userTextByTurn,
  }
}