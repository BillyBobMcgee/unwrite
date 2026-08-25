import { test } from "node:test";
import assert from "node:assert/strict";
import { makeWorkspace } from "./helpers";
import { pickaxe } from "../src/pickaxe";
import { searchActions, listActions } from "../src/db";

test("content search finds the action that introduced a string", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("api.ts", "const timeout = 30;\n");
    ws.agentWrite("api.ts", "const timeout = 30;\nconst apiKey = process.env.KEY;\n");
    const introduced = listActions(ws.db, { limit: 1 })[0].id;
    ws.agentWrite("api.ts", "const timeout = 60;\nconst apiKey = process.env.KEY;\n");

    const hits = pickaxe(ws.db, ws.store, "apiKey");

    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, introduced);
  } finally {
    ws.cleanup();
  }
});

test("content search also catches removals", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("api.ts", "keep\ndelete-me\n");
    ws.agentWrite("api.ts", "keep\n");
    const removal = listActions(ws.db, { limit: 1 })[0].id;

    const hits = pickaxe(ws.db, ws.store, "delete-me");

    assert.equal(hits.length, 2, "the action that added it and the one that removed it");
    assert.equal(hits[0].id, removal);
  } finally {
    ws.cleanup();
  }
});

test("moving text around is not a content-search hit", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("api.ts", "alpha\nmarker\nbeta\n");
    const created = listActions(ws.db, { limit: 1 })[0].id;
    ws.agentWrite("api.ts", "marker\nalpha\nbeta\n");

    const hits = pickaxe(ws.db, ws.store, "marker");

    assert.deepEqual(
      hits.map((h) => h.id),
      [created]
    );
  } finally {
    ws.cleanup();
  }
});

test("metadata search matches intent and shell commands", () => {
  const ws = makeWorkspace();
  try {
    ws.agentWrite("api.ts", "x\n", "add retry logic to the fetch call");
    ws.agentBash("npm install lodash");

    assert.equal(searchActions(ws.db, "retry logic").length, 1);
    assert.equal(searchActions(ws.db, "lodash").length, 1);
    assert.equal(searchActions(ws.db, "nothing-like-this").length, 0);
  } finally {
    ws.cleanup();
  }
});
