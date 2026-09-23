/**
 * dsh-ui-shortcuts, browser half: the three shortcut actions wired end to end
 * (spec US-1/2/4 — the composer-focus action is CUT, see README). The config
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
}

/** Required services: the slot registry, locale, the RPC carrier, and the two layout faces. */
export const inject = ['slots', 'locale', 'connection', 'layout', 'sidebarRight']

/** Browser platform family for CmdOrCtrl resolution and overlay display. */
function platformOf(navigator: { platform: string }): Platform {
  return navigator.platform.includes('Mac') ? 'mac' : 'other'
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
  const platform = platformOf(navigator)

  // Engine-side stores: overlay open state and display-ready bindings. Empty
  // binding map until the config fetch settles; the overlay publishes rows
  // only for actions that carry a binding string.
  let open = false
  const openListeners = new Set<() => void>()
  const openSource: HostObservable<boolean> = {
    getSnapshot: () => open,
    subscribe: (listener) => { openListeners.add(listener); return () => { openListeners.delete(listener) } },
  }
  const setOpen = (next: boolean): void => {
    if (open === next) return
    open = next
    for (const listener of [...openListeners]) listener()
  }
  let displayBindings: Readonly<Partial<Record<ActionId, string>>> = {}
  const bindingsListeners = new Set<() => void>()
  const bindingsSource: HostObservable<Readonly<Partial<Record<ActionId, string>>>> = {
    getSnapshot: () => displayBindings,
    subscribe: (listener) => { bindingsListeners.add(listener); return () => { bindingsListeners.delete(listener) } },
  }
  const publishBindings = (next: Readonly<Partial<Record<ActionId, string>>>): void => {
    if (Object.is(next, displayBindings)) return
    displayBindings = next
    for (const listener of [...bindingsListeners]) listener()
  }

  // The engine owns every DOM touch in this plugin: listeners, guards, and
  // dispatch live here and nowhere else.
  const engine = new ShortcutEngine({
    document,
    platform,
    onAction: (action) => {
      if (action === 'sidebar') scoped.layout.toggleSidebar()
      else if (action === 'rightbar') scoped.sidebarRight.toggleExpanded()
      else setOpen(!openSource.getSnapshot())
    },
    // Bare Escape closes the overlay and swallows the key only while it is
    // open, so the rest of the page keeps its Escape behavior (US-8).
    onEscape: () => {
      if (!openSource.getSnapshot()) return false
      setOpen(false)
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
    publishBindings(display)
  }, 'dsh-ui-shortcuts: fetch config')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-ui-shortcuts-help',
    locale: NS,
    inject: (): ShortcutsHelpInjected => ({
      hooks: { bindings: bindingsSource, open: openSource },
      close: () => setOpen(false),
    }),
  }, ShortcutsHelp)), 'dsh-ui-shortcuts: help overlay')
}