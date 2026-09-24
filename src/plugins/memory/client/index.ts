/**
 * dsh-memory, browser half: the read-only Memory tab in the session header —
 * one entry of the `conversation.view` list slot (session scope, `id:
 * 'memory'`, order 20 after Chat 0 / Trajectory 10, plain label "Memory").
 * The tab follows whatever session is open (no subagent special-casing) and
 * shows the memory block injected for THAT session, rendered as markdown
 * through the host's frozen MarkdownText primitive (content bytes unchanged).
 *
 * Data path: `ctx.connection.rpc.call('/dsh-memory', 'block', {sessionId,
 * cwd})` against the host half's webServer prefix route — the block is
 * recomputed by the same pure functions the pre-step injection uses, so the
 * tab is byte-identical to what the model sees. `sessionId` arrives on the
 * slot inject face; `cwd` is read from the sessions mirror at inject time.
 * Freshness: fetch on tab open (component mount) + one manual refresh
 * control; no polling, no push (spec). Export discipline:
 * packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the 'conversation.view' SlotMap row (declared by ui-conversation)
// must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { MemoryView, type MemoryBlockResponse, type MemoryViewInjected } from './MemoryView.tsx'

export type { MemoryBlockResponse, MemoryViewInjected } from './MemoryView.tsx'
export { MemoryView, MEMORY_VIEW_COPY } from './MemoryView.tsx'

/** RPC channel owned by the host half of this plugin. */
export const CHANNEL = '/dsh-memory'

/** Endpoint under {@link CHANNEL}: `{sessionId, cwd}` → `{block}`. */
export const ENDPOINT_BLOCK = 'block'

/** The tab's position in the conversation view roster: after Chat (0) and Trajectory (10). */
const VIEW_ORDER = 20

/** The slices of the client Context this plugin reads (structural). */
interface MemoryClientCtx {
  slots: ClientContext['slots']
  connection: { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> } }
  sessions: {
    list: {
      getSnapshot(): { readonly byId: Record<string, { readonly cwd?: string } | undefined> }
    }
  }
}

/** Required services: the slot registry, the Connection RPC carrier, and the sessions mirror (cwd lookup). */
export const inject = ['slots', 'connection', 'sessions']

/**
 * Client plugin body: register the Memory tab in the conversation view
 * roster. The registration rides the slot service's effect wrapper, so
 * plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const scoped = ctx as unknown as MemoryClientCtx
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'memory',
    order: VIEW_ORDER,
    label: 'Memory',
    inject: (sessionId): MemoryViewInjected => {
      const cwd = scoped.sessions.list.getSnapshot().byId[sessionId]?.cwd ?? ''
      return {
        sessionId,
        cwd,
        fetchBlock: () => scoped.connection.rpc.call(CHANNEL, ENDPOINT_BLOCK, { sessionId, cwd }) as Promise<RpcResult<MemoryBlockResponse>>,
      }
    },
  }, MemoryView))
}
