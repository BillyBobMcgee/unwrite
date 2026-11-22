import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeWorkspace } from "./helpers";
import { hookCommands, writeHookSettings, registeredHookCommands } from "../src/settings";

// runs the CLI from source in the given folder
function unwrite(cwd: string, ...args: string[]) {
  const cli = path.join(__dirname, "..", "src", "cli.ts");
  return spawnSync(process.execPath, [require.resolve("tsx/cli"), cli, ...args], { cwd, encoding: "utf8" });
}

test("doctor finds the hooks when run from a subfolder", () => {
  const ws = makeWorkspace();
  try {
    writeHookSettings(path.join(ws.dir, ".claude", "settings.json"), hookCommands(true, "irrelevant"));
    fs.mkdirSync(ws.file("src"));

    const result = unwrite(ws.file("src"), "doctor");

    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    ws.cleanup();
  }
});

test("uninstall removes the hooks when run from a subfolder", () => {
  const ws = makeWorkspace();
  try {
    const settingsPath = path.join(ws.dir, ".claude", "settings.json");
    writeHookSettings(settingsPath, hookCommands(true, "irrelevant"));
    fs.mkdirSync(ws.file("src"));

    unwrite(ws.file("src"), "uninstall");

    assert.deepEqual(registeredHookCommands(settingsPath, "PreToolUse"), []);
  } finally {
    ws.cleanup();
  }
});
