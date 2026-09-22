/**
 * dsh-reference, node half.
 *
 * A named reference table (alias → external directory path + description +
 * visibility) stored in the global `dsh-reference` settings namespace — every
 * profile shares one table, persisted to settings.yaml by the settings
 * service. The host half registers the namespace schema (validation shared
 * with the pure core) and mounts a dynamic `systemPrompt` section
 * (`dsh-reference:rules`, order 10400, after the persona suffix) that
 * re-reads the table at every assembly: every entry is advertised with its
 * resolved path (plus its description when present) in an
 * `<available_references>` block so the agent knows when to consult the
 * material — hidden only skips the @-menu, never the advertisement (OC
 * semantics). A webServer RPC channel (`/dsh-reference`, endpoint `exists`)
 * answers the browser's path-existence probe for the settings page's
 * non-blocking ⚠ warning. The UI lives in the client half
 * (src/plugins/reference/client).
 */
import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { pickDirectoryOnHost } from './directory-picker.ts'
import {
  aliasValidationError,
  buildAdvertisementText,
  normalizeTable,
  referencePathError,
} from './pure.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-reference'

/** Required services: the settings registry and the system-prompt registry. */
export const inject = ['settings', 'systemPrompt']

/** Plugin config: no options — the table lives in the settings namespace. */
export interface Config {}

export const Config = z.object({})

/** Section placement: after the persona suffix, the tail reference slot. */
export const SECTION_NAME = 'dsh-reference:rules'
export const SECTION_ORDER = 10400

/** RPC channel owned by this plugin (browser-side path probe + directory picker). */
const CHANNEL = '/dsh-reference'

/** Endpoint under {@link CHANNEL}: answer whether one resolved path exists. */
const ENDPOINT_EXISTS = 'exists'

/** Endpoint under {@link CHANNEL}: spawn the platform's native folder dialog. */
const ENDPOINT_PICK_DIRECTORY = 'pickDirectory'

// Schemastery object keys are optional by absence (and the entry shape's
// field types are enforced by the dict layer), so the transform below pins
// what the shape cannot: alias-key legality, path requiredness, and the
// path-prefix rule — the same rules the pure core exposes to the save layer
// (spec decision: validation applies at both the schema layer and the save
// layer). Plain Error (not z.ValidationError): this schemastery version
// invokes transform callbacks with the value only, so the options argument
// the ValidationError constructor needs is never provided at runtime.
const entryShape = z.object({
  path: z.string(),
  description: z.string(),
  hidden: z.boolean(),
})

const tableShape = z.dict(entryShape)

/** The settings-namespace schema: map(alias → { path, description?, hidden? }). */
export const Schema = z
  .transform(tableShape, (table) => {
    for (const [alias, entry] of Object.entries(table)) {
      const aliasError = aliasValidationError(alias)
      if (aliasError !== undefined) {
        throw new Error(`dsh-reference: alias「${alias}」${aliasError}`)
      }
      const shape = entry as { path?: unknown }
      if (typeof shape.path !== 'string') {
        throw new Error(`dsh-reference: entry「${alias}」缺少 path`)
      }
      const pathError = referencePathError(shape.path)
      if (pathError !== undefined) {
        throw new Error(`dsh-reference: entry「${alias}」path「${shape.path}」${pathError}`)
      }
    }
    return table
  })
  .default({})

/** Structural settings-registry face (the scope's get() is the read API). */
interface SettingsScopeLike {
  get(): unknown
}

interface SettingsLike {
  register(namespace: string, schema: unknown): SettingsScopeLike
}

/** Structural system-prompt service face: section() returns the disposer. */
interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: () => string
    /** False preserves literal text (no {{variable}} interpolation). */
    readonly interpolate?: boolean
  }): () => void
}

/** Structural plugin context face. */
interface ReferenceCtx {
  settings: SettingsLike
  systemPrompt: SystemPromptLike
}

/**
 * Mount the reference-table settings namespace and the dynamic advertisement
 * section. The namespace registration is itself effect-scoped (the settings
 * provider registers through ctx.effect, removing the namespace when this
 * plugin's scope disposes) — no extra effect wrapper. The section re-reads
 * the table at every assembly, so a settings-save lands in the next turn's
 * prompt without a restart.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  const scoped = ctx as unknown as ReferenceCtx
  const home = homedir()
  const scope = scoped.settings.register('dsh-reference', Schema)

  // Read fresh at every assembly: settings edits (settings.yaml or the web
  // settings page) land in the next turn's advertisement.
  ctx.effect(() => scoped.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // Model-facing instruction text, not a prompt-variable template —
    // preserve literal text like a {@link PromptSection} contributor must.
    interpolate: false,
    text: () => buildAdvertisementText(normalizeTable(scope.get()), home),
  }))

  // Browser-side path-existence probing (the settings page's non-blocking ⚠
  // warning) and the native directory picker (the "Choose folder" button): both
  // ride one webServer prefix route speaking the Connection-RPC envelope,
  // because the connection service is provided inside the web-app boot tree and
  // a profile fiber's inject never activates (dsh-ui-peak-rate precedent).
  // Non-web profiles simply skip the channel.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: (req, res) => {
        void serveReferenceChannel(req, res, home)
      },
    }), 'dsh-reference: /dsh-reference channel')
  })
}

/** Response payload of the {@link ENDPOINT_EXISTS} endpoint. */
interface ExistsResponse {
  readonly exists: boolean
}

/**
 * Serve the `/dsh-reference` channel as a Connection-RPC route (POST-only,
 * JSON client-request envelope, server-response envelope out — the same
 * envelope dsh-client-connection's rpcFetchHandler speaks, so the browser-side
 * `connection.rpc.call()` keeps working unchanged). Two endpoints share the
 * envelope parsing: {@link ENDPOINT_EXISTS} stats one path and
 * {@link ENDPOINT_PICK_DIRECTORY} spawns the platform's folder dialog.
 * @param req - the incoming HTTP request.
 * @param res - the HTTP response.
 * @param home - the user's home directory (`~/` expansion and picker start).
 */
async function serveReferenceChannel(req: IncomingMessage, res: ServerResponse, home: string): Promise<void> {
  const writeJson = (status: number, body: unknown): void => {
    const bytes = Buffer.from(JSON.stringify(body))
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', String(bytes.length))
    res.writeHead(status)
    res.end(bytes)
  }
  const pathname = req.url ?? '/'
  const urlPath = pathname.split('?', 1)[0]
  if (req.method !== 'POST'
    || (urlPath !== `${CHANNEL}/${ENDPOINT_EXISTS}` && urlPath !== `${CHANNEL}/${ENDPOINT_PICK_DIRECTORY}`)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  let rawBody: unknown
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
    }
    rawBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const message = (rawBody ?? {}) as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  const result = (value: RpcResult<unknown>): void =>
    writeJson(200, {
      type: 'server-response',
      rpcId: typeof message.rpcId === 'string' ? message.rpcId : '',
      result: value,
    })
  if (typeof rawBody !== 'object' || rawBody === null || message.type !== 'client-request'
    || typeof message.rpcId !== 'string' || typeof message.method !== 'string'
    || message.method !== urlPath.slice(CHANNEL.length + 1)) {
    result({ ok: false, error: { code: 'internal', message: 'invalid client-request message', details: {} } })
    return
  }
  if (message.method === ENDPOINT_EXISTS) {
    await serveExists(message.payload, home, result)
    return
  }
  await servePickDirectory(home, result)
}

/** Answer the {@link ENDPOINT_EXISTS} payload with the path's existence. */
async function serveExists(
  payload: unknown,
  home: string,
  result: (value: RpcResult<unknown>) => void,
): Promise<void> {
  const value = (payload ?? {}) as { path?: unknown }
  if (typeof value.path !== 'string') {
    result({ ok: false, error: { code: 'internal', message: 'path must be a string', details: {} } })
    return
  }
  // Stat the resolved absolute path; every stat failure (missing, permission,
  // race) answers false — the settings page treats it as a non-blocking ⚠.
  const resolved = value.path.startsWith('~/') ? `${home}/${value.path.slice(2)}` : value.path
  try {
    await stat(resolved)
    result({ ok: true, value: { exists: true } })
  } catch {
    result({ ok: true, value: { exists: false } })
  }
}

/** Answer {@link ENDPOINT_PICK_DIRECTORY} with the native folder dialog. */
async function servePickDirectory(home: string, result: (value: RpcResult<unknown>) => void): Promise<void> {
  try {
    result({ ok: true, value: await pickDirectoryOnHost(home) })
  } catch (error) {
    // Every picker failed to spawn (missing binary); the client drops the
    // button press silently and keeps the manual input path.
    result({ ok: false, error: { code: 'internal', message: `directory picker failed: ${String(error)}`, details: {} } })
  }
}