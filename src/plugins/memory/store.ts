/**
 * dsh-memory sqlite storage: one node:sqlite DatabaseSync over a single
 * memory.db file. Every SQL statement lives in this module; the file path
 * resolution and lazy directory creation stay in the plugin entry, so tests
 * inject a `:memory:` database and never touch the filesystem.
 */
import { DatabaseSync } from 'node:sqlite'
import type { ManualScope, MemoryBlockRow } from './pure.ts'

/** Compaction harvest payload: the summary event's identity plus its text. */
export interface InsertCompactionInput {
  readonly workspace: string
  /** Owning session; null when the event carries no session identity. */
  readonly sessionId: string | null
  readonly content: string
  /** The checkpoint user/message event's seq — the idempotency key (UNIQUE). */
  readonly sourceEventSeq: number
  /** The checkpoint's sourceEventSeqs ([startSeq, summarySeq, ...shadowedSeqs]), JSON-stringified into `shadowed_event_seqs`. */
  readonly shadowedEventSeqs: readonly number[]
  readonly createdAt: number
}

/** One stored memory row as read back from sqlite (identity columns for supersession detection). */
export interface StoredMemoryRow extends MemoryBlockRow {
  readonly source_event_seq: number | null
  readonly shadowed_event_seqs: string | null
  readonly superseded_by: number | null
}

/** The DDL: memories table, active-row index, and the idempotency UNIQUE key. NULLs never collide, so manual rows (NULL seq) are unaffected by the unique index. */
const DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT,
  session_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('manual','compaction')),
  content TEXT NOT NULL,
  source_event_seq INTEGER,
  shadowed_event_seqs TEXT,
  superseded_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active ON memories(workspace, superseded_by, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_seq ON memories(workspace, source_event_seq);
`

/**
 * Memory storage over an injected sqlite database.
 * @param db - open DatabaseSync (file-backed in production, `:memory:` in tests).
 */
export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(DDL)
  }

  /** Insert one manual memory. Identification columns follow the scope: global → NULL workspace, session → session id, workspace → cwd hash. Workspace scope without a workspace key is a caller bug: never store (a NULL workspace would render as global). */
  insertManual(scope: ManualScope, opts: { content: string; sessionId?: string | null; workspace?: string | null }): number {
    const workspace = scope === 'global' ? null : (opts.workspace ?? null)
    if (scope === 'workspace' && workspace === null) {
      throw new Error('insertManual workspace scope requires a workspace key')
    }
    const sessionId = scope === 'session' ? (opts.sessionId ?? null) : null
    const result = this.db.prepare(
      'INSERT INTO memories (workspace, session_id, kind, content, source_event_seq, shadowed_event_seqs, superseded_by, created_at) '
      + 'VALUES (?, ?, \'manual\', ?, NULL, NULL, NULL, ?)',
    ).run(workspace, sessionId, opts.content, Date.now())
    return Number(result.lastInsertRowid)
  }

  /**
   * Insert one harvested compaction checkpoint. Idempotent on
   * (workspace, source_event_seq): a replayed/fired-again event inserts
   * nothing and returns null.
   * @returns the new row id, or null when the event was already harvested.
   */
  insertCompaction(input: InsertCompactionInput): number | null {
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO memories (workspace, session_id, kind, content, source_event_seq, shadowed_event_seqs, superseded_by, created_at) '
      + 'VALUES (?, ?, \'compaction\', ?, ?, ?, NULL, ?)',
    ).run(
      input.workspace,
      input.sessionId,
      input.content,
      input.sourceEventSeq,
      JSON.stringify(input.shadowedEventSeqs),
      input.createdAt,
    )
    return result.changes === 0 ? null : Number(result.lastInsertRowid)
  }

  /** Mark rows superseded by a newer checkpoint. @returns the number of rows updated. */
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
SELECT id, workspace, session_id, kind, content, source_event_seq, shadowed_event_seqs, superseded_by, created_at
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