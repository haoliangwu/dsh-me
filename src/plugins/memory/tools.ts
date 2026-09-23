/**
 * dsh-memory tools: `memory_write` / `memory_list` / `memory_forget` over the
 * memory store, registered through the host tool registry (defineTool DSL,
 * the session-messenger structure). Every write notifies the caller so the
 * dynamic prompt section re-renders next assembly.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { cwdToWorkspaceKey, scopeOfRow, type ManualScope, type MemoryBlockRow } from './pure.ts'
import type { MemoryStore } from './store.ts'

/** Structural tool-registry face: register returns a disposer. */
interface ToolsLike {
  register(definition: unknown): () => void
}

/** Structural execution context: the caller agent plus cancellation. */
interface ToolExecLike {
  agent?: { readonly session?: { readonly id?: string; readonly header?: { readonly cwd?: string } } } | undefined
  signal?: AbortSignal
}

/** The caller session's cwd, when present. */
function cwdOf(exec: ToolExecLike): string | undefined {
  return exec.agent?.session?.header?.cwd
}

/** The caller's workspace key, or null when the session carries no cwd. */
function workspaceKeyOf(exec: ToolExecLike): string | null {
  const cwd = cwdOf(exec)
  return cwd !== undefined ? cwdToWorkspaceKey(cwd) : null
}

/** Content preview length for list output (token-light rows). */
const CONTENT_PREVIEW = 240

/** One list row as the model sees it: previewed content plus provenance. */
interface ListEntry {
  readonly id: number
  readonly scope: ManualScope
  readonly kind: 'manual' | 'compaction'
  readonly content: string
  readonly created: number
}

/** Resolve the effective write scope for one call; session scope needs a session context to bind to. */
function resolveWriteScope(req: ManualScope, exec: ToolExecLike): ManualScope {
  if (req !== 'session') return req
  if (exec.agent?.session === undefined) {
    throw new Error('memory_write session scope needs session context (exec.agent.session is empty)')
  }
  return 'session'
}

/** List-row projection: scope from columns, content previewed to {@link CONTENT_PREVIEW}. */
function toListEntry(row: MemoryBlockRow): ListEntry {
  const content = row.content.length > CONTENT_PREVIEW
    ? `${row.content.slice(0, CONTENT_PREVIEW - 3)}...`
    : row.content
  return {
    id: row.id,
    scope: scopeOfRow(row),
    kind: row.kind,
    content,
    created: row.created_at,
  }
}

/**
 * Register the three memory tools on the given registry.
 * @param ctx - the tool-registry face.
 * @param store - the memory store.
 * @param notify - callback fired after every mutation (emits `system-prompt/change`).
 * @returns the composite disposer unregistering all three tools.
 */
export function installMemoryTools(ctx: ToolsLike, store: MemoryStore, notify: () => void): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.register(defineTool({
    name: 'memory_write',
    description:
      'Save one durable memory: persistent knowledge useful across sessions of this workspace '
      + '(project facts, user preferences, hard-won fixes). Do NOT store ephemeral details of the '
      + 'current turn. Scope: "workspace" (default, this cwd), "global" (all workspaces), '
      + '"session" (this session only — survives compaction but dies with the session).',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The durable memory text',
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'global', 'session'],
        description: 'Memory scope; defaults to "workspace"',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', required: true },
          scope: { type: 'string', required: true },
        },
      },
      render: (_args, value: { id: number; scope: string }) => [{
        type: 'text',
        text: `saved memory #${String(value.id)} (scope: ${value.scope})`,
      }],
    },
    async execute(args: { content: string; scope?: ManualScope }, exec: ToolExecLike) {
      exec.signal?.throwIfAborted()
      const content = args.content.trim()
      if (content === '') throw new Error('memory_write content must not be empty')
      const requested = args.scope ?? 'workspace'
      // A genuine workspace/global write without a calling agent is a caller
      // bug; session scope needs a session context (resolveWriteScope throws).
      if (exec.agent === undefined && requested !== 'session') {
        throw new Error('memory_write needs a calling agent (exec.agent is empty)')
      }
      const scope = resolveWriteScope(requested, exec)
      // Workspace must resolve to a real cwd key: a NULL workspace would render
      // as global and escape cwd isolation, so fail loudly instead of storing.
      if (scope === 'workspace' && cwdOf(exec) === undefined) {
        throw new Error('memory_write workspace scope needs the session cwd (exec.agent.session.header.cwd is empty)')
      }
      const workspace = scope === 'global' ? null : workspaceKeyOf(exec)
      const sessionId = scope === 'session' ? (exec.agent?.session?.id ?? null) : null
      const id = store.insertManual(scope, { content, sessionId, workspace })
      notify()
      return { id, scope }
    },
  })))

  disposers.push(ctx.register(defineTool({
    name: 'memory_list',
    description:
      'List stored memories visible to this session: global, this workspace, and this session\'s '
      + 'own notes. Optional keyword filters content by substring. Read-only audit of the memory bank.',
    parameters: {
      keyword: {
        type: 'string',
        description: 'Optional substring filter over memory content',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                scope: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                content: { type: 'string', required: true },
                created: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { memories: readonly ListEntry[] }) => [{
        type: 'text',
        text: value.memories.length === 0 ? 'no memories' : JSON.stringify(value.memories),
      }],
    },
    async execute(args: { keyword?: string }, exec: ToolExecLike) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('memory_list needs a calling agent (exec.agent is empty)')
      exec.signal?.throwIfAborted()
      const rows = store.listActive(workspaceKeyOf(exec), caller.session?.id ?? null, args.keyword)
      return { memories: rows.map(toListEntry) }
    },
  })))

  disposers.push(ctx.register(defineTool({
    name: 'memory_forget',
    description:
      'Delete one stored memory by its id (see memory_list). Use for outdated or wrong memories; '
      + 'deletion is permanent unless the host replays the same compaction event.',
    parameters: {
      id: {
        type: 'integer',
        required: true,
        description: 'The memory row id to delete',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value: { deleted: boolean }) => [{
        type: 'text',
        text: value.deleted ? 'memory deleted' : 'memory not found',
      }],
    },
    async execute(args: { id: number }, exec: ToolExecLike) {
      exec.signal?.throwIfAborted()
      const deleted = store.deleteById(args.id) > 0
      if (deleted) notify()
      return { deleted }
    },
  })))

  return () => {
    for (const dispose of disposers) dispose()
  }
}