/**
 * dsh-undo Phase 0 spike: the design's surface mechanics against a REAL
 * `@deepseek-ai/dsh-session` Session — tombstone fold (§2.1), fake-turn copy
 * replay (§2.2), wire isomorphism, and undo→redo→undo convergence.
 *
 * The wire fan-out mirrors `serializeMessages` (dsh-llm-deepseek): role +
 * content only, tool results expanded to separate `tool` rows — ids and
 * sources never reach the provider, which is exactly why the redo copies are
 * wire-isomorphic despite fresh message ids and plugin sources (design §2.3).
 *
 * Tombstone non-rendering in the UI is a client-half concern (design §4.2)
 * and is NOT asserted here.
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
  type ContentBlock,
  type Message,
} from '@deepseek-ai/dsh-llm'
import {
  FAKE_TURN_BASE,
  buildRedoAppendPlan,
  buildTombstoneAppend,
  findLastUndoTombstone,
  isReplayedUserMessage,
  isUndoTombstone,
  lastStepOfTurn,
  shadowedTurnNodes,
  turnLogRange,
} from './pure.ts'
import { appendRedoStep, performRedo, performUndo } from './index.ts'

/** One assembled session: the live Session plus its turn-1 message ids. */
interface BuiltSession {
  readonly session: Session
  readonly userMessageId: string
  readonly assistantMessageId: string
  readonly toolCallId: string
}

/**
 * Append one canonical Q&A turn with a tool call: boundaries, user message,
 * tool-calling assistant message, tool/call + tool/result pair, then the step
 * and turn closers. Returns the message ids for later assertions.
 */
function appendToolTurn(session: Session, turn: number): { userMessageId: string; assistantMessageId: string; toolCallId: string } {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 0 })
  const user = createUserMessage({
    content: [{ type: 'text', text: 'list the project files' }],
    source: { kind: 'user' },
  })
  session.append('user/message', user, { surfaceOp: 'append' })
  const assistant = createAssistantMessage({
    content: [
      { type: 'text', text: 'sure, listing now' },
      { type: 'tool-call', id: ToolCallId(`call-${turn}`), name: 'list_files', arguments: '{}' },
    ],
    source: { provider: 'deepseek-official', model: 'v4-flash' },
  })
  session.append('assistant/message', {
    turn,
    step: 0,
    message: assistant,
    stream: [],
    usage: { inputTokens: 42, outputTokens: 7, totalTokens: 49 },
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
    content: [{ type: 'text', text: 'a.txt\nb.txt' }],
    isError: false,
  })
  session.append('tool/result', { turn, step: 0, message: result }, {
    surfaceOp: 'append',
    sourceEventSeqs: [call.seq],
  })
  session.append('step/end', { turn, step: 0 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { userMessageId: user.id, assistantMessageId: assistant.id, toolCallId: `call-${turn}` }
}

/** A session with optional system-prompt turn 0 followed by a tool-calling turn 1. */
function buildSession(sessionId: string, systemPrompt?: string): BuiltSession {
  const session = Session.create(SessionId(sessionId))
  if (systemPrompt !== undefined) {
    session.append('turn/start', { turn: 0 })
    session.append('step/start', { turn: 0, step: 0 })
    session.append('system/message', {
      turn: 0,
      step: 0,
      message: createSystemMessage(systemPrompt, 'dsh-agent-instructions'),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 0, step: 0 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
  }
  const ids = appendToolTurn(session, 1)
  return { session, ...ids }
}

/** Append the dsh-undo tombstone over `shadowed` (design §2.1) to a live session. */
function appendTombstone(session: Session, shadowed: readonly number[], turn: number): SessionEvent {
  const events = session.snapshotEvents()
  const append = buildTombstoneAppend({
    turn,
    step: lastStepOfTurn(events, turn),
    startSeq: shadowed[0] as number,
    endSeq: shadowed.at(-1) as number,
    shadowedSeqs: shadowed,
  })
  return session.append('system/message', append.data, {
    surfaceOp: {
      op: 'replace',
      startSeq: SessionSeq(append.surfaceOp.startSeq),
      endSeq: SessionSeq(append.surfaceOp.endSeq),
    },
    sourceEventSeqs: append.sourceEventSeqs.map(SessionSeq),
  })
}

/** Replay the last tombstone's turn as fake-turn copies (design §2.2). */
function redoLastTurn(session: Session): void {
  const events = session.snapshotEvents()
  const tombstone = findLastUndoTombstone(events)
  if (tombstone === undefined) throw new Error('no tombstone to redo')
  for (const step of buildRedoAppendPlan(events, tombstone)) appendRedoStep(session, step)
}

/** Join the text blocks of a message (mirrors serializeMessages' flattenText). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Project derived messages to the provider wire form, mirroring
 * `serializeMessages` (dsh-llm-deepseek): id/source stripped, tool results
 * expanded into standalone `role: 'tool'` rows. Byte-for-byte JSON comparison
 * of this projection is the redo isomorphism criterion.
 */
function wireOf(messages: readonly Message[]): unknown[] {
  const wire: unknown[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      const reasoning = message.content
        .filter(block => block.type === 'reasoning')
        .map(block => block.text)
        .join('')
      const toolCalls = message.content
        .filter(block => block.type === 'tool-call')
        .map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }))
      wire.push({
        role: 'assistant',
        content: text,
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    const toolResults = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const result of toolResults) {
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: flattenText(result.content) || '(no output)' })
    }
  }
  return wire
}

/**
 * Canonicalize every call id to one token, so a replayed wire (fresh call
 * ids, §2.2.4 amendment) compares equal to the pre-undo wire: the ids are
 * opaque correlation tokens, the pairing is what must survive. Works on any
 * JSON-serializable shape (wire rows and raw content blocks alike).
 */
function canonicalCallIds<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, member) =>
    (key === 'id' || key === 'tool_call_id' || key === 'toolCallId') && typeof member === 'string' ? 'CALL' : member))
}

/** The message id of one message-producing event. */
function messageIdOf(event: SessionEvent): string {
  if (event.type === 'user/message') return event.data.id
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message.id
  return ''
}

/** Whether one message event is a dsh-undo redo copy (identification rule, §2.3). */
function isCopyEvent(events: readonly SessionEvent[], event: SessionEvent): boolean {
  if (event.type === 'user/message') return isReplayedUserMessage(events, event)
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.turn >= FAKE_TURN_BASE
  return false
}

/** Role + content projection of derived messages (wire minus id/source). */
function contentOf(messages: readonly Message[]): unknown[] {
  return messages.map(message => ({ role: message.role, content: message.content }))
}

describe('dsh-undo spike: tombstone fold (§2.1)', () => {
  it('folds without exception and drops the shadowed turn from derived history', () => {
    const { session } = buildSession('spike-fold-1')
    const beforeNodes = [...session.surface.nodes]
    const tombstoneEvent = appendTombstone(session, beforeNodes, 1)

    // The canonical full-log fold accepts the tombstone (no surface violation).
    expect(() => foldSurface(session.snapshotEvents())).not.toThrow()

    // Derived history excludes the shadowed range entirely (no system prompt
    // session, single turn → nothing left).
    expect(session.deriveMessages()).toEqual([])

    // The live surface and the fold agree: shadowed nodes gone, tombstone in.
    const fold = foldSurface(session.snapshotEvents())
    for (const seq of beforeNodes) {
      expect(fold.nodes).not.toContain(seq)
      expect(session.surface.nodes).not.toContain(seq)
    }
    expect(fold.nodes).toContain(tombstoneEvent.seq)
    expect(fold.nodes.at(-1)).toBe(tombstoneEvent.seq)
    expect(isUndoTombstone(tombstoneEvent)).toBe(true)
  })

  it('keeps a system prompt at node 0 when a later turn is undone (head protection path)', () => {
    const { session } = buildSession('spike-fold-2', 'you are helpful')
    const nodes = [...session.surface.nodes]
    // Turn 1 nodes start after node 0 (system prompt); shadow only the turn.
    const shadowed = nodes.slice(1)
    appendTombstone(session, shadowed, 1)

    expect(() => foldSurface(session.snapshotEvents())).not.toThrow()
    const fold = foldSurface(session.snapshotEvents())
    // Node 0 survives: the system prompt is still model-visible.
    expect(fold.nodes[0]).toBe(nodes[0])
    const derived = session.deriveMessages()
    expect(derived).toHaveLength(1)
    expect(derived[0]?.role).toBe('system')
  })
})

describe('dsh-undo spike: redo wire isomorphism (§2.2–2.3)', () => {
  it('reconstructs the pre-undo wire modulo fresh call ids after replaying fake-turn copies', () => {
    const { session } = buildSession('spike-wire-1')
    const beforeWire = wireOf(session.deriveMessages())
    const beforeContent = contentOf(session.deriveMessages())
    expect(beforeWire.length).toBeGreaterThan(0)

    appendTombstone(session, [...session.surface.nodes], 1)
    redoLastTurn(session)

    // The replay itself must fold cleanly — appending already validated
    // incrementally, but the full-log fold is the canonical replay gate.
    expect(() => foldSurface(session.snapshotEvents())).not.toThrow()

    const after = session.deriveMessages()
    expect(JSON.stringify(canonicalCallIds(wireOf(after)))).toBe(JSON.stringify(canonicalCallIds(beforeWire)))
    // Content-block equality as a second lens (covers tool-result blocks,
    // modulo the fresh call ids).
    expect(canonicalCallIds(contentOf(after))).toEqual(canonicalCallIds(beforeContent))

    // The tombstone stays dormant in the surface (its empty content projects
    // to no wire message) — one extra node, zero wire residue.
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    expect(tombstone).toBeDefined()
    expect(foldSurface(session.snapshotEvents()).nodes).toContain(tombstone?.seq)
  })

  it('mints fresh message ids for every copy (design §2.2.2: same-id rows break the client assembler)', () => {
    const { session } = buildSession('spike-wire-2')
    const originalIds = new Set(
      session.snapshotEvents()
        .filter(event => event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
        .map(messageIdOf),
    )
    appendTombstone(session, [...session.surface.nodes], 1)
    redoLastTurn(session)
    const events = session.snapshotEvents()
    const copyIds = events
      .filter(event => (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') && isCopyEvent(events, event))
      .map(messageIdOf)
    expect(copyIds.length).toBeGreaterThan(0)
    for (const id of copyIds) expect(originalIds.has(id)).toBe(false)
  })

  it('replays the user copy with the ORIGINAL kind:\'user\' source (user bubble + persistence audit, §2.3 amendment)', () => {
    const { session, userMessageId } = buildSession('spike-user-source-1')
    appendTombstone(session, [...session.surface.nodes], 1)
    redoLastTurn(session)

    const events = session.snapshotEvents()
    const userCopy = events.find((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.id !== userMessageId)
    if (userCopy === undefined) throw new Error('no replayed user copy')
    // Fresh id + cloned ORIGINAL source: kind stays 'user' so the chat
    // renders a user bubble, and the persistence audit forbids extra members
    // on kind:'user' sources — no plugin marker may ride here.
    expect(userCopy.data.id).not.toBe(userMessageId)
    expect(userCopy.data.source).toEqual({ kind: 'user' })
    // Fake-turn attribution recognizes the copy and rejects the original.
    expect(isReplayedUserMessage(events, userCopy)).toBe(true)
    const original = events.find((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.id === userMessageId)
    if (original === undefined) throw new Error('no original user message')
    expect(isReplayedUserMessage(events, original)).toBe(false)
  })

  it('undo→redo→undo converges to the same wire every round, one dormant tombstone per round', () => {
    const { session } = buildSession('spike-converge-1')
    const originalWire = JSON.stringify(canonicalCallIds(wireOf(session.deriveMessages())))

    appendTombstone(session, [...session.surface.nodes], 1)
    redoLastTurn(session)
    expect(JSON.stringify(canonicalCallIds(wireOf(session.deriveMessages())))).toBe(originalWire)

    // Second undo targets the replayed (fake) turn — its copies are the tail.
    const copyTurn = session.snapshotEvents()
      .find((event): event is SessionEvent & { type: 'assistant/message' } =>
        event.type === 'assistant/message' && event.data.turn >= FAKE_TURN_BASE)?.data.turn
    if (copyTurn === undefined) throw new Error('no replayed assistant copy to undo')
    const copyRange = turnLogRange(session.snapshotEvents(), copyTurn)
    if (copyRange === undefined) throw new Error('no copy turn range')
    const copyShadowed = shadowedTurnNodes([...session.surface.nodes], copyRange)
    appendTombstone(session, copyShadowed, copyTurn)
    redoLastTurn(session)
    expect(JSON.stringify(canonicalCallIds(wireOf(session.deriveMessages())))).toBe(originalWire)

    // Two undo rounds → exactly two dormant tombstones, no leak.
    expect(session.snapshotEvents().filter(isUndoTombstone)).toHaveLength(2)
  })
})

describe('dsh-undo spike: tool copies (§2.2.4–2.2.5)', () => {
  it('replays tool/call with turn=F and a FRESH callId, pairing the replayed result and content', () => {
    const { session, toolCallId } = buildSession('spike-tool-1')
    appendTombstone(session, [...session.surface.nodes], 1)
    redoLastTurn(session)

    const events = session.snapshotEvents()
    const fakeCalls = events.filter((event): event is SessionEvent<'tool/call'> =>
      event.type === 'tool/call' && event.data.turn >= FAKE_TURN_BASE)
    const fakeResults = events.filter((event): event is SessionEvent<'tool/result'> =>
      event.type === 'tool/result' && event.data.turn >= FAKE_TURN_BASE)
    expect(fakeCalls).toHaveLength(1)
    expect(fakeResults).toHaveLength(1)
    // Fresh id — the client's trajectory assembler rejects a second start for
    // an already-seen callId while the original events remain in the feed.
    expect(fakeCalls[0]?.data.callId).not.toBe(toolCallId)
    expect(fakeCalls[0]?.data.turn).toBe(FAKE_TURN_BASE + 1)
    const result = fakeResults[0]
    if (result === undefined) throw new Error('missing fake tool result')
    expect(result.data.turn).toBe(FAKE_TURN_BASE + 1)
    expect(result.data.message.source.callId).toBe(fakeCalls[0]?.data.callId)
    expect(result.data.message.content[0]?.toolCallId).toBe(fakeCalls[0]?.data.callId)
  })
})

describe('dsh-undo spike: foreign replacement events in the turn range (§2.2 append guard)', () => {
  /**
   * A session whose turn-2 LOG range contains two FOREIGN replacement events:
   * a tool/result rewrite of turn-1's result and a magic-context refresh of
   * turn-1's context row (the verified live shape, 2026-09-23). Turn 1 carries
   * a step-1 assistant row AFTER its result so both rewrites splice INTO turn
   * 1's positional cluster — the tombstone's trailing run (trailingTurnRun)
   * then shadows only turn 2's own rows and leaves the rewrites visible.
   */
  function buildReplacementSession(sessionId: string): {
    session: Session
    turn2AssistantId: string
    replacementResultId: string
    replacementContextId: string
  } {
    const session = Session.create(SessionId(sessionId))
    // ── Turn 1: tool turn with a trailing step-1 assistant row ──────────────
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    const user1 = createUserMessage({ content: [{ type: 'text', text: 'list files' }], source: { kind: 'user' } })
    session.append('user/message', user1, { surfaceOp: 'append' })
    const context = createUserMessage({
      content: [{ type: 'text', text: 'context snapshot' }],
      source: { kind: 'plugin', plugin: 'magic-context' },
    })
    const contextEvent = session.append('user/message', context, { surfaceOp: 'append' })
    const assistant1 = createAssistantMessage({
      content: [
        { type: 'text', text: 'listing' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'list_files', arguments: '{}' },
      ],
      source: { provider: 'deepseek-official', model: 'v4-flash' },
    })
    session.append('assistant/message', { turn: 1, step: 0, message: assistant1, stream: [] }, { surfaceOp: 'append' })
    const call1 = session.append('tool/call', {
      turn: 1,
      step: 0,
      callId: ToolCallId('call-1'),
      name: 'list_files',
      arguments: '{}',
    })
    const result1 = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'a.txt' }],
      isError: false,
    })
    session.append('tool/result', { turn: 1, step: 0, message: result1 }, { surfaceOp: 'append', sourceEventSeqs: [call1.seq] })
    session.append('step/end', { turn: 1, step: 0 })
    session.append('step/start', { turn: 1, step: 1 })
    const assistant1b = createAssistantMessage({
      content: [{ type: 'text', text: 'done' }],
      source: { provider: 'deepseek-official', model: 'v4-flash' },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: assistant1b, stream: [] }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // ── Turn 2 opens; TWO foreign replacements land inside its log range ────
    const eventsBefore = session.snapshotEvents()
    const result1Event = eventsBefore.find((event): event is SessionEvent<'tool/result'> =>
      event.type === 'tool/result')
    if (result1Event === undefined) throw new Error('missing turn-1 tool result')
    const contextSeq = contextEvent.seq
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 0 })
    // A tool-result rewrite of turn-1's result (rewrite may change only the
    // tool-result block's text content).
    const rewrittenResult = structuredClone(result1Event.data) as SessionEventMap['tool/result']
    const resultBlock = rewrittenResult.message.content[0] as { content: unknown }
    resultBlock.content = [{ type: 'text', text: 'REFRESHED' }]
    session.append('tool/result', rewrittenResult, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(result1Event.seq), endSeq: SessionSeq(result1Event.seq) },
      sourceEventSeqs: [SessionSeq(result1Event.seq)],
    })
    // A magic-context refresh of turn-1's context row.
    const refreshedContext = createUserMessage({
      content: [{ type: 'text', text: 'context refreshed' }],
      source: { kind: 'plugin', plugin: 'magic-context' },
    })
    session.append('user/message', refreshedContext, {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(contextSeq), endSeq: SessionSeq(contextSeq) },
      sourceEventSeqs: [SessionSeq(contextSeq)],
    })
    // ── Turn 2's own content ────────────────────────────────────────────────
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
    return {
      session,
      turn2AssistantId: assistant2.id,
      replacementResultId: rewrittenResult.message.id,
      replacementContextId: refreshedContext.id,
    }
  }

  /** A stub host serving one live session (the endpoint shape). */
  function hostOf(session: Session): {
    sessions: { get(id: SessionId): Session | undefined }
    agents: { get(id: SessionId): { id: SessionId; status: 'idle' } | undefined }
  } {
    return {
      sessions: { get: id => (id === session.id ? session : undefined) },
      agents: { get: () => ({ id: session.id, status: 'idle' as const }) },
    }
  }

  it('builds a redo plan that excludes the foreign replacement events', async () => {
    const { session, turn2AssistantId, replacementResultId, replacementContextId } =
      buildReplacementSession('spike-replacement-plan')
    const host = hostOf(session)
    const undone = await performUndo(host, session.id, turn2AssistantId)
    if (!undone.ok) throw new Error(`undo failed: ${undone.error.message}`)
    const tombstone = findLastUndoTombstone(session.snapshotEvents())
    if (tombstone === undefined) throw new Error('no tombstone')
    const plan = buildRedoAppendPlan(session.snapshotEvents(), tombstone)
    // Exactly the turn's OWN rows replay: the two replacement events inside
    // the log range produce no steps (no extra user/assistant/tool-result).
    expect(plan.map(step => step.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message',
      'tool/call', 'tool/result', 'step/end', 'turn/end',
    ])
    const userStep = plan.find(step => step.type === 'user/message')
    const resultStep = plan.find(step => step.type === 'tool/result')
    if (userStep === undefined || userStep.type !== 'user/message'
      || resultStep === undefined || resultStep.type !== 'tool/result') throw new Error('missing replay steps')
    // The replayed user message is a fresh copy of turn-2's OWN input (not the
    // magic-context refresh), and the replayed result is a fresh copy of
    // turn-2's OWN result (not the turn-1 rewrite).
    expect((userStep.data as SessionEventMap['user/message']).id).not.toBe(replacementContextId)
    expect((resultStep.data as SessionEventMap['tool/result']).message.id).not.toBe(replacementResultId)
  })

  it('redo with foreign replacements in the turn range stays wire-isomorphic', async () => {
    const { session, turn2AssistantId } = buildReplacementSession('spike-replacement-wire')
    const host = hostOf(session)
    const beforeWire = JSON.stringify(canonicalCallIds(wireOf(session.deriveMessages())))
    const beforeContent = canonicalCallIds(contentOf(session.deriveMessages()))

    const undone = await performUndo(host, session.id, turn2AssistantId)
    if (!undone.ok) throw new Error(`undo failed: ${undone.error.message}`)
    const afterUndoWire = JSON.stringify(canonicalCallIds(wireOf(session.deriveMessages())))
    // The foreign rewrite rows stay visible: the tombstone shadows only turn
    // 2's own trailing run, so the refreshed context and the replaced result
    // survive the undo and redo must not re-append them.
    expect(afterUndoWire).toContain('context refreshed')
    expect(afterUndoWire).toContain('REFRESHED')

    const redone = await performRedo(host, session.id)
    if (!redone.ok) throw new Error(`redo failed: ${redone.error.message}`)
    const after = session.deriveMessages()
    expect(JSON.stringify(canonicalCallIds(wireOf(after)))).toBe(beforeWire)
    expect(canonicalCallIds(contentOf(after))).toEqual(beforeContent)
    expect(() => foldSurface(session.snapshotEvents())).not.toThrow()
  })
})