/**
 * dsh-undo host tests: the pure decision core (turn location, shadowed
 * computation, tombstone/replay construction) plus the undo/redo endpoints'
 * reject and round-trip paths against REAL `@deepseek-ai/dsh-session`
 * sessions with stubbed agents (the RPC envelope transport itself is the
 * notification pattern and is not re-tested here).
 */
import { describe, expect, it } from 'vitest'
import {
  Session,
  SessionId,
  SessionSeq,
  foldSurface,
  type SessionEvent,
  type SessionEventMap,
} from '@deepseek-ai/dsh-session'
import {
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type Message,
} from '@deepseek-ai/dsh-llm'
import {
  FAKE_TURN_BASE,
  UNDO_PLUGIN,
  buildRedoAppendPlan,
  buildTombstoneAppend,
  findAssistantMessageTurn,
  findLastUndoTombstone,
  isSurfaceTail,
  isSurfaceTailTurn,
  isUndoTombstone,
  lastStepOfTurn,
  shadowedTurnNodes,
  trailingTurnRun,
  turnLogRange,
  userMessageIdOfTurn,
} from './pure.ts'
import { appendRedoStep, performRedo, performUndo, type UndoHost } from './index.ts'
import { assertV3RowAdmission } from '@deepseek-ai/dsh-session-format-v2-to-v3'

/** Ids of one appended plain turn. */
interface TurnIds {
  readonly userMessageId: string
  readonly assistantMessageId: string
}

/** Append one plain text-only turn (boundaries + user + assistant). */
function appendPlainTurn(session: Session, turn: number, text = `question ${String(turn)}`): TurnIds {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 0 })
  const user = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  session.append('user/message', user, { surfaceOp: 'append' })
  const assistant = createAssistantMessage({
    content: [{ type: 'text', text: `answer ${String(turn)}` }],
    source: { provider: 'deepseek-official', model: 'v4-flash' },
  })
  session.append('assistant/message', { turn, step: 0, message: assistant, stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 0 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { userMessageId: user.id, assistantMessageId: assistant.id }
}

/** A fresh detached session with `count` plain turns. */
function sessionWithTurns(sessionId: string, count: number, systemPrompt?: string): { session: Session; ids: TurnIds[] } {
  const session = Session.create(SessionId(sessionId))
  if (systemPrompt !== undefined) {
    session.append('system/message', {
      turn: 0,
      step: 0,
      message: createSystemMessage(systemPrompt, 'dsh-agent-instructions'),
    }, { surfaceOp: 'append' })
  }
  const ids: TurnIds[] = []
  for (let turn = 1; turn <= count; turn += 1) ids.push(appendPlainTurn(session, turn))
  return { session, ids }
}

/** Append one tool-calling turn (assistant with tool-call content + call/result pair). */
function appendToolTurn(session: Session, turn: number): TurnIds & { toolCallId: string } {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 0 })
  const user = createUserMessage({ content: [{ type: 'text', text: 'run the tool' }], source: { kind: 'user' } })
  session.append('user/message', user, { surfaceOp: 'append' })
  const assistant = createAssistantMessage({
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: ToolCallId(`call-${turn}`), name: 'list_files', arguments: '{}' },
    ],
    source: { provider: 'deepseek-official', model: 'v4-flash' },
  })
  session.append('assistant/message', {
    turn,
    step: 0,
    message: assistant,
    stream: [],
    usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', {
    turn,
    step: 0,
    callId: ToolCallId(`call-${turn}`),
    name: 'list_files',
    arguments: '{}',
  })
  const result = createToolResultMessage({
    callId: ToolCallId(`call-${turn}`),
    content: [{ type: 'text', text: 'x.txt' }],
    isError: false,
  })
  session.append('tool/result', { turn, step: 0, message: result }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn, step: 0 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { userMessageId: user.id, assistantMessageId: assistant.id, toolCallId: `call-${turn}` }
}

/** A stub host carrying the given live session and agent status. */
function hostOf(session: Session | undefined, status: 'idle' | 'running' | 'absent' = 'idle'): UndoHost {
  return {
    sessions: { get: id => (session !== undefined && id === session.id ? session : undefined) },
    agents: {
      get: id => (status === 'absent' ? undefined : { id, status }),
    },
  }
}

/** The undone turn's whole surface range as the tombstone's shadowed list. */
function shadowedNodesOf(session: Session, turn: number): SessionSeq[] {
  const range = turnLogRange(session.snapshotEvents(), turn)
  if (range === undefined) throw new Error('no turn range')
  return shadowedTurnNodes([...session.surface.nodes], range).map(SessionSeq)
}

/** Tombstone one turn directly (the host endpoint does exactly this). */
function undoTurn(session: Session, turn: number): void {
  const events = session.snapshotEvents()
  const range = turnLogRange(events, turn)
  if (range === undefined) throw new Error('no turn range')
  const shadowed = shadowedTurnNodes([...session.surface.nodes], range)
  const append = buildTombstoneAppend({
    turn,
    step: lastStepOfTurn(events, turn),
    startSeq: shadowed[0] as number,
    endSeq: shadowed.at(-1) as number,
    shadowedSeqs: shadowed,
  })
  session.append('system/message', append.data, {
    surfaceOp: { op: 'replace', startSeq: SessionSeq(append.surfaceOp.startSeq), endSeq: SessionSeq(append.surfaceOp.endSeq) },
    sourceEventSeqs: append.sourceEventSeqs.map(SessionSeq),
  })
}

/** Role+content projection for wire-equality assertions. */
function contentOf(messages: readonly Message[]): unknown[] {
  return messages.map(message => ({ role: message.role, content: message.content }))
}

describe('pure: turn location', () => {
  it('finds the turn of an append-origin assistant message by id', () => {
    const { session, ids } = sessionWithTurns('pure-locate-1', 2)
    const events = session.snapshotEvents()
    expect(findAssistantMessageTurn(events, ids[0]?.assistantMessageId as string)).toBe(1)
    expect(findAssistantMessageTurn(events, ids[1]?.assistantMessageId as string)).toBe(2)
    expect(findAssistantMessageTurn(events, 'nope')).toBeUndefined()
  })

  it('reports one turn log range', () => {
    const { session } = sessionWithTurns('pure-locate-2', 2)
    const events = session.snapshotEvents()
    expect(turnLogRange(events, 2)).toEqual({ startSeq: 6, endSeq: 11 })
    expect(turnLogRange(events, 9)).toBeUndefined()
  })

  it('returns undefined for an unclosed turn range', () => {
    const session = Session.create(SessionId('pure-locate-3'))
    session.append('turn/start', { turn: 5 })
    expect(turnLogRange(session.snapshotEvents(), 5)).toBeUndefined()
  })
})

describe('pure: shadowed computation, tail and step facts', () => {
  it('selects only the surface nodes inside the turn range', () => {
    expect(shadowedTurnNodes([0, 1, 2, 3, 4], { startSeq: 1, endSeq: 3 })).toEqual([1, 2, 3])
    expect(shadowedTurnNodes([0, 1, 2], { startSeq: 0, endSeq: 2 })).toEqual([0, 1, 2])
    expect(shadowedTurnNodes([5], { startSeq: 0, endSeq: 9 })).toEqual([5])
  })

  it('trailingTurnRun claims only the contiguous positional tail (magic-context regression)', () => {
    // Live shape: seq 31 (a turn-2 replacement event) is spliced at seq 16's
    // position inside turn 1's cluster, so the fold's node order is NOT
    // seq-sorted. The tombstone may claim one contiguous positional run only.
    const nodes = [13, 14, 15, 31, 17, 18, 19, 25, 33, 35]
    const turn2 = new Set(shadowedTurnNodes(nodes, { startSeq: 29, endSeq: 37 }))
    expect([...turn2]).toEqual([31, 33, 35])
    expect(trailingTurnRun(nodes, turn2)).toEqual([33, 35])
    // Contiguous turns claim everything.
    const turn1 = new Set(shadowedTurnNodes(nodes, { startSeq: 10, endSeq: 27 }))
    expect(trailingTurnRun(nodes, turn1)).toEqual([17, 18, 19, 25])
    // Empty/absent turns claim nothing.
    expect(trailingTurnRun(nodes, new Set())).toEqual([])
    expect(trailingTurnRun([], new Set([1]))).toEqual([])
  })

  it('detects the surface tail and the last user message/step of a turn', () => {
    const session = Session.create(SessionId('pure-shadow-1'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    const user = createUserMessage({ content: [{ type: 'text', text: 'q1' }], source: { kind: 'user' } })
    session.append('user/message', user, { surfaceOp: 'append' })
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'a1' }],
      source: { provider: 'deepseek-official', model: 'v4-flash' },
    })
    session.append('assistant/message', { turn: 1, step: 0, message: assistant, stream: [] }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 0 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const events = session.snapshotEvents()
    const nodes = [...session.surface.nodes]
    expect(isSurfaceTail(nodes, nodes.at(-1) as number)).toBe(true)
    expect(isSurfaceTail(nodes, 0)).toBe(false)
    expect(isSurfaceTail([], 0)).toBe(false)
    expect(userMessageIdOfTurn(events, 1)).toBe(user.id)
    expect(lastStepOfTurn(events, 1)).toBe(1)
  })
})

describe('pure: surface-perspective tail (cascade, §5)', () => {
  it('peels stacked tombstones and accepts the exposed real turn', () => {
    const { session } = sessionWithTurns('pure-tail-stack', 3)
    undoTurn(session, 3)
    undoTurn(session, 2)
    const events = session.snapshotEvents()
    const nodes = [...session.surface.nodes]
    expect(isSurfaceTailTurn(events, nodes, 1)).toBe(true)
    expect(isSurfaceTailTurn(events, nodes, 2)).toBe(false)
    expect(isSurfaceTailTurn(events, nodes, 3)).toBe(false)
  })

  it('accepts a redo-copied turn whose own copies are the surface tail', () => {
    const { session } = sessionWithTurns('pure-tail-redo', 1)
    undoTurn(session, 1)
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    if (tombstone === undefined) throw new Error('no tombstone')
    for (const step of buildRedoAppendPlan(session.snapshotEvents(), tombstone)) {
      appendRedoStep(session, step)
    }
    const events = session.snapshotEvents()
    const nodes = [...session.surface.nodes]
    expect(isSurfaceTailTurn(events, nodes, FAKE_TURN_BASE + 1)).toBe(true)
    // The original turn's rows are gone; it is no longer undoable.
    expect(isSurfaceTailTurn(events, nodes, 1)).toBe(false)
  })

  it('rejects when the real tail belongs to a different turn or the range is unclosed/empty', () => {
    const { session } = sessionWithTurns('pure-tail-neighbor', 2)
    const events = session.snapshotEvents()
    const nodes = [...session.surface.nodes]
    expect(isSurfaceTailTurn(events, nodes, 1)).toBe(false)
    expect(isSurfaceTailTurn(events, nodes, 2)).toBe(true)
    expect(isSurfaceTailTurn(events, [], 2)).toBe(false)
    const open = Session.create(SessionId('pure-tail-open'))
    open.append('turn/start', { turn: 9 })
    expect(isSurfaceTailTurn(open.snapshotEvents(), [...open.surface.nodes], 9)).toBe(false)
  })

  it('peels a redo-copied turn from the tail and accepts the real turn below it', () => {
    const { session } = sessionWithTurns('pure-tail-under-copy', 2)
    undoTurn(session, 2)
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    if (tombstone === undefined) throw new Error('no tombstone')
    for (const step of buildRedoAppendPlan(session.snapshotEvents(), tombstone)) {
      appendRedoStep(session, step)
    }
    const events = session.snapshotEvents()
    const nodes = [...session.surface.nodes]
    expect(isSurfaceTailTurn(events, nodes, 1)).toBe(true)
    expect(isSurfaceTailTurn(events, nodes, 2)).toBe(false)
  })
})

describe('pure: tombstone recognition and construction (§2.1)', () => {
  it('recognizes only empty plugin-marked system/message replacements', () => {
    const { session, ids } = sessionWithTurns('pure-tombstone-1', 1)
    const events = session.snapshotEvents()
    const shadowed = shadowedNodesOf(session, 1)
    const append = buildTombstoneAppend({
      turn: 1,
      step: 0,
      startSeq: shadowed[0] as number,
      endSeq: shadowed.at(-1) as number,
      shadowedSeqs: shadowed,
    })
    const tombstone = session.append('system/message', append.data, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(append.surfaceOp.startSeq), endSeq: SessionSeq(append.surfaceOp.endSeq) },
      sourceEventSeqs: append.sourceEventSeqs.map(SessionSeq),
    })
    expect(isUndoTombstone(tombstone)).toBe(true)
    // A non-plugin empty system replacement is not ours.
    const foreign = session.append('system/message', {
      turn: 1,
      step: 0,
      message: createSystemMessage('', 'somebody-else'),
    }, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(tombstone.seq), endSeq: SessionSeq(tombstone.seq) },
      sourceEventSeqs: [tombstone.seq],
    })
    expect(isUndoTombstone(foreign)).toBe(false)
    // An append-origin empty system message is not a tombstone either.
    const plain = session.append('system/message', {
      turn: 1,
      step: 0,
      message: createSystemMessage('', UNDO_PLUGIN),
    }, { surfaceOp: 'append' })
    expect(isUndoTombstone(plain)).toBe(false)
    void events
  })

  it('builds the §2.1 tombstone append payload', () => {
    const append = buildTombstoneAppend({
      turn: 7,
      step: 2,
      startSeq: 10,
      endSeq: 13,
      shadowedSeqs: [10, 11, 12, 13],
    })
    expect(append.type).toBe('system/message')
    expect(append.data.turn).toBe(7)
    expect(append.data.step).toBe(2)
    expect(append.data.message.role).toBe('system')
    expect(append.data.message.content).toEqual([])
    // Schema-clean source: the persistence admission relabels system/message
    // to user/message and audits members — anything beyond {kind, plugin,
    // form, sections, summary} fails the flush (2026-09-23 lesson).
    expect(append.data.message.source).toEqual({ kind: 'plugin', plugin: UNDO_PLUGIN })
    expect(append.data.message.id).toBeTruthy()
    expect(append.surfaceOp).toEqual({ op: 'replace', startSeq: 10, endSeq: 13 })
    expect(append.sourceEventSeqs).toEqual([10, 11, 12, 13])
  })

  it('finds the last tombstone and recovers its shadowed seqs', () => {
    const { session } = sessionWithTurns('pure-tombstone-2', 1)
    const shadowed = shadowedNodesOf(session, 1)
    const append = buildTombstoneAppend({
      turn: 1,
      step: 0,
      startSeq: shadowed[0] as number,
      endSeq: shadowed.at(-1) as number,
      shadowedSeqs: shadowed,
    })
    session.append('system/message', append.data, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(append.surfaceOp.startSeq), endSeq: SessionSeq(append.surfaceOp.endSeq) },
      sourceEventSeqs: append.sourceEventSeqs.map(SessionSeq),
    })
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    expect(tombstone).toMatchObject({
      turn: 1,
      step: 0,
    })
    expect(tombstone?.shadowedSeqs).toEqual(shadowed)
  })
})

describe('pure: redo replay plan (§2.2)', () => {
  it('maps boundaries to the fake turn and replays events in log order', () => {
    const { session, ids } = sessionWithTurns('pure-redo-1', 1)
    const events = session.snapshotEvents()
    const shadowed = shadowedNodesOf(session, 1)
    const append = buildTombstoneAppend({
      turn: 1,
      step: 0,
      startSeq: shadowed[0] as number,
      endSeq: shadowed.at(-1) as number,
      shadowedSeqs: shadowed,
    })
    session.append('system/message', append.data, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(append.surfaceOp.startSeq), endSeq: SessionSeq(append.surfaceOp.endSeq) },
      sourceEventSeqs: append.sourceEventSeqs.map(SessionSeq),
    })
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    if (tombstone === undefined) throw new Error('no tombstone')
    const plan = buildRedoAppendPlan(session.snapshotEvents(), tombstone)

    // First boundary is the fake turn/start; last is the completed turn/end;
    // the replayed message events sit between them in log order.
    expect(plan[0]).toEqual({ type: 'turn/start', data: { turn: FAKE_TURN_BASE + 1 } })
    expect(plan.at(-1)).toEqual({ type: 'turn/end', data: { turn: FAKE_TURN_BASE + 1, reason: { kind: 'completed' } } })
    expect(plan.map(step => step.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    const userCopy = plan[2]
    const assistantCopy = plan[3]
    if (userCopy === undefined || assistantCopy === undefined
      || userCopy.type !== 'user/message' || assistantCopy.type !== 'assistant/message') {
      throw new Error('copy steps missing')
    }
    // Fresh id + ORIGINAL source on the user copy (kind stays 'user' — the
    // chat renders a user bubble and the persistence audit forbids extra
    // members on kind:'user' sources, §2.3 amendment); content carried
    // verbatim. (The step union carries a wide data type; narrow the payload
    // per case.)
    const userData = userCopy.data as SessionEventMap['user/message']
    const assistantData = assistantCopy.data as SessionEventMap['assistant/message']
    expect(userData.role).toBe('user')
    expect(userData.id).not.toBe(ids[0]?.userMessageId)
    expect(userData.content).toEqual([{ type: 'text', text: 'question 1' }])
    expect(userData.source).toEqual({ kind: 'user' })
    // Assistant copy: fake turn, usage dropped, provider/model source retained.
    expect(assistantData.turn).toBe(FAKE_TURN_BASE + 1)
    expect(assistantData.usage).toBeUndefined()
    expect(assistantData.message.content).toEqual([{ type: 'text', text: 'answer 1' }])
    expect(assistantData.message.source).toMatchObject({ kind: 'model', provider: 'deepseek-official', model: 'v4-flash' })
  })

  it('never reuses the original user message id (same-id copy counterexample)', () => {
    const { session, ids } = sessionWithTurns('pure-redo-2', 1)
    const shadowed = shadowedNodesOf(session, 1)
    const append = buildTombstoneAppend({
      turn: 1,
      step: 0,
      startSeq: shadowed[0] as number,
      endSeq: shadowed.at(-1) as number,
      shadowedSeqs: shadowed,
    })
    session.append('system/message', append.data, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(append.surfaceOp.startSeq), endSeq: SessionSeq(append.surfaceOp.endSeq) },
      sourceEventSeqs: append.sourceEventSeqs.map(SessionSeq),
    })
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    if (tombstone === undefined) throw new Error('no tombstone')
    const plan = buildRedoAppendPlan(session.snapshotEvents(), tombstone)
    const userCopy = plan.find(step => step.type === 'user/message')
    if (userCopy === undefined || userCopy.type !== 'user/message') throw new Error('no user copy')
    const userData = userCopy.data as SessionEventMap['user/message']
    expect(userData.id).not.toBe(ids[0]?.userMessageId)
  })

  it('skips foreign replacement events inside the turn range (append-only replay guard)', () => {
    // Live shape (2026-09-23): the turn's log range can hold OTHER rows
    // rewritten by replacement events — a magic-context context refresh and a
    // tool-result rewrite — spliced positionally into earlier clusters. Those
    // are rewrites of EARLIER surface rows (unshadowed by the tombstone's
    // trailing run), so the redo plan must not re-append them as fresh tails.
    const session = Session.create(SessionId('pure-redo-guard-1'))
    appendToolTurn(session, 1)
    const beforeTurn2 = session.snapshotEvents()
    const result1 = beforeTurn2.find((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    const user1 = beforeTurn2.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    if (result1 === undefined || user1 === undefined) throw new Error('missing turn-1 rows')
    const result1Seq = result1.seq
    const user1Seq = user1.seq

    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 0 })
    // A tool-result rewrite of turn-1's result (rewrite may change only the
    // tool-result block's text content) — its seq now lies inside turn 2's log
    // range.
    const rewrittenResult = structuredClone(result1.data) as SessionEventMap['tool/result']
    const resultBlock = rewrittenResult.message.content[0] as { content: unknown }
    resultBlock.content = [{ type: 'text', text: 'REFRESHED' }]
    session.append('tool/result', rewrittenResult, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(result1Seq), endSeq: SessionSeq(result1Seq) },
      sourceEventSeqs: [SessionSeq(result1Seq)],
    })
    // A magic-context refresh of turn-1's user row.
    const refreshed = createUserMessage({
      content: [{ type: 'text', text: 'context refreshed' }],
      source: { kind: 'plugin', plugin: 'magic-context' },
    })
    session.append('user/message', refreshed, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(user1Seq), endSeq: SessionSeq(user1Seq) },
      sourceEventSeqs: [SessionSeq(user1Seq)],
    })
    // Turn 2's own content.
    const user2 = createUserMessage({ content: [{ type: 'text', text: 'run it again' }], source: { kind: 'user' } })
    session.append('user/message', user2, { surfaceOp: 'append' })
    const assistant2 = createAssistantMessage({
      content: [
        { type: 'text', text: 'running' },
        { type: 'tool-call', id: ToolCallId('call-2'), name: 'list_files', arguments: '{}' },
      ],
      source: { provider: 'deepseek-official', model: 'v4-flash' },
    })
    session.append('assistant/message', { turn: 2, step: 0, message: assistant2, stream: [] }, { surfaceOp: 'append' })
    const call2 = session.append('tool/call', {
      turn: 2,
      step: 0,
      callId: ToolCallId('call-2'),
      name: 'list_files',
      arguments: '{}',
    })
    const result2 = createToolResultMessage({
      callId: ToolCallId('call-2'),
      content: [{ type: 'text', text: 'b.txt' }],
      isError: false,
    })
    session.append('tool/result', { turn: 2, step: 0, message: result2 }, { surfaceOp: 'append', sourceEventSeqs: [call2.seq] })
    session.append('step/end', { turn: 2, step: 0 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    // Tombstone turn 2 over its CONTIGUOUS trailing run (as performUndo does).
    const events = session.snapshotEvents()
    const range2 = turnLogRange(events, 2)
    if (range2 === undefined) throw new Error('no turn-2 range')
    const turn2Seqs = new Set(shadowedTurnNodes([...session.surface.nodes], range2))
    const run = trailingTurnRun([...session.surface.nodes], turn2Seqs)
    const append = buildTombstoneAppend({
      turn: 2,
      step: lastStepOfTurn(events, 2),
      startSeq: run[0] as number,
      endSeq: run.at(-1) as number,
      shadowedSeqs: run,
    })
    session.append('system/message', append.data, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(append.surfaceOp.startSeq), endSeq: SessionSeq(append.surfaceOp.endSeq) },
      sourceEventSeqs: append.sourceEventSeqs.map(SessionSeq),
    })
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    if (tombstone === undefined) throw new Error('no tombstone')
    const plan = buildRedoAppendPlan(session.snapshotEvents(), tombstone)
    // Exactly the turn's OWN rows replay: the two replacement events inside
    // the log range produce no steps.
    expect(plan.map(step => step.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message',
      'tool/call', 'tool/result', 'step/end', 'turn/end',
    ])
    const userStep = plan.find(step => step.type === 'user/message')
    const resultStep = plan.find(step => step.type === 'tool/result')
    if (userStep === undefined || userStep.type !== 'user/message'
      || resultStep === undefined || resultStep.type !== 'tool/result') throw new Error('missing replay steps')
    const userData = userStep.data as SessionEventMap['user/message']
    const resultData = resultStep.data as SessionEventMap['tool/result']
    // The replayed user message is a fresh copy of turn-2's OWN input (not the
    // magic-context refresh), and the replayed result is a fresh copy of
    // turn-2's OWN result (not the turn-1 rewrite).
    expect(userData.id).not.toBe(refreshed.id)
    expect(resultData.message.id).not.toBe(rewrittenResult.message.id)
  })

  it('replays a tool turn with FRESH call ids paired across call, result, and content, turn becomes F', () => {
    const session = Session.create(SessionId('pure-redo-3'))
    session.append('system/message', {
      turn: 0,
      step: 0,
      message: createSystemMessage('you are a robot', 'dsh-agent-instructions'),
    }, { surfaceOp: 'append' })
    appendToolTurn(session, 1)
    const shadowed = shadowedNodesOf(session, 1)
    const append = buildTombstoneAppend({
      turn: 1,
      step: 0,
      startSeq: shadowed[0] as number,
      endSeq: shadowed.at(-1) as number,
      shadowedSeqs: shadowed,
    })
    session.append('system/message', append.data, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(append.surfaceOp.startSeq), endSeq: SessionSeq(append.surfaceOp.endSeq) },
      sourceEventSeqs: append.sourceEventSeqs.map(SessionSeq),
    })
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    if (tombstone === undefined) throw new Error('no tombstone')
    const plan = buildRedoAppendPlan(session.snapshotEvents(), tombstone)

    const call = plan.find(step => step.type === 'tool/call')
    const result = plan.find(step => step.type === 'tool/result')
    if (call === undefined || call.type !== 'tool/call') throw new Error('no tool/call copy')
    if (result === undefined || result.type !== 'tool/result') throw new Error('no tool/result copy')
    const callData = call.data as SessionEventMap['tool/call']
    const resultData = result.data as SessionEventMap['tool/result']
    // Fresh id: the client's trajectory assembler rejects a second start for
    // an already-seen callId, and the original turn's events remain in the
    // live feed (§2.2.4 amendment, 2026-09-23).
    expect(callData.callId).not.toBe('call-1')
    expect(callData).toMatchObject({ turn: FAKE_TURN_BASE + 1, step: 0, name: 'list_files', arguments: '{}' })
    expect(resultData.turn).toBe(FAKE_TURN_BASE + 1)
    // The replayed result pairs the REPLAYED call, not the original.
    expect(resultData.message.source.callId).toBe(callData.callId)
    expect(resultData.message.content[0]?.toolCallId).toBe(callData.callId)
    // Assistant copy dropped its usage; its tool-call block was remapped to
    // the fresh call id too.
    const assistant = plan.find(step => step.type === 'assistant/message')
    if (assistant === undefined || assistant.type !== 'assistant/message') throw new Error('no assistant copy')
    const assistantData = assistant.data as SessionEventMap['assistant/message']
    expect(assistantData.usage).toBeUndefined()
    const toolCallBlock = assistantData.message.content.find(block => block.type === 'tool-call')
    if (toolCallBlock === undefined || toolCallBlock.type !== 'tool-call') throw new Error('no tool-call block')
    expect(toolCallBlock.id).toBe(callData.callId)
  })
})

describe('endpoint: undo reject paths', () => {
  it('rejects a missing session', async () => {
    const { session, ids } = sessionWithTurns('endpoint-undo-1', 1)
    const result = await performUndo(hostOf(undefined), session.id, ids[0]?.assistantMessageId as string)
    expect(result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })

  it('rejects a running agent', async () => {
    const { session, ids } = sessionWithTurns('endpoint-undo-2', 1)
    const result = await performUndo(hostOf(session, 'running'), session.id, ids[0]?.assistantMessageId as string)
    expect(result).toMatchObject({ ok: false, error: { code: 'agent-busy' } })
  })

  it('rejects an unknown message id', async () => {
    const { session } = sessionWithTurns('endpoint-undo-3', 1)
    const result = await performUndo(hostOf(session), session.id, 'no-such-message')
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!result.ok) expect(result.error.message).toContain('dsh-undo/target-not-found')
  })

  it('rejects a non-tail turn', async () => {
    const { session, ids } = sessionWithTurns('endpoint-undo-4', 2)
    const result = await performUndo(hostOf(session), session.id, ids[0]?.assistantMessageId as string)
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!result.ok) expect(result.error.message).toContain('dsh-undo/not-tail')
  })

  it('rejects undoing an already-undone tail turn', async () => {
    const { session, ids } = sessionWithTurns('endpoint-undo-5', 1)
    const host = hostOf(session)
    const first = await performUndo(host, session.id, ids[0]?.assistantMessageId as string)
    expect(first.ok).toBe(true)
    const second = await performUndo(host, session.id, ids[0]?.assistantMessageId as string)
    expect(second).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!second.ok) expect(second.error.message).toContain('dsh-undo/already-undone')
  })
})

describe('endpoint: undo cascade and post-undo turns (§5)', () => {
  it('undoes N then undoes N-1 (continuous undo cascade)', async () => {
    const { session, ids } = sessionWithTurns('endpoint-cascade-1', 2)
    const host = hostOf(session)
    const undoneN = await performUndo(host, session.id, ids[1]?.assistantMessageId as string)
    expect(undoneN.ok).toBe(true)
    const undoneNMinus1 = await performUndo(host, session.id, ids[0]?.assistantMessageId as string)
    expect(undoneNMinus1).toMatchObject({ ok: true, value: { turn: 1 } })
    expect(session.snapshotEvents().filter(isUndoTombstone)).toHaveLength(2)
  })

  it('rejects a non-tail turn when no undo preceded it', async () => {
    const { session, ids } = sessionWithTurns('endpoint-cascade-2', 3)
    const host = hostOf(session)
    const result = await performUndo(host, session.id, ids[0]?.assistantMessageId as string)
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!result.ok) expect(result.error.message).toContain('dsh-undo/not-tail')
  })

  it('undoes a new turn appended after an undo', async () => {
    const { session, ids } = sessionWithTurns('endpoint-cascade-3', 2)
    const host = hostOf(session)
    const undone = await performUndo(host, session.id, ids[1]?.assistantMessageId as string)
    expect(undone.ok).toBe(true)
    const newTurn = appendPlainTurn(session, 3)
    const result = await performUndo(host, session.id, newTurn.assistantMessageId)
    expect(result).toMatchObject({ ok: true, value: { turn: 3 } })
  })
})

describe('endpoint: redo reject paths', () => {
  it('rejects a missing session', async () => {
    const result = await performRedo(hostOf(undefined), 'ghost')
    expect(result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })

  it('rejects a running agent', async () => {
    const { session } = sessionWithTurns('endpoint-redo-1', 1)
    const result = await performRedo(hostOf(session, 'running'), session.id)
    expect(result).toMatchObject({ ok: false, error: { code: 'agent-busy' } })
  })

  it('rejects a session with no tombstone', async () => {
    const { session } = sessionWithTurns('endpoint-redo-2', 1)
    const result = await performRedo(hostOf(session), session.id)
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!result.ok) expect(result.error.message).toContain('dsh-undo/nothing-to-redo')
  })

  it('rejects a stale tombstone (newer messages follow it)', async () => {
    const { session, ids } = sessionWithTurns('endpoint-redo-3', 2)
    const host = hostOf(session)
    const undone = await performUndo(host, session.id, ids[1]?.assistantMessageId as string)
    expect(undone.ok).toBe(true)
    appendPlainTurn(session, 3)
    const result = await performRedo(host, session.id)
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
    if (!result.ok) expect(result.error.message).toContain('dsh-undo/redo-stale')
  })
})

describe('endpoint: round trips on a real session', () => {
  it('undo then redo restores the derived wire; undo→redo→undo converges', async () => {
    const { session, ids } = sessionWithTurns('endpoint-cycle-1', 1)
    const host = hostOf(session)
    const original = JSON.stringify(contentOf(session.deriveMessages()))
    const messageId = ids[0]?.assistantMessageId as string

    const undone = await performUndo(host, session.id, messageId)
    if (!undone.ok) throw new Error(`undo failed: ${undone.error.message}`)
    expect(undone.value).toEqual({ turn: 1 })
    expect(session.deriveMessages()).toEqual([])

    // The tombstone is schema-clean: its shadowed seqs carry the draft
    // context for the client (which derives the text from the log scan).
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    expect(tombstone?.shadowedSeqs.length).toBeGreaterThan(0)

    const redone = await performRedo(host, session.id)
    if (!redone.ok) throw new Error(`redo failed: ${redone.error.message}`)
    expect(JSON.stringify(contentOf(session.deriveMessages()))).toBe(original)

    // Second undo targets the replayed copy turn, then redo converges again.
    const copyTurn = session.snapshotEvents()
      .find((event): event is SessionEvent & { type: 'assistant/message' } =>
        event.type === 'assistant/message' && event.data.turn >= FAKE_TURN_BASE)?.data.turn
    if (copyTurn === undefined) throw new Error('no replayed assistant copy')
    const copyAssistantId = session.snapshotEvents()
      .find((event): event is SessionEvent & { type: 'assistant/message' } =>
        event.type === 'assistant/message' && event.data.turn === copyTurn)?.data.message.id
    if (copyAssistantId === undefined) throw new Error('no copy assistant id')

    const undoneAgain = await performUndo(host, session.id, copyAssistantId)
    expect(undoneAgain.ok).toBe(true)
    const redoneAgain = await performRedo(host, session.id)
    expect(redoneAgain.ok).toBe(true)
    expect(JSON.stringify(contentOf(session.deriveMessages()))).toBe(original)
    expect(session.snapshotEvents().filter(isUndoTombstone)).toHaveLength(2)
  })

  it('undo/redo a tool turn end-to-end and the full fold stays valid', async () => {
    const session = Session.create(SessionId('endpoint-tool-1'))
    appendToolTurn(session, 1)
    const host = hostOf(session)
    const assistantId = session.snapshotEvents()
      .find((event): event is SessionEvent & { type: 'assistant/message' } => event.type === 'assistant/message')?.data.message.id
    if (assistantId === undefined) throw new Error('no assistant message')

    const undone = await performUndo(host, session.id, assistantId)
    expect(undone.ok).toBe(true)
    const redone = await performRedo(host, session.id)
    expect(redone.ok).toBe(true)

    const events = session.snapshotEvents()
    const fakeCalls = events.filter((event): event is SessionEvent<'tool/call'> =>
      event.type === 'tool/call' && event.data.turn >= FAKE_TURN_BASE)
    const fakeResults = events.filter((event): event is SessionEvent<'tool/result'> =>
      event.type === 'tool/result' && event.data.turn >= FAKE_TURN_BASE)
    expect(fakeCalls).toHaveLength(1)
    expect(fakeResults).toHaveLength(1)
    // Fresh call id — never the original (client trajectory assembler, §2.2.4
    // amendment) — and the replayed result pairs the replayed call.
    expect(fakeCalls[0]?.data.callId).not.toBe('call-1')
    expect(fakeResults[0]?.data.message.source.callId).toBe(fakeCalls[0]?.data.callId)
    // The canonical replay fold accepts the full log after the round trip.
    expect(() => foldSurface(events)).not.toThrow()
  })

  it('undo keeps the protected system-prompt head row (rc.2 assertSystemHeadRewrite)', async () => {
    // Real harness shape (dsh-general sessions): the per-request system
    // prompt is a system/message surface node INSIDE the turn's log range,
    // so it is surface node 0 and the tombstone may not shadow it.
    const session = Session.create(SessionId('endpoint-head-1'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    session.append('system/message', {
      turn: 1,
      step: 0,
      message: createSystemMessage('you are a harness agent', 'dsh-agent-instructions'),
    }, { surfaceOp: 'append' })
    const ids = appendPlainTurn(session, 1)
    const host = hostOf(session)

    const undone = await performUndo(host, session.id, ids.assistantMessageId)
    if (!undone.ok) throw new Error(`undo failed: ${undone.error.message}`)
    expect(undone.value).toEqual({ turn: 1 })

    // The head row survives: surface = [head system node, tombstone], and the
    // tombstone range excludes the head seq.
    const nodes = [...session.surface.nodes]
    expect(nodes).toHaveLength(2)
    const events = session.snapshotEvents()
    const head = events[nodes[0] as number] as SessionEvent
    const tombstone = events[nodes[1] as number] as SessionEvent
    expect(head.type).toBe('system/message')
    expect((head.data as { message: { source?: { plugin?: string } } }).message.source?.plugin).not.toBe('dsh-undo')
    expect(tombstone.type).toBe('system/message')
    // The tombstone's replace range excludes the protected head seq.
    const lastTombstone = findLastUndoTombstone(events)
    expect(lastTombstone?.shadowedSeqs).not.toContain(nodes[0])

    const redone = await performRedo(host, session.id)
    if (!redone.ok) throw new Error(`redo failed: ${redone.error.message}`)
    // Redo replays the chat rows only: the head system/message (excluding
    // dsh-undo's own tombstones) is still present exactly once.
    const headCount = session.snapshotEvents()
      .filter((event): event is SessionEvent<'system/message'> => event.type === 'system/message')
      .filter((event) => !isUndoTombstone(event)).length
    expect(headCount).toBe(1)
    expect(() => foldSurface(session.snapshotEvents())).not.toThrow()
  })

  it('every appended event passes the persistence admission after undo/redo (schema-clean tombstone and copies)', async () => {
    // 2026-09-23 production incident: the tombstone's message.source carried
    // unaudited members (undoId, userMessageId) and every flush failed —
    // zero persistence, export 500, turn failures. The relabel path
    // (system/message → user/message) audits source members, so this gate
    // must run over the full appended log. The fixture mirrors the REAL
    // runtime shapes (steps are 1-based; the user message carries a
    // kind:'user' source), unlike the looser helpers above.
    const session = Session.create(SessionId('endpoint-admission-1'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const user = createUserMessage({ content: [{ type: 'text', text: 'run the tool' }], source: { kind: 'user' } })
    session.append('user/message', user, { surfaceOp: 'append' })
    const assistant = createAssistantMessage({
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'list_files', arguments: '{}' },
      ],
      source: { provider: 'deepseek-official', model: 'v4-flash' },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    const call = session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-1'),
      name: 'list_files',
      arguments: '{}',
    })
    const result = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'x.txt' }],
      isError: false,
    })
    session.append('tool/result', { turn: 1, step: 1, message: result }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const host = hostOf(session)

    const undone = await performUndo(host, session.id, assistant.id)
    expect(undone.ok).toBe(true)
    const redone = await performRedo(host, session.id)
    expect(redone.ok).toBe(true)

    type AdmissionRow = Parameters<typeof assertV3RowAdmission>[0]
    for (const event of session.snapshotEvents()) {
      expect(() => assertV3RowAdmission(event as unknown as AdmissionRow)).not.toThrow()
    }
  })

  it('appendRedoStep drops boundary events into the log without surface metadata', async () => {
    const session = Session.create(SessionId('endpoint-append-1'))
    const { assistantMessageId } = appendPlainTurn(session, 1)
    const host = hostOf(session)
    const undone = await performUndo(host, session.id, assistantMessageId)
    expect(undone.ok).toBe(true)
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    if (tombstone === undefined) throw new Error('no tombstone')
    for (const step of buildRedoAppendPlan(session.snapshotEvents(), tombstone)) {
      appendRedoStep(session, step)
    }
    const lastEvents = session.snapshotEvents()
    const boundary = lastEvents.filter(event => event.type === 'turn/start' || event.type === 'turn/end')
    expect(boundary.some(event => event.data.turn === FAKE_TURN_BASE + 1)).toBe(true)
    // Boundary events carry no surface metadata.
    for (const event of boundary) {
      if (event.type === 'turn/end' && event.data.turn === FAKE_TURN_BASE + 1) {
        expect(event.surfaceOp).toBeUndefined()
      }
    }
  })
})