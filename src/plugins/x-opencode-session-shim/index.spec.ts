import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, sessionValueFor } from './index.ts'

/** Capture fetch calls through a fake globalThis.fetch. */
function captureFetch(): { calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }>; restore: () => void } {
  const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return Promise.resolve(new Response('{}'))
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** Minimal cordis-shaped context double. */
function fakeCtx(initiator?: { id: string }) {
  const disposers: Array<() => void> = []
  return {
    agents: { currentInitiator: () => initiator },
    logger: { info: vi.fn() },
    // mirror cordis semantics: the callback runs immediately, its return
    // value is the disposer
    effect: (fn: () => () => void) => { disposers.push(fn()) },
    dispose: () => { for (const d of disposers) d() },
  }
}

describe('sessionValueFor', () => {
  it('uses the initiator session id', () => {
    expect(sessionValueFor(() => ({ id: 'session-123' }))).toBe('session-123')
  })

  it('falls back to the agentless id outside an initiator boundary', () => {
    expect(sessionValueFor(() => undefined)).toBe('dsh')
  })

  it('falls back when the registry refuses reads after disposal', () => {
    expect(sessionValueFor(() => { throw new Error('disposed') })).toBe('dsh')
  })
})

describe('apply', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  function setup(initiator?: { id: string }) {
    const ctx = fakeCtx(initiator)
    const { calls, restore } = captureFetch()
    cleanups.push(restore)
    apply(ctx as never)
    cleanups.push(ctx.dispose)
    return { ctx, calls }
  }

  it('stamps x-opencode-session on opencode-go requests (string URL form)', async () => {
    const { ctx, calls } = setup({ id: 'session-abc' })
    await globalThis.fetch('https://opencode.ai/zen/go/chat/completions', { method: 'POST', headers: { authorization: 'Bearer k' } })
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0]!.init?.headers).get('x-opencode-session')).toBe('session-abc')
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer k')
  })

  it('passes requests to other endpoints through untouched', async () => {
    const { ctx, calls } = setup({ id: 'session-abc' })
    await globalThis.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: {} })
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0]!.init?.headers).get('x-opencode-session')).toBeNull()
  })

  it('stamps the fallback id when no initiator is active', async () => {
    const { calls } = setup(undefined)
    await globalThis.fetch('https://opencode.ai/zen/go/v1/messages', { method: 'POST' })
    expect(new Headers(calls[0]!.init?.headers).get('x-opencode-session')).toBe('dsh')
  })

  it('stamps the header on Request-object form without init', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL) => input) as never
    const request = new Request('https://opencode.ai/zen/go/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer k' },
      body: '{"x":1}',
    })
    globalThis.fetch = original
    const { calls } = setup({ id: 'session-req' })
    await globalThis.fetch(request)
    expect(calls).toHaveLength(1)
    const sent = calls[0]!.input as Request
    expect(sent.headers.get('x-opencode-session')).toBe('session-req')
    expect(sent.headers.get('authorization')).toBe('Bearer k')
  })

  it('restores the original fetch on dispose', async () => {
    const ctx = fakeCtx({ id: 's' })
    const { restore } = captureFetch()
    cleanups.push(restore)
    apply(ctx as never)
    const patched = globalThis.fetch
    ctx.dispose()
    expect(globalThis.fetch).not.toBe(patched)
  })
})
