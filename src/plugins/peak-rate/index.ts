/**
 * Web composer 🔥 2× peak-rate badge, node half.
 *
 * Mounts the host-plane Config carrier as a Connection RPC channel: the
 * browser half reads the validated provider list, peak windows, and multiplier
 * through `ctx.connection.rpc.call('/peak-rate', 'config', {})`. There is no
 * in-process Service shared across the host/browser boundary — the only
 * transport is the Connection RPC channel.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import z from '@deepseek-ai/schemastery'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name. */
export const name = 'client-ui-peak-rate'

/**
 * Required services. The web route is attached at runtime via
 * `ctx.inject(['webServer'])` (vision-toolkit pattern) so non-web profiles
 * simply skip the channel instead of pending forever.
 */
export const inject = []

/** Plugin config: providers, peak windows, and multiplier for the peak badge. */
export interface Config {
  /** Provider ids that show the peak-rate badge (default: the official DeepSeek provider). */
  providers?: string[]
  /** Peak windows `[startHour, endHour)` UTC, left-closed right-open (default: [[1,4],[6,10]]). */
  peakWindows?: (readonly [number, number])[]
  /** Peak-rate multiplier vs off-peak rate (default: 2). */
  multiplier?: number
}

export const Config = z.object({
  providers: z.array(String).default(['deepseek-official']),
  peakWindows: z.transform(
    z.array(z.tuple([Number, Number])),
    (windows, options) => {
      const typed = windows as [number, number][]
      for (const [start, end] of typed) {
        if (!(start >= 0 && start < end && end <= 24)) {
          throw new z.ValidationError(`peak window [${start},${end}] must satisfy 0 <= start < end <= 24`, options)
        }
      }
      return typed
    },
  ).default([[1, 4], [6, 10]]),
  multiplier: z.number().default(2),
})

/** Response payload for the `config` endpoint. */
interface ConfigResponse {
  readonly providers: readonly string[]
  readonly peakWindows: readonly (readonly [number, number])[]
  readonly multiplier: number
}

/** RPC channel owned by this plugin. */
const CHANNEL = '/peak-rate'

/** Endpoint under {@link CHANNEL} returning the configured peak-rate policy. */
const ENDPOINT_CONFIG = 'config'

/**
 * Mount the host RPC handler that returns the validated peak-rate policy.
 * @param ctx - host plugin context carrying the Connection service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const response: ConfigResponse = {
    providers: config.providers as string[],
    peakWindows: config.peakWindows as (readonly [number, number])[],
    multiplier: config.multiplier as number,
  }
  // dsh-client-connection 0.1.5-rc.2: connection.rpc.handle() is unusable from
  // the profile plugin tree — the connection service is provided inside the
  // web-app boot tree, so a profile fiber's inject wait never activates.
  // Register a plain webServer prefix route speaking the same
  // client-request/server-response envelopes instead.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: (req, res) => {
        void serveChannel(req, res, CHANNEL, (endpoint, payload) => {
          void payload
          if (endpoint === ENDPOINT_CONFIG) {
            return Promise.resolve({ ok: true as const, value: response })
          }
          return Promise.resolve({
            ok: false as const,
            error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
          })
        })
      },
    }), 'dsh-ui-peak-rate: /peak-rate channel')
  })
}

/**
 * Serve one Connection-RPC channel over a plain webServer route, mirroring
 * dsh-client-connection's rpcFetchHandler semantics (POST-only, JSON
 * client-request envelope, server-response envelope out) so the browser-side
 * `connection.rpc.call()` keeps working unchanged.
 */
async function serveChannel(
  req: IncomingMessage,
  res: ServerResponse,
  channel: string,
  handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
): Promise<void> {
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
  if (typeof body !== 'object' || body === null || message.type !== 'client-request'
    || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
    respond({ ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } })
    return
  }
  if (message.method !== endpoint) {
    respond({
      ok: false,
      error: {
        code: 'gateway/bad-request',
        message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: {},
      },
    })
    return
  }
  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  req.socket.once('close', () => controller.abort())
  try {
    respond(await handler(endpoint, message.payload, controller.signal))
  } catch (error) {
    res.writeHead(500)
    res.end(`handler failure: ${String(error)}`)
  }
}

/** Extract and validate the endpoint segment below the channel prefix. */
function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_$.-]+$/.test(segment))) return undefined
  return endpoint
}