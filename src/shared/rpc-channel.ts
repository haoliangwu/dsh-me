/**
 * Shared Connection-RPC channel server for profile-tree plugins.
 *
 * Profile plugin fibers cannot use `connection.rpc.handle`: the connection
 * service is provided inside the web-app boot tree, so a profile fiber's
 * inject wait never activates. These plugins instead mount a plain webServer
 * prefix route speaking the same client-request/server-response envelopes, so
 * the browser-side `connection.rpc.call()` keeps working unchanged. This
 * module is the single implementation of that route, mirroring
 * dsh-client-connection's `rpcFetchHandler` semantics:
 *
 * - POST-only + valid endpoint segment → else 404
 * - `application/json` content type → else 415
 * - JSON body parse failure → else 400
 * - invalid client-request envelope / method≠endpoint → 200 with
 *   `gateway/bad-request` result (the official envelope response)
 * - handler rejection → 500 `handler failure: <error>` plus a server log
 *
 * Admit guard: the official route handler runs `connection.admit(req)` and
 * rejects with 401/403 before the envelope (rpc-host.ts). That fence
 * (trustedHosts + browser auth) is unreachable from profile fibers.
 *
 * Origins are deliberately NOT matched against Host: the official fence binds
 * Host only (api-request-trust.ts — "Host is the one header rebinding cannot
 * forge"), and the Desktop surface loads from a custom-scheme origin
 * (`dsh-*://app/`), which a same-origin check would 403 on every request.
 * This module keeps a Host sanity check (a malformed or absent authority is
 * refused) and leaves the trustworthy-origin/auth decision to the connection
 * service once the profile tree can reach it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'

/** One channel endpoint handler; identical to connection's ConnectionRpcHandler. */
export type RpcChannelHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Serving options for {@link serveRpcChannel}. */
export interface RpcChannelOptions {
  /** Channel path prefix (e.g. `/peak-rate`); also bounds the endpoint parser. */
  readonly channel: string
  /** Server-log prefix for handler failures (e.g. `dsh-ui-peak-rate: /peak-rate channel`). */
  readonly logLabel: string
}

/** Endpoint segment alphabet, identical to connection's ENDPOINT_SEGMENT_PATTERN. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Serve one Connection-RPC channel over a plain webServer route.
 * @param req - the incoming HTTP request.
 * @param res - the HTTP response.
 * @param options - channel path and log label.
 * @param handler - endpoint dispatch returning a server-response result.
 */
export async function serveRpcChannel(
  req: IncomingMessage,
  res: ServerResponse,
  options: RpcChannelOptions,
  handler: RpcChannelHandler,
): Promise<void> {
  const { channel, logLabel } = options
  const writeJson = (status: number, body: unknown): void => {
    const bytes = Buffer.from(JSON.stringify(body))
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', String(bytes.length))
    res.writeHead(status)
    res.end(bytes)
  }
  const endpoint = endpointFromPath(channel, req.url ?? '/')
  if (req.method !== 'POST' || endpoint === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  if (!hasAuthoritativeHost(req)) {
    res.writeHead(400)
    res.end('missing or malformed host header')
    return
  }
  let body: unknown
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      chunks.push(part)
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const message = (body ?? {}) as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  const respond = (result: RpcResult<unknown>): void =>
    writeJson(200, { type: 'server-response', rpcId: typeof message.rpcId === 'string' ? message.rpcId : '', result })
  // The full envelope schema lives in connection (clientRequestSchema); this
  // local check keeps the same field contract and error code, with an empty
  // issues list when the detail is unavailable from the zod schema.
  if (typeof body !== 'object' || body === null || message.type !== 'client-request'
    || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
    respond({
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
    } as unknown as RpcResult<unknown>)
    return
  }
  if (message.method !== endpoint) {
    respond({
      ok: false,
      error: {
        code: 'gateway/bad-request',
        message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: { issues: [] },
      },
    } as unknown as RpcResult<unknown>)
    return
  }
  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  req.socket.once('close', () => controller.abort())
  try {
    respond(await handler(endpoint, message.payload, controller.signal))
  } catch (error) {
    // The browser only shows "transport failure ... HTTP 500"; the thrown
    // detail must reach the server log or it is lost.
    console.error(`${logLabel}: ${String(endpoint)} handler failure:`, error)
    res.writeHead(500)
    res.end(`handler failure: ${String(error)}`)
  }
}

/** Extract and validate the endpoint segment below the channel prefix. */
function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some((segment) =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

/** Host-authority sanity guard: a present, parseable Host header (any origin). */
function hasAuthoritativeHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  try {
    new URL(`http://${host}`)
    return true
  } catch {
    return false
  }
}