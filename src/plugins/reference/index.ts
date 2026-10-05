/**
 * dsh-reference, node half.
 *
 * A named reference table (alias → external directory path + description +
 * auto-include, or a git repository + optional branch/refresh). In the
 * 0.1.7-rc.2 settings model the table lives in THIS plugin entry's own Config
 * form: the volatile `table` dict field below IS the browser-facing
 * `dsh-reference` settings namespace (entry ids are namespace ids; the old
 * `settings.register` API is gone), served by the settings service while the
 * profile composes this plugin. The host half reads the table from its own
 * live Config reference (`config.table.get()`) and mounts a dynamic
 * `systemPrompt` section (`dsh-reference:rules`, order 10400, after the
 * persona suffix) that re-reads the table at every assembly: every auto-include
 * entry is advertised with its resolved materialized path (git:
 * `<cacheDir>/<alias>`) plus its description when present, in an
 * `<available_references>` block so the agent knows when to consult the
 * material. autoInclude defaults true; setting it false keeps the entry in
 * the @-menu (manual mount works) but out of the advertisement — the agent
 * is not told (semantic inversion of the legacy `hidden`, which the schema
 * tolerates on read and the pure-core normalize migrates). Git entries are
 * materialized in the background at apply AND after every settings-table
 * mutation (the `loader/volatile-update` event re-runs materialization, so a
 * git entry saved through the settings page clones without a reload; re-runs
 * are idempotent by the missing-only semantics — no debounce): clone/fetch per
 * the refresh policy; failures only log — never blocking apply. missing-only
 * leaves an existing checkout untouched (no network), a branch change
 * re-clones, always fetches + hard-resets. A webServer RPC channel
 * (`/dsh-reference`, endpoint `exists`) answers the browser's path-existence
 * probe for the settings page's non-blocking ⚠ warning. The UI lives in the
 * client half (src/plugins/reference/client).
 */
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'
import { serveRpcChannel } from '../../shared/rpc-channel.ts'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { pickDirectoryOnHost } from './directory-picker.ts'

// The `loader/volatile-update` event is declared by the official vendor loader
// (vendor/loader/src/index.ts EventMap) which dsh-me does not depend on at
// type level; re-declare it so the settings-write watcher typechecks.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}
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
  resolveReferencePath,
  type LoggerLike,
  type ReferenceTable,
  type RefreshMode,
} from './pure.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-reference'

/** Required services: the settings registry (page policy) and the system-prompt registry. */
export const inject = ['settings', 'systemPrompt']

/**
 * Plugin config: the git cache root, the global git refresh policy, and the
 * reference table. The table is a VOLATILE dict field of this plugin's own
 * Config schema: in the 0.1.7-rc.2 settings model every profile entry's
 * Config form IS its settings namespace (entry id `dsh-reference`), so the
 * settings service serves the table to the browser with no separate
 * registration (the old `settings.register` API is gone).
 */
export interface Config {
  /** Git cache root (default: `~/.cache/dsh-me/references`). */
  cacheDir?: string
  /**
   * Global git refresh policy (default `'missing-only'`): `'always'` fetches +
   * hard-resets every load; `'missing-only'` clones only when the cache dir is
   * absent and leaves existing checkouts untouched. Per-entry `refresh` wins.
   */
  refresh?: RefreshMode
  /** The reference table: map(alias → entry). Live-editable; read via {@link Volatile.get}. */
  table: Volatile<ReferenceTable>
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
  autoInclude: z.boolean(),
})

const tableShape = z.dict(entryShape)

/**
 * Validate one reference table: alias syntax, entry shape, and path
 * semantics. Shared by the exported {@link Schema} and the live Config
 * `table` field so the settings write path (volatile mutation) and the
 * profile assembly path enforce the SAME rules — a hand-edited cordis.yml or
 * a settings-page save cannot land an invalid alias/path silently.
 */
function validateReferenceTable(table: Record<string, unknown>): Record<string, unknown> {
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
}

/** The settings-namespace schema: map(alias → local | git entry). */
export const Schema = z
  .transform(tableShape, validateReferenceTable)
  .default({})

/**
 * The plugin Config schema: cacheDir (optional; home-resolved by the pure core) + global refresh, and the volatile reference table (served as the `dsh-reference` settings namespace).
 *
 * NOTE: the table must stay a PLAIN `z.dict(...).volatile()` — the official
 * settings service projects the editable form via `volatileForm` →
 * `plainSchema` → `schema.toJSON()`, and a `transform` wrapper serializes as
 * `{type:'transform'}` which the client configForms renderer cannot project
 * (the settings page hangs on Loading…). Semantic validation therefore lives
 * OUTSIDE the schema: `validateReferenceTable` runs at apply (fail loud) and
 * on every `loader/volatile-update` (warn), not in a schema transform.
 */
export const Config = z.object({
  cacheDir: z.string(),
  refresh: refreshModeShape.default('missing-only'),
  table: z.dict(entryShape).default({}).volatile(),
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

/** Structural settings-service face: presentation policy only (auto page opt-out). */
interface SettingsLike {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void
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
 * Serve the reference table as this entry's settings namespace (0.1.7-rc.2:
 * namespaces ARE plugin entries' own Config forms — the volatile `table` field
 * above, no `settings.register`), kick off git materialization in the
 * background, and mount the dynamic advertisement section. The settings service
 * serves the entry's form for as long as the plugin is composed — nothing to
 * register or unregister here. Materialization runs at apply (plugin load /
 * cordis HMR config reload) AND after every volatile-config update
 * (`loader/volatile-update` fires on settings saves, so a git entry saved
 * through the settings page materializes without a reload): clone/fetch/refresh
 * failures only log — apply never waits on the network, and the prompt points
 * at the target cache path meanwhile. Re-runs are idempotent by the
 * missing-only semantics (an existing checkout touches no network), so no
 * debounce is needed. The section re-reads the table at every assembly, so a
 * settings-save lands in the next turn's prompt without a restart.
 * @param ctx - host plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Assembly-time validation (fail loud — the pre-transform schema behavior):
  // an invalid alias/path in the profile config must surface at load, not
  // silently degrade. The settings write path is guarded separately on every
  // `loader/volatile-update` (warn).
  validateReferenceTable(config.table.get() as Record<string, unknown>)
  const scoped = ctx as unknown as ReferenceCtx
  const home = homedir()
  // We ship our own settings page for this namespace; suppress the generic
  // auto-generated form so the shell shows only our custom section. (The
  // plugin's own inject already gated apply on the settings service.)
  ctx.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber))
  let cacheDir = resolveCacheDir(config.cacheDir, home)
  if (cacheDir === undefined) {
    scoped.logger.warn(`dsh-reference: cacheDir「${config.cacheDir}」不是绝对路径或 ~/ 开头；使用默认 ${defaultCacheDir(home)}`)
    cacheDir = defaultCacheDir(home)
  }

  /** Materialize every git entry of the current table in the background. */
  const materializeAll = (): void => {
    // Clone/refresh failures only log; nothing here throws into the watcher.
    for (const spec of gitSpecsOf(normalizeTable(config.table.get()), home, cacheDir, config.refresh)) {
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

  // Materialize at apply (the entry config already holds the table on load).
  materializeAll()

  // Re-materialize after every settings save: the entry's volatile `table`
  // field updates without a plugin remount and the loader emits
  // `loader/volatile-update`, so a git entry saved through the settings page
  // clones without a reload (spec US-1/US-5 — the table is runtime data; a
  // config HMR would never fire).
  ctx.on('loader/volatile-update', () => {
    // Runtime guard for the settings write path: validate the mutated table
    // with the same rules the schema transform enforces at assembly, so an
    // entry saved through the settings page cannot land an invalid
    // alias/path silently (surface validation warn; the write itself is
    // owned by the settings service).
    try {
      validateReferenceTable(config.table.get() as Record<string, unknown>)
    } catch (error) {
      scoped.logger.warn(`dsh-reference: settings table invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    materializeAll()
  })

  // Read fresh at every assembly: settings edits (the entry config or the web
  // settings page) land in the next turn's advertisement.
  ctx.effect(() => scoped.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // Model-facing instruction text, not a prompt-variable template —
    // preserve literal text like a {@link PromptSection} contributor must.
    interpolate: false,
    text: () => buildAdvertisementText(normalizeTable(config.table.get()), home, cacheDir),
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
        void serveRpcChannel(req, res, { channel: CHANNEL, logLabel: 'dsh-reference: /dsh-reference channel' }, (endpoint, payload) => {
          if (endpoint === ENDPOINT_EXISTS) {
            const value = (payload ?? {}) as { path?: unknown }
            if (typeof value.path !== 'string') {
              return Promise.resolve({ ok: false as const, error: { code: 'internal', message: 'path must be a string', details: {} } })
            }
            return serveExists(value.path, home)
          }
          if (endpoint === ENDPOINT_CONFIG) {
            const value: ConfigResponse = { cacheDir, refresh: config.refresh ?? 'missing-only' }
            return Promise.resolve({ ok: true as const, value })
          }
          if (endpoint === ENDPOINT_PICK_DIRECTORY) {
            return servePickDirectory(home)
          }
          return Promise.resolve({
            ok: false as const,
            error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
          })
        })
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

/** Answer {@link ENDPOINT_EXISTS} with the path's existence. */
async function serveExists(path: string, home: string): Promise<RpcResult<unknown>> {
  // Stat the resolved absolute path; every stat failure (missing, permission,
  // race) answers false — the settings page treats it as a non-blocking ⚠.
  const resolved = resolveReferencePath(path, home)
  try {
    await stat(resolved)
    return { ok: true, value: { exists: true } }
  } catch {
    return { ok: true, value: { exists: false } }
  }
}

/** Answer {@link ENDPOINT_PICK_DIRECTORY} with the native folder dialog. */
async function servePickDirectory(home: string): Promise<RpcResult<unknown>> {
  try {
    return { ok: true, value: await pickDirectoryOnHost(home) }
  } catch (error) {
    // Every picker failed to spawn (missing binary); the client drops the
    // button press silently and keeps the manual input path.
    return { ok: false, error: { code: 'internal', message: `directory picker failed: ${String(error)}`, details: {} } }
  }
}