/**
 * dsh-memory, node half.
 *
 * Cross-session memory for dsh: every compaction checkpoint message (the
 * surface `user/message` event whose `data.source` marks a compact plugin;
 * the `compaction/summary` event is metadata-only and never surfaces) is
 * harvested into a local sqlite file (idempotent on the event seq,
 * workspace-keyed by the session cwd), superseded checkpoints are marked and
 * hidden, session disposal drops that session's notes, and a dynamic
 * `systemPrompt` section re-reads the store at every assembly and injects the
 * filtered, budget-trimmed memory block. `memory_write` / `memory_list` /
 * `memory_forget` give the agent an explicit memory API. Harvest is fully
 * fault-isolated: a failure only logs a warning, never reaches the host event
 * stream.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  assembleMemoryBlock,
  cwdToWorkspaceKey,
  detectSupersession,
  extractCheckpointSummary,
} from './pure.ts'
import { MemoryStore } from './store.ts'
import { installMemoryTools } from './tools.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-memory'

/**
 * Required services: the system-prompt registry and the tool registry. Event
 * listeners and the emissions need no injected service (spec decision 19).
 */
export const inject = ['systemPrompt', 'tools']

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

/** Dynamic section placement: right after the tool sections (spec decision). */
export const SECTION_NAME = 'dsh-memory:context'
export const SECTION_ORDER = 3120

/** The store file's subdirectory below the dsh home. */
export const MEMORY_DIR_RELATIVE = 'dsh-memory'
export const MEMORY_FILE = 'memory.db'

/** Structural assembly context: session cwd + id for workspace/session resolution. */
interface AssemblyContextLike {
  readonly agent?: { readonly session?: { readonly id?: string; readonly header?: { readonly cwd?: string } } }
}

/** Structural session as events deliver it. */
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

/** Structural plugin context face. */
interface MemoryCtx {
  systemPrompt: {
    section(section: {
      readonly name: string
      readonly order: number
      readonly text: (context: AssemblyContextLike) => string
      readonly interpolate?: boolean
    }): () => void
  }
  tools: { register(definition: unknown): () => void }
  on(event: 'session/event', listener: (session: SessionLike, event: CheckpointEventLike) => void): () => void
  on(event: 'session/disposed', listener: (session: SessionLike) => void): () => void
  emit(event: 'system-prompt/change'): void
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
function harvestCompaction(store: MemoryStore, notify: () => void, session: SessionLike, event: CheckpointEventLike): void {
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
  notify()
}

/**
 * Mount the dynamic prompt section, the event harvest, the disposal cleanup,
 * and the three memory tools.
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
  const notify = (): void => scoped.emit('system-prompt/change')

  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // Dynamic injection: re-reads the store at every assembly, so a memory
    // write lands on the very next prompt (spec decision 14).
    disposers.push(scoped.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: (assembly) => {
        const agent = assembly.agent
        const cwd = agent?.session?.header?.cwd
        if (cwd === undefined) return ''
        const rows = store.listActive(cwdToWorkspaceKey(cwd), agent.session?.id ?? null)
        return assembleMemoryBlock(rows, { maxChars: config.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS })
      },
    }))

    // The three memory tools, effect-scoped like the section.
    disposers.push(installMemoryTools(scoped.tools, store, notify))

    // Fire-and-forget harvest: every exception is contained to a warning log,
    // never thrown into the compaction transaction (spec decision 15).
    disposers.push(scoped.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const data = event.data as { source?: unknown } | undefined
      if (!isCompactCheckpointSource(data?.source)) return
      try {
        harvestCompaction(store, notify, session, event)
      } catch (error) {
        ctx.logger.warn(`[dsh-memory] compaction harvest failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))

    // Session disposal clears that session's notes (spec US-12); workspace
    // checkpoints survive their source session.
    disposers.push(scoped.on('session/disposed', (session) => {
      try {
        if (store.deleteSessionRows(session.id) > 0) notify()
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