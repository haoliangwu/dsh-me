import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from './store.ts'

const WORKSPACE_A = 'aaaa000000000000'
const WORKSPACE_B = 'bbbb000000000000'

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

  it('inserts manual rows with the scope-derived identification columns', () => {
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
    for (const row of rows) expect(row.kind).toBe('manual')
  })

  it('refuses a workspace-scope insert without a workspace key (never falls back to global)', () => {
    expect(() => store.insertManual('workspace', { content: 'oops' })).toThrow(/workspace key/)
  })

  it('insertCompaction is idempotent on (workspace, source_event_seq)', () => {
    const input = {
      workspace: WORKSPACE_A,
      sessionId: 's1',
      content: '## Primary Request and Intent\n- goal',
      sourceEventSeq: 10,
      shadowedEventSeqs: [1, 2, 3],
      createdAt: 1000,
    }
    const first = store.insertCompaction(input)
    expect(first).not.toBeNull()
    const again = store.insertCompaction(input)
    expect(again).toBeNull()
    expect(store.listActive(WORKSPACE_A, 's1')).toHaveLength(1)
  })

  it('lets the same seq land in different workspaces', () => {
    store.insertCompaction({ workspace: WORKSPACE_A, sessionId: 's1', content: 'a', sourceEventSeq: 10, shadowedEventSeqs: [], createdAt: 1 })
    const other = store.insertCompaction({ workspace: WORKSPACE_B, sessionId: 's2', content: 'b', sourceEventSeq: 10, shadowedEventSeqs: [], createdAt: 2 })
    expect(other).not.toBeNull()
  })

  it('markSuperseded hides rows from listActive', () => {
    const a = store.insertCompaction({ workspace: WORKSPACE_A, sessionId: 's1', content: 'one', sourceEventSeq: 10, shadowedEventSeqs: [], createdAt: 1 })
    const b = store.insertCompaction({ workspace: WORKSPACE_A, sessionId: 's1', content: 'two', sourceEventSeq: 11, shadowedEventSeqs: [], createdAt: 2 })
    expect(store.markSuperseded([a as number], b as number)).toBe(1)
    const rows = store.listActive(WORKSPACE_A, 's1')
    expect(rows.map(r => r.id)).toEqual([b])
    // Idempotent re-mark updates nothing.
    expect(store.markSuperseded([a as number], b as number)).toBe(0)
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
    const checkpoint = store.insertCompaction({ workspace: WORKSPACE_A, sessionId: 's1', content: 'ckpt', sourceEventSeq: 5, shadowedEventSeqs: [], createdAt: 1 })
    expect(store.deleteSessionRows('s1')).toBe(1)
    // s1's own note is gone; its workspace checkpoints survive.
    const mine = store.listActive(WORKSPACE_A, 's1')
    expect(mine.map(r => r.kind)).toEqual(['compaction'])
    expect(mine.map(r => r.id)).toEqual([checkpoint])
    // A sibling session still sees its own note plus the workspace checkpoint.
    const sibling = store.listActive(WORKSPACE_A, 's2').map(r => r.content)
    expect(sibling).toContain('other note')
    expect(sibling).toContain('ckpt')
  })

  it('deleteById removes exactly one row', () => {
    const id = store.insertManual('workspace', { content: 'fact', workspace: WORKSPACE_A })
    expect(store.deleteById(id)).toBe(1)
    expect(store.listActive(WORKSPACE_A, 's1')).toEqual([])
    expect(store.deleteById(id)).toBe(0)
  })
})