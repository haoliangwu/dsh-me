// @vitest-environment jsdom
/**
 * dsh-ui-shortcuts apply-level integration: boot the REAL client apply over a
 * fake cordis Context (hand-rolled slots registry / locale / connection /
 * layout / sidebarRight fakes — no dsh-client-test-runtime in this repo) and
 * dispatch REAL KeyboardEvents on the jsdom document. Only external behavior
 * is asserted: service calls, guard interception/pass-through, config
 * adoption, overlay open/close, and fiber-dispose listener removal.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from './index.ts'
import { ShortcutsHelp } from './ShortcutsHelp.tsx'
import { en, zh } from './locales.ts'

type ConfigResponse = Record<'sidebar' | 'rightbar' | 'focus' | 'help', string>

/** One recorded slot entry, mirroring the registry's register() shape. */
interface FakeEntry {
  name: string
  id?: string
  locale?: string
  component: unknown
  inject: (...args: unknown[]) => unknown
}

/** Minimal fake SlotRegistry: discoverable entries, eager inject, register cleanups. */
function fakeSlots() {
  const entries: FakeEntry[] = []
  return {
    entries,
    byName: (name: string): FakeEntry[] => entries.filter(entry => entry.name === name),
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: Omit<FakeEntry, 'component'>, component: unknown) => {
      const entry = { ...options, component }
      entries.push(entry)
      return () => { entries.splice(entries.indexOf(entry), 1) }
    },
  }
}

/** Boot the real apply over fake services; platform simulation via navigator.platform. */
async function fullBench(config: ConfigResponse, platform: 'mac' | 'other') {
  Object.defineProperty(navigator, 'platform', {
    value: platform === 'mac' ? 'MacIntel' : 'Linux x86_64',
    configurable: true,
  })
  const ctx = new Context()
  const actions: Array<'sidebar' | 'rightbar'> = []
  const slots = fakeSlots()
  const dictionaries = new Map<string, unknown>()
  // Per-bench mutable focus seam: the fake uiSession current binding, the
  // focus facade `for()` resolves, and the last binding ctx handed out so
  // tests can assert `for()` received the session's own ctx ("right target").
  const focusSpy = vi.fn()
  const bench = {
    currentBinding: { key: 's1' as string | undefined },
    focusFor: (): { focus?: () => void } => ({ focus: focusSpy }),
    forTargets: [] as unknown[],
    bindingCtx: undefined as { get(name: string): unknown } | undefined,
  }
  // Cordis' default buffer exporter threshold is INFO, so warns are dropped
  // there; register a capture exporter with a tall level to observe the
  // one-shot focus-unavailable warning (effect-scoped, disposed with the fiber).
  const warns: unknown[][] = []
  ctx.logger.exporter({
    levels: { default: 4 },
    export: (message: { type: string; args: unknown[] }) => {
      if (message.type === 'warn') warns.push(message.args)
    },
  })
  ctx.provide('slots', slots as never)
  ctx.provide('locale', {
    register: (name: string, values: unknown) => {
      dictionaries.set(name, values)
      return () => { dictionaries.delete(name) }
    },
  } as never)
  ctx.provide('connection', {
    rpc: { call: async () => ({ ok: true, value: config }) },
  } as never)
  ctx.provide('layout', { toggleSidebar: () => { actions.push('sidebar') } } as never)
  ctx.provide('sidebarRight', { toggleExpanded: () => { actions.push('rightbar') } } as never)
  ctx.provide('sessions', {
    binding: (sessionId: string) => {
      if (sessionId !== 's1') return undefined
      const binding = {
        sessionId: 's1',
        ctx: {
          get: (name: string): unknown => name === 'conversation' ? {
            input: { for: (actx: unknown) => { bench.forTargets.push(actx); return bench.focusFor() } },
          } : undefined,
        },
      }
      bench.bindingCtx = binding.ctx
      return binding
    },
  } as never)
  ctx.provide('uiSession', {
    adapter: { current: { getSnapshot: () => bench.currentBinding } },
  } as never)
  const fiber = await ctx.plugin({ inject, apply })
  // The config fetch effect resolves on the microtask queue; one tick settles it.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return { ctx, fiber, slots, dictionaries, actions, focusSpy, bench, warns }
}

/** Dispatch one real keydown on the document; false = an engine handler preventDefaulted it. */
function keydown(init: KeyboardEventInit): boolean {
  return document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

/** Advance past the engine's 0ms IME-suppress time-box (real jsdom timers). */
function tick(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

const DEFAULTS: ConfigResponse = { sidebar: 'CmdOrCtrl+B', rightbar: 'CmdOrCtrl+I', focus: '/', help: 'Shift+?' }

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'layout', 'sidebarRight', 'sessions', 'uiSession'])
  })

  it('registers the locale dictionaries and the shell.overlay entry', async () => {
    const { fiber, slots, dictionaries } = await fullBench(DEFAULTS, 'mac')
    try {
      expect(dictionaries.get('shortcuts')).toEqual({ zh, en })
      const entries = slots.byName('shell.overlay')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.id).toBe('dsh-ui-shortcuts-help')
      expect(entries[0]?.locale).toBe('shortcuts')
      expect(entries[0]?.component).toBe(ShortcutsHelp)
    } finally {
      await fiber.dispose()
    }
  })

  it('CmdOrCtrl+B toggles the sidebar — meta on mac, ctrl on other platforms', async () => {
    const mac = await fullBench(DEFAULTS, 'mac')
    try {
      keydown({ key: 'b', metaKey: true })
      keydown({ key: 'b', ctrlKey: true })
      expect(mac.actions).toEqual(['sidebar'])
    } finally {
      await mac.fiber.dispose()
    }
    const other = await fullBench(DEFAULTS, 'other')
    try {
      keydown({ key: 'b', ctrlKey: true })
      expect(other.actions).toEqual(['sidebar'])
    } finally {
      await other.fiber.dispose()
    }
  })

  it('CmdOrCtrl+I toggles the right panel', async () => {
    const { fiber, actions } = await fullBench(DEFAULTS, 'mac')
    try {
      keydown({ key: 'i', metaKey: true })
      expect(actions).toEqual(['rightbar'])
    } finally {
      await fiber.dispose()
    }
  })

  it('guard: single-key binding skips while an input holds focus; modifier combos still fire', async () => {
    const config: ConfigResponse = { ...DEFAULTS, help: '?' }
    const { fiber, actions, slots } = await fullBench(config, 'mac')
    const overlay = slots.byName('shell.overlay')[0] as FakeEntry | undefined
    if (overlay === undefined) throw new Error('overlay entry missing')
    const injected = overlay.inject() as { hooks: { open: { getSnapshot(): boolean } } }
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    try {
      keydown({ key: '?' })
      expect(injected.hooks.open.getSnapshot()).toBe(false)
      keydown({ key: 'b', metaKey: true })
      expect(actions).toEqual(['sidebar'])
      input.blur()
      keydown({ key: '?' })
      expect(injected.hooks.open.getSnapshot()).toBe(true)
    } finally {
      input.remove()
      await fiber.dispose()
    }
  })

  it('guard: Shift-only binding (Shift+?) skips while an input holds focus — typing ? must not open the help overlay', async () => {
    const { fiber, slots } = await fullBench(DEFAULTS, 'mac')
    const overlay = slots.byName('shell.overlay')[0] as FakeEntry | undefined
    if (overlay === undefined) throw new Error('overlay entry missing')
    const injected = overlay.inject() as { hooks: { open: { getSnapshot(): boolean } } }
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    try {
      keydown({ key: '?', shiftKey: true })
      expect(injected.hooks.open.getSnapshot()).toBe(false)
      // The fullwidth CJK form types text too — guarded the same way.
      keydown({ key: '？', shiftKey: true })
      expect(injected.hooks.open.getSnapshot()).toBe(false)
      input.blur()
      keydown({ key: '?', shiftKey: true })
      expect(injected.hooks.open.getSnapshot()).toBe(true)
    } finally {
      input.remove()
      await fiber.dispose()
    }
  })

  it('IME (WebKit ordering): compositionend then an immediate keydown is suppressed; the next keydown fires', async () => {
    const { fiber, actions } = await fullBench(DEFAULTS, 'mac')
    try {
      // WebKit fires compositionend BEFORE the final commit keydown, so that
      // keydown arrives synchronously while the 0ms suppress box is armed.
      document.dispatchEvent(new Event('compositionstart'))
      keydown({ key: 'b', metaKey: true })
      expect(actions).toEqual([])
      document.dispatchEvent(new Event('compositionend'))
      keydown({ key: 'b', metaKey: true })
      expect(actions).toEqual([])
      // The suppress box clears; the user's next real keydown fires normally.
      await tick()
      keydown({ key: 'b', metaKey: true })
      expect(actions).toEqual(['sidebar'])
    } finally {
      await fiber.dispose()
    }
  })

  it('IME (Chrome/Firefox ordering): the commit keydown inside composition is suppressed; the next keydown fires', async () => {
    const { fiber, actions } = await fullBench(DEFAULTS, 'mac')
    try {
      // Chrome/Firefox fire the commit keydown INSIDE the composition
      // (ev.isComposing=true) and compositionend only afterwards. Before the
      // time-boxed fix, compositionend re-armed the suppress flag for the
      // user's NEXT real keydown — the regression this test pins.
      document.dispatchEvent(new Event('compositionstart'))
      keydown({ key: 'b', metaKey: true, isComposing: true })
      expect(actions).toEqual([])
      document.dispatchEvent(new Event('compositionend'))
      await tick()
      keydown({ key: 'b', metaKey: true })
      expect(actions).toEqual(['sidebar'])
    } finally {
      await fiber.dispose()
    }
  })

  it('IME (cancelled composition): compositionend with no keydown leaves the next keydown untouched', async () => {
    const { fiber, actions } = await fullBench(DEFAULTS, 'mac')
    try {
      // Composition dismissed (click elsewhere etc.) with no commit keydown:
      // the suppress box must expire on its own, not swallow the next key.
      document.dispatchEvent(new Event('compositionstart'))
      document.dispatchEvent(new Event('compositionend'))
      await tick()
      keydown({ key: 'b', metaKey: true })
      expect(actions).toEqual(['sidebar'])
    } finally {
      await fiber.dispose()
    }
  })

  it('adopts custom bindings from the config fetch; the default no longer fires', async () => {
    const config: ConfigResponse = { sidebar: 'Alt+Shift+S', rightbar: 'CmdOrCtrl+I', help: 'Shift+?' }
    const { fiber, actions } = await fullBench(config, 'mac')
    try {
      keydown({ key: 'b', metaKey: true })
      expect(actions).toEqual([])
      keydown({ key: 's', altKey: true, shiftKey: true })
      expect(actions).toEqual(['sidebar'])
    } finally {
      await fiber.dispose()
    }
  })

  it('focus: / with body focus focuses the current session composer and prevents the default key', async () => {
    const { fiber, focusSpy, bench } = await fullBench(DEFAULTS, 'mac')
    try {
      // Body holds focus (document.activeElement, not editable) — the textual
      // guard passes and the binding fires.
      expect(keydown({ key: '/' })).toBe(false)
      expect(focusSpy).toHaveBeenCalledTimes(1)
      expect(focusSpy).toHaveBeenCalledWith()
      // for() received the session binding's own ctx — the "right target".
      expect(bench.forTargets).toEqual([bench.bindingCtx])
      expect(bench.bindingCtx).toBeDefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('focus: / while an input holds focus is a normal keystroke — focus NOT called', async () => {
    const { fiber, focusSpy } = await fullBench(DEFAULTS, 'mac')
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    try {
      expect(keydown({ key: '/' })).toBe(true)
      expect(focusSpy).not.toHaveBeenCalled()
      input.blur()
      keydown({ key: '/' })
      expect(focusSpy).toHaveBeenCalledTimes(1)
    } finally {
      input.remove()
      await fiber.dispose()
    }
  })

  it('focus: no session selected — nothing called, no crash', async () => {
    const { fiber, focusSpy, bench } = await fullBench(DEFAULTS, 'mac')
    bench.currentBinding = { key: undefined }
    try {
      keydown({ key: '/' })
      expect(focusSpy).not.toHaveBeenCalled()
      expect(bench.forTargets).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('focus: runtime without SessionInput.focus() and no editable mounted — no crash, ONE warning across repeated presses', async () => {
    const { fiber, focusSpy, bench, warns } = await fullBench(DEFAULTS, 'mac')
    bench.focusFor = () => ({}) // 0.1.5-era facade: no focus()
    try {
      keydown({ key: '/' })
      expect(focusSpy).not.toHaveBeenCalled()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toEqual(['dsh-ui-shortcuts: focus action unavailable — the running dsh runtime predates SessionInput.focus() and no composer editable is mounted'])
      keydown({ key: '/' })
      expect(warns).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('focus: DOM fallback — a mounted composer editable receives focus when the facade lacks focus()', async () => {
    const { fiber, focusSpy, bench, warns } = await fullBench(DEFAULTS, 'mac')
    bench.focusFor = () => ({}) // 0.1.5-era facade: no focus()
    const editable = document.createElement('div')
    editable.setAttribute('data-lexical-editor', 'true')
    editable.setAttribute('contenteditable', 'true')
    document.body.appendChild(editable)
    try {
      keydown({ key: '/' })
      expect(focusSpy).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(editable)
      expect(warns).toHaveLength(0)
    } finally {
      editable.remove()
      await fiber.dispose()
    }
  })

  it('Shift+? toggles the help overlay; bare Escape closes it and wins over other handlers', async () => {
    const { fiber, slots } = await fullBench(DEFAULTS, 'mac')
    const overlay = slots.byName('shell.overlay')[0] as FakeEntry | undefined
    if (overlay === undefined) throw new Error('overlay entry missing')
    const injected = overlay.inject() as { hooks: { open: { getSnapshot(): boolean } }; close: () => void }
    try {
      expect(injected.hooks.open.getSnapshot()).toBe(false)
      keydown({ key: '?', shiftKey: true })
      expect(injected.hooks.open.getSnapshot()).toBe(true)
      // CJK IME (Chinese mode) emits the fullwidth ？ with no composition
      // events — it must fire the same binding.
      keydown({ key: '？', shiftKey: true })
      expect(injected.hooks.open.getSnapshot()).toBe(false)
      // Reopen via the halfwidth form so the Escape section below starts open.
      keydown({ key: '?', shiftKey: true })
      expect(injected.hooks.open.getSnapshot()).toBe(true)
      // A late document Escape handler must NOT see the keyed Escape.
      let sawEscape = false
      const lateListener = (): void => { sawEscape = true }
      document.addEventListener('keydown', lateListener, false)
      keydown({ key: 'Escape' })
      expect(injected.hooks.open.getSnapshot()).toBe(false)
      expect(sawEscape).toBe(false)
      document.removeEventListener('keydown', lateListener, false)
    } finally {
      await fiber.dispose()
    }
  })

  it('disposal: fiber dispose removes every listener and slot/locale registration', async () => {
    const { fiber, slots, dictionaries, actions } = await fullBench(DEFAULTS, 'mac')
    await fiber.dispose()
    keydown({ key: 'b', metaKey: true })
    expect(actions).toEqual([])
    expect(slots.entries).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})