/**
 * dsh-memory, node half.
 *
 * Cross-session memory for dsh: every compaction checkpoint message (the
 * surface `user/message` event whose `data.source` marks a compact plugin;
 * the `compaction/summary` event is metadata-only and never surfaces) is
 * harvested into a local sqlite file (idempotent on the event seq,
 * workspace-keyed by the session cwd), superseded checkpoints are marked and
 * hidden, session disposal drops that session's notes, and the segmented,
 * dual-pool-budgeted memory block is injected into every pre-step as a PERSISTED
 * context `user/message` row carrying a plugin source + digest (never a
 * dynamic systemPrompt section — the system prompt must stay byte-stable for
 * the provider prefix cache). The row is epoch-pinned: an in-place replace is
 * allowed only right after this session's own compaction (whose cache
 * invalidation the refresh rides); store changes between compactions pin the
 * row byte-stable instead of busting the prefix. `memory_write` / `memory_list` /
 * `memory_forget` give the agent an explicit memory API, and the `/memory-tidy`
 * command steers the agent with a generated prompt to reorganize the current
 * workspace's memory (merge duplicates, drop stale entries, settle conflicts
 * on the newer fact). Harvest and
 * injection are fully fault-isolated: a failure only logs a warning, never
 * reaches the host event stream or the agent waterfall.
 *
 * The browser half's read-only Memory tab is served over a webServer prefix
 * route `/dsh-memory` (Connection-RPC envelope, endpoint `block`): the SAME
 * pure functions the pre-step injection uses recompute the block per request,
 * so the tab shows byte-identical content — the model's-eye view.
 */
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { RpcResult } from '../../shared/rpc-types'
import { serveRpcChannel } from '../../shared/rpc-channel.ts'
import { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  assembleMemoryBlock,
  buildMemoryMessage,
  buildTidyMessage,
  cwdToWorkspaceKey,
  detectSupersession,
  extractCheckpointSummary,
  MEMORY_PLUGIN,
  segmentSummary,
  type MemoryBudgetOptions,
} from './pure.ts'
import { MemoryStore } from './store.ts'
import { installMemoryTools } from './tools.ts'

/** Stable Cordis plugin name. */
export const name = MEMORY_PLUGIN

/**
 * Required services: the tool registry plus the web router. The
 * `agent/pre-step` listener needs no injected service — it reads the live
 * session off the pre-step payload (`payload.agent.session`) and appends
 * through it, and the cordis event bus delivers the waterfall (spec
 * decision 19-style strictness; the retired `systemPrompt` service is no
 * longer consumed). `webServer` carries the Memory tab's read-only `/dsh-memory`
 * channel (spec — static inject, registered inside the single `ctx.effect`).
 */
export const inject = ['tools']

/** Plugin config: the three dual-pool/envelope knobs (spec — the old char budget is retired). */
export interface Config {
  /** Entry cap: harvest segment split threshold + memory_write truncation threshold (default: 2500). */
  maxEntryChars?: number
  /** Compaction pool size: whole checkpoint groups, newest first (default: 2). */
  maxCompactionSummaries?: number
  /** Manual pool budget: total content length (chars) of admitted entries, newest first (default: 10000). */
  maxManualChars?: number
}

/** Defaults when the config omits each knob. */
export const DEFAULT_MAX_ENTRY_CHARS = 2500
export const DEFAULT_MAX_COMPACTION_SUMMARIES = 2
export const DEFAULT_MAX_MANUAL_CHARS = 10000

export const Config = z.object({
  maxEntryChars: z.number().step(1).min(1).default(DEFAULT_MAX_ENTRY_CHARS),
  maxCompactionSummaries: z.number().step(1).min(0).default(DEFAULT_MAX_COMPACTION_SUMMARIES),
  maxManualChars: z.number().step(1).min(0).default(DEFAULT_MAX_MANUAL_CHARS),
})

/** The store file's subdirectory below the dsh home. */
export const MEMORY_DIR_RELATIVE = 'dsh-memory'
export const MEMORY_FILE = 'memory.db'

/** RPC channel owned by this plugin (the Memory tab's data path). */
const CHANNEL = '/dsh-memory'

/** Endpoint under {@link CHANNEL}: `{sessionId, cwd}` → `{block}` (the verbatim injected block). */
const ENDPOINT_BLOCK = 'block'

/**
 * Slash command name: one-shot generation of the memory-reorg prompt. The
 * handler steers the receiving agent with the prompt as a durable user
 * message; the agent then reorganizes through the three memory tools.
 */
export const TIDY_COMMAND = 'memory-tidy'

/** Structural command-invocation face for `/memory-tidy` (the registry's CommandInvocation). */
interface TidyInvocationLike {
  readonly agent: { readonly session: LiveSessionLike; steer(message: UserMessage): void }
  readonly rawInput: string
  readonly signal: AbortSignal
}

/** Structural command-result face (the registry's CommandResult). */
type TidyResultLike = { readonly kind: 'success'; readonly text?: string } | { readonly kind: 'error'; readonly text: string }

/** Structural command-registry face (the child context the inject grants). */
interface CommandChildContextLike {
  commands: {
    register(definition: {
      readonly name: string
      readonly description: string
      readonly input?: { readonly hint: string }
      readonly handler: (invocation: TidyInvocationLike) => TidyResultLike | Promise<TidyResultLike>
    }): () => void
  }
}

/**
 * Structural live session as the pre-step reads it: the harness `Agent`
 * carries `session` (core/agent runtime-types:168), the same live `Session`
 * the loop appends through. `snapshotEvents()` returns the log indexed by
 * seq, so `events[seq]` resolves a surface node to its event (dsh-undo's
 * reading pattern).
 */
export interface LiveSessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
  readonly surface: { readonly nodes: readonly number[] }
  snapshotEvents(): readonly unknown[]
  append: Session['append']
}

/** Structural surface row for the memory scan (only the fields the scan reads). */
interface MemoryScanEvent {
  readonly type?: string
  readonly data?: {
    readonly source?: { readonly kind?: string; readonly plugin?: string; readonly digest?: string }
  }
}

/** Structural `agent/pre-step` payload: the live agent carrying its session. */
export interface PreStepPayloadLike {
  readonly agent?: { readonly session?: LiveSessionLike }
}

/** Structural pre-step waterfall decision (mirrors the harness PreStepDecision). */
export type PreStepDecisionLike = { kind: 'reject' } | { kind: 'enter'; messages: readonly UserMessage[] }

/** Structural session as events deliver it (harvest path, unchanged). */
interface SessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
}

/** Structural checkpoint user/message event (the payload fields used for harvest). */
interface CheckpointEventLike {
  readonly seq?: unknown
  readonly time?: unknown
  readonly type: string
  readonly data?: unknown
  /** Derivation links live at the event top level (sibling of data), per the session append contract. */
  readonly sourceEventSeqs?: unknown
}

/**
 * The pre-step injection decision (testable core of the handler):
 * `append` → persist one fresh context row this step, `replace` → splice the
 * existing row in place, `none` → touch nothing.
 */
export type MemoryInjectionPlan =
  | { readonly kind: 'append'; readonly message: UserMessage }
  | { readonly kind: 'replace'; readonly message: UserMessage; readonly rowSeq: number }
  | { readonly kind: 'none' }

/**
 * The last live-surface memory row (its seq and digest), scanning the surface
 * node list backwards (surface order = positional model order; the LAST row
 * wins, so a redo-cloned copy or a replace-spliced refresh is the row the
 * next replace targets — digest-equal clones stay untouched). Shadowed
 * (tombstone-covered) rows are not surface nodes, so a fully shadowed memory
 * row vanishes from the scan → fresh append at the tail = self-heal.
 * @param session - the live session.
 * @returns the row's seq + digest, or undefined when none is on the surface.
 */
export function findLastMemoryRow(session: LiveSessionLike): { readonly seq: number; readonly digest: string } | undefined {
  const events = session.snapshotEvents() as readonly (MemoryScanEvent | undefined)[]
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    const event = seq === undefined ? undefined : events[seq]
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind === 'dsh-memory' && source.plugin === MEMORY_PLUGIN) {
      return { seq, digest: typeof source.digest === 'string' ? source.digest : '' }
    }
  }
  return undefined
}

/**
 * Whether this session has committed a compaction AFTER the surfaced memory
 * row was written (epoch pinning, spec): between compactions the row is
 * deliberately pinned — a store change (this session's own memory_write or
 * another session's write/harvest) must NOT replace the row mid-epoch,
 * because the row sits at the head of the prefix and an in-place replace
 * invalidates the whole cached conversation. A compaction already busts
 * that cache, so a refresh riding the epoch boundary is free.
 * @param session - the live session (its event log).
 * @param rowSeq - the surfaced memory row's seq.
 * @returns true when a compaction/summary event exists at a seq after the row.
 */
function sessionCompactedSince(session: LiveSessionLike, rowSeq: number): boolean {
  const events = session.snapshotEvents() as readonly (MemoryScanEvent | undefined)[]
  for (let index = events.length - 1; index > rowSeq; index -= 1) {
    if (events[index]?.type === 'compaction/summary') return true
  }
  return false
}

/**
 * Decide the injection for one pre-step (pure over the live session + store):
 * assemble the block for the session's workspace under the dual-pool budget,
 * build the context message with its digest, and compare against the last
 * surfaced memory row:
 * - no row + non-empty block → append the fresh row;
 * - row + same digest → no-op (row is byte-stable);
 * - row + differing digest + compaction since the row (epoch boundary) →
 *   replace in place — the refresh rides the cache invalidation the
 *   compaction already caused;
 * - row + differing digest + NO compaction since the row → no-op (epoch
 *   pinning: the block stays pinned to the session's last epoch — its start
 *   or its latest compaction — and store changes wait for the next epoch),
 *   UNLESS `forceRefresh` is set (the refresh arming: a memory_forget drop or
 *   a closed /memory-tidy turn): then replace in place immediately — the
 *   row's own session just deleted or reorganized memories, so the refresh is
 *   the point of the change, and granting it never touches other sessions'
 *   pinned rows;
 * - empty block → never inject (a stale row, if any, is left on the surface —
 *   documented edge, README).
 * @param store - the memory store.
 * @param session - the live session (cwd + surface + log).
 * @param options - the dual-pool budget.
 * @param forceRefresh - whether a mid-epoch digest change replaces the row
 *   right away (armed per session by forget or a closed tidy turn);
 *   defaults to false.
 * @returns the injection plan.
 */
export function planMemoryInjection(
  store: MemoryStore,
  session: LiveSessionLike,
  options: MemoryBudgetOptions,
  forceRefresh = false,
): MemoryInjectionPlan {
  const cwd = session.header.cwd
  if (cwd === undefined) return { kind: 'none' }
  const block = assembleMemoryBlock(store.listActive(cwdToWorkspaceKey(cwd), session.id ?? null), options, session.id ?? undefined)
  if (block === '') return { kind: 'none' }
  const message = buildMemoryMessage(block)
  const row = findLastMemoryRow(session)
  if (row === undefined) return { kind: 'append', message }
  const digest = (message.source as { readonly digest?: string }).digest
  if (digest !== undefined && row.digest === digest) return { kind: 'none' }
  if (!forceRefresh && !sessionCompactedSince(session, row.seq)) return { kind: 'none' }
  return { kind: 'replace', message, rowSeq: row.seq }
}

/** Structural plugin context face (the webServer slice mirrors how peak-rate consumes it). */
interface MemoryCtx {
  tools: { register(definition: unknown): () => void }
  /** Optional service read via `ctx.get` (property access without inject throws in cordis). */
  get(name: 'webServer'): {
    register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
  } | undefined
  /** Child command-registry mount: the `/memory-tidy` command ships only when a command registry is composed (plan-mode pattern). */
  inject(dependencies: readonly ['commands'], callback: (child: CommandChildContextLike) => void): unknown
  on(event: 'session/event', listener: (session: SessionLike, event: CheckpointEventLike) => void): () => void
  on(event: 'session/disposed', listener: (session: SessionLike) => void): () => void
  on(event: 'agent/turn-stopping', listener: (payload: { readonly agent: { readonly session: { readonly id: string } } }) => void): () => void
  on(event: 'agent/pre-step', listener: (payload: PreStepPayloadLike, next: () => Promise<PreStepDecisionLike>) => Promise<PreStepDecisionLike>): () => void
}

/** Extract the joined text of a ContentBlock[] (text blocks only). */
function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is { type: 'text'; text: string } => {
      if (typeof block !== 'object' || block === null) return false
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Read the summary's shadowed seqs into a number[] (non-numeric entries ignored). */
function readSeqArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is number =>
    typeof entry === 'number' && Number.isInteger(entry))
}

/** Structural check: does the event source carry the compaction checkpoint marker? */
function isCompactCheckpointSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const candidate = source as { kind?: unknown; plugin?: unknown }
  return candidate.kind === 'compact-checkpoint'
    || (candidate.kind === 'plugin' && candidate.plugin === 'compact')
}

/** One-session harvest: segment the checkpoint summary, store its segments, run supersession, notify. Never throws. */
function harvestCompaction(store: MemoryStore, session: SessionLike, event: CheckpointEventLike, maxEntryChars: number): void {
  const seq = event.seq
  if (typeof seq !== 'number') return // no stable idempotency key
  const data = event.data as { content?: unknown } | undefined
  if (data === undefined) return
  const content = extractCheckpointSummary(textOfBlocks(data.content))
  if (content === '') return
  const cwd = session.header.cwd
  if (cwd === undefined) return // no workspace to scope into
  const createdAt = typeof event.time === 'number' ? event.time : Date.now()
  const shadowed = readSeqArray(event.sourceEventSeqs)
  const workspace = cwdToWorkspaceKey(cwd)
  // Segment at harvest (pure function of text + cap → deterministic), so the
  // store holds segment-level rows and re-harvest is idempotent at GROUP
  // granularity (insertCompaction skips the whole event when any segment
  // exists — a changed cap re-splitting the summary still stores nothing).
  const segments = segmentSummary(content, maxEntryChars)
  if (segments.length === 0) return
  const id = store.insertCompaction({
    workspace,
    sessionId: session.id,
    segments,
    sourceEventSeq: seq,
    shadowedEventSeqs: shadowed,
    createdAt,
  })
  if (id === null) return // duplicate event, already harvested
  const targets = detectSupersession(shadowed, store.listActive(workspace, session.id))
  if (targets.length > 0) store.markSuperseded(targets, id)
}

/**
 * Mount the pre-step injection, the event harvest, the disposal cleanup, and
 * the three memory tools.
 * @param ctx - host plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const scoped = ctx as unknown as MemoryCtx
  // DSH_HOME env override, falling back to `~/.dsh`; the store directory is
  // created lazily on first mount.
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const memoryDir = join(dshHome, MEMORY_DIR_RELATIVE)
  mkdirSync(memoryDir, { recursive: true })
  const db = new DatabaseSync(join(memoryDir, MEMORY_FILE))
  const store = new MemoryStore(db)
  // Two refresh-arming sources, one settled flag:
  // - `pendingRefresh` — the row is owed a re-assembly NOW: a successful
  //   memory_forget dropped bytes the session may never see again, or a
  //   /memory-tidy turn just closed. The next pre-step consumes the flag and
  //   splices the re-assembled block in place (or clears it when the row
  //   already reflects the store).
  // - `tidyPending` — a /memory-tidy turn is in progress: the command steers
  //   the reorg, and the flag must NOT fire on the tidy turn's own pre-steps
  //   (the first one runs BEFORE the reorg tools land — a pre-tool consume
  //   would leave the post-tool store pinned again). agent/turn-stopping
  //   transfers it to `pendingRefresh`, so the first pre-step AFTER the turn
  //   (the next message's step) syncs the final store, forget-called or not.
  // memory_write arms neither: its content is already on the session surface
  // (the tool result), so an injected echo would be redundant (epoch-pin
  // semantics for own writes). Both sets are keyed by session id, so sibling
  // sessions keep their pinned rows untouched.
  const pendingRefresh = new Set<string>()
  const tidyPending = new Set<string>()
  const budget: MemoryBudgetOptions = {
    maxEntryChars: config.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS,
    maxCompactionSummaries: config.maxCompactionSummaries ?? DEFAULT_MAX_COMPACTION_SUMMARIES,
    maxManualChars: config.maxManualChars ?? DEFAULT_MAX_MANUAL_CHARS,
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // Pre-step injection (replaces the retired dynamic systemPrompt section;
    // `system-prompt/change` emission dropped with it — advisory only, no
    // harness consumer). The memory rides a persisted context user/message row
    // with a plugin source + digest, exactly the RuntimeContextProjection /
    // magic-context m0-m1 delivery pattern, so the system prompt bytes stay
    // fixed and the provider prefix cache survives unchanged steps; only a
    // real memory change invalidates the cache from the row's byte onward, in
    // place, for one request.
    //
    // Why merged through next(): the pre-step waterfall's own fallback builds
    // the incoming batch (`[...claimed, runtimeContext]`), and other listeners
    // (magic-context's prepended gate) rewrite payload.messages. Returning our
    // own enter decision without next() would veto the whole chain and drop
    // the user's actual message — so the memory message is always appended to
    // the downstream enter decision instead. A rejected step (kind 'reject')
    // just skips the memory append for this step; the next step retries.
    //
    // Why not agent.inject(): inject queues into the next-step inbox, which
    // the loop claims and appends AGAIN, duplicating the row (magic-context
    // knowledge-gate comment warning). The pre-step decision path (or an
    // in-place surface replace) persists exactly once.
    //
    // Not prepended on purpose: magic-context's gate is the outermost fence;
    // memory runs after it and merges at the message tail.
    disposers.push(scoped.on('agent/pre-step', async (payload, next) => {
      const session = payload.agent?.session
      const sessionId = session?.id
      // The refresh arming (forget drop or a closed /memory-tidy turn) lets
      // the digest comparison replace the row right away instead of waiting
      // for a compaction boundary. The flag is consumed by this pre-step
      // either way — replaced, freshly appended, or already fresh.
      const forceRefresh = sessionId !== undefined && pendingRefresh.delete(sessionId)
      let plan: MemoryInjectionPlan = { kind: 'none' }
      try {
        // Same fault-isolation discipline as harvest: any store/log failure
        // here is contained to a warning; the waterfall always proceeds.
        plan = session === undefined
          ? { kind: 'none' }
          : planMemoryInjection(store, session, budget, forceRefresh)
      } catch (error) {
        ctx.logger.warn(`[dsh-memory] injection failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (plan.kind === 'replace' && session !== undefined) {
        // In-place splice: the row keeps its position (a context row in the
        // wire, not the head), new content + digest land immediately, and the
        // provider prefix cache is invalidated from this byte only when the
        // memory actually changed — the whole point of this rewrite. Same
        // fault isolation as every other write here: the surface validation
        // (rowSeq shadowed by a concurrent compaction) is contained to a
        // warning instead of throwing through the pre-step waterfall.
        try {
          session.append('user/message', plan.message, {
            surfaceOp: { op: 'replace', startSeq: SessionSeq(plan.rowSeq), endSeq: SessionSeq(plan.rowSeq) },
            sourceEventSeqs: [SessionSeq(plan.rowSeq)],
          })
        } catch (error) {
          ctx.logger.warn(`[dsh-memory] memory row replace failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const decision = await next()
      if (plan.kind !== 'append' || session === undefined || decision.kind !== 'enter') return decision
      // ONE fresh context row this step: the loop persists decision.messages
      // as durable user/message appends (agent-loop step admission), giving
      // immediate visibility AND durability — the row next pre-step scans.
      return { ...decision, messages: [...decision.messages, plan.message] }
    }))

    // The three memory tools, effect-scoped like the pre-step listener. A
    // write lands via the next pre-step's digest comparison (no
    // system-prompt/change notify needed anymore — the injected bytes are
    // the persisted row, replaced in place). A forget arms the calling
    // session's refresh: the deleted bytes must leave the injected block at
    // the next pre-step, not at the next compaction.
    disposers.push(installMemoryTools(scoped.tools, store, budget.maxEntryChars, (sessionId) => {
      if (sessionId !== undefined) pendingRefresh.add(sessionId)
    }))

    // The Memory tab's data path: a plain webServer prefix route speaking the
    // Connection-RPC client-request/server-response envelope (peak-rate/
    // undo serveChannel pattern — `connection.rpc.handle()` is
    // unreachable from the profile plugin tree). Endpoint `block` recomputes
    // the block through the SAME pure functions the pre-step injection uses
    // (`assembleMemoryBlock` over `store.listActive`), so the tab renders
    // byte-identical content to what the model sees. Empty sessionId/cwd
    // answer `{block: ''}`; an unknown endpoint answers the RPC error shape;
    // an assembly/store fault is contained to a warning + error result —
    // same harvest discipline, never a thrown request. Web-only: profiles
    // without a webServer (or with the route unused) skip the channel, so the
    // fiber never waits on a web-plane service (optional service discipline:
    // `ctx.get` reads the global store and returns undefined; a direct
    // property read of an undeclared service throws in cordis 4).
    const webServer = scoped.get('webServer')
    if (webServer !== undefined) {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: (req, res) => {
          void serveRpcChannel(req, res, { channel: CHANNEL, logLabel: 'dsh-memory: /dsh-memory channel' }, (endpoint, payload) => {
            if (endpoint !== ENDPOINT_BLOCK) {
              return Promise.resolve({
                ok: false as const,
                error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
              })
            }
            try {
              const { sessionId, cwd } = (payload ?? {}) as { sessionId?: unknown; cwd?: unknown }
              if (typeof sessionId !== 'string' || sessionId === ''
                || typeof cwd !== 'string' || cwd === '') {
                return Promise.resolve({ ok: true as const, value: { block: '' } })
              }
              const block = assembleMemoryBlock(store.listActive(cwdToWorkspaceKey(cwd), sessionId), budget, sessionId)
              return Promise.resolve({ ok: true as const, value: { block } })
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error)
              ctx.logger.warn(`[dsh-memory] block endpoint failed: ${reason}`)
              return Promise.resolve({
                ok: false as const,
                error: { code: 'internal', message: `block assembly failed: ${reason}`, details: {} },
              })
            }
          })
        },
      }))
    }

    // Fire-and-forget harvest: every exception is contained to a warning log,
    // never thrown into the compaction transaction (spec decision 15).
    disposers.push(scoped.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const data = event.data as { source?: unknown } | undefined
      if (!isCompactCheckpointSource(data?.source)) return
      try {
        harvestCompaction(store, session, event, budget.maxEntryChars)
      } catch (error) {
        ctx.logger.warn(`[dsh-memory] compaction harvest failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))

    // Session disposal clears that session's notes (spec US-12); workspace
    // checkpoints survive their source session. It also drops any pending
    // refresh / tidy arming (the session is gone, the flags are meaningless).
    disposers.push(scoped.on('session/disposed', (session) => {
      pendingRefresh.delete(session.id)
      tidyPending.delete(session.id)
      try {
        store.deleteSessionRows(session.id)
      } catch (error) {
        ctx.logger.warn(`[dsh-memory] session cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))

    // A /memory-tidy turn closed: move its arming into the pending refresh so
    // the FIRST pre-step after the turn (the next message's step) re-assembles
    // the row — whether or not the reorg called memory_forget. The transfer
    // (not a direct pre-step read) is what keeps the tidy turn's own pre-tool
    // pre-step from consuming the flag early. Same fault-isolation discipline
    // as the harvest/pre-step paths: an unexpected payload (or a broken
    // session deref) is contained to a warning, never thrown into the serial
    // turn-stopping dispatch.
    disposers.push(scoped.on('agent/turn-stopping', (payload) => {
      try {
        const sessionId = payload.agent.session.id
        if (tidyPending.delete(sessionId)) pendingRefresh.add(sessionId)
      } catch (error) {
        ctx.logger.warn(`[dsh-memory] tidy transfer failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))

    return () => {
      for (const dispose of disposers) dispose()
      try {
        db.close()
      } catch {
        // Already closed: nothing to release.
      }
    }
  })

  // The `/memory-tidy` command, mounted through a commands-injected child so
  // the core memory fiber stays headless-safe: compositions without a command
  // registry (ACP, bare demo trunks) still mount the store, harvest, and
  // tools. One handler call builds the reorganization prompt (pure.ts, pinned
  // verbatim) and steers the receiving agent with it as a durable user
  // message — the steer path persists the prompt as a user/message row and
  // wakes an idle agent, so the agent's next turn runs the reorg through the
  // three memory tools (memory_list → classify → memory_write/memory_forget).
  // Like the injected memory row, the steered prompt is model-visible and
  // fully log-reconstructable; the handler itself only needs the agent's cwd
  // to guarantee a real workspace target (the same gate memory_write applies).
  scoped.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: TIDY_COMMAND,
      description: '整理当前 workspace 的记忆：合并重复、删除过期、解决冲突（以较新事实为准）',
      input: { hint: '可选：附加的整理要求' },
      handler: (invocation) => {
        invocation.signal.throwIfAborted()
        if (invocation.agent.session.header.cwd === undefined) {
          return {
            kind: 'error',
            text: '/memory-tidy: 当前会话没有 workspace（session.header.cwd 为空），无法定位要整理的记忆',
          }
        }
        invocation.agent.steer(buildTidyMessage(invocation.rawInput))
        // Arm the post-tidy refresh: once the reorg turn closes, the next
        // pre-step of THIS session re-assembles the injected row — whether or
        // not the reorg called memory_forget (the deletes additionally arm
        // the immediate path through onForget). The arming is kept out of the
        // pre-step read until the turn closes (transfer in turn-stopping), so
        // the tidy turn's own pre-tool step can never consume it early.
        tidyPending.add(invocation.agent.session.id)
        return { kind: 'success', text: '/memory-tidy: 已生成整理 prompt 并交给 agent（见下一条消息），整理回合结束后注入记忆会自动同步' }
      },
    })
  })
}
