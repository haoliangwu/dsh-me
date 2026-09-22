/**
 * dsh-reference, node half.
 *
 * A named reference table (alias → external directory path + description +
 * visibility, or a git repository + optional branch/refresh) stored in the
 * global `dsh-reference` settings namespace — every profile shares one table,
 * persisted to settings.yaml by the settings service. The host half registers
 * the namespace schema (validation shared with the pure core: alias/path
 * rules plus the `{ path }` XOR `{ repository, branch? }` shape) and mounts a
 * dynamic `systemPrompt` section (`dsh-reference:rules`, order 10400, after
 * the persona suffix) that re-reads the table at every assembly: every entry
 * is advertised with its resolved materialized path (git: `<cacheDir>/<alias>`)
 * plus its description when present, in an `<available_references>` block so
 * the agent knows when to consult the material — hidden only skips the
 * @-menu, never the advertisement (OC semantics). Git entries are materialized
 * in the background at apply AND after every settings-table mutation (the
 * settings scope watch re-runs materialization, so a git entry saved through
 * the settings page clones without a reload; re-runs are idempotent by the
 * missing-only semantics — no debounce): clone/fetch per the refresh policy;
 * failures only log — never blocking apply. missing-only leaves an existing
 * checkout untouched (no network), a branch change re-clones, always fetches +
 * hard-resets. A webServer RPC channel (`/dsh-reference`, endpoint `exists`)
 * answers the browser's path-existence probe for the settings page's
 * non-blocking ⚠ warning. The UI lives in the client half
 * (src/plugins/reference/client).
 */
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  defaultCacheDir,
  entryShapeError,
  gitSpecsOf,
  materializeGit,
  normalizeTable,
  referencePathError,
  resolveCacheDir,
  type LoggerLike,
  type RefreshMode,
} from './pure.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-reference'

/** Required services: the settings registry and the system-prompt registry. */
export const inject = ['settings', 'systemPrompt']

/** Plugin config: the git cache root and the global git refresh policy. */
export interface Config {
  /** Git cache root (default: `~/.cache/dsh-me/references`). */
  cacheDir?: string
  /**
   * Global git refresh policy (default `'missing-only'`): `'always'` fetches +
   * hard-resets every load; `'missing-only'` clones only when the cache dir is
   * absent and leaves existing checkouts untouched. Per-entry `refresh` wins.
   */
  refresh?: RefreshMode
}

// Schemastery object keys are optional by absence (and the entry shape's
// field types are enforced by the dict layer), so the transform below pins
// what the shape cannot: alias-key legality, the XOR { path } / { repository,
// branch? } shape, path requiredness/prefix, file:// rejection, and refresh
// const-union bounds — the same rules the pure core exposes to the save layer
// (spec decision: validation applies at both the schema layer and the save
// layer). Plain Error (not z.ValidationError): this schemastery version
// invokes transform callbacks with the value only, so the options argument
// the ValidationError constructor needs is never provided at runtime.
const refreshModeShape = z.union([z.const('always'), z.const('missing-only')])

const entryShape = z.object({
  path: z.string(),
  repository: z.string(),
  branch: z.string(),
  refresh: refreshModeShape,
  description: z.string(),
  hidden: z.boolean(),
})

const tableShape = z.dict(entryShape)

/** The settings-namespace schema: map(alias → local | git entry). */
export const Schema = z
  .transform(tableShape, (table) => {
    for (const [alias, entry] of Object.entries(table)) {
      const aliasError = aliasValidationError(alias)
      if (aliasError !== undefined) {
        throw new Error(`dsh-reference: alias「${alias}」${aliasError}`)
      }
      const shape = entry as { path?: unknown; repository?: unknown; branch?: unknown; refresh?: unknown }
      const shapeError = entryShapeError(shape)
      if (shapeError !== undefined) {
        throw new Error(`dsh-reference: entry「${alias}」${shapeError}`)
      }
      if (typeof shape.path === 'string') {
        const pathError = referencePathError(shape.path)
        if (pathError !== undefined) {
          throw new Error(`dsh-reference: entry「${alias}」path「${shape.path}」${pathError}`)
        }
      }
    }
    return table
  })
  .default({})

/** The plugin Config schema: cacheDir (optional; home-resolved by the pure core) + global refresh. */
export const Config = z.object({
  cacheDir: z.string(),
  refresh: refreshModeShape.default('missing-only'),
})

/** Section placement: after the persona suffix, the tail reference slot. */
export const SECTION_NAME = 'dsh-reference:rules'
export const SECTION_ORDER = 10400

/** RPC channel owned by this plugin (browser-side path probe + directory picker). */
const CHANNEL = '/dsh-reference'

/** Endpoint under {@link CHANNEL}: answer whether one resolved path exists. */
const ENDPOINT_EXISTS = 'exists'

/** Endpoint under {@link CHANNEL}: spawn the platform's native folder dialog. */
const ENDPOINT_PICK_DIRECTORY = 'pickDirectory'

/** Endpoint under {@link CHANNEL}: return the host's resolved git cacheDir + refresh policy. */
const ENDPOINT_CONFIG = 'config'

/** Structural settings-registry face (the scope's get()/watch() are the read + observe API). */
interface SettingsScopeLike {
  get(): unknown
  /**
   * Observe every namespace mutation (the settings service invokes the
   * listener after each write lands). Returns the disposer.
   */
  watch(listener: () => void): () => void
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
  logger: LoggerLike
}

/**
 * One `git` invocation through node:child_process, promise-wrapped. Resolves
 * with stdout (branch detection reads it); git writes go to stderr.
 */
function runGit(args: readonly string[], options: { readonly cwd: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd: options.cwd }, (error, stdout) => {
      if (error === null) resolve(String(stdout ?? ''))
      else reject(error)
    })
  })
}

/**
 * Mount the reference-table settings namespace, kick off git materialization
 * in the background, and mount the dynamic advertisement section. The
 * namespace registration is itself effect-scoped (the settings provider
 * registers through ctx.effect, removing the namespace when this plugin's
 * scope disposes) — no extra effect wrapper. Materialization runs at apply
 * (plugin load / cordis HMR config reload) AND after every settings-table
 * mutation (the scope watch re-runs it, so a git entry saved through the
 * settings page materializes without a reload): clone/fetch/refresh failures
 * only log — apply never waits on the network, and the prompt points at the
 * target cache path meanwhile. Re-runs are idempotent by the missing-only
 * semantics (an existing checkout touches no network), so no debounce is
 * needed. The section re-reads the table at every assembly, so a
 * settings-save lands in the next turn's prompt without a restart.
 * @param ctx - host plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const scoped = ctx as unknown as ReferenceCtx
  const home = homedir()
  const scope = scoped.settings.register('dsh-reference', Schema)
  const cacheDir = resolveCacheDir(config.cacheDir, home)
    ?? (scoped.logger.warn(`dsh-reference: cacheDir「${config.cacheDir}」不是绝对路径或 ~/ 开头；使用默认 ${defaultCacheDir(home)}`),
      defaultCacheDir(home))

  /** Materialize every git entry of the current table in the background. */
  const materializeAll = (): void => {
    // Clone/refresh failures only log; nothing here throws into the watcher.
    for (const spec of gitSpecsOf(normalizeTable(scope.get()), home, cacheDir, config.refresh)) {
      void materializeGit(spec, {
        exec: runGit,
        exists: existsSync,
        mkdir: (path) => mkdirSync(path, { recursive: true }),
        rm: (path) => rmSync(path, { recursive: true, force: true }),
        readFile: (path) => {
          try {
            return readFileSync(path, 'utf8')
          } catch (error) {
            // A missing marker is an ordinary state (pre-feature cache): report
            // it as undefined; real read errors propagate to the detection log.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          }
        },
        writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
      }, scoped.logger)
    }
  }

  // Materialize at apply (settings.yaml already holds the table on load).
  materializeAll()

  // Re-materialize after every table mutation: a git entry saved through the
  // settings page must clone without a plugin reload (spec US-1/US-5 — the
  // table is runtime data; a config HMR would never fire). The effect return
  // value is the watch disposer, torn down with this plugin's scope.
  ctx.effect(() => scope.watch(materializeAll))

  // Read fresh at every assembly: settings edits (settings.yaml or the web
  // settings page) land in the next turn's advertisement.
  ctx.effect(() => scoped.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // Model-facing instruction text, not a prompt-variable template —
    // preserve literal text like a {@link PromptSection} contributor must.
    interpolate: false,
    text: () => buildAdvertisementText(normalizeTable(scope.get()), home, cacheDir),
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
        void serveReferenceChannel(req, res, home, cacheDir, config.refresh ?? 'missing-only')
      },
    }), 'dsh-reference: /dsh-reference channel')
  })
}

/** Response payload of the {@link ENDPOINT_EXISTS} endpoint. */
interface ExistsResponse {
  readonly exists: boolean
}

/** Response payload of the {@link ENDPOINT_CONFIG} endpoint. */
interface ConfigResponse {
  /** The host-resolved git cache root (custom config or the default). */
  readonly cacheDir: string
  /** The global git refresh policy (`missing-only` unless configured). */
  readonly refresh: RefreshMode
}

/**
 * Serve the `/dsh-reference` channel as a Connection-RPC route (POST-only,
 * JSON client-request envelope, server-response envelope out — the same
 * envelope dsh-client-connection's rpcFetchHandler speaks, so the browser-side
 * `connection.rpc.call()` keeps working unchanged). Three endpoints share the
 * envelope parsing: {@link ENDPOINT_EXISTS} stats one path,
 * {@link ENDPOINT_PICK_DIRECTORY} spawns the platform's folder dialog, and
 * {@link ENDPOINT_CONFIG} answers the host's resolved git cacheDir + refresh.
 * @param req - the incoming HTTP request.
 * @param res - the HTTP response.
 * @param home - the user's home directory (`~/` expansion and picker start).
 * @param cacheDir - the host-resolved git cache root.
 * @param refresh - the global git refresh policy.
 */
async function serveReferenceChannel(
  req: IncomingMessage,
  res: ServerResponse,
  home: string,
  cacheDir: string,
  refresh: RefreshMode,
): Promise<void> {
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
    || (urlPath !== `${CHANNEL}/${ENDPOINT_EXISTS}`
      && urlPath !== `${CHANNEL}/${ENDPOINT_PICK_DIRECTORY}`
      && urlPath !== `${CHANNEL}/${ENDPOINT_CONFIG}`)) {
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
  if (message.method === ENDPOINT_CONFIG) {
    serveConfig(result, cacheDir, refresh)
    return
  }
  await servePickDirectory(home, result)
}

/** Answer {@link ENDPOINT_CONFIG} with the host's resolved git cacheDir + refresh policy. */
function serveConfig(result: (value: RpcResult<unknown>) => void, cacheDir: string, refresh: RefreshMode): void {
  const value: ConfigResponse = { cacheDir, refresh }
  result({ ok: true, value })
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