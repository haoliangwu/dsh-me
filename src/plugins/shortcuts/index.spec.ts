/**
 * dsh-ui-shortcuts host tests: the Config schema (defaults merge + startup
 * syntax rejection, spec US-10) and the webServer channel mounting — the fake
 * webServer captures the prefix route so the Connection-RPC envelope is
 * exercised against the real serveChannel with fake req/res streams. The route
 * handler fire-and-forgets serveChannel (`void`), so every invocation flushes
 * the microtask/timer queue before reading the response.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, inject, name } from './index.ts'

/** Fake IncomingMessage speaking the async-iterable chunk contract serveChannel reads. A Buffer body is yielded raw (malformed-JSON test). */
function reqOf(method: string, url: string, body: unknown, contentType = 'application/json') {
  const json = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  return {
    method,
    url,
    headers: { 'content-type': contentType },
    once: () => {},
    socket: { once: () => {} },
    [Symbol.asyncIterator]: async function* () { yield json },
  } as unknown as import('node:http').IncomingMessage
}

/** Fake ServerResponse capturing status + body. */
function resOf() {
  let status = 0
  let body = ''
  return {
    get statusCode() { return status },
    get body() { return body },
    setHeader: () => {},
    writeHead: (code: number) => { status = code },
    end: (chunk?: unknown) => { body = String(chunk ?? '') },
  } as unknown as import('node:http').ServerResponse & { statusCode: number; body: string }
}

/** Await the fire-and-forget route handler plus its queued continuation. */
async function invoke(handler: (req: unknown, res: unknown) => void, req: unknown, res: unknown): Promise<void> {
  handler(req, res)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** Boot apply over a fake webServer that records every registered route. */
async function mountedWith(config: unknown) {
  const ctx = new Context()
  const routes: Array<{ path: string; kind: string; handler: (req: unknown, res: unknown) => void }> = []
  ctx.provide('webServer', {
    register: (route: { path: string; kind: string; handler: (req: unknown, res: unknown) => void }) => {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  } as never)
  apply(ctx, Config(config as never) as never)
  // ctx.inject's fiber reload runs on the microtask queue; one tick settles it.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return { ctx, routes }
}

/** POST one client-request envelope to the captured channel and return the 200 server-response JSON. */
async function askConfig(handler: (req: unknown, res: unknown) => void) {
  const res = resOf()
  await invoke(handler,
    reqOf('POST', '/shortcuts/config', { type: 'client-request', rpcId: 'r1', method: 'config', payload: {} }),
    res,
  )
  return { res, message: JSON.parse(res.body) as { type: string; rpcId: string; result: unknown } }
}

describe('plugin contract', () => {
  it('declares the empty host dependency list and the plugin id', () => {
    expect(name).toBe('dsh-ui-shortcuts')
    expect(inject).toEqual([])
  })
})

describe('Config schema', () => {
  it('resolves the default bindings for an empty config', () => {
    expect(Config({})).toEqual({
      bindings: { sidebar: 'CmdOrCtrl+B', rightbar: 'CmdOrCtrl+I', focus: '/', help: 'Shift+?' },
    })
  })

  it('keeps defaults for actions a partial config does not override', () => {
    expect(Config({ bindings: { sidebar: 'CmdOrCtrl+K' } })).toEqual({
      bindings: { sidebar: 'CmdOrCtrl+K', rightbar: 'CmdOrCtrl+I', focus: '/', help: 'Shift+?' },
    })
  })

  it('rejects a syntactically invalid binding at Config load', () => {
    expect(() => Config({ bindings: { sidebar: 'Ctrl+' } })).toThrow(/bindings\.sidebar is invalid/)
    expect(() => Config({ bindings: { help: 'Bogus' } })).toThrow(/bindings\.help is invalid/)
    expect(() => Config({ bindings: { rightbar: 'Shift+Shift+K' } })).toThrow(/bindings\.rightbar is invalid/)
  })

  it('rejects a non-string binding value', () => {
    expect(() => Config({ bindings: { sidebar: 42 } } as never)).toThrow()
  })
})

describe('webServer channel', () => {
  it('mounts the /shortcuts prefix route and serves the config envelope with defaults', async () => {
    const { routes } = await mountedWith({})
    const route = routes[0]
    expect(route.kind).toBe('prefix')
    expect(route.path).toBe('/shortcuts')
    const { res, message } = await askConfig(route.handler)
    expect(res.statusCode).toBe(200)
    expect(message.type).toBe('server-response')
    expect(message.rpcId).toBe('r1')
    expect(message.result).toEqual({
      ok: true,
      value: { sidebar: 'CmdOrCtrl+B', rightbar: 'CmdOrCtrl+I', focus: '/', help: 'Shift+?' },
    })
  })

  it('serves custom bindings through to the response', async () => {
    const { routes } = await mountedWith({ bindings: { sidebar: 'Alt+Shift+S', help: '?' } })
    const { res, message } = await askConfig(routes[0].handler)
    expect(res.statusCode).toBe(200)
    expect(message.result).toEqual({
      ok: true,
      value: { sidebar: 'Alt+Shift+S', rightbar: 'CmdOrCtrl+I', focus: '/', help: '?' },
    })
  })

  it('404s a non-POST request and an unknown endpoint segment', async () => {
    const { routes } = await mountedWith({})
    const res = resOf()
    await invoke(routes[0].handler, reqOf('GET', '/shortcuts/config', {}), res)
    expect(res.statusCode).toBe(404)
    const res2 = resOf()
    await invoke(routes[0].handler, reqOf('POST', '/shortcuts/../etc', {}), res2)
    expect(res2.statusCode).toBe(404)
  })

  it('415s a non-JSON content type and 400s a malformed body', async () => {
    const { routes } = await mountedWith({})
    const res = resOf()
    await invoke(routes[0].handler, reqOf('POST', '/shortcuts/config', {}, 'text/plain'), res)
    expect(res.statusCode).toBe(415)
    const res2 = resOf()
    await invoke(routes[0].handler, reqOf('POST', '/shortcuts/config', Buffer.from('not json')), res2)
    expect(res2.statusCode).toBe(400)
  })

  it('rejects a mismatched envelope method', async () => {
    const { routes } = await mountedWith({})
    const res = resOf()
    await invoke(routes[0].handler,
      reqOf('POST', '/shortcuts/config', { type: 'client-request', rpcId: 'r1', method: 'bogus', payload: {} }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const message = JSON.parse(res.body) as { result: { ok: boolean; error: { code: string } } }
    expect(message.result.ok).toBe(false)
    expect(message.result.error.code).toBe('gateway/bad-request')
  })
})