/**
 * dsh-reference pure decision core: alias/path validation, settings-table
 * normalization (hidden defaults to false), advertisement-section text
 * assembly, @-menu candidate filtering, and mention serialization. Zero I/O —
 * home is injected, so vitest covers every branch without host fixtures.
 */

/** One normalized reference entry. */
export interface ReferenceEntry {
  readonly path: string
  readonly description?: string
  readonly hidden: boolean
}

/** The normalized alias → entry table (the settings namespace value shape). */
export type ReferenceTable = Readonly<Record<string, ReferenceEntry>>

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

/**
 * Normalize a raw settings-table value: hidden defaults to false, an
 * empty/absent description becomes undefined, and non-object entries or
 * entries without a string path are dropped defensively (the schema layer
 * rejects those shapes at write time; this keeps downstream readers total).
 * @param raw - the raw table value (schema-validated on the write path).
 * @returns the normalized table.
 */
export function normalizeTable(raw: unknown): ReferenceTable {
  const table: Record<string, ReferenceEntry> = {}
  if (raw === null || typeof raw !== 'object') return table
  for (const [alias, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') continue
    const shape = entry as { path?: unknown; description?: unknown; hidden?: unknown }
    if (typeof shape.path !== 'string') continue
    const description = typeof shape.description === 'string' && shape.description !== '' ? shape.description : undefined
    table[alias] = { path: shape.path, ...(description === undefined ? {} : { description }), hidden: shape.hidden === true }
  }
  return table
}

/**
 * Assemble the advertisement-section text: every entry with a description
 * (hidden entries included — hidden only governs @-menu visibility, aligning
 * with OC semantics), one line per entry in alias order, with the resolved
 * absolute path. Entries without a description never appear; an empty result
 * is an empty string so the renderer drops the section.
 * @param table - the normalized reference table.
 * @param home - the user's home directory (`~/` expansion).
 * @returns the section text, or '' when nothing is advertised.
 */
export function buildAdvertisementText(table: ReferenceTable, home: string): string {
  const lines = Object.entries(table)
    .filter(([, entry]) => entry.description !== undefined)
    .sort(([a], [b]) => compareAliases(a, b))
    .map(([alias, entry]) => `- ${alias}: ${resolveReferencePath(entry.path, home)} — ${entry.description}`)
  if (lines.length === 0) return ''
  return `Available external references:\n${lines.join('\n')}`
}

/** One @-menu candidate: a visible reference with its resolved path. */
export interface ReferenceCandidate {
  readonly alias: string
  readonly path: string
  readonly description?: string
}

/**
 * Filter and resolve the @-menu candidates: hidden entries are dropped, the
 * rest resolve their absolute path and sort by alias (spec US-8/US-9).
 * @param table - the normalized reference table.
 * @param home - the user's home directory (`~/` expansion).
 * @returns the visible candidates in alias order.
 */
export function candidateEntries(table: ReferenceTable, home: string): ReferenceCandidate[] {
  return Object.entries(table)
    .filter(([, entry]) => !entry.hidden)
    .sort(([a], [b]) => compareAliases(a, b))
    .map(([alias, entry]) => ({
      alias,
      path: resolveReferencePath(entry.path, home),
      ...(entry.description === undefined ? {} : { description: entry.description }),
    }))
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
  return a < b ? -1 : a > b ? 1 : 0
}