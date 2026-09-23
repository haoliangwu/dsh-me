/**
 * dsh-reference pure decision core: alias/path validation, settings-table
 * normalization (autoInclude defaults to true; the legacy `hidden` field
 * migrates — `hidden: true` → `autoInclude: false`, anything else → true; git
 * entries keep repository + branch + refresh), advertisement-section text
 * assembly, @-menu candidate listing, mention serialization, and the git
 * materialization command sequence. Zero I/O and zero Node builtins —
 * home/cacheDir are injected and every path op is plain string handling
 * (POSIX joins), so the browser bundle can import every symbol without a Node
 * polyfill (the client sandbox has no node:path).
 */

/** Git refresh policy: `always` fetches + hard-resets; `missing-only` (default) clones only when the cache dir is absent. */
export type RefreshMode = 'always' | 'missing-only'

/** One normalized reference entry: local (`path`) XOR git (`repository` + optional `branch`/`refresh`). */
export interface ReferenceEntry {
  /** Local form: absolute path or `~/`-prefixed raw path (mutually exclusive with repository). */
  readonly path?: string
  /** Git form: remote repository URL (mutually exclusive with path); `file://` rejected. */
  readonly repository?: string
  /** Git form: optional branch pin; a mid-life change re-materializes the checkout. */
  readonly branch?: string
  /** Git form: per-entry refresh override; falls back to the global Config value. */
  readonly refresh?: RefreshMode
  readonly description?: string
  /** Auto-include in the system-prompt advertisement (default true). Off = manual @ only — the agent is not told. */
  readonly autoInclude: boolean
}

/** The normalized alias → entry table (the settings namespace value shape). */
export type ReferenceTable = Readonly<Record<string, ReferenceEntry>>

/** One git entry flattened with its deterministic cache path. */
export interface GitSpec {
  readonly name: string
  readonly repository: string
  readonly branch?: string
  readonly path: string
  /** Resolved policy: per-entry override or the global Config value. */
  readonly refresh: RefreshMode
}

/** The logger surface materialization needs (host ctx.logger). */
export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
}

/**
 * Minimal file-system surface materializeGit needs (stub-able in tests).
 * `exec` resolves with the command's stdout; `readFile` returns `undefined`
 * for a missing file and throws on real read errors (branch detection).
 */
export interface GitDeps {
  exec: (args: readonly string[], options: { readonly cwd: string }) => Promise<string>
  exists: (path: string) => boolean
  mkdir: (path: string) => void
  rm: (path: string) => void
  readFile: (path: string) => string | undefined
  writeFile: (path: string, content: string) => void
}

/**
 * Marker file inside each branch-pinned checkout recording the branch it was
 * cloned with, so `missing-only` can detect a mid-life config branch change
 * without touching the network (per-entry file: no cross-entry races, no
 * read-modify-write). Absent/undetectable marker = assume a match.
 */
const BRANCH_MARKER = '.refs-branch'

/** Default git cache root (relative to home): `~/.cache/dsh-me/references`. */
const DEFAULT_CACHE_RELATIVE = '.cache/dsh-me/references'

/**
 * POSIX path join (the node:path subset this core needs): parts are joined
 * with '/', an empty part is skipped, and a part that ends in '/' is trimmed
 * first — no Node builtin, so the sandboxed browser bundle can run it.
 * @param parts - path segments (absolute prefixes keep their leading '/').
 * @returns the joined path.
 */
export function joinPath(...parts: readonly string[]): string {
  let out = ''
  for (const part of parts) {
    if (part === '') continue
    out = out === '' ? part : `${out.replace(/\/+$/, '')}/${part.replace(/^\//, '')}`
  }
  return out
}

/**
 * The parent directory of a path (the dirname subset needed for `<cacheDir>/<alias>`
 * targets): everything before the last '/', '/' for a bare root. Pure string
 * handling — no Node builtin.
 * @param path - the absolute target path.
 * @returns the parent directory.
 */
export function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/')
  if (index <= 0) return '/'
  return path.slice(0, index)
}

/**
 * Validate an alias against the naming rule (spec US-5): non-empty, no `/`,
 * `\`, whitespace, backtick, or comma. Returns the reason for rejection, or
 * undefined when the alias is legal.
 * @param alias - the alias to validate.
 * @returns the reason fragment, or undefined for a legal alias.
 */
export function aliasValidationError(alias: string): string | undefined {
  if (alias === '') return '不能为空'
  // eslint-disable-next-line no-control-regex
  if (/[/\\\s`,]/.test(alias)) return '不能包含 /、\\、空白、反引号或逗号'
  return undefined
}

/**
 * Validate an entry path against the resolution rule (spec US-6): it must be
 * an absolute path or start with `~/` — anything else is ambiguous. Returns
 * the reason for rejection, or undefined for a legal path.
 * @param path - the raw path to validate.
 * @returns the reason fragment, or undefined for a legal path.
 */
export function referencePathError(path: string): string | undefined {
  if (path.startsWith('/') || path.startsWith('~/')) return undefined
  return '必须用绝对路径或 ~/ 开头'
}

/** Whether a repository string is a `file://`/`file:` local-repo URI (OC excludes these). */
export function isFileRepository(repository: string): boolean {
  return repository.startsWith('file://') || repository.startsWith('file:')
}

/**
 * Validate a git branch pin against check-ref-format's spirit (a subset the
 * clone would reject): no empty value, no whitespace or the punctuation git
 * forbids in refs, no `..`, no leading/trailing or doubled slash. Returns the
 * reason for rejection, or undefined for a legal branch. Only called when a
 * branch is present — an absent branch is always legal (default branch).
 * @param branch - the branch pin as typed.
 * @returns the reason fragment, or undefined for a legal branch.
 */
export function branchValidationError(branch: string): string | undefined {
  if (branch === '') return '不能为空'
  if (branch.includes('..')) return '不能包含 ..'
  if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('//')) return '不能以 / 开头或结尾，或包含 //'
  if (/[\\\s~^:?*\[\]]/.test(branch)) return '不能包含空白或 git 禁用的字符（\\ ~ ^ : ? * [）'
  return undefined
}

/**
 * Validate an entry against the XOR shape rule (spec v2 ID-1): exactly one of
 * `path` (local) or `repository` (git) — both or neither are rejected — and a
 * git entry must reject an empty or `file://`/`file:` repository (OC parity),
 * keep branch a string within the git ref rules when present, and keep refresh
 * within the const-union. Returns the reason for rejection, or undefined for a
 * legal entry. Shared by the schema transform and the save layer (one source
 * of truth with {@link aliasValidationError}).
 * @param entry - the raw entry value (typed fields enforced by the schema).
 * @returns the reason fragment, or undefined for a legal entry.
 */
export function entryShapeError(entry: { readonly path?: unknown; readonly repository?: unknown; readonly branch?: unknown; readonly refresh?: unknown }): string | undefined {
  const hasPath = typeof entry.path === 'string'
  const hasRepository = typeof entry.repository === 'string'
  if (hasPath === hasRepository) {
    return '必须二选一：{ path }（本地目录）或 { repository, branch? }（Git 仓库）；两种形态混用或缺失均不允许'
  }
  if (hasRepository) {
    const repository = entry.repository as string
    if (repository === '') {
      return 'repository 不能为空'
    }
    if (isFileRepository(repository)) {
      return 'repository 不支持 file:// 本地仓库（与 OC 对齐）'
    }
    if (entry.branch !== undefined && typeof entry.branch !== 'string') {
      return 'branch 必须是字符串'
    }
    if (typeof entry.branch === 'string' && entry.branch !== '') {
      const branchError = branchValidationError(entry.branch)
      if (branchError !== undefined) return branchError
    }
    if (entry.refresh !== undefined && entry.refresh !== 'always' && entry.refresh !== 'missing-only') {
      return 'refresh 必须是 always 或 missing-only'
    }
  }
  return undefined
}

/**
 * Resolve an entry path to its absolute form: `~/` expands to home, absolute
 * paths pass through unchanged (the call layer rejects relative input before
 * this ever runs).
 * @param path - the raw path.
 * @param home - the user's home directory.
 * @returns the resolved absolute path.
 */
export function resolveReferencePath(path: string, home: string): string {
  return path.startsWith('~/') ? `${home}/${path.slice(2)}` : path
}

/** The deterministic default git cache root: `~/.cache/dsh-me/references`. */
export function defaultCacheDir(home: string): string {
  return joinPath(home, DEFAULT_CACHE_RELATIVE)
}

/**
 * Resolve the configured cache dir: `~/` expands to home, absolute paths pass
 * through, and a missing value falls back to the deterministic default.
 * Anything else (a relative path — the plugin process cwd is unstable)
 * resolves to undefined so the caller falls back and logs.
 * @param raw - the Config cacheDir value, or undefined for the default.
 * @param home - the user's home directory (`~/` expansion).
 * @returns the resolved cache root, or undefined for an invalid raw value.
 */
export function resolveCacheDir(raw: string | undefined, home: string): string | undefined {
  if (raw === undefined) return defaultCacheDir(home)
  if (raw.startsWith('~/')) return joinPath(home, raw.slice(2))
  if (raw.startsWith('/')) return raw
  return undefined
}

/**
 * Resolve one entry's materialized path: local entries expand `~/`/pass
 * absolute paths through; git entries resolve to their deterministic cache
 * path `<cacheDir>/<alias>`, where the clone lands and the prompt/@-menu point.
 * @param alias - the entry's table key (the git cache subdirectory name).
 * @param entry - the normalized entry.
 * @param home - the user's home directory (`~/` expansion).
 * @param cacheDir - the resolved git cache root.
 * @returns the absolute path the agent should read.
 */
export function resolveEntryPath(alias: string, entry: ReferenceEntry, home: string, cacheDir: string): string {
  if (entry.path !== undefined) return resolveReferencePath(entry.path, home)
  return joinPath(cacheDir, alias)
}

/**
 * Normalize a raw settings-table value: autoInclude defaults to true (the
 * legacy `hidden` field migrates — `hidden: true` → `autoInclude: false`,
 * since an old hidden user explicitly opted out of auto-inclusion; `hidden:
 * false`/absent → `autoInclude: true`; an explicit autoInclude always wins),
 * an empty/absent description becomes undefined, git entries keep repository +
 * optional branch/refresh, and non-object entries or entries matching neither
 * legal form (or a `file://` repository) are dropped defensively (the schema
 * layer rejects those shapes at write time; this keeps downstream readers
 * total).
 * @param raw - the raw table value (schema-validated on the write path).
 * @returns the normalized table.
 */
export function normalizeTable(raw: unknown): ReferenceTable {
  const table: Record<string, ReferenceEntry> = {}
  if (raw === null || typeof raw !== 'object') return table
  for (const [alias, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') continue
    const shape = entry as {
      path?: unknown
      repository?: unknown
      branch?: unknown
      refresh?: unknown
      description?: unknown
      autoInclude?: unknown
      hidden?: unknown
    }
    const description = typeof shape.description === 'string' && shape.description !== '' ? shape.description : undefined
    // Legacy `hidden` migrates: old hidden:true users explicitly did NOT want
    // automatic agent disclosure, so it flips to autoInclude:false. Everything
    // else defaults to true (auto-include on). An explicit autoInclude beats
    // the legacy field when both exist.
    const autoInclude = typeof shape.autoInclude === 'boolean' ? shape.autoInclude : shape.hidden !== true
    if (typeof shape.path === 'string') {
      table[alias] = { path: shape.path, ...(description === undefined ? {} : { description }), autoInclude }
    } else if (typeof shape.repository === 'string' && shape.repository !== '' && !isFileRepository(shape.repository)) {
      table[alias] = {
        repository: shape.repository,
        ...(typeof shape.branch === 'string' && shape.branch !== '' ? { branch: shape.branch } : {}),
        ...(shape.refresh === 'always' ? { refresh: 'always' as const } : {}),
        ...(description === undefined ? {} : { description }),
        autoInclude,
      }
    }
  }
  return table
}

/**
 * Assemble the advertisement-section text in the `<available_references>` XML
 * shape (the archived legacy plugin's verified format): every auto-include
 * entry (autoInclude: false entries stay manual-@-only — the agent is not
 * told about them), one `<reference>` per entry in alias order, with the
 * resolved materialized path (git: `<cacheDir>/<alias>`). A missing
 * description simply omits the `<description>` element; only a fully empty
 * table — or one whose every entry is autoInclude: false — yields '' so the
 * renderer drops the section.
 * @param table - the normalized reference table.
 * @param home - the user's home directory (`~/` expansion).
 * @param cacheDir - the git cache root (default: `~/.cache/dsh-me/references`).
 * @returns the section text, or '' for an empty table.
 */
export function buildAdvertisementText(table: ReferenceTable, home: string, cacheDir: string = defaultCacheDir(home)): string {
  const entries = Object.entries(table)
    .filter(([, entry]) => entry.autoInclude !== false)
    .sort(([a], [b]) => compareAliases(a, b))
  if (entries.length === 0) return ''
  const lines = [
    'Project references provide additional directories that can be accessed when relevant.',
    '<available_references>',
  ]
  for (const [alias, entry] of entries) {
    lines.push('  <reference>', `    <name>${alias}</name>`, `    <path>${resolveEntryPath(alias, entry, home, cacheDir)}</path>`)
    if (entry.description !== undefined) lines.push(`    <description>${entry.description}</description>`)
    lines.push('  </reference>')
  }
  lines.push('</available_references>')
  return lines.join('\n')
}

/** One @-menu candidate: a reference entry with its resolved path. */
export interface ReferenceCandidate {
  readonly alias: string
  readonly path: string
  readonly description?: string
}

/**
 * List and resolve the @-menu candidates: every entry qualifies (@ 提及总是
 * 可用 — autoInclude only gates the system-prompt advertisement, never the
 * menu), each resolves its materialized path (git: `<cacheDir>/<alias>`) and
 * the list sorts by alias (spec US-8/US-9).
 * @param table - the normalized reference table.
 * @param home - the user's home directory (`~/` expansion).
 * @param cacheDir - the git cache root (default: `~/.cache/dsh-me/references`).
 * @returns the candidates in alias order.
 */
export function candidateEntries(table: ReferenceTable, home: string, cacheDir: string = defaultCacheDir(home)): ReferenceCandidate[] {
  return Object.entries(table)
    .sort(([a], [b]) => compareAliases(a, b))
    .map(([alias, entry]) => ({
      alias,
      path: resolveEntryPath(alias, entry, home, cacheDir),
      ...(entry.description === undefined ? {} : { description: entry.description }),
    }))
}

/**
 * Flatten the git entries of a normalized table into materialization specs:
 * deterministic `<cacheDir>/<alias>` paths, per-entry refresh override or the
 * global Config default. Local entries never produce a spec.
 * @param table - the normalized reference table.
 * @param home - the user's home directory (`~/` expansion).
 * @param cacheDir - the resolved git cache root.
 * @param defaultRefresh - the global Config refresh policy (default `missing-only`).
 * @returns the git specs to materialize, in table order.
 */
export function gitSpecsOf(
  table: ReferenceTable,
  home: string,
  cacheDir: string,
  defaultRefresh: RefreshMode = 'missing-only',
): GitSpec[] {
  const specs: GitSpec[] = []
  for (const [alias, entry] of Object.entries(table)) {
    if (entry.repository === undefined) continue
    specs.push({
      name: alias,
      repository: entry.repository,
      ...(entry.branch === undefined ? {} : { branch: entry.branch }),
      path: resolveEntryPath(alias, entry, home, cacheDir),
      refresh: entry.refresh ?? defaultRefresh,
    })
  }
  return specs
}

/**
 * Materialize one git entry without blocking the caller. Missing target →
 * clone (depth 1, optional branch) into `spec.path`. With `refresh: 'always'`
 * an existing checkout is fetched + hard-reset to `origin/<branch||HEAD>`;
 * with `missing-only` (default) an existing checkout is left untouched — no
 * network — unless its recorded branch marker no longer matches the
 * configured branch (a mid-life config change), which counts as missing: the
 * checkout is deleted and re-cloned. Failures are logged, never thrown — the
 * prompt keeps pointing at the target path meanwhile (oc behavior).
 * @param spec - the flattened git spec.
 * @param deps - the injected fs/exec surface.
 * @param logger - the host logger.
 */
export async function materializeGit(spec: GitSpec, deps: GitDeps, logger: LoggerLike): Promise<void> {
  try {
    if (deps.exists(spec.path)) {
      if (spec.refresh === 'always') {
        await deps.exec(['fetch', 'origin'], { cwd: spec.path })
        await deps.exec(['reset', '--hard', `origin/${spec.branch ?? 'HEAD'}`], { cwd: spec.path })
        logger.info(`dsh-reference: git ${spec.name} refreshed at ${spec.path}`)
        return
      }
      // missing-only: no network unless the config branch changed mid-life.
      if (spec.branch !== undefined) {
        const stored = storedBranch(deps, spec.path, logger, spec.name)
        if (stored !== undefined && stored !== spec.branch) {
          logger.info(`dsh-reference: git ${spec.name} branch mismatch (${stored} != ${spec.branch}); re-cloning`)
          deps.rm(spec.path)
          await cloneInto(spec, deps, logger)
          return
        }
      }
      // Matching (or undetectable) checkout: leave it alone.
      return
    }
    await cloneInto(spec, deps, logger)
  } catch (error) {
    logger.warn(`dsh-reference: git ${spec.name} materialization failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The branch a branch-pinned checkout was cloned with, from its marker file.
 * Returns `undefined` when the marker is absent or unreadable — unreadable
 * markers are logged and treated as a match (no re-clone).
 */
function storedBranch(deps: GitDeps, path: string, logger: LoggerLike, name: string): string | undefined {
  try {
    const content = deps.readFile(joinPath(path, BRANCH_MARKER))
    if (content === undefined) return undefined
    const branch = content.trim()
    return branch === '' ? undefined : branch
  } catch (error) {
    logger.warn(`dsh-reference: git ${name} branch detection failed: ${error instanceof Error ? error.message : String(error)}; leaving cache untouched`)
    return undefined
  }
}

/** Clone `spec.repository` (depth 1, optional branch) into `spec.path`. */
async function cloneInto(spec: GitSpec, deps: GitDeps, logger: LoggerLike): Promise<void> {
  deps.mkdir(dirnameOf(spec.path))
  const args = ['clone', '--depth', '1']
  if (spec.branch !== undefined) args.push('-b', spec.branch)
  args.push(spec.repository, spec.path)
  await deps.exec(args, { cwd: dirnameOf(spec.path) })
  logger.info(`dsh-reference: git ${spec.name} cloned to ${spec.path}`)
  await recordBranch(spec, deps, logger)
}

/** Non-fatal: record the cloned branch for later `missing-only` checks. */
async function recordBranch(spec: GitSpec, deps: GitDeps, logger: LoggerLike): Promise<void> {
  if (spec.branch === undefined) return
  try {
    deps.writeFile(joinPath(spec.path, BRANCH_MARKER), spec.branch)
  } catch (error) {
    logger.warn(`dsh-reference: git ${spec.name} branch marker write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Serialize a resolved path into the plain-text mention form (spec US-10,
 * file-mention parity): `@<path>`, or the quoted `@"<path>"` when the path
 * contains whitespace.
 * @param path - the resolved absolute path.
 * @returns the mention text.
 */
export function serializeMention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

/** Code-unit alias comparison — locale-independent, stable across machines. */
function compareAliases(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
