import Database from "better-sqlite3";
import { ActionRow } from "./db";
import { ObjectStore } from "./store";

/**
 * Finds the actions that introduced or removed a piece of text — the same
 * question `git log -S` answers, asked of agent actions instead of commits.
 *
 * An action counts as a hit when the number of occurrences of `query` differs
 * between its before and after snapshots, so edits that merely move the text
 * around don't produce noise.
 */
export function pickaxe(
  db: Database.Database,
  store: ObjectStore,
  query: string,
  limit = 25
): ActionRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM actions
       WHERE is_barrier = 0 AND status != 'aborted' AND file_path IS NOT NULL
       ORDER BY id DESC`
    )
    .all() as ActionRow[];

  const hits: ActionRow[] = [];
  for (const row of rows) {
    const before = read(store, row.pre_hash);
    const after = read(store, row.post_hash);
    if (occurrences(before, query) !== occurrences(after, query)) hits.push(row);
    if (hits.length >= limit) break;
  }
  return hits;
}

function read(store: ObjectStore, hash: string | null): string {
  if (!hash || !store.has(hash)) return "";
  try {
    return store.get(hash);
  } catch {
    return "";
  }
}

function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
