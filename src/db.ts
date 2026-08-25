import Database from "better-sqlite3";
import { dbPath, ensureUnwriteRoot } from "./paths";

export interface ActionRow {
  id: number;
  tool_use_id: string | null;
  session_id: string | null;
  timestamp: string;
  tool_name: string;
  file_path: string | null;
  pre_hash: string | null;
  post_hash: string | null;
  intent: string | null;
  is_barrier: number;
  barrier_detail: string | null;
  status: "pending" | "complete" | "reverted" | "aborted";
  reverted_by: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_use_id TEXT,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  file_path TEXT,
  pre_hash TEXT,
  post_hash TEXT,
  intent TEXT,
  is_barrier INTEGER NOT NULL DEFAULT 0,
  barrier_detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reverted_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_actions_tool_use_id ON actions(tool_use_id);
CREATE INDEX IF NOT EXISTS idx_actions_file_path ON actions(file_path);
CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id);
`;

export function openDb(unwriteRoot: string): Database.Database {
  ensureUnwriteRoot(unwriteRoot);
  const db = new Database(dbPath(unwriteRoot));
  db.pragma("journal_mode = WAL");
  // Two hooks can fire close together; wait rather than throwing SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

export function insertPending(
  db: Database.Database,
  row: Pick<
    ActionRow,
    "tool_use_id" | "session_id" | "timestamp" | "tool_name" | "file_path" | "pre_hash" | "intent"
  >
): number {
  const stmt = db.prepare(
    `INSERT INTO actions (tool_use_id, session_id, timestamp, tool_name, file_path, pre_hash, intent, status)
     VALUES (@tool_use_id, @session_id, @timestamp, @tool_name, @file_path, @pre_hash, @intent, 'pending')`
  );
  const info = stmt.run(row);
  return Number(info.lastInsertRowid);
}

export function completeByToolUseId(db: Database.Database, toolUseId: string, postHash: string): void {
  db.prepare(
    `UPDATE actions SET post_hash = ?, status = 'complete' WHERE tool_use_id = ? AND status = 'pending'`
  ).run(postHash, toolUseId);
}

/**
 * The tool call errored or was denied, so the pre-snapshot describes a change
 * that never happened. Marking it aborted keeps it out of `list` and `revert`
 * while preserving the record that the agent tried.
 */
export function abortByToolUseId(db: Database.Database, toolUseId: string): void {
  db.prepare(`UPDATE actions SET status = 'aborted' WHERE tool_use_id = ? AND status = 'pending'`).run(
    toolUseId
  );
}

export function insertBarrier(
  db: Database.Database,
  row: Pick<ActionRow, "tool_use_id" | "session_id" | "timestamp" | "tool_name" | "barrier_detail" | "intent">
): number {
  const stmt = db.prepare(
    `INSERT INTO actions (tool_use_id, session_id, timestamp, tool_name, barrier_detail, intent, is_barrier, status)
     VALUES (@tool_use_id, @session_id, @timestamp, @tool_name, @barrier_detail, @intent, 1, 'complete')`
  );
  const info = stmt.run(row);
  return Number(info.lastInsertRowid);
}

export interface ListFilter {
  limit?: number;
  filePath?: string;
  sessionId?: string;
  since?: string;
  includeBarriers?: boolean;
  includeAborted?: boolean;
}

export function listActions(db: Database.Database, filter: ListFilter = {}): ActionRow[] {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.filePath) {
    where.push("file_path = ?");
    params.push(filter.filePath);
  }
  if (filter.sessionId) {
    where.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.since) {
    where.push("timestamp >= ?");
    params.push(filter.since);
  }
  if (filter.includeBarriers === false) where.push("is_barrier = 0");
  if (filter.includeAborted !== true) where.push("status != 'aborted'");

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(filter.limit ?? 50);
  return db.prepare(`SELECT * FROM actions ${clause} ORDER BY id DESC LIMIT ?`).all(...params) as ActionRow[];
}

export function getAction(db: Database.Database, id: number): ActionRow | undefined {
  return db.prepare(`SELECT * FROM actions WHERE id = ?`).get(id) as ActionRow | undefined;
}

/** Chronological history of one file, oldest first — the input to `blame`. */
export function fileHistory(db: Database.Database, filePath: string): ActionRow[] {
  return db
    .prepare(
      `SELECT * FROM actions
       WHERE file_path = ? AND is_barrier = 0 AND post_hash IS NOT NULL AND status != 'aborted'
       ORDER BY id ASC`
    )
    .all(filePath) as ActionRow[];
}

/** Free-text search across recorded intent, file path and barrier command. */
export function searchActions(db: Database.Database, query: string, limit = 25): ActionRow[] {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT * FROM actions
       WHERE status != 'aborted'
         AND (intent LIKE ? OR file_path LIKE ? OR barrier_detail LIKE ? OR tool_name LIKE ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(like, like, like, like, limit) as ActionRow[];
}

export function barriersAfter(db: Database.Database, id: number): ActionRow[] {
  return db
    .prepare(`SELECT * FROM actions WHERE id > ? AND is_barrier = 1 ORDER BY id ASC`)
    .all(id) as ActionRow[];
}

export function markReverted(db: Database.Database, originalId: number, revertRowId: number): void {
  db.prepare(`UPDATE actions SET status = 'reverted', reverted_by = ? WHERE id = ?`).run(
    revertRowId,
    originalId
  );
}

export function insertRevertRecord(
  db: Database.Database,
  row: Pick<ActionRow, "timestamp" | "file_path" | "pre_hash" | "post_hash" | "intent">
): number {
  const stmt = db.prepare(
    `INSERT INTO actions (timestamp, tool_name, file_path, pre_hash, post_hash, intent, status)
     VALUES (@timestamp, 'unwrite:revert', @file_path, @pre_hash, @post_hash, @intent, 'complete')`
  );
  const info = stmt.run(row);
  return Number(info.lastInsertRowid);
}

/** Every hash still referenced by a row — anything else in objects/ is garbage. */
export function referencedHashes(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT pre_hash, post_hash FROM actions WHERE pre_hash IS NOT NULL OR post_hash IS NOT NULL`)
    .all() as { pre_hash: string | null; post_hash: string | null }[];
  const set = new Set<string>();
  for (const row of rows) {
    if (row.pre_hash) set.add(row.pre_hash);
    if (row.post_hash) set.add(row.post_hash);
  }
  return set;
}

export interface Stats {
  total: number;
  edits: number;
  barriers: number;
  reverted: number;
  pending: number;
  files: number;
  sessions: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  topFiles: { file_path: string; edits: number }[];
}

export function stats(db: Database.Database): Stats {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(is_barrier = 0) AS edits,
         SUM(is_barrier = 1) AS barriers,
         SUM(status = 'reverted') AS reverted,
         SUM(status = 'pending') AS pending,
         COUNT(DISTINCT file_path) AS files,
         COUNT(DISTINCT session_id) AS sessions,
         MIN(timestamp) AS firstTimestamp,
         MAX(timestamp) AS lastTimestamp
       FROM actions WHERE status != 'aborted'`
    )
    .get() as Omit<Stats, "topFiles">;
  const topFiles = db
    .prepare(
      `SELECT file_path, COUNT(*) AS edits FROM actions
       WHERE file_path IS NOT NULL AND is_barrier = 0 AND status != 'aborted'
       GROUP BY file_path ORDER BY edits DESC LIMIT 5`
    )
    .all() as { file_path: string; edits: number }[];
  return {
    ...counts,
    edits: counts.edits ?? 0,
    barriers: counts.barriers ?? 0,
    reverted: counts.reverted ?? 0,
    pending: counts.pending ?? 0,
    topFiles,
  };
}

export function pendingActions(db: Database.Database): ActionRow[] {
  return db.prepare(`SELECT * FROM actions WHERE status = 'pending' ORDER BY id ASC`).all() as ActionRow[];
}
