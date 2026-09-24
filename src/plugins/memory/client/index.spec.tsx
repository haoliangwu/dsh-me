// @vitest-environment jsdom
/**
 * dsh-memory browser-half contract: boot the REAL client apply over a fake
 * cordis Context (hand-rolled slots registry / connection / sessions — the
 * same seams shortcuts-engine.spec uses; no dsh-client-test-runtime in this
 * repo), then render the registered MemoryView with its inject face. Only
 * external behavior is asserted: the tab registration shape (id/order/label),
 * one RPC on mount with the right `{sessionId, cwd}`, markdown block
 * rendering through the host MarkdownText primitive, and the loading /
 * empty / error(+Retry) / manual-refresh states.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { CHANNEL, ENDPOINT_BLOCK, apply, inject } from './index.ts'
import {
  MEMORY_VIEW_COPY,
  MemoryView,
  prepareMemoryMarkdown,
  type MemoryViewInjected,
} from './MemoryView.tsx'

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

/** The text the card shows: wire bytes after view-side tag preprocessing (the stub passes it through). */
const PREPPED_BLOCK = prepareMemoryMarkdown(BLOCK)

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
      // The block lands in the markdown card — rendered by MarkdownText on
      // the preprocessed text (the stub renders it into the card).
      await waitFor(() => {
        const card = document.querySelector('[data-memory-block]')
        expect(card?.textContent).toBe(PREPPED_BLOCK)
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

  it('gives the root full-bleed own-scroll styles with a composer-height bottom reserve', () => {
    // jsdom does not apply CSS modules; pin the posture at the source: the
    // root must fill the clipped viewArea, be its own scroller, and reserve
    // the floating composer's live height in its bottom padding (Trajectory
    // / Chat same calc), with no leftover stacking hacks from the
    // width-handle z-index attempt.
    const source = readFileSync(
      resolve(process.cwd(), 'src/plugins/memory/client/memory.module.css'), 'utf8')
    const rootBlock = source.match(/\.root \{[^}]*\}/)?.[0]
    expect(rootBlock).toBeDefined()
    expect(rootBlock).toContain('height: 100%')
    expect(rootBlock).toContain('overflow: auto')
    expect(rootBlock).toContain('padding: 16px 24px calc(var(--dsh-composer-height, 152px) + 16px)')
    expect(rootBlock).not.toContain('z-index')
    expect(rootBlock).not.toContain('isolation')
  })

  it('bounds the scrolling content to the host chat content column, centered', () => {
    // Composer-mask gutter contract: the host composer seat's top fade band is
    // translucent outside the composer card, so everything that scrolls must
    // live inside the host content column (same var + centering as ChatView's
    // .column) — otherwise transcript text streams past the card's edges.
    const source = readFileSync(
      resolve(process.cwd(), 'src/plugins/memory/client/memory.module.css'), 'utf8')
    const columnBlock = source.match(/\.column \{[^}]*\}/)?.[0]
    expect(columnBlock).toBeDefined()
    expect(columnBlock).toContain('max-width: var(--dsh-chat-content-width)')
    expect(columnBlock).toContain('margin-inline: auto')
    // The column wraps toolbar + body in the view (everything that scrolls).
    const view = readFileSync(
      resolve(process.cwd(), 'src/plugins/memory/client/MemoryView.tsx'), 'utf8')
    expect(view).toContain('<div className={css.column}>')
    expect(view.indexOf('css.toolbar')).toBeGreaterThan(view.indexOf('css.column'))
    expect(view.indexOf('data-memory-block')).toBeGreaterThan(view.indexOf('css.column'))
  })

  it('renders the block through the host MarkdownText primitive (no monospace pre-wrap)', () => {
    // Same source-pin discipline (jsdom applies no CSS modules): the view
    // imports and renders MarkdownText inside the [data-memory-block] card,
    // keeps no <pre>, and the card rule drops the pre-wrap posture —
    // markdown reflows long lines itself, and the host primitive keeps raw
    // HTML disabled — the wire tags never reach it (prepareMemoryMarkdown
    // already hid them).
    const view = readFileSync(
      resolve(process.cwd(), 'src/plugins/memory/client/MemoryView.tsx'), 'utf8')
    expect(view).toContain("from '@deepseek-ai/dsh-client-ui-primitives'")
    expect(view).toContain('<MarkdownText text={prepareMemoryMarkdown(state.block)}')
    expect(view).toContain('data-memory-block')
    expect(view).not.toContain('<pre')
    const source = readFileSync(
      resolve(process.cwd(), 'src/plugins/memory/client/memory.module.css'), 'utf8')
    const blockRule = source.match(/\.block \{[^}]*\}/)?.[0]
    expect(blockRule).toBeDefined()
    expect(blockRule).not.toContain('white-space: pre-wrap')
    expect(source).not.toMatch(/\.block\s*::-webkit-scrollbar/)
  })
})

describe('prepareMemoryMarkdown (wire-tag hiding)', () => {
  it('drops structural tags and keeps heading, intro, and note content (single entry)', () => {
    const input = '## Project Memory\nKnowledge from previous sessions.\n\n<project-memory>\n<note id="1" scope="global">user prefers terse replies</note>\n</project-memory>'
    expect(prepareMemoryMarkdown(input)).toBe(
      '## Project Memory\nKnowledge from previous sessions.\n\nuser prefers terse replies')
  })

  it('strips note tags to bare content, each note its own paragraph', () => {
    const input = '<note id="14" scope="workspace">alpha</note>\n<note id="13" scope="global">beta</note>'
    expect(prepareMemoryMarkdown(input)).toBe('alpha\n\nbeta')
  })

  it('converts checkpoint open tags to date/session caption lines', () => {
    const input =
      '<checkpoint id="13" session="session-abcdef1234567890" date="2026-09-24">\nsummary\n</checkpoint>\n' +
      '<checkpoint id="12" session="session-99887766" date="2026-09-23">\nolder\n</checkpoint>'
    expect(prepareMemoryMarkdown(input)).toBe(
      '> Checkpoint · 2026-09-24 · session-abcd…7890\n\nsummary\n\n' +
      '> Checkpoint · 2026-09-23 · session-99887766\n\nolder')
  })

  it('renders a multi-entry block with no raw XML tags, one caption per checkpoint, content preserved', () => {
    const input = [
      '## Project Memory',
      'Knowledge from previous sessions. May be stale; correct via memory_write.',
      '',
      '<project-memory>',
      '<note id="14" scope="workspace">user prefers terse replies</note>',
      '<checkpoint id="13" session="session-abcdef1234567890" date="2026-09-24">',
      'compaction segment one',
      '- bullet in checkpoint',
      '</checkpoint>',
      '<checkpoint id="12" session="session-99887766" date="2026-09-23">',
      'older compaction content',
      '</checkpoint>',
      '</project-memory>',
      '(2 older memories omitted)',
    ].join('\n')
    const prepared = prepareMemoryMarkdown(input)
    // No wire markup survives — wrapper, note, and checkpoint tags all gone.
    expect(prepared).not.toMatch(/<\/?(?:project-memory|note|checkpoint)\b/)
    // One muted metadata caption per checkpoint, with date + short session id.
    expect(prepared.match(/^> Checkpoint · /gm)).toHaveLength(2)
    expect(prepared).toContain('> Checkpoint · 2026-09-24 · session-abcd…7890')
    expect(prepared).toContain('> Checkpoint · 2026-09-23 · session-99887766')
    // Content, heading/intro, and the omitted-count trailer stay byte-identical,
    // and every entry is its own paragraph (never glued to the next).
    expect(prepared).toBe([
      '## Project Memory',
      'Knowledge from previous sessions. May be stale; correct via memory_write.',
      '',
      'user prefers terse replies',
      '',
      '> Checkpoint · 2026-09-24 · session-abcd…7890',
      '',
      'compaction segment one',
      '- bullet in checkpoint',
      '',
      '> Checkpoint · 2026-09-23 · session-99887766',
      '',
      'older compaction content',
      '',
      '(2 older memories omitted)',
    ].join('\n'))
  })

  it('leaves non-tag lines untouched (content, lists, headings, inline tags)', () => {
    const input = '## Project Memory\n1. item with `code`\n2. second\nnot a <tag> inline'
    expect(prepareMemoryMarkdown(input)).toBe(input)
  })

  it('does not duplicate an existing blank line around a structural tag', () => {
    const input = 'before\n\n<project-memory>\n\nafter'
    expect(prepareMemoryMarkdown(input)).toBe('before\n\nafter')
  })

  it('still fences an unknown pure tag line, with a double fence when it holds a backtick', () => {
    expect(prepareMemoryMarkdown('  <div class="a`b">')).toBe('  `` <div class="a`b"> ``')
  })

  it('preserves an ordered list after a checkpoint caption so it parses as a list', () => {
    const prepared = prepareMemoryMarkdown(
      '<checkpoint id="4">\n1. one `code`\n2. two\n3. three\n</checkpoint>')
    // Blank line after the caption: "1." starts a fresh paragraph (list);
    // the closing structural tag drops without eating into the list.
    expect(prepared).toBe(
      '> Checkpoint\n\n1. one `code`\n2. two\n3. three')
    expect(prepared.split('\n\n')).toHaveLength(2) // caption / list paragraphs
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
      await waitFor(() => expect(document.querySelector('[data-memory-block]')?.textContent).toBe(PREPPED_BLOCK))
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
      expect(document.querySelector('[data-memory-block]')).toBeNull()
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
      await waitFor(() => expect(document.querySelector('[data-memory-block]')?.textContent).toBe(PREPPED_BLOCK))
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
      await waitFor(() => expect(document.querySelector('[data-memory-block]')?.textContent).toBe(PREPPED_BLOCK))
      fireEvent.click(screen.getByText(MEMORY_VIEW_COPY.refresh))
      // Background refresh: the stale block stays visible until the new one lands…
      expect(document.querySelector('[data-memory-block]')?.textContent).toBe(PREPPED_BLOCK)
      await waitFor(() => expect(document.querySelector('[data-memory-block]')?.textContent).toContain('(note refreshed)'))
      expect(call).toHaveBeenCalledTimes(2)
      expect(call).toHaveBeenNthCalledWith(2, CHANNEL, ENDPOINT_BLOCK, { sessionId: 's1', cwd: '/work/a' })
    } finally {
      await fiber.dispose()
    }
  })
})
