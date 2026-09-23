/**
 * dsh-memory pure decision core: compaction-section filtering, memory-block
 * assembly with a char budget, supersession detection, and cwd-hash workspace
 * keying. Zero I/O and zero sqlite — store rows are plain values here, so
 * vitest covers every branch without a database.
 */
import { createHash } from 'node:crypto'

/** Persistent compaction sections kept at render time (spec decision: whitelist). */
export const PERSISTENT_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code',
  'Errors and Fixes',
  'Critical Context',
] as const

/** Volatile compaction sections dropped at render time (dead-session transient state). */
export const VOLATILE_SECTIONS = ['Pending Jobs', 'Current Work', 'Next Step'] as const

/** One row as the renderer and the supersession matcher see it (mirrors the store's active rows). */
export interface MemoryBlockRow {
  readonly id: number
  /** cwd hash; NULL for global-scope manual rows. */
  readonly workspace: string | null
  /** Owning session; set for session-scoped notes and compaction sources. */
  readonly session_id: string | null
  readonly kind: 'manual' | 'compaction'
  readonly content: string
  readonly created_at: number
}

/** The frame tags dsh's compaction checkpoint wraps its summary in (see `frameSummary` in compaction-basic). */
export const CHECKPOINT_OPEN_TAG = '<compacted-summary>'
export const CHECKPOINT_CLOSE_TAG = '</compacted-summary>'

/**
 * Extract the inner summary text from one framed checkpoint message body
 * (joined text of its content blocks). Everything up to and including the
 * `<compacted-summary>` opener (the preamble) and everything from the
 * `</compacted-summary>` closer onward is dropped. When either tag is missing
 * or the closer precedes the opener, the raw text passes through unchanged —
 * never lose data.
 * @param content - the checkpoint message's joined text.
 * @returns the inner summary text, trimmed.
 */
export function extractCheckpointSummary(content: string): string {
  const openIndex = content.indexOf(CHECKPOINT_OPEN_TAG)
  const closeIndex = content.lastIndexOf(CHECKPOINT_CLOSE_TAG)
  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) return content
  return content.slice(openIndex + CHECKPOINT_OPEN_TAG.length, closeIndex).trim()
}

/** Manual-scope vocabulary, derived from the row's workspace/session columns. */
export type ManualScope = 'global' | 'workspace' | 'session'

/** Derive the scope of one manual row from its columns (spec: global = NULL workspace). */
export function scopeOfRow(row: MemoryBlockRow): ManualScope {
  if (row.workspace === null) return 'global'
  if (row.session_id !== null) return 'session'
  return 'workspace'
}

const HEADING_RE = /^##\s+(.+)$/

/** One `## `-split fragment: the heading line plus its body, or an unnamed preamble. */
interface SummarySection {
  readonly heading: string | undefined
  readonly lines: string[]
}

/** Split raw summary text on `## ` headings; text before the first heading becomes an unnamed preamble section. */
function splitSummarySections(raw: string): SummarySection[] {
  const sections: SummarySection[] = []
  let current: SummarySection | undefined
  for (const line of raw.split('\n')) {
    const match = HEADING_RE.exec(line)
    if (match !== null) {
      current = { heading: match[1].trim(), lines: [line] }
      sections.push(current)
      continue
    }
    if (current === undefined) {
      current = { heading: undefined, lines: [] }
      sections.push(current)
    }
    current.lines.push(line)
  }
  return sections
}

const isVolatile = (heading: string): boolean => (VOLATILE_SECTIONS as readonly string[]).includes(heading)
const isPersistent = (heading: string): boolean => (PERSISTENT_SECTIONS as readonly string[]).includes(heading)

/**
 * Reduce one compaction summary to its persistent sections: whitelist sections
 * keep (empty `(none)` bodies dropped), volatile sections drop, unknown
 * headings keep (never lose data). When no known heading parses, the whole
 * raw text passes through unchanged — custom summarizer output is injected
 * verbatim. Filtering happens only at render time; the store keeps the full
 * text.
 * @param raw - one compaction summary's full text.
 * @returns the filtered text.
 */
export function filterSummarySections(raw: string): string {
  const sections = splitSummarySections(raw)
  const known = sections.some(section => section.heading !== undefined
    && (isVolatile(section.heading) || isPersistent(section.heading)))
  if (!known) return raw
  return sections
    .filter(section => {
      if (section.heading === undefined) return true // preamble: unknown → keep
      if (isVolatile(section.heading)) return false
      const body = section.lines.slice(1).join('\n').trim()
      return body !== '' && body !== '(none)'
    })
    .map(section => section.lines.join('\n'))
    .join('\n')
    .trim()
}

/** Manual scope rank for the injection order: global → workspace → session. */
const MANUAL_RANK: Record<ManualScope, number> = { global: 0, workspace: 1, session: 2 }

/** Injection order (spec): global manual → workspace manual → session notes → checkpoints, newest first within each tier. */
function orderRows(rows: readonly MemoryBlockRow[]): MemoryBlockRow[] {
  return [...rows].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'manual' ? -1 : 1
    if (a.kind === 'manual') {
      const rankA = MANUAL_RANK[scopeOfRow(a)]
      const rankB = MANUAL_RANK[scopeOfRow(b)]
      if (rankA !== rankB) return rankA - rankB
    }
    return b.created_at - a.created_at
  })
}

/** The checkpoint date attribute: the created-at timestamp's UTC calendar day. */
function dateOf(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10)
}

/** Render one row as a `<note>` or `<checkpoint>` element (spec format). */
function renderRow(row: MemoryBlockRow): string {
  if (row.kind === 'manual') {
    return `<note id="${row.id}" scope="${scopeOfRow(row)}">${row.content}</note>`
  }
  return `<checkpoint id="${row.id}" session="${row.session_id ?? ''}" date="${dateOf(row.created_at)}">\n`
    + filterSummarySections(row.content)
    + '\n</checkpoint>'
}

/** The fixed block header and guidance line (spec format). */
const BLOCK_HEADER = '## Project Memory\n'
  + 'Knowledge from previous sessions. May be stale; correct via memory_write.\n\n'
  + '<project-memory>\n'
const BLOCK_FOOTER = '</project-memory>'

/**
 * Assemble the injected memory block: ordered rows under the fixed header,
 * trimmed from the tail until the char budget fits (the newest checkpoints
 * survive first; manual notes are never trimmed before older content). When
 * the budget forces drops, the omitted count is appended after the wrapper.
 * When even the smallest prefix outgrows the budget, zero rows render with an
 * omitted count covering all rows — the cap is hard (spec US-5).
 * @param rows - active store rows (any order; ordering happens here).
 * @param options - the char budget.
 * @returns the rendered block, or '' for an empty store.
 */
export function assembleMemoryBlock(rows: readonly MemoryBlockRow[], options: { maxChars: number }): string {
  if (rows.length === 0) return ''
  const pieces = orderRows(rows).map(renderRow)
  const render = (count: number): string => {
    const kept = pieces.slice(0, count)
    const omitted = pieces.length - count
    const text = `${BLOCK_HEADER}${kept.join('\n')}${kept.length > 0 ? '\n' : ''}${BLOCK_FOOTER}`
    return omitted > 0 ? `${text}\n(${omitted} older memories omitted)` : text
  }
  let best = 0
  for (let count = pieces.length; count >= 1; count -= 1) {
    if (render(count).length <= options.maxChars) {
      best = count
      break
    }
  }
  return render(best)
}

/** Supersession matcher input: any row slice carrying the identity columns. */
export interface SupersessionCandidate {
  readonly id: number
  readonly kind?: string
  readonly source_event_seq?: number | null
  readonly superseded_by?: number | null
}

/**
 * Which active compaction rows a new summary supersedes: rows whose own
 * `source_event_seq` appears in the new summary's shadowed seqs (spec —
 * chained compactions merge the older checkpoint, so only the newest stays
 * injected).
 * @param newShadowedSeqs - the new summary's shadowed event seqs.
 * @param existingRows - stored rows of the same workspace.
 * @returns the row ids to mark superseded.
 */
export function detectSupersession(newShadowedSeqs: readonly number[], existingRows: readonly SupersessionCandidate[]): number[] {
  const shadowed = new Set(newShadowedSeqs)
  return existingRows
    .filter(row => row.kind === 'compaction'
      && row.superseded_by == null
      && row.source_event_seq != null
      && shadowed.has(row.source_event_seq))
    .map(row => row.id)
}

/**
 * Workspace key for one session cwd: the first 16 hex digits of its SHA-1
 * (spec). Stable across sessions sharing the cwd; collisions are improbable
 * and only ever merge two workspaces' memories.
 * @param cwd - the session header cwd.
 * @returns the workspace key.
 */
export function cwdToWorkspaceKey(cwd: string): string {
  return createHash('sha1').update(cwd, 'utf8').digest('hex').slice(0, 16)
}