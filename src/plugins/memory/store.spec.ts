import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, type InsertCompactionInput } from './store.ts'
import { detectSupersession } from './pure.ts'

const WORKSPACE_A = 'aaaa000000000000'
const WORKSPACE_B = 'bbbb000000000000'

/** One compact checkpoint insert input with the given segments (still deterministic for replay). */
function checkpoint(
  workspace: string,
  sourceEventSeq: number,
  createdAt: number,
  segments: Array<{ content: string; heading: string | null; segmentIndex: number }>,
  opts: { sessionId?: string | null; shadowedEventSeqs?: readonly number[] } = {},
): InsertCompactionInput {
  return {
    workspace,
    sessionId: opts.sessionId ?? 's1',
    segments,
    sourceEventSeq,
    shadowedEventSeqs: opts.shadowedEventSeqs ?? [],
    createdAt,
  }
}

/** The two typical segments of one checkpoint (a whole + a split section). */
const TWO_SEGMENTS = [
  { content: '## Primary Request and Intent\n- goal', heading: 'Primary Request and Intent', segmentIndex: 0 },
  { content: '## Files and Code (cont. 1/2)\n- a.ts', heading: 'Files and Code', segmentIndex: 1 },
]

describe('MemoryStore over :memory:', () => {
  let db: DatabaseSync
  let store: MemoryStore

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    store = new MemoryStore(db)
  })

  it('creates the schema idempotently (a second store over the same db is fine)', () => {
    const second = new MemoryStore(db)
    expect(second.listActive(WORKSPACE_A, 's1')).toEqual([])
    expect(() => db.prepare('SELECT COUNT(*) AS n FROM memories').get()).not.toThrow()
  })

  it('inserts manual rows with the scope-derived identification columns (single segment, heading NULL)', () => {
    const globalId = store.insertManual('global', { content: 'pref' })
    const workspaceId = store.insertManual('workspace', { content: 'fact', workspace: WORKSPACE_A })
    const sessionId = store.insertManual('session', { content: 'note', workspace: WORKSPACE_A, sessionId: 's1' })
    const rows = store.listActive(WORKSPACE_A, 's1')
    expect(rows).toHaveLength(3)
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get(globalId)?.workspace).toBeNull()
    expect(byId.get(globalId)?.session_id).toBeNull()
    expect(byId.get(workspaceId)?.workspace).toBe(WORKSPACE_A)
    expect(byId.get(workspaceId)?.session_id).toBeNull()
    expect(byId.get(sessionId)?.workspace).toBe(WORKSPACE_A)
    expect(byId.get(sessionId)?.session_id).toBe('s1')
    for (const row of rows) {
      expect(row.kind).toBe('manual')
      expect(row.heading).toBeNull()
      expect(row.segment_index).toBe(0)
    }
  })

  it('refuses a workspace-scope insert without a workspace key (never falls back to global)', () => {
    expect(() => store.insertManual('workspace', { content: 'oops' })).toThrow(/workspace key/)
  })

  it('insertCompaction stores a whole group atomically, group-idempotent on (workspace, source_event_seq)', () => {
    const input = checkpoint(WORKSPACE_A, 10, 1000, TWO_SEGMENTS)
    const first = store.insertCompaction(input)
    expect(first).not.toBeNull()
    const rows = store.listActive(WORKSPACE_A, 's1')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.segment_index)).toEqual([1, 0]) // listActive order is created_at DESC, id DESC
    expect(rows.map(r => r.source_event_seq)).toEqual([10, 10])
    const again = store.insertCompaction(input)
    expect(again).toBeNull()
    expect(store.listActive(WORKSPACE_A, 's1')).toHaveLength(2)
  })

  it('returns null for an empty segment list (nothing to store)', () => {
    expect(store.insertCompaction(checkpoint(WORKSPACE_A, 10, 1000, []))).toBeNull()
  })

  it('group-level idempotency: a re-harvest with a different split never mutates the stored group', () => {
    const original = checkpoint(WORKSPACE_A, 10, 1000, TWO_SEGMENTS)
    expect(store.insertCompaction(original)).not.toBeNull()
    expect(store.listActive(WORKSPACE_A, 's1')).toHaveLength(2)
    // maxEntryChars changed between harvest attempts → the same summary now
    // splits into MORE segments with an overlapping tail index. The old
    // per-segment key would have spliced the re-split's extra segment onto
    // the stored group (chimeric text); the group gate must skip it all.
    const resplit = checkpoint(WORKSPACE_A, 10, 1000, [
      { content: '## Primary Request and Intent\n- goal', heading: 'Primary Request and Intent', segmentIndex: 0 },
      { content: '## Files and Code (cont. 1/3)\n- a.ts\n- b.ts', heading: 'Files and Code', segmentIndex: 1 },
      { content: '## Files and Code (cont. 2/3)\n- c.ts', heading: 'Files and Code', segmentIndex: 2 },
    ])
    expect(store.insertCompaction(resplit)).toBeNull()
    const rows = store.listActive(WORKSPACE_A, 's1')
    expect(rows).toHaveLength(2)
    // The stored rows are byte-identical to the original harvest, not the re-split.
    expect(rows.map(r => r.content).sort()).toEqual([
      '## Files and Code (cont. 1/2)\n- a.ts',
      '## Primary Request and Intent\n- goal',
    ])
  })

  it('lets the same seq land in different workspaces', () => {
    store.insertCompaction(checkpoint(WORKSPACE_A, 10, 1, TWO_SEGMENTS))
    const other = store.insertCompaction(checkpoint(WORKSPACE_B, 10, 2, TWO_SEGMENTS, { sessionId: 's2' }))
    expect(other).not.toBeNull()
  })

  it('migrates a legacy single-segment schema: old rows stay readable, the three-column key is enforced', () => {
    const legacy = new DatabaseSync(':memory:')
    legacy.exec(`
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT, session_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('manual','compaction')),
  content TEXT NOT NULL, source_event_seq INTEGER,
  shadowed_event_seqs TEXT, superseded_by INTEGER, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_unique_seq ON memories(workspace, source_event_seq);
`)
    legacy.prepare(
      'INSERT INTO memories (workspace, session_id, kind, content, source_event_seq, shadowed_event_seqs, superseded_by, created_at) '
      + 'VALUES (?, ?, \'compaction\', ?, ?, \'[]\', NULL, ?)',
    ).run(WORKSPACE_A, 's1', '## Primary Request and Intent\n- legacy blob', 10, 1000)
    const migrated = new MemoryStore(legacy) // the constructor migrates
    const indexes = (legacy.prepare('SELECT name FROM sqlite_master WHERE type = \'index\'').all() as Array<{ name: string }>)
      .map(index => index.name)
    expect(indexes).toContain('idx_unique_seg')
    expect(indexes).not.toContain('idx_unique_seq')
    // The pre-existing row behaves as a single segment (segment_index 0, no backfill).
    const rows = migrated.listActive(WORKSPACE_A, 's1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'compaction',
      heading: null,
      segment_index: 0,
      source_event_seq: 10,
      content: '## Primary Request and Intent\n- legacy blob',
    })
    // New groups insert alongside with full segment identity.
    const id = migrated.insertCompaction(checkpoint(WORKSPACE_A, 20, 2000, TWO_SEGMENTS))
    expect(id).not.toBeNull()
    expect(migrated.insertCompaction(checkpoint(WORKSPACE_A, 20, 2000, TWO_SEGMENTS))).toBeNull()
    expect(migrated.listActive(WORKSPACE_A, 's1')).toHaveLength(3)
    // Re-mounting the migrated db is a no-op (idempotent migration).
    expect(() => new MemoryStore(legacy)).not.toThrow()
  })

  it('markSuperseded hides rows from listActive', () => {
    store.insertCompaction(checkpoint(WORKSPACE_A, 10, 1, TWO_SEGMENTS))
    const b = store.insertCompaction(checkpoint(WORKSPACE_A, 11, 2, TWO_SEGMENTS))
    // Marking ids of the old group hides every segment with the seq.
    const ids = store.listActive(WORKSPACE_A, 's1').filter(r => r.source_event_seq === 10).map(r => r.id)
    expect(store.markSuperseded(ids, b as number)).toBe(2)
    const rows = store.listActive(WORKSPACE_A, 's1')
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.source_event_seq === 11)).toBe(true)
    // Idempotent re-mark updates nothing.
    expect(store.markSuperseded(ids, b as number)).toBe(0)
  })

  it('supersession marks every segment of the shadowed group (detectSupersession → markSuperseded)', () => {
    const newId = store.insertCompaction(checkpoint(WORKSPACE_A, 20, 2000, TWO_SEGMENTS))
    store.insertCompaction(checkpoint(WORKSPACE_A, 10, 1000, TWO_SEGMENTS))
    const rows = store.listActive(WORKSPACE_A, 's1')
    expect(rows).toHaveLength(4)
    const targets = detectSupersession([10], rows.map(r => ({
      id: r.id, kind: r.kind, source_event_seq: r.source_event_seq, superseded_by: r.superseded_by,
    })))
    expect(targets).toHaveLength(2) // both segments of the old group
    expect(store.markSuperseded(targets, newId as number)).toBe(2)
    const active = store.listActive(WORKSPACE_A, 's1')
    expect(active).toHaveLength(2)
    expect(active.every(r => r.source_event_seq === 20)).toBe(true)
  })

  it('listActive scopes by workspace and session, including global rows', () => {
    store.insertManual('global', { content: 'global pref' })
    store.insertManual('workspace', { content: 'workspace fact', workspace: WORKSPACE_A })
    store.insertManual('workspace', { content: 'other fact', workspace: WORKSPACE_B })
    store.insertManual('session', { content: 'my note', workspace: WORKSPACE_A, sessionId: 's1' })
    store.insertManual('session', { content: 'their note', workspace: WORKSPACE_A, sessionId: 's2' })

    const mine = store.listActive(WORKSPACE_A, 's1').map(r => r.content)
    expect(mine).toContain('global pref')
    expect(mine).toContain('workspace fact')
    expect(mine).toContain('my note')
    expect(mine).not.toContain('other fact')
    expect(mine).not.toContain('their note')

    const otherWorkspace = store.listActive(WORKSPACE_B, 'sX').map(r => r.content)
    expect(otherWorkspace).toEqual(['other fact', 'global pref'])
  })

  it('listActive newest-first and keyword filters content', () => {
    store.insertManual('workspace', { content: 'alpha first', workspace: WORKSPACE_A })
    store.insertManual('workspace', { content: 'beta second', workspace: WORKSPACE_A })
    const rows = store.listActive(WORKSPACE_A, 's1')
    expect(rows[0]?.content).toBe('beta second')
    expect(store.listActive(WORKSPACE_A, 's1', 'alpha').map(r => r.content)).toEqual(['alpha first'])
    expect(store.listActive(WORKSPACE_A, 's1', 'zzz')).toEqual([])
  })

  it('deleteSessionRows removes only that session\'s manual notes, keeping its checkpoints', () => {
    store.insertManual('session', { content: 'note', workspace: WORKSPACE_A, sessionId: 's1' })
    store.insertManual('session', { content: 'other note', workspace: WORKSPACE_A, sessionId: 's2' })
    const checkpointId = store.insertCompaction(checkpoint(WORKSPACE_A, 5, 1, TWO_SEGMENTS))
    expect(store.deleteSessionRows('s1')).toBe(1)
    const mine = store.listActive(WORKSPACE_A, 's1')
    expect(mine.map(r => r.kind)).toEqual(['compaction', 'compaction'])
    expect(mine.every(r => r.source_event_seq === 5)).toBe(true)
    const sibling = store.listActive(WORKSPACE_A, 's2').map(r => r.content)
    expect(sibling).toContain('other note')
    expect(sibling.join('\n')).toContain('- a.ts')
  })

  it('deleteById removes exactly one row', () => {
    const id = store.insertManual('workspace', { content: 'fact', workspace: WORKSPACE_A })
    expect(store.deleteById(id)).toBe(1)
    expect(store.listActive(WORKSPACE_A, 's1')).toEqual([])
    expect(store.deleteById(id)).toBe(0)
  })
})