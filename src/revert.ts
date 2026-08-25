import * as fs from "node:fs";
import Database from "better-sqlite3";
import { ObjectStore } from "./store";
import { getAction, barriersAfter, markReverted, insertRevertRecord, ActionRow } from "./db";
import { revertViaThreeWayMerge, removeCreatedContent } from "./merge";
import { splitLines } from "./diff";
import { sha256 } from "./hash";

export interface RevertResult {
  ok: boolean;
  conflict: boolean;
  message: string;
  barrierWarnings: string[];
  /** The file this revert targets, when the action had one. */
  filePath?: string;
  /** File content before and after the revert; `after: null` means deletion. */
  before?: string;
  after?: string | null;
  dryRun: boolean;
}

export interface RevertOptions {
  /** Compute the outcome and report it without touching disk or the log. */
  dryRun?: boolean;
  /** Formats file paths for the human-readable message (defaults to as-stored). */
  format?: (filePath: string) => string;
}

export function revertAction(
  db: Database.Database,
  store: ObjectStore,
  id: number,
  options: RevertOptions = {}
): RevertResult {
  const dryRun = options.dryRun === true;
  const show = options.format ?? ((value: string) => value);
  const action = getAction(db, id);
  if (!action) return fail(dryRun, `No action ${id} found.`);

  if (action.is_barrier) {
    return fail(
      dryRun,
      `Action ${id} ran ${action.tool_name} (${action.barrier_detail}) — it has no file state to revert. ` +
        `If a barrier like this ran after the file change you actually want undone, reverting that earlier ` +
        `file action is still safe for the files, but won't undo the ${action.tool_name} itself.`
    );
  }
  if (action.status === "aborted") {
    return fail(dryRun, `Action ${id} never completed (the tool call failed or was denied) — nothing to revert.`);
  }
  if (!action.file_path || action.status === "pending") {
    return fail(
      dryRun,
      `Action ${id} has no complete file snapshot to revert (still pending — did the agent's tool call ever finish?).`
    );
  }
  if (!action.post_hash && !action.pre_hash) {
    return fail(dryRun, `Action ${id} has no file snapshots recorded — nothing to revert.`);
  }
  if (action.status === "reverted") {
    return fail(
      dryRun,
      `Action ${id} was already reverted by action ${action.reverted_by}. ` +
        `To undo that revert, run: unwrite revert ${action.reverted_by}`
    );
  }

  const postHash: string | null = action.post_hash;
  const filePath = action.file_path;
  const warnings = barriersAfter(db, id).map(
    (b) => `action ${b.id} ran ${b.tool_name} (${b.barrier_detail}) — reverting these files won't undo that.`
  );

  let currentContent: string | null;
  try {
    currentContent = fs.readFileSync(filePath, "utf8");
  } catch {
    currentContent = null;
  }
  const currentHash = currentContent !== null ? sha256(currentContent) : null;

  let outcomeContent: string | null;
  let conflict = false;
  let message: string;
  // Dry runs describe what would happen; real runs describe what did.
  const v = (past: string, future: string) => (dryRun ? `Would ${future}` : past);

  if (postHash === null) {
    // This action deleted the file (an unwrite revert of a creation is the
    // usual source). Reverting it puts the file back.
    if (currentContent !== null) {
      return fail(
        dryRun,
        `${show(filePath)} exists again, so action ${id}'s deletion has already been undone by something else.`,
        warnings
      );
    }
    outcomeContent = store.get(action.pre_hash!);
    message = `${v("Restored", "restore")} ${show(filePath)} (deleted by action ${id}).`;
  } else if (action.pre_hash === null) {
    // This action created the file, so reverting it means removing what it added.
    if (currentContent === null) {
      return fail(dryRun, `${show(filePath)} is already gone — action ${id} has nothing left to revert.`, warnings);
    }
    if (currentHash === postHash) {
      outcomeContent = null;
      message = `${v("Deleted", "delete")} ${show(filePath)} (created by action ${id}, untouched since).`;
    } else {
      // Later edits exist: strip the lines this action contributed and keep
      // everything that arrived afterwards.
      const remaining = removeCreatedContent(store.get(postHash), currentContent);
      if (remaining === "") {
        outcomeContent = null;
        message = `${v("Deleted", "delete")} ${show(filePath)} — every line action ${id} created is backed out and nothing else remains.`;
      } else {
        outcomeContent = remaining;
        const kept = splitLines(remaining).length;
        message = `${v("Removed", "remove")} action ${id}'s creation of ${show(filePath)}, keeping the ${kept} line(s) written after it.`;
      }
    }
  } else if (currentContent === null) {
    return fail(
      dryRun,
      `${show(filePath)} no longer exists on disk — cannot revert action ${id} onto a missing file.`,
      warnings
    );
  } else if (currentHash === postHash) {
    // Untouched since this action: direct restore, no merge needed.
    outcomeContent = store.get(action.pre_hash);
    message = `${v("Reverted", "revert")} action ${id} on ${show(filePath)} (no later edits to that file — restored directly).`;
  } else {
    const merged = revertViaThreeWayMerge(currentContent, store.get(postHash), store.get(action.pre_hash), id);
    conflict = merged.conflict;
    outcomeContent = merged.content;
    message = conflict
      ? `Reverting action ${id} on ${show(filePath)} conflicts with later edits. Conflict markers ` +
        (dryRun ? "would be written into the file." : "were written into the file — resolve them like a normal merge conflict, then save.")
      : `${v("Reverted", "revert")} action ${id} on ${show(filePath)} via three-way merge — later edits to that file are preserved.`;
  }

  const result: RevertResult = {
    ok: !conflict,
    conflict,
    message,
    barrierWarnings: warnings,
    filePath,
    before: currentContent ?? "",
    after: outcomeContent,
    dryRun,
  };

  if (dryRun) return result;

  if (outcomeContent === null) {
    fs.unlinkSync(filePath);
  } else {
    fs.writeFileSync(filePath, outcomeContent, "utf8");
  }

  // A conflicted merge is written out so it can be resolved by hand, but the
  // action stays un-reverted: the undo isn't finished until a human says so.
  if (!conflict) {
    const newHash = outcomeContent === null ? null : store.put(outcomeContent);
    recordRevert(db, action, filePath, currentHash, newHash);
  }

  return result;
}

function fail(dryRun: boolean, message: string, barrierWarnings: string[] = []): RevertResult {
  return { ok: false, conflict: false, message, barrierWarnings, dryRun };
}


function recordRevert(
  db: Database.Database,
  original: ActionRow,
  filePath: string,
  // Null when the file did not exist before this revert, exactly as it is for
  // an action that creates a file — so reverting this row deletes it again.
  preHash: string | null,
  postHash: string | null
): void {
  const revertId = insertRevertRecord(db, {
    timestamp: new Date().toISOString(),
    file_path: filePath,
    pre_hash: preHash,
    post_hash: postHash,
    intent: `revert of action ${original.id}`,
  });
  markReverted(db, original.id, revertId);
}
