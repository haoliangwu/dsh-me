/**
 * dsh-undo, browser half: the undo and redo icon actions in the finalized
 * assistant's actions strip, the event-window state derivation, and the DOM
 * row hiding that keeps shadowed original rows out of the transcript (design
 * §4). One {@link UndoSurface} per session feeds both buttons' reactive state
 * and the row hider; the slot inject face's `hooks` compartment binds it as
 * the `useUndo` selector hook the buttons read — no conversation location
 * data, no fold registration (the pinned 0.1.5-rc.2 assembler requires every
 * published location-data entry to carry the owning definition's kind as its
 * key, and the component state needs no such publication). The undo button
 * shows while its turn is final/undone/idle; the paired redo entry replaces
 * it in the same strip while that turn is shadowed by a tombstone (the strip
 * lives in the turn-tail row, which the row hider never hides). Export
 * discipline: the plugin exposes only `apply`/`inject` (and the locale key
 * type like sibling plugins).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-chat SlotMap merge (the two chat slots used below).
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RedoAction } from './RedoAction.tsx'
import { UndoButton } from './UndoButton.tsx'
import { CHANNEL, RowHider, UndoSurface, type UndoSurfaceDeps } from './undo-engine.ts'
import { en, zh, type UndoKey } from './locales.ts'

export type { UndoKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The undo + redo actions copy. */
    undo: UndoKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'undo'

/** The undo action's position after the feedback pair in the actions strip. */
const ACTION_ORDER = 20

/** The client service slices this plugin reads (structural). */
interface UndoCtx {
  slots: ClientContext['slots']
  locale: ClientContext['locale']
  connection: { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> } }
  sessions: {
    binding(sessionId: string): {
      readonly sessionId: string
      readonly ctx: { get(name: string): unknown }
      readonly eventSource: UndoSurfaceDeps['eventSource']
    } | undefined
  }
}

/** Required services: the slot registry, locale, the RPC carrier, and the sessions mirror. */
export const inject = ['slots', 'locale', 'connection', 'sessions']

/**
 * Client plugin body: register the `undo` dictionaries, the actions-strip undo
 * button, and its paired redo action; drive the row hider from every session's
 * derived undo state.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-undo: dictionaries')

  const scoped = ctx as unknown as UndoCtx
  const surfaces = new Map<string, UndoSurface>()
  const hiddenKeySets = new Map<string, ReadonlySet<string>>()
  let currentKeys: ReadonlySet<string> = new Set()
  const hider = new RowHider(
    () => document.querySelector<HTMLElement>('[data-chat-flow]'),
    () => currentKeys,
  )

  /** Union the hidden keys of every surface with undo activity. */
  const reapplyHidden = (): void => {
    const union = new Set<string>()
    for (const keys of hiddenKeySets.values()) for (const key of keys) union.add(key)
    currentKeys = union
    hider.apply()
  }

  const surfaceFor = (sessionId: string): UndoSurface => {
    const cached = surfaces.get(sessionId)
    if (cached !== undefined) return cached
    const binding = scoped.sessions.binding(sessionId)
    const deps: UndoSurfaceDeps = binding === undefined
      ? {
          // One-off bound-only sessions (projection edges) have no live window;
          // serve them a detached surface so the slot still renders.
          sessionId,
          eventSource: { subscribe: () => () => {}, getSnapshot: () => ({ entries: [] }) },
          callRpc: () => Promise.resolve(false),
          setDraft: () => {},
        }
      : {
          sessionId,
          eventSource: binding.eventSource,
          callRpc: async (endpoint, payload) => (await scoped.connection.rpc.call(CHANNEL, endpoint, payload)).ok,
          setDraft: (text) => {
            const conversation = binding.ctx.get('conversation') as {
              input?: { for(actx: unknown): { setDraft(text: string): void } | undefined }
            } | undefined
            conversation?.input?.for(binding.ctx)?.setDraft(text)
          },
          onState: state => {
            hiddenKeySets.set(sessionId, state.hiddenKeys)
            reapplyHidden()
          },
        }
    const surface = new UndoSurface(deps)
    hiddenKeySets.set(sessionId, surface.getSnapshot().hiddenKeys)
    surfaces.set(sessionId, surface)
    return surface
  }

  ctx.effect(() => () => {
    for (const surface of surfaces.values()) surface.dispose()
    surfaces.clear()
    hiddenKeySets.clear()
    hider.dispose()
  }, 'dsh-undo: per-session surfaces and row hider')

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'undo',
    order: ACTION_ORDER,
    locale: NS,
    inject: (sessionId) => {
      const surface = surfaceFor(sessionId)
      return {
        hooks: { undo: surface },
        undo: (messageId: string) => surface.undo(messageId),
      }
    },
  }, UndoButton))

  // The redo entry rides the same assistant-actions LIST, one cell after the
  // undo entry: while its turn is shadowed the undo button returns null and
  // this entry renders the redo icon in that exact spot. No turnTail chain
  // registration — that slot is chain-kind in the pinned 0.1.5-rc.2 and a
  // select-less register is rejected at load. Both buttons read the surface
  // state through the same `useUndo` hook (the inject hooks compartment binds
  // the per-session UndoSurface); no conversation fold publishes anything.
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'undo-redo',
    order: ACTION_ORDER + 1,
    locale: NS,
    inject: (sessionId) => {
      const surface = surfaceFor(sessionId)
      return {
        hooks: { undo: surface },
        redo: () => surface.redo(),
      }
    },
  }, RedoAction))
}