import * as fs from "node:fs";
import { findExistingUnwriteRoot } from "../paths";
import { openDb, completeByToolUseId, abortByToolUseId } from "../db";
import { ObjectStore } from "../store";
import { classifyTool, resolveFilePath, looksBinary } from "../classify";
import { HookInput, toolCallFailed } from "../types";

export function runPostToolUse(input: HookInput): void {
  const unwriteRoot = findExistingUnwriteRoot(input.cwd);
  if (!unwriteRoot) return;

  if (classifyTool(input.tool_name) !== "file-write") return;

  const filePath = resolveFilePath(input.tool_input);
  if (!filePath) return;

  const db = openDb(unwriteRoot);

  // The write never happened, so the pending row would describe a change that
  // doesn't exist on disk. Retire it instead of completing it.
  if (toolCallFailed(input.tool_response)) {
    abortByToolUseId(db, input.tool_use_id);
    return;
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    // File vanished post-write (a Write immediately followed by a delete, say).
    abortByToolUseId(db, input.tool_use_id);
    return;
  }
  if (looksBinary(buffer)) {
    abortByToolUseId(db, input.tool_use_id);
    return;
  }

  const store = new ObjectStore(unwriteRoot);
  const postHash = store.put(buffer.toString("utf8"));
  completeByToolUseId(db, input.tool_use_id, postHash);
}
