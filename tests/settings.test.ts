import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  hookCommands,
  writeHookSettings,
  removeHookSettings,
  registeredHookCommands,
  readSettings,
  ensureGitignore,
} from "../src/settings";
import { classifyTool, resolveFilePath, looksBinary, barrierDetail } from "../src/classify";
import { toolCallFailed } from "../src/types";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "unwrite-settings-"));
}

test("init is idempotent: re-running never duplicates the hooks", () => {
  const dir = tempDir();
  const settingsPath = path.join(dir, ".claude", "settings.json");
  const commands = hookCommands(true, "irrelevant");

  writeHookSettings(settingsPath, commands);
  writeHookSettings(settingsPath, commands);
  writeHookSettings(settingsPath, commands);

  assert.deepEqual(registeredHookCommands(settingsPath, "PreToolUse"), ["unwrite hook pre"]);
  assert.deepEqual(registeredHookCommands(settingsPath, "PostToolUse"), ["unwrite hook post"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("existing unrelated hooks and settings survive init", () => {
  const dir = tempDir();
  const settingsPath = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      model: "opus",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] },
    })
  );

  writeHookSettings(settingsPath, hookCommands(true, "irrelevant"));

  const settings = readSettings(settingsPath);
  assert.equal(settings.model, "opus");
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "my-linter");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("uninstall removes only unwrite's hooks", () => {
  const dir = tempDir();
  const settingsPath = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] },
    })
  );
  writeHookSettings(settingsPath, hookCommands(true, "irrelevant"));

  assert.equal(removeHookSettings(settingsPath), true);
  const settings = readSettings(settingsPath);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "my-linter");
  assert.equal(settings.hooks.PostToolUse, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("absolute hook commands point at the running CLI", () => {
  const commands = hookCommands(false, "/opt/unwrite/dist/cli.js");
  assert.ok(commands.pre.includes("hook pre"));
  assert.ok(commands.pre.includes("cli.js"));
  assert.ok(commands.post.includes("hook post"));
});

test("gitignore entry is added once", () => {
  const dir = tempDir();
  const gitignore = path.join(dir, ".gitignore");
  assert.equal(ensureGitignore(gitignore), true);
  assert.equal(ensureGitignore(gitignore), false);
  assert.equal(fs.readFileSync(gitignore, "utf8"), ".unwrite/\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools are classified into file writes, barriers and silent reads", () => {
  assert.equal(classifyTool("Edit"), "file-write");
  assert.equal(classifyTool("NotebookEdit"), "file-write");
  assert.equal(classifyTool("Bash"), "barrier");
  assert.equal(classifyTool("PowerShell"), "barrier");
  assert.equal(classifyTool("mcp__github__create_pr"), "barrier");
  assert.equal(classifyTool("Read"), "silent");
});

test("tools like AskUserQuestion that change nothing aren't logged as barriers", () => {
  for (const tool of ["ToolSearch", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]) {
    assert.equal(classifyTool(tool), "silent", tool);
  }
});

test("PowerShell and Agent barriers show the command or task instead of raw JSON", () => {
  assert.equal(
    barrierDetail("PowerShell", { command: "npm install undici", description: "Install undici" }),
    "npm install undici"
  );
  assert.equal(
    barrierDetail("Agent", { description: "Find auth callers", prompt: "Search for authHeader()" }),
    "Find auth callers"
  );
});

test("NotebookEdit's notebook_path is resolved like a file path", () => {
  assert.equal(resolveFilePath({ file_path: "/a.ts" }), "/a.ts");
  assert.equal(resolveFilePath({ notebook_path: "/a.ipynb" }), "/a.ipynb");
  assert.equal(resolveFilePath({}), null);
});

test("binary content is detected by its NUL bytes", () => {
  assert.equal(looksBinary(Buffer.from("plain text")), false);
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x00, 0x4e])), true);
});

test("failed tool responses are recognized in every shape Claude Code uses", () => {
  assert.equal(toolCallFailed({ success: false }), true);
  assert.equal(toolCallFailed({ error: "nope" }), true);
  assert.equal(toolCallFailed({ is_error: true }), true);
  assert.equal(toolCallFailed({ filePath: "/a.ts" }), false);
  assert.equal(toolCallFailed(undefined), false);
});
