import { test } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff, diffStat, splitLines } from "../src/diff";

test("splitLines ignores the empty element a trailing newline produces", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
});

test("identical inputs produce no diff", () => {
  assert.equal(unifiedDiff("same\n", "same\n"), "");
});

test("a one-line change renders as a unified hunk", () => {
  const diff = unifiedDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n");
  assert.match(diff, /^@@ -1,3 \+1,3 @@$/m);
  assert.match(diff, /^-two$/m);
  assert.match(diff, /^\+TWO$/m);
  assert.match(diff, /^ one$/m);
});

test("distant changes are split into separate hunks", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 1", "LINE 1").replace("line 38", "LINE 38");
  const hunks = unifiedDiff(before, after).match(/^@@/gm) ?? [];
  assert.equal(hunks.length, 2);
});

test("labels are emitted when provided", () => {
  const diff = unifiedDiff("a\n", "b\n", { beforeLabel: "a/x", afterLabel: "b/x" });
  assert.ok(diff.startsWith("--- a/x\n+++ b/x\n"));
});

test("diffStat counts added and removed lines", () => {
  assert.deepEqual(diffStat("a\nb\n", "a\nb\nc\nd\n"), { added: 2, removed: 0 });
  assert.deepEqual(diffStat("a\nb\n", "a\n"), { added: 0, removed: 1 });
  assert.deepEqual(diffStat("a\n", "A\n"), { added: 1, removed: 1 });
});
