import * as fs from "node:fs";
import { findExistingUnwriteRoot } from "../paths";
import { openDb, insertPending, insertBarrier } from "../db";
import { ObjectStore } from "../store";
import { classifyTool, barrierDetail, resolveFilePath, looksBinary } from "../classify";
import { extractIntent } from "../intent";
import { HookInput } from "../types";

export function runPreToolUse(input: HookInput): void {
  const unwriteRoot = findExistingUnwriteRoot(input.cwd);
  if (!unwriteRoot) return; // project never ran `unwrite init` — no-op

  const kind = classifyTool(input.tool_name);
  if (kind === "silent") return;

  const db = openDb(unwriteRoot);
  const timestamp = new Date().toISOString();
  const intent = safeExtractIntent(input.transcript_path, input.tool_use_id);

  if (kind === "barrier") {
    insertBarrier(db, {
      tool_use_id: input.tool_use_id,
      session_id: input.session_id,
      timestamp,
      tool_name: input.tool_name,
      barrier_detail: barrierDetail(input.tool_name, input.tool_input),
      intent,
    });
    return;
  }

  // file-write: capture pre-state by reading the file as it stands right now
  const filePath = resolveFilePath(input.tool_input);
  if (!filePath) return;

  const store = new ObjectStore(unwriteRoot);
  let preHash: string | null = null;
  try {
    const buffer = fs.readFileSync(filePath);
    // Snapshots round-trip through UTF-8 strings; binary would be corrupted.
    if (looksBinary(buffer)) return;
    preHash = store.put(buffer.toString("utf8"));
  } catch {
    preHash = null; // file doesn't exist yet — this action creates it
  }

  insertPending(db, {
    tool_use_id: input.tool_use_id,
    session_id: input.session_id,
    timestamp,
    tool_name: input.tool_name,
    file_path: filePath,
    pre_hash: preHash,
    intent,
  });
}

function safeExtractIntent(transcriptPath: string, toolUseId: string): string | null {
  try {
    return extractIntent(transcriptPath, toolUseId);
  } catch {
    return null;
  }
}
