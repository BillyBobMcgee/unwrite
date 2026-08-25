import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorkspace } from "./helpers";
import { revertAction } from "../src/revert";
import { listActions, referencedHashes } from "../src/db";

/** What `unwrite doctor` checks: nothing in the log points at a missing blob. */
function assertNoDanglingSnapshots(ws: ReturnType<typeof makeWorkspace>) {
  const onDisk = new Set(ws.store.list());
  const missing = [...referencedHashes(ws.db)].filter((hash) => !onDisk.has(hash));
  assert.deepEqual(missing, [], "log references snapshots that are not in objects/");
}

test("deleting and restoring a file leaves no dangling snapshot references", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("notes.txt", "scratch\n");
    const created = listActions(ws.db, { limit: 1 })[0].id;

    // Revert the creation: the file is deleted and the revert row records no
    // post-state. Reverting that row restores the file from no pre-state.
    revertAction(ws.db, ws.store, created);
    const deletion = listActions(ws.db, { limit: 1 })[0].id;
    const restore = revertAction(ws.db, ws.store, deletion);

    assert.equal(restore.ok, true, restore.message);
    assert.equal(ws.read("notes.txt"), "scratch\n");
    assertNoDanglingSnapshots(ws);
  } finally {
    ws.cleanup();
  }
});

test("a restored file can be deleted again by reverting the restore", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("notes.txt", "scratch\n");
    const created = listActions(ws.db, { limit: 1 })[0].id;
    revertAction(ws.db, ws.store, created);
    const deletion = listActions(ws.db, { limit: 1 })[0].id;
    revertAction(ws.db, ws.store, deletion);

    const restore = listActions(ws.db, { limit: 1 })[0].id;
    const result = revertAction(ws.db, ws.store, restore);

    assert.equal(result.ok, true, result.message);
    assert.equal(ws.exists("notes.txt"), false);
    assertNoDanglingSnapshots(ws);
  } finally {
    ws.cleanup();
  }
});

test("ordinary edits and reverts keep every referenced snapshot on disk", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("api.ts", "one\n");
    ws.agentWrite("api.ts", "one\ntwo\n");
    ws.agentWrite("api.ts", "one\ntwo\nthree\n");
    const middle = listActions(ws.db, { limit: 2 })[1].id;

    revertAction(ws.db, ws.store, middle);

    assertNoDanglingSnapshots(ws);
  } finally {
    ws.cleanup();
  }
});
