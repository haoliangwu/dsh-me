/**
 * dsh-ui-notification, node half.
 *
 * Serves the validated notification-trigger toggles over the Connection RPC
 * channel `/notification` endpoint `config`; the browser half reads them
 * through `ctx.connection.rpc.call('/notification', 'config', {})`. In the
 * Electron desktop shell the renderer's HTML5 Notification API creates no OS
 * bubble, so the browser half posts endpoint `notify` and this half shows a
 * native macOS notification through `osascript`. There is no in-process
 * Service shared across the host/browser boundary — the only transport is
 * the Connection RPC channel.
 */
import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { serveRpcChannel } from '../../shared/rpc-channel.ts'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name. */
export const name = 'dsh-ui-notification'

/**
 * Required services. The web route is attached at runtime via
 * `ctx.inject(['webServer'])` (peak-rate pattern) so non-web profiles simply
 * skip the channel instead of pending forever.
 */
export const inject = []

/** Plugin config: independent toggles per notification trigger type. */
export interface Config {
  /** Notify when a turn ends `completed` or `max-tokens` (default: true). */
  notifyCompletion?: boolean
  /** Notify when a turn ends `error` (default: true). */
  notifyError?: boolean
  /** Notify when the agent asks the user a question (default: true). */
  notifyQuestion?: boolean
  /** Notify when a tool asks for permission approval (default: true). */
  notifyApproval?: boolean
  /** Play the synthesized chime instead of the OS default sound (default: true). */
  notifySound?: boolean
}

export const Config = z.object({
  notifyCompletion: z.boolean().default(true),
  notifyError: z.boolean().default(true),
  notifyQuestion: z.boolean().default(true),
  notifyApproval: z.boolean().default(true),
  notifySound: z.boolean().default(true),
})

/** Response payload for the `config` endpoint. */
interface ConfigResponse {
  readonly notifyCompletion: boolean
  readonly notifyError: boolean
  readonly notifyQuestion: boolean
  readonly notifyApproval: boolean
  readonly notifySound: boolean
}

/** RPC channel owned by this plugin. */
const CHANNEL = '/notification'

/** Endpoint under {@link CHANNEL} returning the configured trigger toggles. */
const ENDPOINT_CONFIG = 'config'

/** Endpoint under {@link CHANNEL} showing one native desktop notification. */
const ENDPOINT_NOTIFY = 'notify'

/** macOS notification payload limit is 256 bytes; the OS truncates long text. */
const TITLE_MAX_CHARS = 48
const BODY_MAX_CHARS = 192

/**
 * One-line AppleScript string literal for `display notification`: CR/LF
 * collapsed to spaces, backslashes escaped before quotes so the second pass
 * cannot double them.
 * @param text - the text to embed.
 * @returns the escaped quoted AppleScript string body.
 */
export function appleScriptString(text: string): string {
  const oneLine = text.replace(/[\r\n]+/g, ' ')
  return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Compose the complete `display notification` AppleScript for one title/body
 * pair: `with title` carries the title, the bare string carries the body.
 * @param title - the notification title.
 * @param body - the notification body.
 * @returns the `-e` script argument.
 */
export function buildOsascriptScript(title: string, body: string): string {
  const bounded: { title: string; body: string } = {
    title: Array.from(title).slice(0, TITLE_MAX_CHARS).join(''),
    body: Array.from(body).slice(0, BODY_MAX_CHARS).join(''),
  }
  return `display notification ${appleScriptString(bounded.body)} with title ${appleScriptString(bounded.title)}`
}

/** Client payload for {@link ENDPOINT_NOTIFY}. */
interface NotifyPayload {
  readonly title: string
  readonly body: string
}

/**
 * Validate and forward one `notify` payload. macOS shows it with `osascript
 * display notification`; every other platform logs and no-ops (browser
 * profiles already notify through the renderer API).
 * @param payload - the client-sent payload.
 * @param ctx - the host plugin context for logging.
 * @returns whether the OS notification was dispatched.
 */
function dispatchNativeNotify(payload: unknown, ctx: Context): Promise<RpcResult<{ readonly delivered: boolean }>> {
  if (typeof payload !== 'object' || payload === null) {
    return Promise.resolve({ ok: false as const, error: { code: 'bad-request', message: 'notify payload must be an object', details: {} } })
  }
  const record = payload as Record<string, unknown>
  const title = record.title
  const body = record.body
  if (typeof title !== 'string' || typeof body !== 'string') {
    return Promise.resolve({ ok: false as const, error: { code: 'bad-request', message: 'notify payload requires string title and body', details: {} } })
  }
  if (process.platform !== 'darwin') {
    ctx.logger.warn('dsh-ui-notification: native notify only supported on darwin, got %s', process.platform)
    return Promise.resolve({ ok: true as const, value: { delivered: false } })
  }
  return new Promise((resolve) => {
    execFile('osascript', ['-e', buildOsascriptScript(title, body)], (error, _stdout, stderr) => {
      if (error) {
        ctx.logger.warn('dsh-ui-notification: osascript failed', error, stderr)
        resolve({ ok: true as const, value: { delivered: false } })
        return
      }
      resolve({ ok: true as const, value: { delivered: true } })
    })
  })
}

/**
 * Mount the host RPC handler that returns the validated trigger toggles.
 * @param ctx - host plugin context carrying the Connection service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const response: ConfigResponse = {
    notifyCompletion: config.notifyCompletion as boolean,
    notifyError: config.notifyError as boolean,
    notifyQuestion: config.notifyQuestion as boolean,
    notifyApproval: config.notifyApproval as boolean,
    notifySound: config.notifySound as boolean,
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
        void serveRpcChannel(req, res, { channel: CHANNEL, logLabel: 'dsh-ui-notification: /notification channel' }, (endpoint, payload) => {
          if (endpoint === ENDPOINT_CONFIG) {
            return Promise.resolve({ ok: true as const, value: response })
          }
          if (endpoint === ENDPOINT_NOTIFY) {
            return dispatchNativeNotify(payload, webCtx)
          }
          return Promise.resolve({
            ok: false as const,
            error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
          })
        })
      },
    }), 'dsh-ui-notification: /notification channel')
  })
}

/**
 * Serve one Connection-RPC channel over a plain webServer route, mirroring
 * dsh-client-connection's rpcFetchHandler semantics (POST-only, JSON
 * client-request envelope, server-response envelope out) so the browser-side
 * `connection.rpc.call()` keeps working unchanged.
 */
