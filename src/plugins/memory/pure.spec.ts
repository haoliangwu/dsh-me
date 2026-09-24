import { describe, expect, it } from 'vitest'
import {
  assembleMemoryBlock,
  buildMemoryMessage,
  cwdToWorkspaceKey,
  detectSupersession,
  digestOf,
  extractCheckpointSummary,
  filterSummarySections,
  hardTruncateText,
  MEMORY_HEADER_LINE,
  MEMORY_PLUGIN,
  normalizeBlockWhitespace,
  PERSISTENT_SECTIONS,
  segmentSummary,
  VOLATILE_SECTIONS,
  type MemoryBlockRow,
  type MemoryBudgetOptions,
} from './pure.ts'

/** The contract 8-section summary body (the default summarizer's exact headings). */
const EIGHT_SECTION_SUMMARY = [
  '## Primary Request and Intent',
  '- goal: ship the memory plugin',
  '',
  '## Key Technical Concepts',
  '- node:sqlite, event sourcing',
  '',
  '## Files and Code',
  '- src/plugins/memory/pure.ts: section filter',
  '',
  '## Errors and Fixes',
  '- sqlite NULL-UNIQUE pitfall: solved with OR IGNORE',
  '',
  '## Pending Jobs',
  '- fix the flaky e2e suite',
  '',
  '## Current Work',
  '- writing pure.spec.ts',
  '',
  '## Next Step',
  '- run pnpm test',
  '',
  '## Critical Context',
  '- never drop unknown sections',
].join('\n')

/** Manual row factory covering the three scopes. */
function row(partial: Partial<MemoryBlockRow> & { id: number; kind: MemoryBlockRow['kind']; content: string; created_at: number }): MemoryBlockRow {
  return { workspace: 'wk', session_id: null, heading: null, segment_index: 0, source_event_seq: null, ...partial }
}

/** One compaction segment row: content plus its group/order identity. */
function segment(id: number, seq: number, content: string, segmentIndex: number, createdAt: number, heading: string | null = null): MemoryBlockRow {
  return { id, workspace: 'wk', session_id: 's1', kind: 'compaction', content, heading, segment_index: segmentIndex, source_event_seq: seq, created_at: createdAt }
}

/** The default dual-pool budget for render tests (large enough to never trim). */
const ROOMY_BUDGET: MemoryBudgetOptions = { maxEntryChars: 2500, maxCompactionSummaries: 10, maxManualEntries: 10 }

describe('filterSummarySections (harvest section filtering)', () => {
  it('keeps the five persistent sections and drops the three volatile ones from a wellformed 8-section summary', () => {
    const filtered = filterSummarySections(EIGHT_SECTION_SUMMARY)
    expect(filtered).toContain('## Primary Request and Intent')
    expect(filtered).toContain('- goal: ship the memory plugin')
    expect(filtered).toContain('## Key Technical Concepts')
    expect(filtered).toContain('## Files and Code')
    expect(filtered).toContain('## Errors and Fixes')
    expect(filtered).toContain('## Critical Context')
    expect(filtered).toContain('- never drop unknown sections')
    expect(filtered).not.toContain('## Pending Jobs')
    expect(filtered).not.toContain('- fix the flaky e2e suite')
    expect(filtered).not.toContain('## Current Work')
    expect(filtered).not.toContain('## Next Step')
  })

  it('keeps unknown headings (custom summarizers must never lose data)', () => {
    const raw = '## Primary Request and Intent\n- goal\n\n## Odd Custom Section\n- kept\n\n## Next Step\n- dropped'
    const filtered = filterSummarySections(raw)
    expect(filtered).toContain('## Odd Custom Section')
    expect(filtered).toContain('- kept')
    expect(filtered).not.toContain('## Next Step')
  })

  it('passes a summary without any known heading through verbatim', () => {
    const raw = '## Completely Alien Format\n- px\n\n## Another One\n- qy'
    expect(filterSummarySections(raw)).toBe(raw)
  })

  it('keeps preamble text before the first heading', () => {
    const raw = 'prefix prose\n\n## Primary Request and Intent\n- goal'
    const filtered = filterSummarySections(raw)
    expect(filtered).toContain('prefix prose')
    expect(filtered).toContain('- goal')
  })

  it('drops empty and "(none)" persistent-section bodies', () => {
    const raw = '## Primary Request and Intent\n- goal\n\n## Files and Code\n(none)\n\n## Critical Context\n\n'
    const filtered = filterSummarySections(raw)
    expect(filtered).toContain('- goal')
    expect(filtered).not.toContain('## Files and Code')
    expect(filtered).not.toContain('## Critical Context')
  })

  it('exports the exact section vocabularies', () => {
    expect(PERSISTENT_SECTIONS).toEqual([
      'Primary Request and Intent',
      'Key Technical Concepts',
      'Files and Code',
      'Errors and Fixes',
      'Critical Context',
    ])
    expect(VOLATILE_SECTIONS).toEqual(['Pending Jobs', 'Current Work', 'Next Step'])
  })

  it('returns empty for an empty input', () => {
    expect(filterSummarySections('')).toBe('')
  })
})

describe('segmentSummary (harvest three-level splitting)', () => {
  it('splits a whole-section summary into one segment per persistent section (volatile dropped), in order', () => {
    const segments = segmentSummary(EIGHT_SECTION_SUMMARY, 2500)
    expect(segments.map(s => s.heading)).toEqual([
      'Primary Request and Intent',
      'Key Technical Concepts',
      'Files and Code',
      'Errors and Fixes',
      'Critical Context',
    ])
    expect(segments.map(s => s.segmentIndex)).toEqual([0, 1, 2, 3, 4])
    expect(segments[0]?.content).toBe('## Primary Request and Intent\n- goal: ship the memory plugin')
    expect(segments[0]?.content.length).toBeLessThanOrEqual(2500)
    for (const segment of segments) expect(segment.content).toMatch(/^## /)
  })

  it('keeps preamble prose as its own leading segment', () => {
    const segments = segmentSummary('prefix prose\n\n## Primary Request and Intent\n- goal', 2500)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ heading: null, content: 'prefix prose', segmentIndex: 0 })
    expect(segments[1]?.content).toBe('## Primary Request and Intent\n- goal')
  })

  it('skips empty and "(none)" sections entirely', () => {
    const none = segmentSummary('## Files and Code\n(none)\n\n## Critical Context\n\n', 2500)
    expect(none).toEqual([])
    const mixed = segmentSummary('## Files and Code\n(none)\n\n## Primary Request and Intent\n- goal', 2500)
    expect(mixed).toHaveLength(1)
  })

  it('falls back to one whole segment when no known heading parses (custom summarizer drift)', () => {
    const raw = '## Completely Alien Format\n- px\n\n## Another One\n- qy'
    expect(segmentSummary(raw, 2500)).toEqual([{ heading: null, content: raw, segmentIndex: 0 }])
  })

  it('greedy-packs an oversized bullet section into cont-marked chunks, preserving order', () => {
    const bullets = Array.from({ length: 5 }, (_, i) => `- ${i}${'x'.repeat(297)}`)
    const raw = `## Files and Code\n${bullets.join('\n')}`
    const segments = segmentSummary(raw, 800)
    // Capacity 800 - header allowance: 2 bullets per chunk → chunks [2, 2, 1].
    expect(segments).toHaveLength(3)
    expect(segments.map(s => s.segmentIndex)).toEqual([0, 1, 2])
    expect(segments[0]?.content).toContain('## Files and Code (cont. 1/3)')
    expect(segments[1]?.content).toContain('## Files and Code (cont. 2/3)')
    expect(segments[2]?.content).toContain('## Files and Code (cont. 3/3)')
    expect(segments[0]?.content).toContain(bullets[0]!)
    expect(segments[0]?.content).toContain(bullets[1]!)
    expect(segments[0]?.content).not.toContain(bullets[2]!)
    expect(segments[1]?.content).toContain(bullets[2]!)
    expect(segments[1]?.content).toContain(bullets[3]!)
    expect(segments[2]?.content).toContain(bullets[4]!)
    expect(segments[2]?.content).not.toContain(bullets[0]!)
    for (const segment of segments) expect(segment.content.length).toBeLessThanOrEqual(800)
  })

  it('attributes nested bullets, indented continuations, and fenced code to their owning bullet block', () => {
    const bulletOne = '- intro\n  - nested detail\ninside\n```js\nconst x = 1\nconst y = 2\n```\nafter code'
    const bulletTwo = `- ${'z'.repeat(600)}`
    const raw = `## Files and Code\n${bulletOne}\n${bulletTwo}`
    const segments = segmentSummary(raw, 650)
    // Chunk1 gets bulletOne (with its nested/fence tail), chunk2 bulletTwo.
    expect(segments).toHaveLength(2)
    expect(segments[0]?.content).toContain('  - nested detail')
    expect(segments[0]?.content).toContain('const y = 2')
    expect(segments[0]?.content).toContain('after code')
    expect(segments[1]?.content).not.toContain('```')
    expect(segments[1]?.content).not.toContain('nested detail')
  })

  it('splits a non-bullet oversized section at paragraph boundaries', () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `paragraph ${i}: ${'p'.repeat(290)}`)
    const raw = `## Errors and Fixes\n\n${paragraphs.join('\n\n')}`
    const segments = segmentSummary(raw, 800)
    // Ordered paragraph packing → [2, 2, 1] chunks with cont markers.
    expect(segments).toHaveLength(3)
    expect(segments[0]?.content).toContain('## Errors and Fixes (cont. 1/3)')
    expect(segments[2]?.content).toContain('## Errors and Fixes (cont. 3/3)')
    expect(segments[0]?.content).toContain(paragraphs[0]!)
    expect(segments[0]?.content).toContain(paragraphs[1]!)
    expect(segments[2]?.content).toContain(paragraphs[4]!)
    for (const segment of segments) expect(segment.content.length).toBeLessThanOrEqual(800)
  })

  it('splits a single oversized block at fence boundaries instead of mid-line', () => {
    const raw = '## Files and Code\n- big\n```js\n'
      + `${'c'.repeat(300)}\n\`\`\`\nmiddle\n\`\`\`py\n${'p'.repeat(300)}\n\`\`\`\nend`
    const segments = segmentSummary(raw, 500)
    // The single bullet block exceeds the cap; fence splitting yields pieces
    // that pack into two chunks — every fence delimiter stays with its code.
    expect(segments).toHaveLength(2)
    expect(segments[0]?.content).toContain('## Files and Code (cont. 1/2)')
    expect(segments[0]?.content).toContain('```js')
    expect(segments[0]?.content).toContain(`${'c'.repeat(300)}`)
    expect(segments[1]?.content).toContain('## Files and Code (cont. 2/2)')
    expect(segments[1]?.content).toContain(`${'p'.repeat(300)}`)
    expect(segments[1]?.content).toContain('end')
    for (const segment of segments) expect(segment).not.toContain('[segment truncated')
    for (const segment of segments) expect(segment.content.length).toBeLessThanOrEqual(500)
  })

  it('merges a fence opener into its body: a chunk break never lands between a delimiter and its code', () => {
    const bodyJs = 'c'.repeat(400)
    const bodyPy = 'p'.repeat(400)
    const raw = '## Files and Code\n- big\n- med note\n```js\n'
      + `${bodyJs}\n\`\`\`\nmiddle\n\`\`\`py\n${bodyPy}\n\`\`\`\nend`
    const segments = segmentSummary(raw, 500)
    // Both fence pieces stay whole (opener + body + closer together), so the
    // packing can only break BETWEEN fences. Old behavior ended chunk 1 with
    // the bare ```py opener and started chunk 2 with its body — a cont
    // header inside the code fence.
    expect(segments).toHaveLength(2)
    expect(segments[0]?.content).toContain('```js')
    expect(segments[0]?.content).toContain(bodyJs)
    expect(segments[0]?.content.endsWith('```py')).toBe(false)
    expect(segments[1]?.content).toContain('```py')
    expect(segments[1]?.content).toContain(bodyPy)
    // Every fence opener is immediately followed by body text in the SAME segment.
    for (const segment of segments) {
      for (const opener of ['```js', '```py']) {
        const at = segment.content.indexOf(opener)
        if (at !== -1) expect(segment.content.slice(at + opener.length)).toMatch(/\n.{1,}/)
      }
    }
    for (const segment of segments) expect(segment.content.length).toBeLessThanOrEqual(500)
  })

  it('hard-truncates with the marker when a single atomic unit still exceeds the cap (the only data-loss path)', () => {
    const raw = `## Files and Code\n- ${'y'.repeat(1998)}`
    const segments = segmentSummary(raw, 300)
    expect(segments).toHaveLength(1)
    expect(segments[0]?.content).toContain('## Files and Code')
    expect(segments[0]?.content).toContain('[segment truncated: 1818 chars omitted]')
    expect(segments[0]?.content.length).toBeLessThanOrEqual(300)
    expect(segments[0]?.content).toContain('- ')
  })

  it('is a deterministic pure function of (text, cap)', () => {
    const raw = `## Files and Code\n${Array.from({ length: 5 }, () => `- ${'x'.repeat(298)}`).join('\n')}`
    const first = JSON.stringify(segmentSummary(raw, 800))
    const second = JSON.stringify(segmentSummary(raw, 800))
    expect(first).toBe(second)
    expect(segmentSummary('## Primary Request and Intent\n- goal', 2500)).toEqual(
      segmentSummary('## Primary Request and Intent\n- goal', 2500),
    )
  })

  it('returns nothing for an empty summary', () => {
    expect(segmentSummary('', 2500)).toEqual([])
    expect(segmentSummary('   \n  ', 2500)).toEqual([])
  })
})

describe('hardTruncateText (entry-cap truncation marker)', () => {
  it('keeps a prefix and appends the exact omitted count', () => {
    const text = 'a'.repeat(200)
    const truncated = hardTruncateText(text, 100)
    expect(truncated).toContain('[segment truncated: 164 chars omitted]')
    expect(truncated.length).toBeLessThanOrEqual(100)
    expect(truncated.startsWith('a'.repeat(36))).toBe(true)
  })

  it('keeps the marker alone when the cap cannot fit any content', () => {
    const truncated = hardTruncateText('abcdefghij', 6)
    expect(truncated).toBe('[segment truncated: 10 chars omitted]')
  })
})

describe('assembleMemoryBlock (dual-pool injection)', () => {
  const block = assembleMemoryBlock
  const globalNote = row({ id: 1, kind: 'manual', content: 'global pref', workspace: null, created_at: 100 })
  const workspaceNote = row({ id: 2, kind: 'manual', content: 'workspace fact', created_at: 101, session_id: null })
  const sessionNote = row({ id: 3, kind: 'manual', content: 'session note', created_at: 102, session_id: 's1' })
  const oldGroup = [
    segment(4, 10, '## Primary Request and Intent\n- old goal', 0, 200, 'Primary Request and Intent'),
    segment(5, 10, '## Files and Code (cont. 1/2)\n- a.ts\n- b.ts', 1, 200, 'Files and Code'),
    segment(6, 10, '## Files and Code (cont. 2/2)\n- c.ts', 2, 200, 'Files and Code'),
  ]
  const newGroup = [
    segment(7, 20, '## Primary Request and Intent\n- new goal', 0, 300, 'Primary Request and Intent'),
  ]

  it('orders global manual → workspace manual → session notes → checkpoints (groups newest first, segments in index order)', () => {
    const output = block([...oldGroup, ...newGroup, sessionNote, workspaceNote, globalNote], ROOMY_BUDGET)
    const order = [
      output.indexOf('<note id="1" scope="global">'),
      output.indexOf('<note id="2" scope="workspace">'),
      output.indexOf('<note id="3" scope="session">'),
      output.indexOf('<checkpoint id="7"'),
      output.indexOf('<checkpoint id="4"'),
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0)
    // Group-internal: segment_index ascending keeps the original section order.
    expect(output.indexOf('## Primary Request and Intent\n- old goal')).toBeLessThan(output.indexOf('- c.ts'))
  })

  it('renders checkpoint segments verbatim (already filtered/segmented at harvest) with the fixed header', () => {
    const output = block(oldGroup, ROOMY_BUDGET)
    expect(output).toContain('## Project Memory')
    expect(output).toContain('Knowledge from previous sessions. May be stale; correct via memory_write.')
    expect(output).toContain('<project-memory>')
    expect(output).toContain('</project-memory>')
    expect(output).toContain('<checkpoint id="4" session="s1" date="1970-01-01">')
    expect(output).toContain('## Primary Request and Intent')
    expect(output).toContain('## Files and Code (cont. 2/2)')
    expect(output).toContain('- c.ts')
    expect(output).not.toContain('## Next Step')
  })

  it('never beheads a group: all segments of a kept checkpoint render, dropped groups vanish whole', () => {
    const skinnyOld = [segment(4, 10, '## Primary Request and Intent\n- old goal', 0, 200, 'Primary Request and Intent')]
    const fatNew = [
      segment(7, 20, '## Primary Request and Intent\n- new goal', 0, 300, 'Primary Request and Intent'),
      segment(8, 20, '## Files and Code (cont. 1/2)\n- a.ts', 1, 300, 'Files and Code'),
      segment(9, 20, '## Files and Code (cont. 2/2)\n- c.ts', 2, 300, 'Files and Code'),
    ]
    const output = block([...skinnyOld, ...fatNew], { ...ROOMY_BUDGET, maxCompactionSummaries: 1 })
    expect(output).toContain('- new goal')
    expect(output).toContain('- a.ts')
    expect(output).toContain('- c.ts')
    expect(output).not.toContain('- old goal')
    expect(output).toContain('(1 older memories omitted)')
  })

  it('counts the manual pool independently: manual entries dropped from the oldest end never evict checkpoints', () => {
    const notes = Array.from({ length: 12 }, (_, i) =>
      row({ id: 100 + i, kind: 'manual', content: `note_${String(i).padStart(2, '0')}`, created_at: i }))
    const output = block([...notes, ...newGroup], { ...ROOMY_BUDGET, maxManualEntries: 10 })
    expect(output).toContain('note_11')
    expect(output).toContain('note_02')
    expect(output).not.toContain('note_01')
    expect(output).not.toContain('note_00')
    expect(output).toContain('<checkpoint id="7"')
    expect(output).toContain('(2 older memories omitted)')
  })

  it('drops the whole compaction pool (and counts the dropped group) when capped at zero', () => {
    const output = block([...oldGroup, globalNote], { ...ROOMY_BUDGET, maxCompactionSummaries: 0 })
    expect(output).toContain('<note id="1" scope="global">global pref</note>')
    expect(output).not.toContain('<checkpoint')
    expect(output).toContain('(1 older memories omitted)')
  })

  it('sums dropped groups and entries into one omitted annotation', () => {
    const notes = Array.from({ length: 3 }, (_, i) =>
      row({ id: 100 + i, kind: 'manual', content: `note ${i}`, created_at: i }))
    const output = block([...notes, ...oldGroup, ...newGroup], { maxEntryChars: 2500, maxCompactionSummaries: 1, maxManualEntries: 1 })
    // 2 manual dropped + 1 group dropped → 3.
    expect(output).toContain('(3 older memories omitted)')
  })

  it('renders a single note normally with no annotation', () => {
    const output = block([row({ id: 9, kind: 'manual', content: 'small note', workspace: null, created_at: 1 })], ROOMY_BUDGET)
    expect(output).toContain('<note id="9" scope="global">small note</note>')
    expect(output).not.toContain('omitted')
  })

  it('admits the newest manual entries ACROSS scopes: a newer note never loses its slot to an older note of a higher tier', () => {
    const oldGlobal = row({ id: 1, kind: 'manual', content: 'old global pref', workspace: null, created_at: 100 })
    const newWorkspace = row({ id: 2, kind: 'manual', content: 'new workspace fact', created_at: 200 })
    const output = block([oldGlobal, newWorkspace], { ...ROOMY_BUDGET, maxManualEntries: 1 })
    // Admission is global-time ranked (workspace wins); render order stays tiered.
    expect(output).toContain('new workspace fact')
    expect(output).not.toContain('old global pref')
    expect(output).toContain('(1 older memories omitted)')
  })

  it('renders an all-dropped store as the header + omission annotation (empty string stays reserved for the empty store)', () => {
    expect(block([], ROOMY_BUDGET)).toBe('')
    const manualOnly = block([globalNote], { ...ROOMY_BUDGET, maxManualEntries: 0 })
    expect(manualOnly).not.toBe('')
    expect(manualOnly).toContain('## Project Memory')
    expect(manualOnly).toContain('<project-memory>')
    expect(manualOnly).toContain('</project-memory>')
    expect(manualOnly).toContain('(1 older memories omitted)')
    const compactionOnly = block(oldGroup, { ...ROOMY_BUDGET, maxCompactionSummaries: 0 })
    expect(compactionOnly).not.toBe('')
    expect(compactionOnly).toContain('(1 older memories omitted)')
  })
})

describe('normalizeBlockWhitespace (wire whitespace, render layer only)', () => {
  it('collapses blank-line runs and strips trailing whitespace outside fences, leaves fence interiors untouched', () => {
    const raw = 'a\n\n\n\nb\n   \nc  \n```\nx\n\n\n\n\ny  \n```\nz\n\n\nd'
    const normalized = normalizeBlockWhitespace(raw)
    expect(normalized).toBe('a\n\nb\n\nc\n```\nx\n\n\n\n\ny  \n```\nz\n\nd')
  })

  it('preserves fenced code byte-for-byte including its blank runs', () => {
    const raw = 'before\n```ts\nconst a = 1\n\n\n\nconst b = 2\n```\nafter'
    const normalized = normalizeBlockWhitespace(raw)
    expect(normalized).toBe('before\n```ts\nconst a = 1\n\n\n\nconst b = 2\n```\nafter')
  })

  it('collapses a leading blank run to a single blank line', () => {
    expect(normalizeBlockWhitespace('\n\n\nx')).toBe('\nx')
  })

  it('is a no-op on already-clean text', () => {
    const clean = '## Project Memory\n<project-memory>\n<note id="1" scope="global">x</note>\n</project-memory>'
    expect(normalizeBlockWhitespace(clean)).toBe(clean)
  })
})

describe('extractCheckpointSummary (framed checkpoint parsing)', () => {
  it('strips the preamble and both frame tags, keeping the inner summary', () => {
    const framed = 'This message is a compaction checkpoint.\n\n<compacted-summary>\n## Primary Request and Intent\n- goal\n</compacted-summary>'
    expect(extractCheckpointSummary(framed)).toBe('## Primary Request and Intent\n- goal')
  })

  it('keeps the raw text when the tags are absent (tolerant fallback)', () => {
    const raw = '## Primary Request and Intent\n- goal'
    expect(extractCheckpointSummary(raw)).toBe(raw)
  })

  it('keeps the raw text when only one tag is present', () => {
    const partial = 'preamble\n\n<compacted-summary>\n## Section\n- body'
    expect(extractCheckpointSummary(partial)).toBe(partial)
  })

  it('handles multiline summaries with blank lines inside the frame', () => {
    const framed = 'preamble\n\n<compacted-summary>\n## Files and Code\n- a.ts\n- b.ts\n\n## Errors and Fixes\n- fixed\n</compacted-summary>'
    expect(extractCheckpointSummary(framed)).toBe('## Files and Code\n- a.ts\n- b.ts\n\n## Errors and Fixes\n- fixed')
  })

  it('returns empty for an empty input', () => {
    expect(extractCheckpointSummary('')).toBe('')
  })
})

describe('detectSupersession (chained-compaction pruning)', () => {
  it('returns the active compaction rows whose seq appears in the new shadowed seqs', () => {
    const rows = [
      { id: 1, kind: 'compaction', source_event_seq: 10, superseded_by: null },
      { id: 2, kind: 'compaction', source_event_seq: 11, superseded_by: null },
      { id: 3, kind: 'manual', source_event_seq: null, superseded_by: null },
    ]
    expect(detectSupersession([5, 10, 99], rows)).toEqual([1])
  })

  it('returns every segment of a shadowed group (per-row marking over the shared seq)', () => {
    const rows = [
      { id: 1, kind: 'compaction', source_event_seq: 10, superseded_by: null },
      { id: 2, kind: 'compaction', source_event_seq: 10, superseded_by: null },
      { id: 3, kind: 'compaction', source_event_seq: 10, superseded_by: null },
    ]
    expect(detectSupersession([10], rows)).toEqual([1, 2, 3])
  })

  it('ignores already-superseded rows and rows without a seq', () => {
    const rows = [
      { id: 1, kind: 'compaction', source_event_seq: 10, superseded_by: 77 },
      { id: 2, kind: 'manual', source_event_seq: null as number | null, superseded_by: null },
    ]
    expect(detectSupersession([10], rows)).toEqual([])
  })

  it('returns nothing for an empty shadow set', () => {
    expect(detectSupersession([], [{ id: 1, kind: 'compaction', source_event_seq: 3, superseded_by: null }])).toEqual([])
  })
})

describe('cwdToWorkspaceKey (workspace identity)', () => {
  it('is a stable 16-hex sha1 prefix', () => {
    const key = cwdToWorkspaceKey('/work/a')
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(cwdToWorkspaceKey('/work/a')).toBe(key)
  })

  it('distinguishes different cwds', () => {
    expect(cwdToWorkspaceKey('/work/a')).not.toBe(cwdToWorkspaceKey('/work/b'))
  })
})

describe('digestOf (injection change-detection key)', () => {
  it('is a stable 64-hex sha256 digest', () => {
    const digest = digestOf('some block text')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digestOf('some block text')).toBe(digest)
  })

  it('flips on any byte change (a store write changes the row text → digest differs → replace)', () => {
    expect(digestOf('fact A')).not.toBe(digestOf('fact B'))
  })
})

describe('buildMemoryMessage (persisted context row payload)', () => {
  it('carries the header lead, the block, plugin source, and a full-text digest', () => {
    const message = buildMemoryMessage('## Project Memory\n<project-memory>\n<note id="1" scope="global">x</note>\n</project-memory>')
    const text = message.content[0] as { text: string }
    expect(message.role).toBe('user')
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(text.text).toBe(`${MEMORY_HEADER_LINE}\n\n## Project Memory\n<project-memory>\n<note id="1" scope="global">x</note>\n</project-memory>`)
    const source = message.source as { kind: string; plugin: string; digest: string }
    expect(source.kind).toBe('plugin')
    expect(source.plugin).toBe(MEMORY_PLUGIN)
    expect(source.digest).toBe(digestOf(text.text))
  })

  it('gives every message a fresh id (a same-id second row would break the client assembler)', () => {
    const first = buildMemoryMessage('block')
    const second = buildMemoryMessage('block')
    expect(first.id).not.toBe(second.id)
  })
})