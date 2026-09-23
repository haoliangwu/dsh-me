/**
 * dsh-undo pure decision core: turn location, tail/shadowed computation,
 * tombstone construction (design §2.1), and the redo replay plan (design
 * §2.2). Zero I/O — event logs and surface node lists are injected, so
 * vitest covers every branch without harness fixtures.
 *
 * The live session's append validation (surface fold) is the authoritative
 * gate on top of these plans: the plans only build the append payloads, the
 * host's `session.append` calls decide acceptance.
 */
import { randomUUID } from 'node:crypto'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage,
  SystemMessage,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SurfaceEventType,
} from '@deepseek-ai/dsh-session'

/** The plugin's canonical identity, stamped on every tombstone and copied user message. */
export const UNDO_PLUGIN = 'dsh-undo'

/**
 * Replayed turns are renumbered to `FAKE_TURN_BASE + originalTurn` so copies
 * are always identifiable (`turn >= 1_000_000`) and never collide with a real
 * turn number. A redo of an already-redone turn compounds the offset
 * (`2_000_000 + T`), which keeps the invariant and never collides.
 */
export const FAKE_TURN_BASE = 1_000_000

/** One recognized dsh-undo tombstone fact, extracted from the log. */
export interface UndoTombstoneMeta {
  /** Seq of the tombstone event itself. */
  readonly seq: number
  /** The shadowed turn (a real turn, or a fake replayed turn ≥ {@link FAKE_TURN_BASE}). */
  readonly turn: number
  /** The shadowed turn's last step, copied onto the tombstone (no runtime meaning). */
  readonly step: number
  /** Every shadowed surface node seq (the tombstone's `sourceEventSeqs`). */
  readonly shadowedSeqs: readonly number[]
}

/**
 * Whether one event is a dsh-undo tombstone: an empty-content
 * `system/message` surface replacement carrying the plugin marker (design
 * §2.1 recognition rule).
 * @param event - event to test.
 * @returns true for a dsh-undo tombstone.
 */
export function isUndoTombstone(event: SessionEvent): boolean {
  if (event.type !== 'system/message' || !isReplacementSurfaceEvent(event)) return false
  if (event.data.message.content.length !== 0) return false
  const source = event.data.message.source
  return source.kind === 'plugin' && source.plugin === UNDO_PLUGIN
}

/**
 * Locate the turn of one finalized assistant message by its message id
 * (feedback precedent: message-feedback/src/index.ts:172-174). Only
 * append-origin assistant messages count — a replaced (compacte- or
 * tombstone-shadowed) copy is not a user-targetable row.
 * @param events - the session's event log.
 * @param messageId - the assistant message id to find.
 * @returns the turn number, or undefined when no such message exists.
 */
export function findAssistantMessageTurn(events: readonly SessionEvent[], messageId: string): number | undefined {
  for (const event of events) {
    if (event.type !== 'assistant/message' || !isAppendSurfaceEvent(event)) continue
    if (event.data.message.id === messageId) return event.data.turn
  }
  return undefined
}

/**
 * The log seq range of one whole turn: its `turn/start` through its
 * `turn/end` (both inclusive).
 * @param events - the session's event log.
 * @param turn - the turn number.
 * @returns the inclusive log range, or undefined when the turn is not closed.
 */
export function turnLogRange(
  events: readonly SessionEvent[],
  turn: number,
): { readonly startSeq: number; readonly endSeq: number } | undefined {
  let startSeq: number | undefined
  let endSeq: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start' && event.data.turn === turn) {
      startSeq = event.seq
      endSeq = undefined
    } else if (startSeq !== undefined && event.type === 'turn/end' && event.data.turn === turn) {
      endSeq = event.seq
      break
    }
  }
  return startSeq !== undefined && endSeq !== undefined ? { startSeq, endSeq } : undefined
}

/**
 * Whether one seq is the current surface tail.
 * @param nodes - the session's surface node seqs in model-visible order.
 * @param seq - the candidate tail seq.
 * @returns true when `seq` is the last surface node.
 */
export function isSurfaceTail(nodes: readonly number[], seq: number): boolean {
  const tail = nodes.at(-1)
  return tail !== undefined && tail === seq
}

/**
 * Whether one turn is the current surface tail once dsh-undo artifacts are
 * peeled off (the cascade gate, design §5 "连续 undo"): walk the surface tail
 * backwards, skipping dsh-undo tombstones and redo-copy rows of OTHER turns
 * (a fake turn ≥ {@link FAKE_TURN_BASE}, or a plugin-copied user message —
 * the §2.3 recognition rule) — and require the first real node to belong to
 * the target turn's log range. After undo N the tombstone shadows only N's
 * rows, so the peeled tail is N-1's closing row and a second undo may proceed;
 * a redo-copied turn is still a valid tail for its own copies. Mirrors the
 * client's redo-copy recognition (client/undo-state.ts §2.3) so both halves
 * agree on what dsh-undo rows look like.
 * @param events - the session's event log (indexed by seq).
 * @param nodes - the session's surface node seqs in model-visible order.
 * @param turn - the candidate turn.
 * @returns true when the target turn's own rows sit at the peeled surface tail.
 */
export function isSurfaceTailTurn(
  events: readonly SessionEvent[],
  nodes: readonly number[],
  turn: number,
): boolean {
  const range = turnLogRange(events, turn)
  if (range === undefined) return false
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    if (seq === undefined) continue
    const event = events[seq]
    if (event === undefined) return false
    if (isUndoTombstone(event)) continue
    const eventTurn = typeof (event.data as { turn?: unknown } | undefined)?.turn === 'number'
      ? (event.data as { turn: number }).turn
      : undefined
    if (eventTurn !== undefined && eventTurn >= FAKE_TURN_BASE && eventTurn !== turn) continue
    // Host-log user/message data IS the message (no turn field); the plugin
    // source marker identifies a replayed copy (design §2.3).
    if (event.type === 'user/message'
      && (event.data as { source?: { plugin?: unknown } } | undefined)?.source?.plugin === UNDO_PLUGIN) continue
    return seq >= range.startSeq && seq <= range.endSeq
  }
  return false
}

/**
 * The turn's surface nodes: every surface node seq inside the turn's log
 * range (turn boundaries keep tool pairs balanced, so the whole contiguous
 * range belongs to the turn).
 * @param nodes - the session's surface node seqs.
 * @param range - the turn's inclusive log range from {@link turnLogRange}.
 * @returns the shadowed surface node seqs, in surface order.
 */
export function shadowedTurnNodes(
  nodes: readonly number[],
  range: { readonly startSeq: number; readonly endSeq: number },
): number[] {
  return nodes.filter(seq => seq >= range.startSeq && seq <= range.endSeq)
}

/**
 * The trailing contiguous positional run of the turn's surface nodes.
 *
 * The surface fold keeps `nodes` in POSITION order, not seq order: a
 * replacement event (e.g. magic-context refreshing a context message) is
 * spliced at the position of the node it replaces, so a later-seq turn node
 * can sit positionally inside an earlier turn's cluster. A replace range is
 * a positional splice, so the tombstone may only claim one contiguous run:
 * walk back from the LAST turn node while the previous node also belongs to
 * the turn. Orphaned turn nodes separated by foreign nodes (context
 * maintenance copies) stay unshadowed — they live positionally inside
 * earlier context and are not conversation content.
 * @param nodes - the session's surface node seqs (positional order).
 * @param turnSeqs - every surface node seq belonging to the turn.
 * @returns the contiguous trailing run, in surface order; empty when the turn has no surface node.
 */
export function trailingTurnRun(nodes: readonly number[], turnSeqs: ReadonlySet<number>): number[] {
  let end = -1
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (turnSeqs.has(nodes[i] as number)) {
      end = i
      break
    }
  }
  if (end === -1) return []
  let start = end
  while (start > 0 && turnSeqs.has(nodes[start - 1] as number)) start--
  return nodes.slice(start, end + 1) as number[]
}

/**
 * The turn's last user message id (the newest human input; the client refills
 * the composer with its text after an undo — design §4.1). Undefined when the
 * turn has no `user/message` event.
 * @param events - the session's event log.
 * @param turn - the turn number.
 * @returns the last user message id in the turn, or undefined.
 */
export function userMessageIdOfTurn(events: readonly SessionEvent[], turn: number): string | undefined {
  const range = turnLogRange(events, turn)
  if (range === undefined) return undefined
  let userMessageId: string | undefined
  for (const event of events.slice(range.startSeq, range.endSeq + 1)) {
    if (event.type === 'user/message') userMessageId = event.data.id
  }
  return userMessageId
}

/**
 * The turn's last step number (the tombstone copies it; it carries no runtime
 * semantics — design §2.1).
 * @param events - the session's event log.
 * @param turn - the turn number.
 * @returns the highest step/assistant step in the turn, or 0.
 */
export function lastStepOfTurn(events: readonly SessionEvent[], turn: number): number {
  const range = turnLogRange(events, turn)
  if (range === undefined) return 0
  let last = 0
  for (const event of events.slice(range.startSeq, range.endSeq + 1)) {
    const step = event.type === 'step/start' || event.type === 'step/end' || event.type === 'assistant/message'
      ? event.data.step
      : undefined
    if (step !== undefined && step > last) last = step
  }
  return last
}

/** The last dsh-undo tombstone in the log (the redo target). */
export interface TombstoneAppend {
  readonly type: 'system/message'
  readonly data: SessionEventMap['system/message']
  /** The replacement range covering every shadowed turn node. */
  readonly surfaceOp: { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
  /** Every shadowed surface node seq — required by the surface replace validation. */
  readonly sourceEventSeqs: readonly number[]
}

/** Inputs for {@link buildTombstoneAppend}. */
export interface TombstoneBuildInput {
  /** The shadowed turn number. */
  readonly turn: number
  /** The shadowed turn's last step. */
  readonly step: number
  /** First shadowed surface seq (inclusive). */
  readonly startSeq: number
  /** Last shadowed surface seq (inclusive). */
  readonly endSeq: number
  /** Every shadowed surface seq, in surface order. */
  readonly shadowedSeqs: readonly number[]
}

/**
 * Build the single-append undo payload (design §2.1): an empty-content
 * `system/message` that replaces the whole turn on the surface. The empty
 * content projects to no wire message (surface.ts:145-148); the plugin marker
 * makes the tombstone recognizable on every log re-read.
 * @param input - turn facts from the undo scan.
 * @returns the append payload (type/data/surface metadata).
 */
export function buildTombstoneAppend(input: TombstoneBuildInput): TombstoneAppend {
  // The source must be schema-clean: the persistence admission relabels every
  // system/message to a user/message (rc.2 relationshipEvent) and audits the
  // source members — anything beyond {kind, plugin, form, sections, summary}
  // fails the flush ("user/message 0 source has unexpected member", the
  // runtime lesson of 2026-09-23). The client derives the draft text from the
  // turn attribution instead of tombstone metadata.
  const source = {
    kind: 'plugin' as const,
    plugin: UNDO_PLUGIN,
  } as SystemMessage['source']
  const message: SystemMessage = {
    id: MessageId(randomUUID()),
    role: 'system',
    content: [],
    source,
  }
  return {
    type: 'system/message',
    data: { turn: input.turn, step: input.step, message },
    surfaceOp: { op: 'replace', startSeq: input.startSeq, endSeq: input.endSeq },
    sourceEventSeqs: [...input.shadowedSeqs],
  }
}

/** One redo replay step carrying surface metadata (a message copy). */
export type RedoAppendStep = RedoSurfaceStep | RedoLogStep

/** A replayed message-producing event: canonical tail append, no source citations. */
export interface RedoSurfaceStep {
  readonly type: 'user/message' | 'assistant/message' | 'tool/result'
  readonly data: SessionEventMap['user/message']
    | SessionEventMap['assistant/message']
    | SessionEventMap['tool/result']
  readonly surfaceOp: 'append'
}

/**
 * A replayed log-only event under the fake turn number: boundaries map to the
 * fake turn (original `turn/end` reasons become `completed` — the replay is a
 * synthetic transcript restore, no model run happened, design §2.2.1), and
 * `tool/call` keeps its original callId/name/arguments with turn moved to the
 * fake turn (design §2.2.4 — the UI renders the tool row against the replayed
 * assistant message).
 */
export interface RedoLogStep {
  readonly type: 'turn/start' | 'step/start' | 'step/end' | 'turn/end' | 'tool/call'
  readonly data: SessionEventMap['turn/start']
    | SessionEventMap['step/start']
    | SessionEventMap['step/end']
    | SessionEventMap['turn/end']
    | SessionEventMap['tool/call']
}

/**
 * Build the redo replay plan (design §2.2): the shadowed turn's events, in
 * log order, renumbered to the fake turn `F = FAKE_TURN_BASE + turn`, with
 * boundaries synthesized and the four message/tool kinds copied. Log-only
 * events with no replay role (request/header, attempts, context) are skipped.
 * @param events - the session's event log.
 * @param tombstone - the tombstone facts from {@link findLastUndoTombstone}.
 * @returns the ordered append steps; throws when the tombstone's turn has no closed log range.
 */
export function buildRedoAppendPlan(
  events: readonly SessionEvent[],
  tombstone: UndoTombstoneMeta,
): RedoAppendStep[] {
  const range = turnLogRange(events, tombstone.turn)
  if (range === undefined) {
    throw new Error(`dsh-undo: tombstone turn ${String(tombstone.turn)} has no closed log range`)
  }
  const fakeTurn = FAKE_TURN_BASE + tombstone.turn
  // Fresh call ids: the client's conversation assembler matches trajectory
  // tool-calls by callId and rejects a second start for the same id, while the
  // original turn's events remain in the live feed — replayed calls must not
  // reuse the original ids (design §2.2.4 amendment, 2026-09-23).
  const callIdRemap = new Map<string, string>()
  for (const event of events.slice(range.startSeq, range.endSeq + 1)) {
    if (event.type === 'tool/call') callIdRemap.set(event.data.callId, ToolCallId(randomUUID()))
  }
  const freshCallId = (id: string): string => callIdRemap.get(id) ?? id
  const plan: RedoAppendStep[] = []
  for (const event of events.slice(range.startSeq, range.endSeq + 1)) {
    switch (event.type) {
      case 'turn/start':
        plan.push({ type: 'turn/start', data: { turn: fakeTurn } })
        break
      case 'step/start':
        plan.push({ type: 'step/start', data: { turn: fakeTurn, step: event.data.step } })
        break
      case 'step/end':
        plan.push({ type: 'step/end', data: { turn: fakeTurn, step: event.data.step } })
        break
      case 'turn/end':
        plan.push({ type: 'turn/end', data: { turn: fakeTurn, reason: { kind: 'completed' } } })
        break
      case 'user/message':
        plan.push({ type: 'user/message', data: replayUserMessage(event.data), surfaceOp: 'append' })
        break
      case 'assistant/message':
        plan.push({ type: 'assistant/message', data: replayAssistantMessage(event.data, fakeTurn, freshCallId), surfaceOp: 'append' })
        break
      case 'tool/call':
        // The call gets a FRESH callId: the client's trajectory assembler
        // matches tool-calls by id and the original turn's events are still
        // in the live feed — a reused id crashes the conversation view
        // (design §2.2.4 amendment). The replayed result and the assistant
        // content's tool-call blocks are remapped to the same fresh id.
        plan.push({
          type: 'tool/call',
          data: {
            turn: fakeTurn,
            step: event.data.step,
            callId: freshCallId(event.data.callId),
            name: event.data.name,
            arguments: event.data.arguments,
          },
        })
        break
      case 'tool/result':
        plan.push({ type: 'tool/result', data: replayToolResult(event.data, fakeTurn, freshCallId), surfaceOp: 'append' })
        break
      default:
        // request/header, assistant/attempt, request/context, session/end-seed,
        // and unknown events have no replay role: boundaries are synthesized
        // and message copies carry their own content.
        break
    }
  }
  return plan
}

/**
 * One replayed user message: fresh id (a same-id second user row would break
 * the client assembler, design §2.2.2), deep-copied content, and the plugin
 * source marker. The user/message projection is verbatim; id/source stay off
 * the wire (design §2.3).
 */
function replayUserMessage(data: SessionEventMap['user/message']): UserMessage {
  return {
    id: MessageId(randomUUID()),
    role: 'user',
    content: structuredClone(data.content),
    source: { kind: 'plugin', plugin: UNDO_PLUGIN },
  }
}

/**
 * One replayed assistant message: deep-copied content + stream, `usage`
 * dropped (the token-meter folds usage by (turn, step), and the fake turn is
 * a new key — copying usage would double-count, design §2.2.3), the message
 * source preserved (model badge), fresh message id (conservative extension —
 * ids never reach the wire, and a fresh id avoids any client message-identity
 * collision with the hidden original row).
 */
function replayAssistantMessage(
  data: SessionEventMap['assistant/message'],
  fakeTurn: number,
  freshCallId: (id: string) => string,
): SessionEventMap['assistant/message'] {
  const message = { ...structuredClone(data.message), id: MessageId(randomUUID()) } as AssistantMessage
  // Remap embedded tool-call block ids to the replayed calls, so the wire
  // and the tool rows pair against the fake turn's fresh call ids.
  message.content = message.content.map((block) =>
    block.type === 'tool-call' ? { ...block, id: ToolCallId(freshCallId(block.id)) } : block,
  )
  return {
    turn: fakeTurn,
    step: data.step,
    message,
    stream: structuredClone(data.stream),
    ...(data.interrupted === true ? { interrupted: true as const } : {}),
  }
}

/**
 * One replayed tool result: fresh message id, remapped callId (must equal
 * `content[0].toolCallId` and pair the REPLAYED tool/call — never the
 * original, whose events remain in the live feed), turn/step moved to the
 * fake turn, error/meta preserved verbatim. The surface op is a plain tail
 * append — no pairing validation exists there (design §2.2.5,
 * surface.ts:483-484; repair.ts:93-125 precedent).
 */
function replayToolResult(
  data: SessionEventMap['tool/result'],
  fakeTurn: number,
  freshCallId: (id: string) => string,
): SessionEventMap['tool/result'] {
  const message = { ...structuredClone(data.message), id: MessageId(randomUUID()) } as ToolResultMessage
  message.source = { ...message.source, callId: ToolCallId(freshCallId(message.source.callId)) }
  message.content = message.content.map((block) =>
    block.type === 'tool-result' ? { ...block, toolCallId: ToolCallId(freshCallId(block.toolCallId)) } : block,
  )
  return {
    turn: fakeTurn,
    step: data.step,
    message,
    ...(data.error === undefined ? {} : { error: structuredClone(data.error) }),
    ...(data.meta === undefined ? {} : { meta: structuredClone(data.meta) }),
  }
}

/**
 * The last dsh-undo tombstone in the log, or undefined when the session was
 * never undone.
 * @param events - the session's event log.
 * @returns the latest tombstone facts.
 */
export function findLastUndoTombstone(events: readonly SessionEvent[]): UndoTombstoneMeta | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'system/message' || !isUndoTombstone(event)) continue
    return {
      seq: event.seq,
      turn: event.data.turn,
      step: event.data.step,
      shadowedSeqs: [...(event.sourceEventSeqs as readonly number[] | undefined ?? [])],
    }
  }
  return undefined
}

/** The full session event type vocabulary (exported so tests can build events). */
export type { SessionEvent, SessionEventMap, SessionEventType, SurfaceEventType }