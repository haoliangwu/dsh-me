import { describe, expect, it } from 'vitest'
import {
  deriveUndoState, isUndoTombstoneShape, nodeKey, TURN_TAIL_KEY_PREFIX,
  type SessionEventLikeEntryShape,
} from './undo-state.ts'

/** One durable event window entry. */
function entry(event: Record<string, unknown>): SessionEventLikeEntryShape {
  return { type: 'event', event: event as SessionEventLikeEntryShape['event'] }
}

/** One transient live-chunk entry (agent streaming). */
function transient(): SessionEventLikeEntryShape {
  return { type: 'transient', event: { seq: 999, type: 'assistant/live-chunk', data: {} } }
}

/** A user message event (flat data: the wire shape carries no turn field). */
function user(seq: number, _turn: number, id: string, text: string): SessionEventLikeEntryShape {
  return entry({
    seq, type: 'user/message', surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  })
}

/** An assistant message event. */
function assistant(seq: number, turn: number, step: number, id: string): SessionEventLikeEntryShape {
  return entry({
    seq, type: 'assistant/message', surfaceOp: 'append',
    data: { turn, step, message: { id, role: 'assistant', content: [] } },
  })
}

/** A tool call event. */
function toolCall(seq: number, turn: number, callId: string): SessionEventLikeEntryShape {
  return entry({ seq, type: 'tool/call', data: { turn, step: 0, callId, name: 'write', arguments: '{}' } })
}

/** A tool result event. */
function toolResult(seq: number, turn: number, callId: string): SessionEventLikeEntryShape {
  return entry({
    seq, type: 'tool/result', surfaceOp: 'append',
    data: { turn, step: 0, message: { id: `m-${seq}`, role: 'tool', content: [], source: { callId } } },
  })
}

function turnEnd(seq: number, turn: number): SessionEventLikeEntryShape {
  return entry({ seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

/** A dsh-undo tombstone shadowing `turn`, replacing `shadowed` seqs. */
function tombstone(seq: number, turn: number, shadowed: number[]): SessionEventLikeEntryShape {
  return entry({
    seq, type: 'system/message', surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed.at(-1) },
    sourceEventSeqs: shadowed,
    data: {
      turn, step: 0,
      message: {
        id: `t-${seq}`, role: 'system', content: [],
        source: { kind: 'plugin', plugin: 'dsh-undo' },
      },
    },
  })
}

/** A plugin-copied user message (the redo marker source). */
function copyUser(seq: number, id: string, text: string): SessionEventLikeEntryShape {
  return entry({
    seq, type: 'user/message', surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-undo' } },
  })
}

/** A standard closed two-turn log. */
function twoTurnLog(): SessionEventLikeEntryShape[] {
  return [
    entry({ seq: 1, type: 'turn/start', data: { turn: 1 } }),
    user(2, 1, 'u1', 'first'),
    assistant(3, 1, 0, 'a1'),
    turnEnd(4, 1),
    entry({ seq: 5, type: 'turn/start', data: { turn: 2 } }),
    user(6, 2, 'u2', 'second'),
    toolCall(7, 2, 'c1'),
    toolResult(8, 2, 'c1'),
    assistant(9, 2, 0, 'a2'),
    turnEnd(10, 2),
  ]
}

describe('isUndoTombstoneShape', () => {
  it('recognizes the empty plugin-marked replacement', () => {
    expect(isUndoTombstoneShape({
      type: 'system/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [3],
      data: { message: { content: [], source: { kind: 'plugin', plugin: 'dsh-undo' } } },
    })).toBe(true)
  })

  it('rejects non-system types', () => {
    expect(isUndoTombstoneShape({
      type: 'assistant/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [3],
      data: { message: { content: [], source: { kind: 'plugin', plugin: 'dsh-undo' } } },
    })).toBe(false)
  })

  it('rejects append surface ops and missing citations', () => {
    expect(isUndoTombstoneShape({
      type: 'system/message', surfaceOp: 'append',
      data: { message: { content: [], source: { kind: 'plugin', plugin: 'dsh-undo' } } },
    })).toBe(false)
  })

  it('rejects non-empty content and foreign markers', () => {
    const base = { type: 'system/message', surfaceOp: { op: 'replace' }, sourceEventSeqs: [3] }
    expect(isUndoTombstoneShape({ ...base, data: { message: { content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'dsh-undo' } } } })).toBe(false)
    expect(isUndoTombstoneShape({ ...base, data: { message: { content: [], source: { kind: 'plugin', plugin: 'compact' } } } })).toBe(false)
    expect(isUndoTombstoneShape({ ...base, data: { message: { content: [], source: { kind: 'user' } } } })).toBe(false)
  })
})

describe('deriveUndoState', () => {
  it('maps a plain undo to hiddenKeys, undoneTurns, and the refill text', () => {
    const log = [...twoTurnLog(), tombstone(11, 2, [6, 7, 8, 9])]
    const state = deriveUndoState(log)
    expect(state.lastTurn).toBe(2)
    expect(state.idle).toBe(true)
    expect([...state.undoneTurns.keys()]).toEqual([2])
    const facts = state.undoneTurns.get(2)
    expect(facts?.userMessageId).toBe('u2')
    expect(facts?.userText).toBe('second')
    expect(state.hiddenKeys).toEqual(new Set([
      nodeKey('input-message', 'u2'),
      nodeKey('tool-call', 'c1'),
      nodeKey('assistant-step', '2:0'),
    ]))
    // The turn-tail key prefix is excluded from hiding elsewhere, but stays published.
    expect(TURN_TAIL_KEY_PREFIX).toBe('9:turn-tail')
    expect(state.messageTurn.get('a2')).toBe(2)
    expect(state.userTextByTurn.get(1)).toBe('first')
    expect(state.userTextByTurn.get(2)).toBe('second')
  })

  it('clears the undone fact once a redo copy boundary follows the tombstone', () => {
    const log = [
      ...twoTurnLog(),
      tombstone(11, 2, [6, 7, 8, 9]),
      entry({ seq: 12, type: 'turn/start', data: { turn: 1_000_002 } }),
      user(13, 0, 'u2-copy', 'second'),
      assistant(14, 1_000_002, 0, 'a2-copy'),
      turnEnd(15, 1_000_002),
    ]
    const state = deriveUndoState(log)
    expect(state.undoneTurns.size).toBe(0)
    // Original rows stay hidden even after the redo.
    expect(state.hiddenKeys.has(nodeKey('assistant-step', '2:0'))).toBe(true)
    expect(state.hiddenKeys.has(nodeKey('input-message', 'u2'))).toBe(true)
  })

  it('recognizes a redo via the plugin-copied user message alone', () => {
    const log = [
      ...twoTurnLog(),
      tombstone(11, 2, [6, 7, 8, 9]),
      copyUser(12, 'u2-copy', 'second'),
    ]
    const state = deriveUndoState(log)
    expect(state.undoneTurns.size).toBe(0)
  })

  it('keeps an old tombstone undone when a NEW message follows (redo stale)', () => {
    const log = [
      ...twoTurnLog(),
      tombstone(11, 2, [6, 7, 8, 9]),
      entry({ seq: 12, type: 'turn/start', data: { turn: 3 } }),
      user(13, 3, 'u3', 'third'),
      assistant(14, 3, 0, 'a3'),
      turnEnd(15, 3),
    ]
    const state = deriveUndoState(log)
    expect([...state.undoneTurns.keys()]).toEqual([2])
    expect(state.hiddenKeys.has(nodeKey('assistant-step', '2:0'))).toBe(true)
    // The redo action separately gates on this scan's facts; the fold keeps its own.
    expect(state.messageTurn.get('a3')).toBe(3)
  })

  it('supports consecutive undone tombstones (each adds its own hidden keys)', () => {
    const log = [
      ...twoTurnLog(),
      tombstone(11, 2, [6, 7, 8, 9]),
      tombstone(12, 1, [2, 3]),
    ]
    const state = deriveUndoState(log)
    expect([...state.undoneTurns.keys()]).toEqual([2, 1])
    expect(state.hiddenKeys).toEqual(new Set([
      nodeKey('input-message', 'u2'),
      nodeKey('tool-call', 'c1'),
      nodeKey('assistant-step', '2:0'),
      nodeKey('input-message', 'u1'),
      nodeKey('assistant-step', '1:0'),
    ]))
  })

  it('does not confuse an undo of a REDONE (fake) turn with the original', () => {
    const log = [
      ...twoTurnLog(),
      tombstone(11, 2, [6, 7, 8, 9]),
      entry({ seq: 12, type: 'turn/start', data: { turn: 1_000_002 } }),
      user(13, 0, 'u2-copy', 'second'),
      assistant(14, 1_000_002, 0, 'a2-copy'),
      turnEnd(15, 1_000_002),
      tombstone(16, 1_000_002, [13, 14]),
    ]
    const state = deriveUndoState(log)
    // The copy turn is undone; the original turn's fact was cleared by redo.
    expect([...state.undoneTurns.keys()]).toEqual([1_000_002])
    expect(state.hiddenKeys.has(nodeKey('assistant-step', '2:0'))).toBe(true)
    expect(state.hiddenKeys.has(nodeKey('assistant-step', '1000002:0'))).toBe(true)
  })

  it('reports idle=false while a turn is open or the tail is streaming', () => {
    const openTurn = [...twoTurnLog(), entry({ seq: 11, type: 'turn/start', data: { turn: 3 } })]
    expect(deriveUndoState(openTurn).idle).toBe(false)
    const closed = twoTurnLog()
    expect(deriveUndoState(closed).idle).toBe(true)
    const streaming = [...closed.slice(0, -1), transient()]
    expect(deriveUndoState(streaming).idle).toBe(false)
    expect(deriveUndoState([]).idle).toBe(true)
  })

  it('ignores transient and unknown entries while deriving facts', () => {
    const log = [...twoTurnLog(), transient()]
    const state = deriveUndoState(log)
    expect(state.messageTurn.get('a2')).toBe(2)
    expect(state.lastTurn).toBe(2)
  })

  it('skips shadowed seqs missing from the window (pagination edge)', () => {
    const log = [...twoTurnLog(), tombstone(11, 2, [6, 7, 8, 9, 999])]
    const state = deriveUndoState(log)
    expect(state.hiddenKeys.has(nodeKey('assistant-step', '2:0'))).toBe(true)
    expect([...state.hiddenKeys].length).toBe(3)
  })

  it('refills text only from text blocks (image-only input contributes none)', () => {
    const log = [
      entry({ seq: 1, type: 'turn/start', data: { turn: 1 } }),
      entry({
        seq: 2, type: 'user/message', surfaceOp: 'append',
        data: { id: 'u1', role: 'user', content: [{ type: 'image', image: {} }], source: { kind: 'user' } },
      }),
      assistant(3, 1, 0, 'a1'),
      turnEnd(4, 1),
      tombstone(5, 1, [2, 3]),
    ]
    const state = deriveUndoState(log)
    expect(state.undoneTurns.get(1)?.userText).toBe('')
    expect(state.userTextByTurn.get(1)).toBe('')
  })
})