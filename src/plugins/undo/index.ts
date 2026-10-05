/**
 * dsh-undo, node half.
 *
 * Serves the undo/redo RPC channel `/dsh-undo` over the Connection-RPC
 * envelope (notification's serveChannel pattern): `undo {sessionId,
 * messageId}` tombstone-shadows the message's whole turn (design §2.1), and
 * `redo {sessionId}` replays the last undone turn as a fake-turn copy
 * sequence (design §2.2). The surface decision core lives in ./pure.ts
 * (turn location, shadowed computation, append-payload construction); this
 * file only reads live sessions/agents, validates the tail/idle preconditions,
 * appends, and serializes requests per session.
 *
 * Both endpoints are rejected while the session's agent is running (v1 does
 * not cancel+undo) and serialize per session via an async queue (feedback
 * enqueue precedent). All state is derived from the event log — restart and
 * pagination are lossless.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcFailure as RpcError, ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'
import { serveRpcChannel } from '../../shared/rpc-channel.ts'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionEventMap,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  FAKE_TURN_BASE,
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
  type RedoAppendStep,
  type RedoSurfaceStep,
} from './pure.ts'

/** Cordis plugin name. */
export const name = 'dsh-undo'

/**
 * Required services: the host session store and the live agent registry (the
 * idle gate). The web route is attached at runtime via
 * `ctx.inject(['webServer'])` (notification pattern) so non-web profiles
 * simply skip the channel.
 */
export const inject = ['sessions', 'agents']

/** RPC channel owned by this plugin. */
const CHANNEL = '/dsh-undo'

/** Endpoint under {@link CHANNEL} tombstoning one assistant turn. */
const ENDPOINT_UNDO = 'undo'

/** Endpoint under {@link CHANNEL} replaying the last undone turn. */
const ENDPOINT_REDO = 'redo'

/**
 * The structural live session the handlers read. `append` mirrors the real
 * `Session.append` shape so both the real session and test doubles type-check
 * at the same call sites.
 */
export interface SessionLike {
  readonly id: string
  readonly surface: { readonly nodes: readonly number[] }
  snapshotEvents(): readonly SessionEvent[]
  append: Session['append']
}

/** The structural live agent the idle gate reads. */
export interface AgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
}

/** The host service slices the handlers touch (both 0811-declared in `inject`). */
export interface UndoHost {
  sessions: { get(id: SessionId): SessionLike | undefined }
  agents: { get(id: SessionId): AgentLike | undefined }
}

/** The undo endpoint result. */
export type UndoResult = RpcResult<{ turn: number }>

/** The redo endpoint result. */
export type RedoResult = RpcResult<{ turn: number }>

/**
 * One envelope rejection. The harness `RpcErrorCode` union is closed (every
 * code row lives in the harness `RpcErrorDetailsMap`), so dsh-undo cannot
 * mint its own wire codes without touching the harness. Only codes that
 * already exist ride the RPC envelope; the remaining semantic failures
 * (`target-not-found`, `not-tail`, `already-undone`, `nothing-to-redo`,
 * `redo-stale`, `bad-request`) fold to `internal` with the semantic code
 * embedded in the message (`dsh-undo/<code>: <details>`) — the v1 client
 * discriminates on that message text.
 */
function internal(message: string): { ok: false; error: RpcError } {
  return { ok: false as const, error: { code: 'internal', message, details: {} } }
}

function sessionNotFound(sessionId: string): { ok: false; error: RpcError } {
  const details = { sessionId: SessionId(sessionId) }
  return {
    ok: false as const,
    error: { code: 'session-not-found', message: `no live session ${sessionId}`, details },
  }
}

function agentBusy(sessionId: string): { ok: false; error: RpcError } {
  return {
    ok: false as const,
    error: {
      code: 'agent-busy',
      message: `session ${sessionId} agent is running; undo/redo requires idle`,
      details: { reason: `agent of session ${sessionId} is running` },
    },
  }
}

/**
 * Execute one undo request (design §3): locate the message's turn, require it
 * to be the session's last closed turn with a non-tombstone surface tail,
 * tombstone the whole turn, and return the shadowed turn.
 * @param host - live sessions/agents service slices.
 * @param sessionId - target session id.
 * @param messageId - the assistant message the user wants undone.
 * @returns the shadowed turn, or a typed envelope failure.
 */
export async function performUndo(host: UndoHost, sessionId: string, messageId: string): Promise<UndoResult> {
  const session = host.sessions.get(SessionId(sessionId))
  if (session === undefined) return sessionNotFound(sessionId)
  const agent = host.agents.get(SessionId(sessionId))
  if (agent?.status === 'running') return agentBusy(sessionId)
  const events = session.snapshotEvents()
  const turn = findAssistantMessageTurn(events, messageId)
  if (turn === undefined) {
    return internal(`dsh-undo/target-not-found: no finalized assistant message ${messageId} in session ${sessionId}`)
  }
  // Surface-perspective tail (design §5 cascade): a dsh-undo tombstone over
  // turn N exposes turn N-1 as the peeled surface tail again, so undoing N-1
  // after N succeeds; the target-aware tombstone check keeps the sharper
  // already-undone rejection for the just-shadowed turn.
  const nodes = [...session.surface.nodes]
  const tail = nodes.at(-1)
  const tailEvent = tail === undefined ? undefined : events[tail]
  if (tailEvent !== undefined && isUndoTombstone(tailEvent) && (tailEvent.data as { turn?: unknown }).turn === turn) {
    return internal('dsh-undo/already-undone: the last turn is already shadowed by a dsh-undo tombstone')
  }
  if (!isSurfaceTailTurn(events, nodes, turn)) {
    return internal(`dsh-undo/not-tail: turn ${String(turn)} is not session ${sessionId}'s last turn`)
  }
  const range = turnLogRange(events, turn)
  const turnSeqs = new Set(range === undefined ? [] : shadowedTurnNodes(nodes, range))
  // The fold protects the surface head while it holds a system/message (rc.2
  // assertSystemHeadRewrite: a multi-node replace over node 0 throws), so the
  // harness's in-turn system prompt row stays visible across the undo — it is
  // request plumbing, not chat content, and redo must not duplicate it either.
  const headSeq = nodes[0]
  if (headSeq !== undefined && events[headSeq]?.type === 'system/message') {
    turnSeqs.delete(headSeq)
  }
  // Positional trailing run (see trailingTurnRun): the fold splices by
  // position, and replacement events can displace turn nodes into earlier
  // positional clusters — only one contiguous run may be claimed.
  const shadowed = trailingTurnRun(nodes, turnSeqs)
  if (range === undefined || shadowed.length === 0) {
    return internal(`dsh-undo/not-tail: turn ${String(turn)} has no closed surface range`)
  }
  const append = buildTombstoneAppend({
    turn,
    step: lastStepOfTurn(events, turn),
    startSeq: shadowed[0] as number,
    endSeq: shadowed.at(-1) as number,
    shadowedSeqs: shadowed,
  })
  session.append('system/message', append.data, {
    surfaceOp: {
      op: 'replace',
      startSeq: SessionSeq(append.surfaceOp.startSeq),
      endSeq: SessionSeq(append.surfaceOp.endSeq),
    },
    sourceEventSeqs: append.sourceEventSeqs.map(SessionSeq),
  })
  return { ok: true as const, value: { turn } }
}

/**
 * Execute one redo request (design §3): locate the last tombstone, require it
 * to be the current surface tail (any newer message makes redo permanently
 * stale), and replay the shadowed turn as fake-turn copies.
 * @param host - live sessions/agents service slices.
 * @param sessionId - target session id.
 * @returns the restored turn, or a typed envelope failure.
 */
export async function performRedo(host: UndoHost, sessionId: string): Promise<RedoResult> {
  const session = host.sessions.get(SessionId(sessionId))
  if (session === undefined) return sessionNotFound(sessionId)
  const agent = host.agents.get(SessionId(sessionId))
  if (agent?.status === 'running') return agentBusy(sessionId)
  const events = session.snapshotEvents()
  const tombstone = findLastUndoTombstone(events)
  if (tombstone === undefined) {
    return internal(`dsh-undo/nothing-to-redo: no dsh-undo tombstone in session ${sessionId}`)
  }
  if (!isSurfaceTail(session.surface.nodes, tombstone.seq)) {
    return internal('dsh-undo/redo-stale: newer messages follow the tombstone; redo is no longer available')
  }
  const plan = buildRedoAppendPlan(events, tombstone)
  try {
    for (const step of plan) appendRedoStep(session, step)
  } catch (error) {
    // appendRedoStep is not atomic: a mid-plan rejection (surface validation
    // or a lost race) leaves a half-open fake turn with no turn/end, which
    // pins the client's idle fold (idle = lastTurnEndSeq >= lastTurnStartSeq)
    // and disables the button forever on an append-only log. Close the fake
    // turn with a synthetic aborted turn/end so the log stays well-formed and
    // the button recovers; the redo value itself is lost.
    try {
      session.append('turn/end', {
        turn: FAKE_TURN_BASE + tombstone.turn,
        reason: { kind: 'aborted' },
      } as SessionEventMap['turn/end'])
    } catch {
      // Even the recovery append failed; the session service owns the log.
    }
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`dsh-undo: redo failed mid-replay: ${reason}`)
    return internal(`dsh-undo/redo-failed: ${reason}`)
  }
  return { ok: true as const, value: { turn: tombstone.turn } }
}

/**
 * Append one replay step to the session. Surface steps use the canonical
 * tail-append op (no source citations — assistant messages carry their
 * embedded stream and tool/result copies need no pairing metadata, design
 * §2.2.5); boundary steps append without surface metadata.
 */
export function appendRedoStep(session: SessionLike, step: RedoAppendStep): void {
  if (isSurfaceStep(step)) {
    switch (step.type) {
      case 'user/message':
        session.append('user/message', step.data as SessionEventMap['user/message'], { surfaceOp: 'append' })
        break
      case 'assistant/message':
        session.append('assistant/message', step.data as SessionEventMap['assistant/message'], { surfaceOp: 'append' })
        break
      case 'tool/result':
        session.append('tool/result', step.data as SessionEventMap['tool/result'], { surfaceOp: 'append' })
        break
    }
    return
  }
  switch (step.type) {
    case 'turn/start':
      session.append('turn/start', step.data as SessionEventMap['turn/start'])
      break
    case 'step/start':
      session.append('step/start', step.data as SessionEventMap['step/start'])
      break
    case 'step/end':
      session.append('step/end', step.data as SessionEventMap['step/end'])
      break
    case 'turn/end':
      session.append('turn/end', step.data as SessionEventMap['turn/end'])
      break
    case 'tool/call':
      session.append('tool/call', step.data as SessionEventMap['tool/call'])
      break
  }
}

/** Narrow a replay step to its surface-append branch. */
function isSurfaceStep(step: RedoAppendStep): step is RedoSurfaceStep {
  return step.type === 'user/message' || step.type === 'assistant/message' || step.type === 'tool/result'
}

/**
 * Mount the host RPC channel. Endpoint handlers run inside a per-session
 * serial queue so concurrent undo/redo calls on one session cannot interleave
 * their read/append sequences (feedback enqueue precedent). The queue is not
 * drained on unload: appends are atomic per event and the session log is the
 * single source of truth, so an in-flight request finishing during teardown
 * leaves a consistent log either way.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  const host: UndoHost = {
    // The client half's `ISessions` augmentation (dsh-client-ui-conversation)
    // shadows the host SessionStore in the merged type graph (repo-wide,
    // pre-existing); the runtime service is the real SessionStore.
    sessions: { get: id => (ctx.sessions as unknown as { get(id: SessionId): SessionLike | undefined }).get(id) },
    agents: { get: id => ctx.agents.get(id) },
  }
  // Per-session serialization: the tail of the previous operation for the
  // same session gates the next one; an operation failure never poisons the
  // queue (the tail swallows the rejection).
  const tails = new Map<string, Promise<unknown>>()
  const enqueue = <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    tails.set(sessionId, tail)
    return result.finally(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId)
    })
  }

  // dsh-client-connection 0.1.5-rc.2: connection.rpc.handle() is unusable from
  // the profile plugin tree — the connection service is provided inside the
  // web-app boot tree, so a profile fiber's inject wait never activates.
  // Register a plain webServer prefix route speaking the same
  // client-request/server-response envelopes instead (notification pattern).
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: (req, res) => {
        void serveRpcChannel(req, res, { channel: CHANNEL, logLabel: 'dsh-undo: /dsh-undo channel' }, (endpoint, payload) => {
          if (endpoint === ENDPOINT_UNDO) {
            const parsed = parseUndoPayload(payload)
            if (parsed === undefined) {
              return Promise.resolve(internal('dsh-undo/bad-request: undo payload must carry sessionId and messageId strings'))
            }
            return enqueue(parsed.sessionId, () => performUndo(host, parsed.sessionId, parsed.messageId))
          }
          if (endpoint === ENDPOINT_REDO) {
            const parsed = parseRedoPayload(payload)
            if (parsed === undefined) {
              return Promise.resolve(internal('dsh-undo/bad-request: redo payload must carry sessionId string'))
            }
            return enqueue(parsed.sessionId, () => performRedo(host, parsed.sessionId))
          }
          return Promise.resolve(internal(`unknown endpoint ${endpoint}`))
        })
      },
    }), 'dsh-undo: /dsh-undo channel')
  })
}

/** Validate the undo RPC payload. */
function parseUndoPayload(payload: unknown): { sessionId: string; messageId: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as { sessionId?: unknown; messageId?: unknown }
  if (typeof record.sessionId !== 'string' || record.sessionId === ''
    || typeof record.messageId !== 'string' || record.messageId === '') return undefined
  return { sessionId: record.sessionId, messageId: record.messageId }
}

/** Validate the redo RPC payload. */
function parseRedoPayload(payload: unknown): { sessionId: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as { sessionId?: unknown }
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return undefined
  return { sessionId: record.sessionId }
}

/**
 * Serve one Connection-RPC channel over a plain webServer route, mirroring
 * dsh-client-connection's rpcFetchHandler semantics (POST-only, JSON
 * client-request envelope, server-response envelope out) so the browser-side
 * `connection.rpc.call()` keeps working unchanged.
 */
