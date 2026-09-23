/**
 * dsh-ui-shortcuts, node half.
 *
 * Mounts the host-plane Config as a Connection RPC channel: the browser half
 * reads the validated bindings (four actions: sidebar, rightbar, focus, help) through
 * `ctx.connection.rpc.call('/shortcuts', 'config', {})`. Binding syntax is
 * validated at Config load through the shared pure parser (spec US-10: a
 * syntax error must fail at startup, not silently no-op), and the resolved
 * defaults live in the schema, so the response carries a self-contained
 * binding set. There is no in-process Service shared across the host/browser
 * boundary — the only transport is the webServer route. The node half itself
 * has no other behavior: no session reads, no state, nothing to dispose.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import z from '@deepseek-ai/schemastery'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ShortcutsBindingError, parseBinding, type ActionId } from './pure.ts'

/** Cordis plugin name. */
export const name = 'dsh-ui-shortcuts'

/**
 * Required services. The web route is attached at runtime via
 * `ctx.inject(['webServer'])` (vision-toolkit pattern) so non-web profiles
 * simply skip the channel instead of pending forever.
 */
export const inject = []

/** Default bindings per action (platform-neutral syntax, spec US-14). */
const DEFAULT_BINDINGS: Record<ActionId, string> = {
  sidebar: 'CmdOrCtrl+B',
  rightbar: 'CmdOrCtrl+I',
  focus: '/',
  help: 'Shift+?',
}

/** Plugin config: overridable bindings per action. */
export interface Config {
  /** Bindings per action (platform-neutral syntax, e.g. 'CmdOrCtrl+B'). */
  bindings?: Partial<Record<ActionId, string>>
}

export const Config = z.object({
  bindings: z.transform(
    z.object({
      sidebar: z.string().default(DEFAULT_BINDINGS.sidebar),
      rightbar: z.string().default(DEFAULT_BINDINGS.rightbar),
      focus: z.string().default(DEFAULT_BINDINGS.focus),
      help: z.string().default(DEFAULT_BINDINGS.help),
    }),
    (bindings, options) => {
      // Validate the written syntax through the same parser the browser
      // engine matches with; a bad binding is a deploy error (spec US-10).
      // (schemastery 3.18 calls the transform callback first WITHOUT the
      // resolution options, so the path prefix must tolerate a missing
      // options object.)
      for (const [action, binding] of Object.entries(bindings)) {
        try {
          parseBinding(binding)
        } catch (error) {
          const reason = error instanceof ShortcutsBindingError ? error.message : String(error)
          throw new z.ValidationError(`dsh-ui-shortcuts: bindings.${action} is invalid — ${reason}`, options ?? {})
        }
      }
      return bindings
    },
  ).default({}),
})

/** Response payload for the `config` endpoint. */
type ConfigResponse = Record<ActionId, string>

/** RPC channel owned by this plugin. */
const CHANNEL = '/shortcuts'

/** Endpoint under {@link CHANNEL} returning the configured bindings. */
const ENDPOINT_CONFIG = 'config'

/**
 * Mount the host RPC handler that returns the validated bindings.
 * @param ctx - host plugin context carrying the Connection service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const bindings = config.bindings as Record<ActionId, string>

  // dsh-client-connection 0.1.5-rc.2: connection.rpc.handle() is unusable from
  // the profile plugin tree — the connection service is provided inside the
  // web-app boot tree, so a profile fiber's inject wait never activates.
  // Register a plain webServer prefix route speaking the same
  // client-request/server-response envelopes instead (undo pattern).
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: (req, res) => {
        void serveChannel(req, res, CHANNEL, (endpoint) => {
          if (endpoint === ENDPOINT_CONFIG) {
            return Promise.resolve({ ok: true as const, value: bindings })
          }
          return Promise.resolve({
            ok: false as const,
            error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
          })
        })
      },
    }), 'dsh-ui-shortcuts: /shortcuts channel')
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
    respond({
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} },
    } as unknown as RpcResult<unknown>)
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
    } as unknown as RpcResult<unknown>)
    return
  }
  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  req.socket.once('close', () => controller.abort())
  try {
    respond(await handler(endpoint, message.payload, controller.signal))
  } catch (error) {
    // rc.2 lesson: the browser only shows "transport failure ... HTTP 500" —
    // the thrown detail must reach the server log or it is lost.
    console.error(`dsh-ui-shortcuts: ${channel}/${String(endpoint)} handler failure:`, error)
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