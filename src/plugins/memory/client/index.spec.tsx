// @vitest-environment jsdom
/**
 * dsh-memory browser-half contract: boot the REAL client apply over a fake
 * cordis Context (hand-rolled slots registry / connection / sessions — the
 * same seams shortcuts-engine.spec uses; no dsh-client-test-runtime in this
 * repo), then render the registered MemoryView with its inject face. Only
 * external behavior is asserted: the tab registration shape (id/order/label),
 * one RPC on mount with the right `{sessionId, cwd}`, verbatim block
 * rendering, and the loading / empty / error(+Retry) / manual-refresh states.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { CHANNEL, ENDPOINT_BLOCK, apply, inject } from './index.ts'
import { MEMORY_VIEW_COPY, MemoryView, type MemoryViewInjected } from './MemoryView.tsx'

afterEach(cleanup)

/** One recorded slot entry, mirroring the registry's register() shape. */
interface FakeEntry {
  name: string
  id?: string
  order?: number
  label?: string
  component: unknown
  inject: (...args: unknown[]) => unknown
}

/** One queued per-call RPC implementation (shifted on each connection.rpc.call). */
type RpcImpl = (channel: string, endpoint: string, payload: unknown) => Promise<unknown>

/** Boot the real apply over fake slots / connection / sessions services. */
async function bench() {
  const ctx = new Context()
  const entries: FakeEntry[] = []
  const slots = {
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: Omit<FakeEntry, 'component'>, component: unknown) => {
      const entry = { ...options, component }
      entries.push(entry)
      return () => { entries.splice(entries.indexOf(entry), 1) }
    },
  }
  const impls: RpcImpl[] = []
  const call = vi.fn((channel: string, endpoint: string, payload: unknown): Promise<unknown> => {
    const impl = impls.shift()
    if (impl === undefined) return Promise.reject(new Error('unexpected extra rpc call'))
    return impl(channel, endpoint, payload)
  })
  ctx.provide('slots', slots as never)
  ctx.provide('connection', { rpc: { call } } as never)
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ byId: { s1: { cwd: '/work/a' } } }) },
  } as never)
  const fiber = await ctx.plugin({ inject, apply })
  // ctx.plugin's apply may settle on the microtask queue; one tick flushes it.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return { fiber, entries, call, impls }
}

/** The registered conversation.view entry (asserted present by every test). */
function memoryEntry(entries: FakeEntry[]): FakeEntry {
  const entry = entries.find(candidate => candidate.name === 'conversation.view')
  if (entry === undefined) throw new Error('conversation.view entry not registered')
  return entry
}

/** A promise plus its resolve seam (controlled loading state). */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** A successful block envelope for the fake host. */
function okBlock(block: string): unknown {
  return { ok: true, value: { block } }
}

const BLOCK = '## Project Memory\nKnowledge from previous sessions. May be stale; correct via memory_write.\n\n<project-memory>\n<note id="1" scope="global">user prefers terse replies</note>\n</project-memory>'

describe('apply (tab registration)', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'connection', 'sessions'])
  })

  it('registers the Memory tab after Chat/Trajectory with the MemoryView component', async () => {
    const { fiber, entries } = await bench()
    try {
      const entry = memoryEntry(entries)
      expect(entry.id).toBe('memory')
      expect(entry.order).toBe(20)
      expect(entry.label).toBe('Memory')
      expect(entry.component).toBe(MemoryView)
    } finally {
      await fiber.dispose()
    }
  })

  it('wires the inject face to the sessions mirror cwd and the /dsh-memory block channel', async () => {
    const { fiber, entries, call, impls } = await bench()
    try {
      impls.push(() => Promise.resolve(okBlock(BLOCK)))
      const props = memoryEntry(entries).inject('s1') as MemoryViewInjected
      expect(props.sessionId).toBe('s1')
      expect(props.cwd).toBe('/work/a')
      render(<MemoryView {...props} />)
      await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      expect(call).toHaveBeenCalledWith(CHANNEL, ENDPOINT_BLOCK, { sessionId: 's1', cwd: '/work/a' })
      // The block lands VERBATIM in the monospace code block — the model's-eye view.
      await waitFor(() => {
        const pre = document.querySelector('pre')
        expect(pre?.textContent).toBe(BLOCK)
      })
    } finally {
      await fiber.dispose()
    }
  })

  it('degrades to an empty cwd for a session the mirror does not know', async () => {
    const { fiber, entries, call, impls } = await bench()
    try {
      impls.push(() => Promise.resolve(okBlock('')))
      const props = memoryEntry(entries).inject('ghost') as MemoryViewInjected
      expect(props.cwd).toBe('')
      render(<MemoryView {...props} />)
      await waitFor(() => expect(call).toHaveBeenCalledWith(CHANNEL, ENDPOINT_BLOCK, { sessionId: 'ghost', cwd: '' }))
    } finally {
      await fiber.dispose()
    }
  })
})

describe('MemoryView host posture', () => {
  it('marks the root as a composer overlay (host hides the width handles)', async () => {
    const { fiber, entries, impls } = await bench()
    try {
      impls.push(() => Promise.resolve(okBlock(BLOCK)))
      const props = memoryEntry(entries).inject('s1') as MemoryViewInjected
      const { container } = render(<MemoryView {...props} />)
      const root = container.firstElementChild
      expect(root?.getAttribute('data-conversation-composer-overlay')).toBe('')
    } finally {
      await fiber.dispose()
    }
  })

  it('gives the root full-bleed own-scroll styles (host no longer scrolls the view)', () => {
    // jsdom does not apply CSS modules; pin the posture at the source: the
    // root must fill the clipped viewArea and be its own scroller, with no
    // leftover stacking hacks from the width-handle z-index attempt.
    const source = readFileSync(
      resolve(process.cwd(), 'src/plugins/memory/client/memory.module.css'), 'utf8')
    const rootBlock = source.match(/\.root \{[^}]*\}/)?.[0]
    expect(rootBlock).toBeDefined()
    expect(rootBlock).toContain('height: 100%')
    expect(rootBlock).toContain('overflow: auto')
    expect(rootBlock).not.toContain('z-index')
    expect(rootBlock).not.toContain('isolation')
  })

  it('pins the block to wrapping (macOS styled scrollbars are overlay-only, so no horizontal scroll)', () => {
    // Same source-pin as above (jsdom applies no CSS modules): the block
    // wraps long lines instead of scrolling them, and carries no dead
    // ::-webkit-scrollbar skin — macOS Chromium paints custom-styled
    // scrollbars only on a physical gesture, so an invisible bar (mid-word
    // clipping with zero affordance) was worse than the reflow wrapping
    // gives: this view is human inspection, and wrapping changes no bytes.
    const source = readFileSync(
      resolve(process.cwd(), 'src/plugins/memory/client/memory.module.css'), 'utf8')
    const blockRule = source.match(/\.block \{[^}]*\}/)?.[0]
    expect(blockRule).toBeDefined()
    expect(blockRule).toContain('white-space: pre-wrap')
    expect(source).not.toMatch(/\.block\s*::-webkit-scrollbar/)
  })
})

describe('MemoryView states', () => {
  it('shows the loading notice (refresh disabled) until the fetch settles', async () => {
    const { fiber, entries, impls } = await bench()
    try {
      const gate = deferred<unknown>()
      impls.push(() => gate.promise)
      render(<MemoryView {...(memoryEntry(entries).inject('s1') as MemoryViewInjected)} />)
      expect(screen.getByText(MEMORY_VIEW_COPY.loading)).toBeDefined()
      expect((screen.getByText(MEMORY_VIEW_COPY.refresh) as HTMLButtonElement).disabled).toBe(true)
      gate.resolve(okBlock(BLOCK))
      await waitFor(() => expect(document.querySelector('pre')?.textContent).toBe(BLOCK))
    } finally {
      await fiber.dispose()
    }
  })

  it('shows the empty notice when the host reports an empty block', async () => {
    const { fiber, entries, impls } = await bench()
    try {
      impls.push(() => Promise.resolve(okBlock('')))
      render(<MemoryView {...(memoryEntry(entries).inject('s1') as MemoryViewInjected)} />)
      expect(await screen.findByText(MEMORY_VIEW_COPY.empty)).toBeDefined()
      expect(document.querySelector('pre')).toBeNull()
    } finally {
      await fiber.dispose()
    }
  })

  it('shows the error notice on a refused envelope and retries through the Retry button', async () => {
    const { fiber, entries, impls, call } = await bench()
    try {
      impls.push(() => Promise.resolve({ ok: false, error: { code: 'internal', message: 'boom', details: {} } }))
      impls.push(() => Promise.resolve(okBlock(BLOCK)))
      render(<MemoryView {...(memoryEntry(entries).inject('s1') as MemoryViewInjected)} />)
      expect(await screen.findByText(MEMORY_VIEW_COPY.error)).toBeDefined()
      fireEvent.click(screen.getByText(MEMORY_VIEW_COPY.retry))
      await waitFor(() => expect(document.querySelector('pre')?.textContent).toBe(BLOCK))
      expect(call).toHaveBeenCalledTimes(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('shows the error notice on a transport rejection', async () => {
    const { fiber, entries, impls } = await bench()
    try {
      impls.push(() => Promise.reject(new Error('offline')))
      render(<MemoryView {...(memoryEntry(entries).inject('s1') as MemoryViewInjected)} />)
      expect(await screen.findByText(MEMORY_VIEW_COPY.error)).toBeDefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('manual refresh re-fetches once with the same args while keeping the block on screen', async () => {
    const { fiber, entries, impls, call } = await bench()
    try {
      impls.push(() => Promise.resolve(okBlock(BLOCK)))
      impls.push(() => Promise.resolve(okBlock(`${BLOCK}\n(note refreshed)`)))
      render(<MemoryView {...(memoryEntry(entries).inject('s1') as MemoryViewInjected)} />)
      await waitFor(() => expect(document.querySelector('pre')?.textContent).toBe(BLOCK))
      fireEvent.click(screen.getByText(MEMORY_VIEW_COPY.refresh))
      // Background refresh: the stale block stays visible until the new one lands…
      expect(document.querySelector('pre')?.textContent).toBe(BLOCK)
      await waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('(note refreshed)'))
      expect(call).toHaveBeenCalledTimes(2)
      expect(call).toHaveBeenNthCalledWith(2, CHANNEL, ENDPOINT_BLOCK, { sessionId: 's1', cwd: '/work/a' })
    } finally {
      await fiber.dispose()
    }
  })
})
