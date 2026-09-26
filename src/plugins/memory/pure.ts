/**
 * dsh-memory pure decision core: compaction-section segmentation (harvest
 * splitting), dual-pool memory-block assembly, supersession detection,
 * cwd-hash workspace keying, wire whitespace normalization, and the injected
 * context-message builder. Zero I/O and zero sqlite — store rows are plain
 * values here, so vitest covers every branch without a database.
 */
import { createHash, randomUUID } from 'node:crypto'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Persistent compaction sections kept at harvest time (spec decision: whitelist). */
export const PERSISTENT_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code',
  'Errors and Fixes',
  'Critical Context',
] as const

/** The plugin identity stamped on every persisted memory context row. */
export const MEMORY_PLUGIN = 'dsh-memory'

/**
 * The one-line lead of the injected context message, before the assembled
 * block (the block itself carries the `## Project Memory` header, spec).
 */
export const MEMORY_HEADER_LINE = 'Persisted cross-session memory:'

/** Volatile compaction sections dropped at harvest time (dead-session transient state). */
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
  /** The owning section name for compaction segments; NULL for manual rows and whole-summary fallbacks. */
  readonly heading: string | null
  /** Segment order within its checkpoint group (manual rows are always 0). */
  readonly segment_index: number
  /** Checkpoint event seq — the compaction group key (NULL for manual rows). */
  readonly source_event_seq: number | null
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
const TOP_BULLET_RE = /^- |^\d+\. /

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

/** The harvest-kept sections of one summary plus whether any known heading parsed. */
function keptSections(raw: string): { readonly known: boolean; readonly sections: readonly SummarySection[] } {
  const sections = splitSummarySections(raw)
  const known = sections.some(section => section.heading !== undefined
    && (isVolatile(section.heading) || isPersistent(section.heading)))
  if (!known) return { known, sections }
  return {
    known,
    sections: sections.filter(section => {
      if (section.heading === undefined) return true // preamble: unknown → keep
      if (isVolatile(section.heading)) return false
      const body = section.lines.slice(1).join('\n').trim()
      return body !== '' && body !== '(none)'
    }),
  }
}

/**
 * Reduce one compaction summary to its persistent sections (the harvest
 * filtering step; segmentation consumes the same kept sections). When no
 * known heading parses the whole raw text passes through unchanged — custom
 * summarizer output is never lost.
 * @param raw - one compaction summary's full text.
 * @returns the filtered text.
 */
export function filterSummarySections(raw: string): string {
  return keptSections(raw).sections
    .map(section => section.lines.join('\n'))
    .join('\n')
    .trim()
}

/** One harvested compaction segment: the store row unit (segment = budget atom). */
export interface MemorySegment {
  readonly heading: string | null
  /** Full segment text: `## <heading>\n<body>`, a `## <heading> (cont. i/N)` chunk, or the whole-summary fallback. */
  readonly content: string
  /** Segment order within its source summary (0-based, across all sections). */
  readonly segmentIndex: number
}

/** The truncation tail marker appended when a single atomic unit still exceeds the entry cap — the system's ONLY data-loss path. */
export function hardTruncateText(text: string, cap: number): string {
  const kept = Math.max(0, cap - 64)
  const omitted = text.length - kept
  const marker = `[segment truncated: ${omitted} chars omitted]`
  return `${text.slice(0, kept)}${kept > 0 ? '\n' : ''}${marker}`
}

/**
 * Reserved per-chunk budget beyond the heading text itself: the `## ` prefix
 * and newline (4 chars) plus the widest possible ` (cont. 9999/9999)` suffix
 * (18 chars), padded with slack so a near-miss fit never strands a unit.
 */
const CONT_HEADER_OVERHEAD = 40

/** Per-chunk header allowance inside a split section: `## H\n` plus ` (cont. 9999/9999)`. */
const headerAllowance = (heading: string | null): number => (heading === null ? 0 : heading.length + CONT_HEADER_OVERHEAD)

/** A ``` code-fence delimiter line (opening ```lang or bare closing ```). */
const isFence = (line: string): boolean => line.trimStart().startsWith('```')

/** Trim blank lines off a line block's edges; drop blocks that become empty. */
function trimBlock(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') start += 1
  while (end > start && lines[end - 1]?.trim() === '') end -= 1
  return lines.slice(start, end)
}

/**
 * Split a section's lines into top-level bullet blocks: a block starts at a
 * column-0 `- ` / `\d+. ` bullet and runs until the next top-level bullet;
 * indented continuation lines, nested bullets, blank lines, and fenced code
 * belong to the current block. Prose before the first bullet is its own
 * block (spec: bullet-block greedy bin-packing).
 */
function splitBulletBlocks(lines: string[]): string[] {
  const blocks: string[][] = []
  let current: string[] | undefined
  for (const line of lines) {
    if (line.length > 0 && TOP_BULLET_RE.test(line)) {
      current = [line]
      blocks.push(current)
      continue
    }
    if (current === undefined) {
      current = []
      blocks.push(current)
    }
    current.push(line)
  }
  return blocks
    .map(block => trimBlock(block))
    .filter(block => block.length > 0)
    .map(block => block.join('\n'))
}

/**
 * Split one block at ``` fence boundaries: the FIRST fence delimiter line
 * (the opening ```lang, or a bare ```) stays attached to the unit that
 * follows — the fence body — and the SECOND one (the closer) ends the piece.
 * Fences alternate open/close, so a chunk break can never land between an
 * opener and its body: a ` (cont. i/N)` header must not sit inside a code
 * fence, and an opener never becomes a standalone unit.
 */
function splitAtFences(lines: string[]): string[] {
  const pieces: string[][] = []
  let current: string[] = []
  let inFence = false
  for (const line of lines) {
    current.push(line)
    if (!isFence(line)) continue
    if (!inFence) {
      inFence = true // fence opener: stays with the body that follows
      continue
    }
    pieces.push(current) // fence closer: the piece it opened ends here
    current = []
    inFence = false
  }
  if (current.length > 0) pieces.push(current)
  return pieces.filter(piece => piece.some(line => line.trim() !== '')).map(piece => piece.join('\n'))
}

/** Split one block into paragraphs on blank-line boundaries (the non-bullet fallback). */
function splitParagraphs(lines: string[]): string[] {
  const blocks: string[][] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current)
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current)
  return blocks.map(block => block.join('\n'))
}

/**
 * Expand one oversized section body into bucket units ≤ cap: bullet blocks as
 *-is, fence-split when a single block still exceeds the cap, hard-truncate
 * when a fence piece still exceeds it.
 */
function expandUnits(blocks: string[], cap: number, heading: string | null): string[] {
  const units: string[] = []
  for (const block of blocks) {
    if (block.length <= cap) {
      units.push(block)
      continue
    }
    const pieces = splitAtFences(block.split('\n'))
    for (const piece of pieces) {
      units.push(piece.length <= cap ? piece : hardTruncateText(piece, Math.max(1, cap - headerAllowance(heading))))
    }
  }
  return units
}

/**
 * Greedy bin-pack line blocks into chunks ≤ cap, preserving order. Chunk
 * content = `## <heading> (cont. i/N)` + its blocks; a sole chunk uses the
 * plain `## <heading>` header. Deterministic in (text, cap).
 */
function packChunks(units: string[], cap: number, heading: string | null, indexStart: number): MemorySegment[] {
  const allowance = headerAllowance(heading)
  const chunks: string[][] = []
  let current: string[] = []
  let currentLen = 0
  for (const unit of units) {
    const added = current.length === 0 ? unit.length : 1 + unit.length
    if (current.length > 0 && currentLen + added + allowance > cap) {
      chunks.push(current)
      current = [unit]
      currentLen = unit.length
    } else {
      current.push(unit)
      currentLen += added
    }
  }
  if (current.length > 0) chunks.push(current)
  const count = chunks.length
  let index = indexStart
  return chunks.map((chunk, i) => {
    const cont = count > 1 ? ` (cont. ${i + 1}/${count})` : ''
    const header = heading === null ? '' : `## ${heading}${cont}`
    const body = chunk.join('\n')
    return { heading, content: header === '' ? body : `${header}\n${body}`, segmentIndex: index++ }
  })
}

/** Segment one kept section: whole when it fits, bullet/paragraph packing with fence/truncate fallbacks otherwise. */
function segmentSection(section: SummarySection, cap: number, indexStart: number): MemorySegment[] {
  const heading = section.heading ?? null
  const text = section.lines.join('\n').trim()
  if (text === '') return []
  if (text.length <= cap) return [{ heading, content: text, segmentIndex: indexStart }]
  // Split on the BODY only — the heading line is not a bullet block/paragraph
  // of its own (it becomes the per-chunk `cont` header instead).
  const bodyLines = heading === null ? section.lines : section.lines.slice(1)
  const isBulleted = bodyLines.some(line => line.length > 0 && TOP_BULLET_RE.test(line))
  const units = isBulleted
    ? expandUnits(splitBulletBlocks(bodyLines), cap, heading)
    : splitParagraphs(bodyLines).map(block => block.length <= cap ? block : hardTruncateText(block, Math.max(1, cap - headerAllowance(heading))))
  return packChunks(units, cap, heading, indexStart)
}

/**
 * The harvest splitter (pure function of text + cap → deterministic segments):
 * section filter first, then per-section three-level splitting — whole section
 * when ≤ cap, bullet-block greedy bin-packing (or paragraph split for prose)
 * when oversized, fence-boundary split when a single block still exceeds the
 * cap, and hard truncation with the `[segment truncated: N chars omitted]`
 * marker as the last resort (the system's only data-loss path). Empty
 * sections are skipped; a summary with no known heading falls back to one
 * whole segment verbatim.
 * @param raw - one compaction summary's full text.
 * @param maxEntryChars - the entry cap (segment budget atom).
 * @returns the harvest segments in section order.
 */
export function segmentSummary(raw: string, maxEntryChars: number): MemorySegment[] {
  const rawText = raw.trim()
  if (rawText === '') return []
  const { known, sections } = keptSections(rawText)
  if (!known) return [{ heading: null, content: rawText, segmentIndex: 0 }]
  const segments: MemorySegment[] = []
  for (const section of sections) segments.push(...segmentSection(section, maxEntryChars, segments.length))
  return segments
}

/** Manual scope rank for the injection order: global → workspace → session. */
const MANUAL_RANK: Record<ManualScope, number> = { global: 0, workspace: 1, session: 2 }

/** The dual-pool budget knobs (spec: compaction by count, manual by total chars). */
export interface MemoryBudgetOptions {
  /** Entry cap: harvest split threshold + memory_write truncation threshold (default 2500). */
  readonly maxEntryChars: number
  /** Compaction pool size: whole checkpoint groups, newest first (default 2). */
  readonly maxCompactionSummaries: number
  /** Manual pool budget: total content length (chars) of admitted entries, newest first (default 10000). */
  readonly maxManualChars: number
}

/** The checkpoint date attribute: the created-at timestamp's UTC calendar day. */
function dateOf(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10)
}

/** Render one manual row as a `<note>` element (spec format). */
function renderNote(row: MemoryBlockRow): string {
  return `<note id="${row.id}" scope="${scopeOfRow(row)}">${row.content}</note>`
}

/** The fixed injected-block header contract lines, recognized wherever they reappear inside stored segment text (the nested-echo feedback loop). */
const ECHO_HEADING_RE = /^##\s+Project Memory\s*$/
const ECHO_GUIDANCE_MARKER = 'Knowledge from previous sessions'
const ECHO_WRAPPER_OPEN = '<project-memory>'
const ECHO_WRAPPER_CLOSE = '</project-memory>'

/**
 * Remove the FIRST strippable memory-block echo from one segment's lines and
 * return the remaining lines, or null when no strippable echo occurs. One
 * occurrence per call; the caller iterates to a fixpoint (nested/sibling
 * echoes each need their own pass). Conservative contract: an occurrence
 * strips only when the heading line is followed by the guidance line AND the
 * heading sits inside a ``` fence (cut from the heading — or its fence opener
 * when the fence body is only the echo — through the fence closer) or, when
 * unfenced, `<project-memory>` … `</project-memory>` wrapper boundaries both
 * follow the heading (cut through the closer). Prose that merely discusses
 * "Project Memory" never matches all of that.
 * @param lines - the segment text, split on newlines.
 * @param fencedAt - per-line flag: the fence state when that line begins (precomputed over the same lines).
 * @returns the post-cut lines, or null when nothing strips.
 */
function stripFirstEcho(lines: readonly string[], fencedAt: readonly boolean[]): string[] | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (!ECHO_HEADING_RE.test(lines[i])) continue
    const guidance = lines[i + 1]
    if (guidance === undefined || !guidance.includes(ECHO_GUIDANCE_MARKER)) continue
    if (fencedAt[i]) {
      // Heading inside a fence: cut through the enclosing fence's closer. The
      // fence opener goes too when its body holds only the echo (an echo-only
      // segment must reduce to '', never to a dangling ```).
      let opener = -1
      for (let k = i - 1; k >= 0; k -= 1) {
        if (isFence(lines[k])) { opener = k; break }
      }
      let closer = -1
      for (let k = i + 1; k < lines.length; k += 1) {
        if (isFence(lines[k])) { closer = k; break }
      }
      const echoOnlyBody = opener !== -1 && lines.slice(opener + 1, i).every(line => line.trim() === '')
      const start = echoOnlyBody ? opener : i
      const end = closer === -1 ? lines.length - 1 : closer
      return [...lines.slice(0, start), ...lines.slice(end + 1)]
    }
    // Unfenced heading: both wrapper boundaries must follow, else this is
    // prose discussing the header contract — keep it.
    const open = lines.findIndex((line, k) => k > i && line.includes(ECHO_WRAPPER_OPEN))
    if (open === -1) continue
    const close = lines.findIndex((line, k) => k > open && line.includes(ECHO_WRAPPER_CLOSE))
    if (close === -1) continue
    return [...lines.slice(0, i), ...lines.slice(close + 1)]
  }
  return null
}

/**
 * Strip every nested memory-block echo from one checkpoint segment's text at
 * render time (the feedback loop: the memory row rides the surface as a
 * regular message, the model quotes it when asked "what's in your memory",
 * the summarizer preserves that echo verbatim inside the next checkpoint,
 * harvest stores it, the next injection then contains a memory-of-memories).
 * The STORE keeps the raw text — this runs only where segments are prepared
 * for assembly, so no data is ever lost. Detection is the fixed block header
 * contract (`## Project Memory` + the guidance line) PLUS a fenced span or a
 * `<project-memory>`…`</project-memory>` wrapper boundary; each occurrence is
 * removed (fixpoint — nested echoes strip fully), and the result is trimmed.
 * Text without a strippable echo passes through byte-identical.
 * @param text - one stored segment's full text.
 * @returns the text with every nested echo removed, or '' when nothing remains.
 */
export function stripNestedMemoryEcho(text: string): string {
  if (!text.includes(ECHO_GUIDANCE_MARKER)) return text
  let current = text
  let stripped = false
  for (;;) {
    const lines = current.split('\n')
    const fencedAt: boolean[] = []
    let inFence = false
    for (const line of lines) {
      fencedAt.push(inFence)
      if (isFence(line)) inFence = !inFence
    }
    const next = stripFirstEcho(lines, fencedAt)
    if (next === null) break
    current = next.join('\n')
    stripped = true
  }
  return stripped ? current.trim() : text
}

/**
 * Render one checkpoint group as a `<checkpoint>` element: its segments in
 * segment_index order (reads like a condensed summary), each stripped of
 * nested memory-block echoes first; a group whose segments all strip to empty
 * renders as '' (the whole group is dropped from the block).
 */
function renderCheckpoint(segments: readonly MemoryBlockRow[]): string {
  const first = segments[0]
  const bodies = segments
    .map(segment => stripNestedMemoryEcho(segment.content))
    .filter(content => content !== '')
  if (bodies.length === 0) return ''
  return `<checkpoint id="${first.id}" session="${first.session_id ?? ''}" date="${dateOf(first.created_at)}">\n`
    + bodies.join('\n')
    + '\n</checkpoint>'
}

/** The fixed block header and guidance line (spec format). */
const BLOCK_HEADER = '## Project Memory\n'
  + 'Knowledge from previous sessions. May be stale; correct via memory_write.\n\n'
  + '<project-memory>\n'
const BLOCK_FOOTER = '</project-memory>'

/**
 * Normalize block whitespace on the wire (render layer only; the store keeps
 * raw text): outside code fences, collapse blank-line runs (>1 → 1) and strip
 * trailing whitespace per line; fence interiors stay untouched. Deterministic.
 * @param text - the assembled block before normalization.
 * @returns the normalized block.
 */
export function normalizeBlockWhitespace(text: string): string {
  const out: string[] = []
  let inFence = false
  let pendingBlank = false
  for (const line of text.split('\n')) {
    const fenceDelimiter = isFence(line)
    if (inFence) {
      out.push(line)
      if (fenceDelimiter) inFence = false
      continue
    }
    if (fenceDelimiter) {
      inFence = true
      out.push(line.replace(/\s+$/, ''))
      pendingBlank = false
      continue
    }
    const stripped = line.replace(/\s+$/, '')
    if (stripped === '') {
      if (!pendingBlank) out.push('')
      pendingBlank = true
    } else {
      out.push(stripped)
      pendingBlank = false
    }
  }
  return out.join('\n')
}

/**
 * Assemble the injected memory block over the TWO independent pools (spec):
 * manual entries first — admission takes the newest entries across ALL scopes
 * (global-time ranked; an older entry of a higher tier never holds a slot
 * against a newer one) by greedy total-length accumulation up to
 * maxManualChars: an entry is admitted only when the running cumulative plus
 * its own content length stays within the budget, and admission STOPS at the
 * first entry that does not fit — no skip-and-continue, so recency order is
 * never broken (older small notes are not scavenged past a non-fitting newer
 * one). The default budget 10000 ≥ the per-entry cap 2500 guarantees any single
 * legal entry fits alone. The kept set then renders in scope-tier order
 * global → workspace → session, newest first within each tier — then
 * compaction checkpoint groups newest→old (whole-group admission capped at
 * maxCompactionSummaries — a group is never beheaded). Both pools drop from
 * the OLDEST end, and the dropped count is annotated after the wrapper. The
 * rendered byte stream is whitespace-normalized (fence interiors untouched);
 * the digest later runs over this exact text.
 *
 * Current-session compaction exclusion (spec — post-compact self-duplication):
 * when `currentSessionId` is given, every compaction row whose `session_id`
 * equals it is filtered out BEFORE any pool selection, because that session's
 * newest checkpoint replacement group is by definition still on its own
 * surface — injecting it again would hand the model the same summary twice.
 * The exclusion runs first, so the freed compaction pool slots refill with
 * the next-oldest ELIGIBLE group (newest first among eligible; no budget is
 * wasted on excluded rows), and an exclusion that empties the row set returns
 * '' (the never-inject path). Manual rows are NEVER excluded — a session's
 * own scope notes must keep injecting while the session lives. Fork caveat
 * (documented in the spec): a fork inherits the parent surface but keeps the
 * original session_id, so the inherited checkpoint group stays visible.
 * @param rows - active store rows (any order; grouping/ordering happens here).
 * @param options - the dual-pool budget.
 * @param currentSessionId - the session the block is assembled for; its own
 * compaction rows are excluded (undefined → no exclusion).
 * @returns the rendered block, or '' for an empty store.
 */
export function assembleMemoryBlock(
  rows: readonly MemoryBlockRow[],
  options: MemoryBudgetOptions,
  currentSessionId?: string,
): string {
  if (rows.length === 0) return ''
  const eligible = currentSessionId === undefined
    ? rows
    : rows.filter(row => !(row.kind === 'compaction' && row.session_id === currentSessionId))
  if (eligible.length === 0) return ''
  // Manual pool admission: greedily accumulate the newest entries across ALL
  // scopes (global-time ranked) up to the total-length budget maxManualChars
  // (cumulative + entry length ≤ budget). Admission STOPS at the first entry
  // that does not fit — no skip-and-continue, so recency order is never broken
  // and older small notes are not scavenged past a non-fitting newer one. The
  // kept set is THEN rendered in scope-tier order (global → workspace →
  // session), newest first within each tier.
  const allManual = eligible.filter(row => row.kind === 'manual')
  const admittedManual: MemoryBlockRow[] = []
  let manualChars = 0
  for (const note of [...allManual].sort((a, b) => b.created_at - a.created_at)) {
    if (manualChars + note.content.length > options.maxManualChars) break
    admittedManual.push(note)
    manualChars += note.content.length
  }
  const keptManual = [...admittedManual].sort((a, b) => {
    const rankA = MANUAL_RANK[scopeOfRow(a)]
    const rankB = MANUAL_RANK[scopeOfRow(b)]
    if (rankA !== rankB) return rankA - rankB
    return b.created_at - a.created_at
  })
  // Compaction pool: whole groups keyed by source_event_seq, newest group first.
  const groups = new Map<number, MemoryBlockRow[]>()
  for (const row of eligible) {
    if (row.kind !== 'compaction' || row.source_event_seq === null) continue
    const group = groups.get(row.source_event_seq)
    if (group === undefined) groups.set(row.source_event_seq, [row])
    else group.push(row)
  }
  const orderedGroups = [...groups.entries()]
    .map(([seq, segments]) => ({ seq, segments, createdAt: Math.max(...segments.map(segment => segment.created_at)) }))
    .sort((a, b) => b.createdAt - a.createdAt)
  const keptGroups = orderedGroups.slice(0, Math.max(0, options.maxCompactionSummaries))
  const dropped = (allManual.length - keptManual.length) + (orderedGroups.length - keptGroups.length)
  const pieces: string[] = [
    ...keptManual.map(renderNote),
    // An all-echo checkpoint group renders '' (echo-only rows strip to empty)
    // and simply vanishes from the block.
    ...keptGroups.map(group => renderCheckpoint(
      [...group.segments].sort((a, b) => a.segment_index - b.segment_index),
    )).filter(piece => piece !== ''),
  ]
  if (pieces.length === 0) {
    // Rows exist but every pool dropped everything (e.g. maxManualChars 0
    // over a manual-only store): still render the header + omission
    // annotation — '' is reserved for the empty store and for a fully
    // excluded row set ("never inject").
    let text = `${BLOCK_HEADER}${BLOCK_FOOTER}`
    if (dropped > 0) text += `\n(${dropped} older memories omitted)`
    return normalizeBlockWhitespace(text)
  }
  let text = `${BLOCK_HEADER}${pieces.join('\n')}\n${BLOCK_FOOTER}`
  if (dropped > 0) text += `\n(${dropped} older memories omitted)`
  return normalizeBlockWhitespace(text)
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
 * injected; per-row marking covers the whole group since every segment shares
 * the seq).
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

/**
 * Full sha256 hex digest of a text. The injection change-detection key: the
 * persisted memory row stays byte-stable while the block is unchanged, and a
 * store write flips the digest so the next pre-step replaces the row in
 * place (provider prefix cache stays reusable across unchanged steps). The
 * digest runs over the NORMALIZED block (mechanism unchanged).
 * @param text - the text to hash.
 * @returns the 64-hex sha256 digest.
 */
export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Build one injected context user/message payload from the assembled block:
 * the fixed one-line lead followed by the block, a fresh message id (a
 * same-id second row would break the client assembler — dsh-undo's replay
 * precedent), and a plugin source carrying the digest of the FULL message
 * text (any byte change in the rendered row flips the digest, so the pre-step
 * scan compares rendered bytes, not just the store blob).
 *
 * The source stays `kind: 'plugin'` (harness relationshipEvent admission
 * allows plugin-kind sources with extra members — magic-context stores
 * messageId/revision/digest the same way; only `kind: 'user'` sources are
 * restricted to kind+rpcId+clientTimeZone, the 2026-09-23 lesson). The chat
 * classes a plugin-source user row as a context row, not a user bubble, so
 * the memory never masquerades as human input.
 * @param block - the assembled memory block (`assembleMemoryBlock` output).
 * @returns the user message payload to persist on the surface.
 */
export function buildMemoryMessage(block: string): UserMessage {
  const content = `${MEMORY_HEADER_LINE}\n\n${block}`
  return {
    id: MessageId(randomUUID()),
    role: 'user',
    content: [{ type: 'text', text: content }],
    source: {
      kind: 'plugin',
      plugin: MEMORY_PLUGIN,
      digest: digestOf(content),
    } as UserMessage['source'],
  }
}