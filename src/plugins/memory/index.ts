/**
 * dsh-memory, node half.
 *
 * Cross-session memory for dsh: every compaction checkpoint message (the
 * surface `user/message` event whose `data.source` marks a compact plugin;
 * the `compaction/summary` event is metadata-only and never surfaces) is
 * harvested into a local sqlite file (idempotent on the event seq,
 * workspace-keyed by the session cwd), superseded checkpoints are marked and
 * hidden, session disposal drops that session's notes, and the filtered,
 * budget-trimmed memory block is injected into every pre-step as a PERSISTED
 * context `user/message` row carrying a plugin source + digest (never a
 * dynamic systemPrompt section — the system prompt must stay byte-stable for
 * the provider prefix cache). `memory_write` / `memory_list` /
 * `memory_forget` give the agent an explicit memory API. Harvest and
 * injection are fully fault-isolated: a failure only logs a warning, never
 * reaches the host event stream or the agent waterfall.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  assembleMemoryBlock,
  buildMemoryMessage,
  cwdToWorkspaceKey,
  detectSupersession,
  extractCheckpointSummary,
  MEMORY_PLUGIN,
} from './pure.ts'
import { MemoryStore } from './store.ts'
import { installMemoryTools } from './tools.ts'

/** Stable Cordis plugin name. */
export const name = MEMORY_PLUGIN

/**
 * Required services: the tool registry only. The `agent/pre-step` listener
 * needs no injected service — it reads the live session off the pre-step
 * payload (`payload.agent.session`) and appends through it, and the cordis
 * event bus delivers the waterfall (spec decision 19-style strictness; the
 * retired `systemPrompt` service is no longer consumed).
 */
export const inject = ['tools']

/** Plugin config: the single tuning knob, the injection char budget. */
export interface Config {
  /** Max characters of the injected memory block; older content is trimmed with an omitted count (default: 6000). */
  maxBlockChars?: number
}

export const Config = z.object({
  maxBlockChars: z.number().step(1).min(1).default(6000),
})

/** The default char budget when the config omits it. */
export const DEFAULT_MAX_BLOCK_CHARS = 6000

/** The store file's subdirectory below the dsh home. */
export const MEMORY_DIR_RELATIVE = 'dsh-memory'
export const MEMORY_FILE = 'memory.db'

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
    if (source?.kind === 'plugin' && source.plugin === MEMORY_PLUGIN) {
      return { seq, digest: typeof source.digest === 'string' ? source.digest : '' }
    }
  }
  return undefined
}

/**
 * Decide the injection for one pre-step (pure over the live session + store):
 * assemble the block for the session's workspace, build the context message
 * with its digest, and compare against the last surfaced memory row:
 * - no row + non-empty block → append the fresh row;
 * - row + same digest → no-op (row is byte-stable);
 * - row + differing digest + non-empty block → replace in place;
 * - empty block → never inject (a stale row, if any, is left on the surface —
 *   documented edge, README).
 * @param store - the memory store.
 * @param session - the live session (cwd + surface + log).
 * @param maxChars - the block char budget.
 * @returns the injection plan.
 */
export function planMemoryInjection(store: MemoryStore, session: LiveSessionLike, maxChars: number): MemoryInjectionPlan {
  const cwd = session.header.cwd
  if (cwd === undefined) return { kind: 'none' }
  const block = assembleMemoryBlock(store.listActive(cwdToWorkspaceKey(cwd), session.id ?? null), { maxChars })
  if (block === '') return { kind: 'none' }
  const message = buildMemoryMessage(block)
  const row = findLastMemoryRow(session)
  if (row === undefined) return { kind: 'append', message }
  const digest = (message.source as { readonly digest?: string }).digest
  if (digest !== undefined && row.digest === digest) return { kind: 'none' }
  return { kind: 'replace', message, rowSeq: row.seq }
}

/** Structural plugin context face. */
interface MemoryCtx {
  tools: { register(definition: unknown): () => void }
  on(event: 'session/event', listener: (session: SessionLike, event: CheckpointEventLike) => void): () => void
  on(event: 'session/disposed', listener: (session: SessionLike) => void): () => void
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
  return candidate.kind === 'plugin' && candidate.plugin === 'compact'
}

/** One-session harvest: store the checkpoint summary, run supersession, notify. Never throws. */
function harvestCompaction(store: MemoryStore, session: SessionLike, event: CheckpointEventLike): void {
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
  const id = store.insertCompaction({
    workspace,
    sessionId: session.id,
    content,
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
      let plan: MemoryInjectionPlan = { kind: 'none' }
      try {
        // Same fault-isolation discipline as harvest: any store/log failure
        // here is contained to a warning; the waterfall always proceeds.
        plan = session === undefined
          ? { kind: 'none' }
          : planMemoryInjection(store, session, config.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS)
      } catch (error) {
        ctx.logger.warn(`[dsh-memory] injection failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (plan.kind === 'replace' && session !== undefined) {
        // In-place splice: the row keeps its position (a context row in the
        // wire, not the head), new content + digest land immediately, and the
        // provider prefix cache is invalidated from this byte only when the
        // memory actually changed — the whole point of this rewrite.
        session.append('user/message', plan.message, {
          surfaceOp: { op: 'replace', startSeq: SessionSeq(plan.rowSeq), endSeq: SessionSeq(plan.rowSeq) },
          sourceEventSeqs: [SessionSeq(plan.rowSeq)],
        })
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
    // the persisted row, replaced in place).
    disposers.push(installMemoryTools(scoped.tools, store))

    // Fire-and-forget harvest: every exception is contained to a warning log,
    // never thrown into the compaction transaction (spec decision 15).
    disposers.push(scoped.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const data = event.data as { source?: unknown } | undefined
      if (!isCompactCheckpointSource(data?.source)) return
      try {
        harvestCompaction(store, session, event)
      } catch (error) {
        ctx.logger.warn(`[dsh-memory] compaction harvest failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))

    // Session disposal clears that session's notes (spec US-12); workspace
    // checkpoints survive their source session.
    disposers.push(scoped.on('session/disposed', (session) => {
      try {
        store.deleteSessionRows(session.id)
      } catch (error) {
        ctx.logger.warn(`[dsh-memory] session cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
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
}