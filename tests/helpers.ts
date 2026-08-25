import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb } from "../src/db";
import { ensureUnwriteRoot } from "../src/paths";
import { ObjectStore } from "../src/store";
import { runPreToolUse } from "../src/hooks/pre-tool-use";
import { runPostToolUse } from "../src/hooks/post-tool-use";
import { HookInput } from "../src/types";

export interface Workspace {
  dir: string;
  unwriteRoot: string;
  db: ReturnType<typeof openDb>;
  store: ObjectStore;
  file(name: string): string;
  read(name: string): string;
  exists(name: string): boolean;
  write(name: string, content: string): void;
  /** Simulates a full Claude Code tool call: PreToolUse, the write, PostToolUse. */
  agentWrite(name: string, content: string, intent?: string): void;
  /** Simulates a tool call that Claude Code reported as failed. */
  agentFailedWrite(name: string, content: string): void;
  agentBash(command: string): void;
  cleanup(): void;
}

let counter = 0;

export function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unwrite-test-"));
  const unwriteRoot = path.join(dir, ".unwrite");
  ensureUnwriteRoot(unwriteRoot);
  const db = openDb(unwriteRoot);
  const store = new ObjectStore(unwriteRoot);

  const file = (name: string) => path.join(dir, name);

  const hook = (overrides: Partial<HookInput>): HookInput => ({
    session_id: "test-session",
    transcript_path: path.join(dir, "no-transcript.jsonl"),
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {},
    tool_use_id: `tool_${++counter}`,
    ...overrides,
  });

  return {
    dir,
    unwriteRoot,
    db,
    store,
    file,
    read: (name) => fs.readFileSync(file(name), "utf8"),
    exists: (name) => fs.existsSync(file(name)),
    write: (name, content) => fs.writeFileSync(file(name), content, "utf8"),

    agentWrite(name, content, intent) {
      const filePath = file(name);
      const input = hook({ tool_input: { file_path: filePath }, tool_name: "Write" });
      runPreToolUse(input);
      fs.writeFileSync(filePath, content, "utf8");
      runPostToolUse({ ...input, hook_event_name: "PostToolUse", tool_response: { success: true } });
      if (intent) {
        db.prepare(`UPDATE actions SET intent = ? WHERE tool_use_id = ?`).run(intent, input.tool_use_id);
      }
    },

    agentFailedWrite(name, content) {
      const filePath = file(name);
      const input = hook({ tool_input: { file_path: filePath } });
      runPreToolUse(input);
      runPostToolUse({
        ...input,
        hook_event_name: "PostToolUse",
        tool_response: { success: false, error: "String to replace not found in file." },
      });
    },

    agentBash(command) {
      runPreToolUse(hook({ tool_name: "Bash", tool_input: { command } }));
    },

    cleanup() {
      db.close();
      try {
        // Windows can hold the SQLite WAL files open a moment longer than the
        // connection; a leftover temp dir is not worth failing a test over.
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* ignore */
      }
    },
  };
}
