import { describe, expect, it } from 'vitest'
import {
  assembleMemoryBlock,
  cwdToWorkspaceKey,
  detectSupersession,
  extractCheckpointSummary,
  filterSummarySections,
  PERSISTENT_SECTIONS,
  VOLATILE_SECTIONS,
  type MemoryBlockRow,
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

/** Manual row factory covering the three scopes + a checkpoint. */
function row(partial: Partial<MemoryBlockRow> & { id: number; kind: MemoryBlockRow['kind']; content: string; created_at: number }): MemoryBlockRow {
  return { workspace: 'wk', session_id: null, ...partial }
}

describe('filterSummarySections (render-time section filtering)', () => {
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

describe('assembleMemoryBlock (ordered, budget-trimmed injection)', () => {
  const block = assembleMemoryBlock
  const globalNote = row({ id: 1, kind: 'manual', content: 'global pref', workspace: null, created_at: 100 })
  const workspaceNote = row({ id: 2, kind: 'manual', content: 'workspace fact', created_at: 101, session_id: null })
  const sessionNote = row({ id: 3, kind: 'manual', content: 'session note', created_at: 102, session_id: 's1' })
  const checkpoint = row({
    id: 4,
    kind: 'compaction',
    content: '## Primary Request and Intent\n- old goal\n\n## Next Step\n- stale',
    created_at: 200,
  })
  const checkpointNewer = row({
    id: 5,
    kind: 'compaction',
    content: '## Primary Request and Intent\n- new goal',
    created_at: 300,
  })

  it('orders global manual → workspace manual → session notes → checkpoints (newest first)', () => {
    const output = block([checkpoint, sessionNote, workspaceNote, globalNote, checkpointNewer], { maxChars: 100000 })
    const order = [
      output.indexOf('<note id="1" scope="global">'),
      output.indexOf('<note id="2" scope="workspace">'),
      output.indexOf('<note id="3" scope="session">'),
      output.indexOf('<checkpoint id="5"'),
      output.indexOf('<checkpoint id="4"'),
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0)
  })

  it('renders checkpoints with filtered persistent sections and the fixed header/guidance', () => {
    const output = block([checkpoint], { maxChars: 100000 })
    expect(output).toContain('## Project Memory')
    expect(output).toContain('Knowledge from previous sessions. May be stale; correct via memory_write.')
    expect(output).toContain('<project-memory>')
    expect(output).toContain('</project-memory>')
    expect(output).toContain('<checkpoint id="4" session="" date="1970-01-01">')
    expect(output).toContain('## Primary Request and Intent')
    expect(output).not.toContain('## Next Step')
    expect(output).toContain('- old goal')
  })

  it('trims from the tail under the char budget and reports the omitted count', () => {
    // 5 rows but a budget that fits only the first 4: the oldest checkpoint drops.
    const output = block([globalNote, workspaceNote, sessionNote, checkpoint, checkpointNewer], { maxChars: 450 })
    expect(output).toContain('<note id="1"')
    expect(output).toContain('<note id="3"')
    expect(output).toContain('<checkpoint id="5"')
    expect(output).not.toContain('<checkpoint id="4"')
    expect(output).toContain('(1 older memories omitted)')
  })

  it('renders an oversized single row as zero rows with the full omitted count (hard budget cap)', () => {
    const huge = 'x'.repeat(5000)
    const output = block([row({ id: 9, kind: 'manual', content: huge, workspace: null, created_at: 1 })], { maxChars: 200 })
    expect(output).not.toContain(huge)
    expect(output).toContain('<project-memory>')
    expect(output).toContain('</project-memory>')
    expect(output).toContain('(1 older memories omitted)')
  })

  it('renders a single row within the budget normally', () => {
    const output = block([row({ id: 9, kind: 'manual', content: 'small note', workspace: null, created_at: 1 })], { maxChars: 5000 })
    expect(output).toContain('<note id="9" scope="global">small note</note>')
    expect(output).not.toContain('omitted')
  })

  it('returns empty for an empty store', () => {
    expect(block([], { maxChars: 6000 })).toBe('')
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