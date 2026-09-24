/**
 * dsh-memory sqlite storage: one node:sqlite DatabaseSync over a single
 * memory.db file. Every SQL statement lives in this module; the file path
 * resolution and lazy directory creation stay in the plugin entry, so tests
 * inject a `:memory:` database and never touch the filesystem.
 *
 * Migration: legacy databases (pre-segmentation, single-row-per-checkpoint)
 * gain the `heading` / `segment_index` columns via ALTER TABLE and the unique
 * key becomes (workspace, source_event_seq, segment_index). Legacy rows keep
 * segment_index 0 — they behave as single-segment entries, aged out by
 * supersession / pool caps like everything else. No backfill.
 */
import { DatabaseSync } from 'node:sqlite'
import type { ManualScope, MemoryBlockRow, MemorySegment } from './pure.ts'

/**
 * One harvested segment's persisted columns — one concept, one name: the
 * store rows carry the harvest split byte-for-byte, so the input type is the
 * pure {@link MemorySegment} itself.
 */
export type CompactionSegmentInput = MemorySegment

/** Compaction harvest payload: the summary event's identity plus its segments. */
export interface InsertCompactionInput {
  readonly workspace: string
  /** Owning session; null when the event carries no session identity. */
  readonly sessionId: string | null
  /** The checkpoint's segments in order (segment_index 0..N-1 across the whole group). */
  readonly segments: readonly CompactionSegmentInput[]
  /** The checkpoint user/message event's seq — part of the idempotency key (UNIQUE). */
  readonly sourceEventSeq: number
  /** The checkpoint's sourceEventSeqs ([startSeq, summarySeq, ...shadowedSeqs]), JSON-stringified into `shadowed_event_seqs`. */
  readonly shadowedEventSeqs: readonly number[]
  readonly createdAt: number
}

/** One stored memory row as read back from sqlite (identity columns for supersession detection). */
export interface StoredMemoryRow extends MemoryBlockRow {
  readonly shadowed_event_seqs: string | null
  readonly superseded_by: number | null
}

/** The DDL (fresh databases): memories table and the active-row index. The three-column unique index is created in `migrate` — it references `segment_index`, which legacy tables lack. NULLs never collide, so manual rows (NULL seq) are unaffected by the unique index. */
const DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT,
  session_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('manual','compaction')),
  content TEXT NOT NULL,
  heading TEXT,
  segment_index INTEGER NOT NULL DEFAULT 0,
  source_event_seq INTEGER,
  shadowed_event_seqs TEXT,
  superseded_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active ON memories(workspace, superseded_by, created_at DESC);
`

/**
 * Bring a database in line with the current schema: add the two segmentation
 * columns to legacy tables, retire the old (workspace, source_event_seq)
 * unique index, and ensure the three-column unique index exists. Idempotent —
 * runs on every boot.
 */
function migrate(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(column => column.name),
  )
  if (!columns.has('heading')) db.exec('ALTER TABLE memories ADD COLUMN heading TEXT')
  if (!columns.has('segment_index')) db.exec('ALTER TABLE memories ADD COLUMN segment_index INTEGER NOT NULL DEFAULT 0')
  db.exec('DROP INDEX IF EXISTS idx_unique_seq')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_seg ON memories(workspace, source_event_seq, segment_index)')
}

/**
 * Memory storage over an injected sqlite database.
 * @param db - open DatabaseSync (file-backed in production, `:memory:` in tests).
 */
export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(DDL)
    migrate(db)
  }

  /** Insert one manual memory. Identification columns follow the scope: global → NULL workspace, session → session id, workspace → cwd hash. Workspace scope without a workspace key is a caller bug: never store (a NULL workspace would render as global). Manual rows are always single segments (heading NULL, segment_index 0). */
  insertManual(scope: ManualScope, opts: { content: string; sessionId?: string | null; workspace?: string | null }): number {
    const workspace = scope === 'global' ? null : (opts.workspace ?? null)
    if (scope === 'workspace' && workspace === null) {
      throw new Error('insertManual workspace scope requires a workspace key')
    }
    const sessionId = scope === 'session' ? (opts.sessionId ?? null) : null
    const result = this.db.prepare(
      'INSERT INTO memories (workspace, session_id, kind, content, heading, segment_index, source_event_seq, shadowed_event_seqs, superseded_by, created_at) '
      + 'VALUES (?, ?, \'manual\', ?, NULL, 0, NULL, NULL, NULL, ?)',
    ).run(workspace, sessionId, opts.content, Date.now())
    return Number(result.lastInsertRowid)
  }

  /**
   * Insert one harvested compaction checkpoint as a segment group. Idempotent
   * at GROUP level on (workspace, source_event_seq): when any segment of the
   * event already exists, the whole insert is skipped and null returned —
   * replay AND re-harvest (even when a changed maxEntryChars re-splits the
   * summary into a different segment set) never mutate the stored group. All
   * segments go in one transaction, so a partially-harvested group never
   * persists.
   * @returns the first new row id (group representative), or null when the event was already harvested.
   */
  insertCompaction(input: InsertCompactionInput): number | null {
    if (input.segments.length === 0) return null
    // Group-level idempotency gate: the per-segment unique key alone would
    // let a differently-split re-harvest insert its extra tail segments over
    // the old ones, splicing two splittings into one chimeric group.
    const alreadyHarvested = this.db.prepare(
      'SELECT 1 FROM memories WHERE workspace = ? AND source_event_seq = ? LIMIT 1',
    ).get(input.workspace, input.sourceEventSeq)
    if (alreadyHarvested !== undefined) return null
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO memories (workspace, session_id, kind, content, heading, segment_index, source_event_seq, shadowed_event_seqs, superseded_by, created_at) '
      + 'VALUES (?, ?, \'compaction\', ?, ?, ?, ?, ?, NULL, ?)',
    )
    let firstId: number | null = null
    let changes = 0
    this.db.exec('BEGIN')
    try {
      for (const segment of input.segments) {
        const result = insert.run(
          input.workspace,
          input.sessionId,
          segment.content,
          segment.heading,
          segment.segmentIndex,
          input.sourceEventSeq,
          JSON.stringify(input.shadowedEventSeqs),
          input.createdAt,
        )
        changes += Number(result.changes)
        if (firstId === null && Number(result.changes) > 0) firstId = Number(result.lastInsertRowid)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return changes === 0 ? null : firstId
  }

  /** Mark rows superseded by a newer checkpoint (per-row marking covers the whole group: every segment shares the seq). @returns the number of rows updated. */
  markSuperseded(ids: readonly number[], byId: number): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const result = this.db.prepare(
      `UPDATE memories SET superseded_by = ? WHERE id IN (${placeholders}) AND superseded_by IS NULL`,
    ).run(byId, ...ids)
    return Number(result.changes)
  }

  /** Active rows visible to one workspace/session scope, newest first, superseded rows excluded. Global rows match everywhere; session notes match only their own session. */
  listActive(workspace: string | null, sessionId: string | null, keyword?: string): StoredMemoryRow[] {
    let sql = `
SELECT id, workspace, session_id, kind, content, heading, segment_index, source_event_seq, shadowed_event_seqs, superseded_by, created_at
FROM memories
WHERE superseded_by IS NULL AND (
  workspace IS NULL
  OR (kind = 'compaction' AND workspace = ?)
  OR (kind = 'manual' AND session_id IS NULL AND workspace = ?)
  OR (kind = 'manual' AND session_id = ?)
)`
    const params: Array<string | null> = [workspace, workspace, sessionId]
    if (keyword !== undefined && keyword !== '') {
      sql += ' AND content LIKE ?'
      params.push(`%${keyword}%`)
    }
    sql += ' ORDER BY created_at DESC, id DESC'
    return this.db.prepare(sql).all(...params) as unknown as StoredMemoryRow[]
  }

  /** Delete one memory by id (memory_forget). @returns rows deleted. */
  deleteById(id: number): number {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return Number(result.changes)
  }

  /** Drop one session's session-scoped notes (session/disposed cleanup); workspace checkpoints survive. @returns rows deleted. */
  deleteSessionRows(sessionId: string): number {
    const result = this.db.prepare('DELETE FROM memories WHERE session_id = ? AND kind = \'manual\'').run(sessionId)
    return Number(result.changes)
  }
}