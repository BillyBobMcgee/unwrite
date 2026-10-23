import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { makeWorkspace } from "./helpers";
import { blameFile } from "../src/blame";
import { fileHistory } from "../src/db";

function blame(ws: ReturnType<typeof makeWorkspace>, name: string) {
  const filePath = ws.file(name);
  return blameFile(
    fileHistory(ws.db, filePath),
    (hash) => ws.store.get(hash),
    fs.readFileSync(filePath, "utf8")
  );
}

test("attributes each line to the action that wrote it", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("app.ts", "alpha\nbeta\n", "scaffold the module");
    ws.agentWrite("app.ts", "alpha\nbeta\ngamma\n", "add the gamma helper");

    const result = blame(ws, "app.ts");

    assert.equal(result.drift, false);
    assert.deepEqual(
      result.lines.map((line) => line.text),
      ["alpha", "beta", "gamma"]
    );
    assert.equal(result.lines[0].action!.intent, "scaffold the module");
    assert.equal(result.lines[2].action!.intent, "add the gamma helper");
    assert.ok(result.lines[0].action!.id < result.lines[2].action!.id);
  } finally {
    ws.cleanup();
  }
});

test("lines that predate tracking are left unattributed", () => {
  const ws = makeWorkspace();
  try {
    ws.write("legacy.ts", "written by a human\n");
    ws.agentWrite("legacy.ts", "written by a human\nadded by the agent\n", "extend the file");

    const result = blame(ws, "legacy.ts");

    assert.equal(result.lines[0].action, null);
    assert.equal(result.lines[0].untracked, false, "pre-existing is not the same as untracked");
    assert.equal(result.lines[1].action!.intent, "extend the file");
  } finally {
    ws.cleanup();
  }
});

test("edits made outside the agent are reported as drift", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("app.ts", "from the agent\n", "write it");
    ws.write("app.ts", "from the agent\nsnuck in by hand\n");

    const result = blame(ws, "app.ts");

    assert.equal(result.drift, true);
    assert.equal(result.lines[0].untracked, false);
    assert.equal(result.lines[1].untracked, true);
    assert.equal(result.lines[1].action, null);
  } finally {
    ws.cleanup();
  }
});

test("an untracked file blames every line as untracked", () => {
  const ws = makeWorkspace();
  try {
    ws.write("unknown.ts", "a\nb\n");
    const result = blame(ws, "unknown.ts");

    assert.equal(result.drift, true);
    assert.ok(result.lines.every((line) => line.untracked));
  } finally {
    ws.cleanup();
  }
});

test("lines you add between claude edits are untracked", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("app.ts", "one\ntwo\n", "first pass");
    ws.write("app.ts", "one\nmine\ntwo\n");
    ws.agentWrite("app.ts", "one\nmine\ntwo\nthree\n", "add three");

    const result = blame(ws, "app.ts");

    assert.equal(result.drift, false);
    assert.equal(result.lines[1].text, "mine");
    assert.equal(result.lines[1].action, null);
    assert.equal(result.lines[1].untracked, true);
    assert.equal(result.lines[3].action!.intent, "add three");
  } finally {
    ws.cleanup();
  }
});

test("rewriting a deleted file starts blame over", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("app.ts", "same\nold\n", "first version");
    fs.unlinkSync(ws.file("app.ts"));
    ws.agentWrite("app.ts", "same\nnew\n", "second version");

    const result = blame(ws, "app.ts");

    assert.equal(result.lines[0].action!.intent, "second version");
    assert.equal(result.lines[1].action!.intent, "second version");
  } finally {
    ws.cleanup();
  }
});
