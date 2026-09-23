/**
 * dsh-ui-shortcuts, browser half: the four shortcut actions wired end to end
 * (spec US-1/2/4/5 — the composer-focus action degrades gracefully on
 * runtimes without `SessionInput.focus()`, see README). The config
 * (validated bindings) is fetched once from the host half through the
 * Connection RPC channel `/shortcuts` endpoint `config`; until the fetch
 * settles the engine runs with an EMPTY binding set, and the overlay shows no
 * rows — bindings arrive before any user keypress in practice. The overlay is
 * a shell.overlay Modal entry whose open state lives in an engine-side store
 * the help action toggles and Escape closes (engine-level handling wins over
 * other document Escape handlers, US-8). Every registration — locale dicts,
 * engine listeners, config fetch, slot entry, stores — lives inside a
 * ctx.effect so fiber dispose restores the page untouched (HMR-safe).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ui-layout Context merge (ctx.layout) and the
// shell.overlay SlotMap entry (list kind, root scope).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-sidebar-right Context merge (ctx.sidebarRight).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { displayBinding, parseBinding, type ActionId, type ParsedBinding, type Platform } from '../pure.ts'
import { ShortcutEngine } from './shortcuts-engine.ts'
import { ShortcutsHelp, type ShortcutsHelpInjected } from './ShortcutsHelp.tsx'
import { ACTIONS } from './rows.ts'
import { en, zh, type ShortcutsKey } from './locales.ts'

export type { ShortcutsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The shortcuts help overlay copy. */
    shortcuts: ShortcutsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'shortcuts'

/** RPC channel owned by the host half of this plugin. */
const CHANNEL = '/shortcuts'

/** Endpoint under {@link CHANNEL} returning the configured bindings. */
const ENDPOINT_CONFIG = 'config'

/** Host response payload for {@link ENDPOINT_CONFIG}. */
type ConfigResponse = Record<ActionId, string>

/** The client service slices this plugin reads (structural). */
interface ShortcutsCtx {
  slots: ClientContext['slots']
  locale: ClientContext['locale']
  connection: { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> } }
  layout: { toggleSidebar(): void }
  sidebarRight: { toggleExpanded(): void }
  sessions: {
    binding(sessionId: string): {
      readonly sessionId: string
      readonly ctx: { get(name: string): unknown }
    } | undefined
  }
  uiSession: {
    adapter: { current: HostObservable<{ readonly key: string | undefined }> }
  }
}

/** Required services: the slot registry, locale, the RPC carrier, the layout faces, and the sessions/uiSession mirrors. */
export const inject = ['slots', 'locale', 'connection', 'layout', 'sidebarRight', 'sessions', 'uiSession']

/** Browser platform family for CmdOrCtrl resolution and overlay display. */
function platformOf(navigator: { platform: string }): Platform {
  return navigator.platform.includes('Mac') ? 'mac' : 'other'
}

/**
 * One observable value cell: a `HostObservable` for the selector hooks the
 * slot runtime binds, plus a setter that skips no-op writes (same reference
 * → no notification). Shared by the overlay open state and the display
 * bindings.
 */
function makeStore<T>(initial: T): { source: HostObservable<T>; set(next: T): void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => value,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    set(next) {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Client plugin body: register the `shortcuts` dictionaries, boot the shortcut
 * engine over the current document, fetch the validated bindings once, and
 * register the help overlay into shell.overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ui-shortcuts: dictionaries')

  const scoped = ctx as unknown as ShortcutsCtx
  const logger = ctx.logger
  const platform = platformOf(navigator)

  // Engine-side stores: overlay open state and display-ready bindings. Empty
  // binding map until the config fetch settles; the overlay publishes rows
  // only for actions that carry a binding string.
  const openStore = makeStore(false)
  const bindingsStore = makeStore<Readonly<Partial<Record<ActionId, string>>>>({})

  // Composer-focus degradation: pinned 0.1.5-rc.2's SessionInput has no
  // focus(); the running runtime does (0.1.6-alpha.2) but older ones must not
  // crash. Missing focus()/conversation/input logs ONE warning per page, then
  // stays silent so repeated presses do not spam the console (US-5).
  let focusUnavailableWarned = false
  const warnFocusUnavailable = (): void => {
    if (focusUnavailableWarned) return
    focusUnavailableWarned = true
    logger.warn('dsh-ui-shortcuts: focus action unavailable — the running dsh runtime predates SessionInput.focus()')
  }
  const focusComposer = (): void => {
    const sessionKey = scoped.uiSession.adapter.current.getSnapshot().key
    if (sessionKey === undefined) return // no session selected — nothing to focus
    const binding = scoped.sessions.binding(sessionKey)
    if (binding === undefined) {
      warnFocusUnavailable()
      return
    }
    const conversation = binding.ctx.get('conversation') as
      | { input?: { for(actx: unknown): { focus?(): void } | undefined } | undefined }
      | undefined
    const facade = conversation?.input?.for(binding.ctx)
    if (facade?.focus !== undefined) {
      facade.focus()
      return
    }
    warnFocusUnavailable()
  }

  // The engine owns every DOM touch in this plugin: listeners, guards, and
  // dispatch live here and nowhere else.
  const engine = new ShortcutEngine({
    document,
    platform,
    onAction: (action) => {
      if (action === 'sidebar') scoped.layout.toggleSidebar()
      else if (action === 'rightbar') scoped.sidebarRight.toggleExpanded()
      else if (action === 'focus') focusComposer()
      else openStore.set(!openStore.source.getSnapshot())
    },
    // Bare Escape closes the overlay and swallows the key only while it is
    // open, so the rest of the page keeps its Escape behavior (US-8).
    onEscape: () => {
      if (!openStore.source.getSnapshot()) return false
      openStore.set(false)
      return true
    },
  })
  ctx.effect(() => {
    engine.attach()
    return () => engine.dispose()
  }, 'dsh-ui-shortcuts: engine listeners')

  // Fetch the validated bindings once; a failed RPC leaves the engine empty
  // (no shortcuts, no rows) rather than guessing at defaults.
  ctx.effect(async () => {
    const result = await scoped.connection.rpc.call(CHANNEL, ENDPOINT_CONFIG, {}) as RpcResult<ConfigResponse>
    if (!result.ok) return
    const parsed: Partial<Record<ActionId, ParsedBinding>> = {}
    const display: Partial<Record<ActionId, string>> = {}
    for (const action of ACTIONS) {
      const raw = result.value[action]
      if (raw === undefined) continue
      parsed[action] = parseBinding(raw)
      display[action] = displayBinding(raw, platform)
    }
    engine.setBindings(parsed)
    bindingsStore.set(display)
  }, 'dsh-ui-shortcuts: fetch config')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-ui-shortcuts-help',
    locale: NS,
    inject: (): ShortcutsHelpInjected => ({
      hooks: { bindings: bindingsStore.source, open: openStore.source },
      close: () => openStore.set(false),
    }),
  }, ShortcutsHelp)), 'dsh-ui-shortcuts: help overlay')
}