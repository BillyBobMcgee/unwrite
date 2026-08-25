export const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Pure reads never touch disk state and generate no meaningful undo target,
// so they're skipped entirely rather than logged as barriers.
export const SILENT_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "TodoWrite",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

export type ToolKind = "file-write" | "barrier" | "silent";

export function classifyTool(toolName: string): ToolKind {
  if (FILE_WRITE_TOOLS.has(toolName)) return "file-write";
  if (SILENT_TOOLS.has(toolName)) return "silent";
  return "barrier";
}

/**
 * File-writing tools don't agree on the parameter name: Write/Edit/MultiEdit
 * use `file_path`, NotebookEdit uses `notebook_path`. Missing either one means
 * there's nothing to snapshot.
 */
export function resolveFilePath(toolInput: any): string | null {
  const candidate = toolInput?.file_path ?? toolInput?.notebook_path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/**
 * Snapshots are stored and merged as UTF-8 text. A NUL byte means the file
 * isn't text, and round-tripping it through a string would corrupt it — such
 * files are left untracked rather than tracked incorrectly.
 */
export function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 8000);
  return window.includes(0);
}

export function barrierDetail(toolName: string, toolInput: any): string {
  if (toolName === "Bash") {
    const cmd = String(toolInput?.command ?? "").trim();
    return truncate(cmd);
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    return truncate(String(toolInput?.url ?? toolInput?.query ?? ""));
  }
  if (toolName === "Task") {
    return truncate(String(toolInput?.description ?? toolInput?.prompt ?? ""));
  }
  return truncate(JSON.stringify(toolInput ?? {}));
}

function truncate(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
