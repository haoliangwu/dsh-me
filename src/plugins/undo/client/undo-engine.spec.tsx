// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { RowHider, UndoSurface, type SessionEventWindowShape, type UndoSurfaceDeps } from './undo-engine.ts'
import { nodeKey, type SessionEventLikeEntryShape } from './undo-state.ts'

/** Mutable fake event window source. */
function fakeWindow(initial: readonly SessionEventLikeEntryShape[]) {
  let entries = initial
  const listeners = new Set<() => void>()
  return {
    entries: {
      replace(next: readonly SessionEventLikeEntryShape[]) { entries = next; for (const l of [...listeners]) l() },
      get(): readonly SessionEventLikeEntryShape[] { return entries },
    },
    source: {
      subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
      getSnapshot(): SessionEventWindowShape { return { entries } },
    } satisfies UndoSurfaceDeps['eventSource'] & { subscribe(l: () => void): () => void },
  }
}

function entry(seq: number, type: string, data: Record<string, unknown>, surfaceOp?: unknown): SessionEventLikeEntryShape {
  return { type: 'event', event: { seq, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } }
}

function twoTurnLog(): SessionEventLikeEntryShape[] {
  return [
    entry(1, 'turn/start', { turn: 1 }),
    entry(2, 'user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }, 'append'),
    entry(3, 'assistant/message', { turn: 1, step: 0, message: { id: 'a1' } }, 'append'),
    entry(4, 'turn/end', { turn: 1 }),
    entry(5, 'turn/start', { turn: 2 }),
    entry(6, 'user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }, 'append'),
    entry(7, 'assistant/message', { turn: 2, step: 0, message: { id: 'a2' } }, 'append'),
    entry(8, 'turn/end', { turn: 2 }),
  ]
}

function tombstone(seq: number, turn: number, shadowed: number[]): SessionEventLikeEntryShape {
  const base = entry(seq, 'system/message', {
    turn, step: 0,
    message: {
      id: `t-${seq}`, role: 'system', content: [],
      source: { kind: 'plugin', plugin: 'dsh-undo' },
    },
  }, { op: 'replace' })
  return { ...base, event: { ...base.event, sourceEventSeqs: shadowed } }
}

function surfaceDeps(window: ReturnType<typeof fakeWindow>, overrides?: Partial<UndoSurfaceDeps>) {
  const rpcCalls: Array<{ endpoint: string; payload: unknown; answer: boolean }> = []
  const drafts: string[] = []
  const onState = vi.fn()
  const surface = new UndoSurface({
    sessionId: 's1',
    eventSource: window.source,
    callRpc: vi.fn(async (endpoint: string, payload: unknown) => {
      const answer = rpcCalls.shift()?.answer ?? true
      return answer
    }) as unknown as UndoSurfaceDeps['callRpc'],
    setDraft: (text: string) => { drafts.push(text) },
    onState,
    ...overrides,
  })
  return { surface, rpcCalls, drafts, onState }
}

describe('UndoSurface', () => {
  it('derives the initial window and re-derives on appends', () => {
    const window = fakeWindow(twoTurnLog())
    const { surface, onState } = surfaceDeps(window)
    expect(surface.getSnapshot().lastTurn).toBe(2)
    const tombstoned = [...twoTurnLog(), tombstone(9, 2, [6, 7])]
    window.entries.replace(tombstoned)
    expect(onState).toHaveBeenCalledTimes(1)
    expect([...surface.getSnapshot().undoneTurns.keys()]).toEqual([2])
    expect(surface.getSnapshot().hiddenKeys.has(nodeKey('assistant-step', '2:0'))).toBe(true)
    surface.dispose()
  })

  it('notifies subscribers after a re-derivation', () => {
    const window = fakeWindow(twoTurnLog())
    const { surface } = surfaceDeps(window)
    const listener = vi.fn()
    const off = surface.subscribe(listener)
    window.entries.replace([...twoTurnLog(), tombstone(9, 2, [6, 7])])
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    window.entries.replace(twoTurnLog())
    expect(listener).toHaveBeenCalledTimes(1)
    surface.dispose()
  })

  it('refills the composer with the original user text after a successful undo', async () => {
    const window = fakeWindow(twoTurnLog())
    const { surface, drafts } = surfaceDeps(window)
    const ok = await surface.undo('a2')
    expect(ok).toBe(true)
    expect(drafts).toEqual(['second'])
    surface.dispose()
  })

  it('skips the refill when the host refuses the undo', async () => {
    const window = fakeWindow(twoTurnLog())
    const { surface, drafts, rpcCalls } = surfaceDeps(window)
    rpcCalls.push({ endpoint: 'undo', payload: {}, answer: false })
    const ok = await surface.undo('a2')
    expect(ok).toBe(false)
    expect(drafts).toEqual([])
    surface.dispose()
  })

  it('skips the refill when the turn has no text', async () => {
    const window = fakeWindow([
      entry(1, 'turn/start', { turn: 1 }),
      entry(2, 'user/message', { id: 'u1', role: 'user', content: [{ type: 'image', image: {} }] }, 'append'),
      entry(3, 'assistant/message', { turn: 1, step: 0, message: { id: 'a1' } }, 'append'),
      entry(4, 'turn/end', { turn: 1 }),
    ])
    const { surface, drafts } = surfaceDeps(window)
    await surface.undo('a1')
    expect(drafts).toEqual([])
    surface.dispose()
  })

  it('sends the redo RPC with the session id', async () => {
    const window = fakeWindow(twoTurnLog())
    const { surface } = surfaceDeps(window)
    const ok = await surface.redo()
    expect(ok).toBe(true)
    surface.dispose()
  })

  it('stops re-deriving after dispose', () => {
    const window = fakeWindow(twoTurnLog())
    const { surface, onState } = surfaceDeps(window)
    surface.dispose()
    window.entries.replace([...twoTurnLog(), tombstone(9, 2, [6, 7])])
    expect(onState).not.toHaveBeenCalled()
  })
})

describe('RowHider', () => {
  function mount(keys: string[]) {
    const container = document.createElement('div')
    container.dataset.chatFlow = ''
    const row = (key: string, display?: string) => {
      const el = document.createElement('div')
      el.dataset.chatFlowKey = key
      if (display !== undefined) el.style.display = display
      container.appendChild(el)
      return el
    }
    return { container, rows: keys.map(key => row(key)) }
  }

  it('hides shadowed rows and skips turn-tail rows', () => {
    const { container, rows } = mount([
      nodeKey('assistant-step', '2:0'),
      nodeKey('turn-tail', '2'),
      nodeKey('input-message', 'u3'),
    ])
    const keys = new Set([nodeKey('assistant-step', '2:0')])
    const hider = new RowHider(() => container, () => keys)
    hider.apply()
    expect(rows[0]?.style.display).toBe('none')
    expect(rows[1]?.style.display).not.toBe('none')
    expect(rows[2]?.style.display).not.toBe('none')
    hider.dispose()
  })

  it('re-hides rows after a React remount drop (MutationObserver)', () => {
    const { container, rows } = mount([
      nodeKey('assistant-step', '2:0'),
      nodeKey('input-message', 'u2'),
    ])
    const keys = new Set([nodeKey('assistant-step', '2:0'), nodeKey('input-message', 'u2')])
    const hider = new RowHider(() => container, () => keys)
    hider.apply()
    expect(rows[0]?.style.display).toBe('none')
    // Simulate React replacing the row node (inline style lost).
    const fresh = document.createElement('div')
    fresh.dataset.chatFlowKey = nodeKey('assistant-step', '2:0')
    rows[0]?.replaceWith(fresh)
    expect(fresh.style.display).toBe('')
    // The observer fires asynchronously (microtask); flush it.
    return Promise.resolve().then(() => {
      expect(fresh.style.display).toBe('none')
      hider.dispose()
    })
  })

  it('restores hidden rows on dispose and with the keys gone', () => {
    const { container, rows } = mount([nodeKey('assistant-step', '2:0')])
    const keys = new Set([nodeKey('assistant-step', '2:0')])
    const hider = new RowHider(() => container, () => keys)
    hider.apply()
    expect(rows[0]?.style.display).toBe('none')
    hider.dispose()
    expect(rows[0]?.style.display).toBe('')
  })

  it('shows a row again when its key leaves the set', () => {
    const { container, rows } = mount([nodeKey('input-message', 'u1')])
    let keys = new Set([nodeKey('input-message', 'u1')])
    const hider = new RowHider(() => container, () => keys)
    hider.apply()
    expect(rows[0]?.style.display).toBe('none')
    keys = new Set()
    hider.apply()
    expect(rows[0]?.style.display).toBe('')
    hider.dispose()
  })

  it('tolerates a missing container', () => {
    const hider = new RowHider(() => null, () => new Set<string>())
    expect(() => hider.apply()).not.toThrow()
    hider.dispose()
  })
})