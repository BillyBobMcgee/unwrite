import { merge, diffComm } from "node-diff3";
import { splitLines } from "./diff";

export interface MergeOutcome {
  conflict: boolean;
  content: string;
}

/**
 * Reverts one action's edit while preserving edits made after it, via a
 * standard three-way merge (the same trick `git revert` uses):
 *
 *   base (o) = the file right after the action being reverted
 *   ours (a) = the file right now (may carry later, unrelated edits)
 *   theirs (b) = the file right before the action being reverted
 *
 * Diffing base->ours captures "everything that happened since"; diffing
 * base->theirs captures "undo just this one action." Merging both against
 * the shared base applies both at once. Conflicts land as standard
 * <<<<<<< / ======= / >>>>>>> markers in the returned content.
 *
 * Splitting to lines here rather than letting node-diff3 split on "\n" is
 * deliberate: a raw split leaves a phantom empty element for the trailing
 * newline, and that phantom collides across all three sides often enough to
 * manufacture conflicts in files that merge perfectly well.
 */
export function revertViaThreeWayMerge(
  current: string,
  base: string,
  pre: string,
  actionId: number
): MergeOutcome {
  const result = merge(splitLines(current), splitLines(base), splitLines(pre), {
    label: { a: "current", b: `before action ${actionId}` },
  });
  let content = result.result.join("\n");
  if (content !== "" && (current.endsWith("\n") || pre.endsWith("\n"))) content += "\n";
  return { conflict: result.conflict, content };
}

/**
 * Backs a file *creation* out of a file that has been edited since.
 *
 * A three-way merge is the wrong tool here: the base side is an empty file,
 * so every later addition sits adjacent to the region being deleted and
 * line-level diff3 reports a conflict for changes that don't really overlap.
 * Comparing the creation's own snapshot against the file as it stands is
 * unambiguous instead — lines the creation wrote that are still there are
 * dropped, and everything that arrived afterwards (including rewrites of the
 * created lines) is kept.
 */
export function removeCreatedContent(post: string, current: string): string {
  const kept: string[] = [];
  for (const chunk of diffComm(splitLines(post), splitLines(current))) {
    if (chunk.common) continue;
    kept.push(...(chunk.buffer2 ?? []));
  }
  if (kept.length === 0) return "";
  return kept.join("\n") + (current.endsWith("\n") ? "\n" : "");
}
