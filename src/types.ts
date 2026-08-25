export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "PreToolUse" | "PostToolUse";
  tool_name: string;
  tool_input: any;
  /** Present on PostToolUse only. Shape varies by tool. */
  tool_response?: any;
  tool_use_id: string;
}

/**
 * Reads the hook payload Claude Code writes to stdin.
 *
 * `readFileSync(0)` is the direct route, but on Windows a pipe that isn't
 * ready yet surfaces as EAGAIN, so fall back to draining /dev/stdin and
 * finally to an empty payload rather than crashing the agent's tool call.
 */
export function readHookInput(): HookInput {
  const fs = require("node:fs") as typeof import("node:fs");
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    try {
      raw = fs.readFileSync("/dev/stdin", "utf8");
    } catch {
      raw = "";
    }
  }
  return JSON.parse(raw || "{}");
}

/**
 * True when a PostToolUse response reports the tool call failed. A failed
 * call leaves the file untouched, so its pending row must not become a
 * revertible action.
 */
export function toolCallFailed(response: any): boolean {
  if (response == null) return false;
  if (typeof response === "string") return false;
  if (response.success === false) return true;
  if (response.error) return true;
  if (response.is_error === true) return true;
  return false;
}
