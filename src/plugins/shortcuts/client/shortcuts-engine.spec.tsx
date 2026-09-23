// @vitest-environment jsdom
/**
 * dsh-ui-shortcuts apply-level integration: boot the REAL client apply over a
 * fake cordis Context (hand-rolled slots registry / locale / connection /
 * layout / sidebarRight fakes — no dsh-client-test-runtime in this repo) and
 * dispatch REAL KeyboardEvents on the jsdom document. Only external behavior
 * is asserted: service calls, guard interception/pass-through, config
 * adoption, overlay open/close, and fiber-dispose listener removal.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from './index.ts'
import { ShortcutsHelp } from './ShortcutsHelp.tsx'
import { en, zh } from './locales.ts'

type ConfigResponse = Record<'sidebar' | 'rightbar' | 'help', string>

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
  const fiber = await ctx.plugin({ inject, apply })
  // The config fetch effect resolves on the microtask queue; one tick settles it.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return { ctx, fiber, slots, dictionaries, actions }
}

/** Dispatch one real keydown on the document. */
function keydown(init: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

/** Advance past the engine's 0ms IME-suppress time-box (real jsdom timers). */
function tick(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

const DEFAULTS: ConfigResponse = { sidebar: 'CmdOrCtrl+B', rightbar: 'CmdOrCtrl+I', help: 'Shift+?' }

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'layout', 'sidebarRight'])
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