import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorkspace } from "./helpers";
import { revertAction } from "../src/revert";
import { listActions, getAction } from "../src/db";

test("reverts a single edit when nothing touched the file afterwards", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("api.ts", "one\ntwo\n");
    ws.agentWrite("api.ts", "one\nTWO\n");

    const [latest] = listActions(ws.db, { limit: 1 });
    const result = revertAction(ws.db, ws.store, latest.id);

    assert.equal(result.ok, true);
    assert.equal(result.conflict, false);
    assert.equal(ws.read("api.ts"), "one\ntwo\n");
    assert.equal(getAction(ws.db, latest.id)!.status, "reverted");
  } finally {
    ws.cleanup();
  }
});

test("reverts a middle action while preserving every later edit", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("api.ts", "header\nauth: old\nbody\nfooter\n");
    const target = listActions(ws.db, { limit: 1 })[0].id;
    ws.agentWrite("api.ts", "header\nauth: BROKEN\nbody\nfooter\n");
    const bad = listActions(ws.db, { limit: 1 })[0].id;
    ws.agentWrite("api.ts", "header\nauth: BROKEN\nbody\nfooter\nretry: true\n");

    const result = revertAction(ws.db, ws.store, bad);

    assert.equal(result.ok, true, result.message);
    assert.equal(result.conflict, false);
    // The bad auth line is gone; the later retry line survives.
    assert.equal(ws.read("api.ts"), "header\nauth: old\nbody\nfooter\nretry: true\n");
    assert.notEqual(target, bad);
  } finally {
    ws.cleanup();
  }
});

test("reverting a file creation deletes the file", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("scratch.ts", "throwaway\n");
    const id = listActions(ws.db, { limit: 1 })[0].id;

    const result = revertAction(ws.db, ws.store, id);

    assert.equal(result.ok, true, result.message);
    assert.equal(ws.exists("scratch.ts"), false);
  } finally {
    ws.cleanup();
  }
});

test("reverting a creation that has since been extended keeps the later lines", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("notes.md", "created line\n");
    const id = listActions(ws.db, { limit: 1 })[0].id;
    ws.agentWrite("notes.md", "created line\nadded later\n");

    const result = revertAction(ws.db, ws.store, id);

    assert.equal(result.ok, true, result.message);
    assert.equal(ws.read("notes.md"), "added later\n");
  } finally {
    ws.cleanup();
  }
});

test("a revert is itself revertible, restoring the reverted change", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("config.json", "{}\n");
    ws.agentWrite("config.json", '{"debug":true}\n');
    const edit = listActions(ws.db, { limit: 1 })[0].id;

    revertAction(ws.db, ws.store, edit);
    assert.equal(ws.read("config.json"), "{}\n");

    const revertRow = listActions(ws.db, { limit: 1 })[0];
    assert.equal(revertRow.tool_name, "unwrite:revert");

    const undo = revertAction(ws.db, ws.store, revertRow.id);
    assert.equal(undo.ok, true, undo.message);
    assert.equal(ws.read("config.json"), '{"debug":true}\n');
  } finally {
    ws.cleanup();
  }
});

test("conflicting reverts write markers and leave the action un-reverted", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("app.ts", "line\n");
    ws.agentWrite("app.ts", "changed by the agent\n");
    const id = listActions(ws.db, { limit: 1 })[0].id;
    // A human rewrites the very same line before the revert runs.
    ws.write("app.ts", "changed by a human\n");

    const result = revertAction(ws.db, ws.store, id);

    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.match(ws.read("app.ts"), /<<<<<<</);
    assert.equal(getAction(ws.db, id)!.status, "complete");
  } finally {
    ws.cleanup();
  }
});

test("dry run reports the outcome without touching the file or the log", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("api.ts", "before\n");
    ws.agentWrite("api.ts", "after\n");
    const id = listActions(ws.db, { limit: 1 })[0].id;

    const result = revertAction(ws.db, ws.store, id, { dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.after, "before\n");
    assert.equal(ws.read("api.ts"), "after\n", "file must be untouched");
    assert.equal(getAction(ws.db, id)!.status, "complete");
  } finally {
    ws.cleanup();
  }
});

test("barriers after the target action are surfaced as warnings", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("pkg.ts", "a\n");
    ws.agentWrite("pkg.ts", "b\n");
    const id = listActions(ws.db, { limit: 1 })[0].id;
    ws.agentBash("npm install lodash");

    const result = revertAction(ws.db, ws.store, id);

    assert.equal(result.ok, true, result.message);
    assert.equal(result.barrierWarnings.length, 1);
    assert.match(result.barrierWarnings[0], /npm install lodash/);
  } finally {
    ws.cleanup();
  }
});

test("barrier actions refuse to be reverted and say why", () => {
  const ws = makeWorkspace();
  try {
    ws.agentBash("rm -rf build/");
    const id = listActions(ws.db, { limit: 1 })[0].id;

    const result = revertAction(ws.db, ws.store, id);

    assert.equal(result.ok, false);
    assert.match(result.message, /no file state to revert/);
  } finally {
    ws.cleanup();
  }
});

test("a failed tool call never becomes a revertible action", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("api.ts", "content\n");
    ws.agentFailedWrite("api.ts", "never written");

    const rows = listActions(ws.db, { limit: 10 });
    assert.equal(rows.length, 1, "aborted rows are hidden from the log");
    assert.equal(rows[0].status, "complete");
  } finally {
    ws.cleanup();
  }
});

test("reverting an unknown action fails cleanly", () => {
  const ws = makeWorkspace();
  try {
    const result = revertAction(ws.db, ws.store, 999);
    assert.equal(result.ok, false);
    assert.match(result.message, /No action 999/);
  } finally {
    ws.cleanup();
  }
});
