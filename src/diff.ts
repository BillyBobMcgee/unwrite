import { diffComm } from "node-diff3";

export type LineOp = { kind: " " | "-" | "+"; text: string };

export interface DiffStat {
  added: number;
  removed: number;
}

/**
 * Flattens two texts into a single ordered list of context/removed/added
 * lines. `diffComm` already gives us comm(1)-style chunks — common runs and
 * mismatched pairs — which is exactly the shape a unified diff needs.
 */
export function diffOps(before: string, after: string): LineOp[] {
  const chunks = diffComm(splitLines(before), splitLines(after));
  const ops: LineOp[] = [];
  for (const chunk of chunks) {
    if (chunk.common) {
      for (const text of chunk.common) ops.push({ kind: " ", text });
    } else {
      for (const text of chunk.buffer1 ?? []) ops.push({ kind: "-", text });
      for (const text of chunk.buffer2 ?? []) ops.push({ kind: "+", text });
    }
  }
  return ops;
}

export function diffStat(before: string, after: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const op of diffOps(before, after)) {
    if (op.kind === "+") added++;
    else if (op.kind === "-") removed++;
  }
  return { added, removed };
}

export interface UnifiedDiffOptions {
  beforeLabel?: string;
  afterLabel?: string;
  context?: number;
}

/** Renders a standard unified diff, or an empty string when nothing changed. */
export function unifiedDiff(before: string, after: string, options: UnifiedDiffOptions = {}): string {
  const context = options.context ?? 3;
  const ops = diffOps(before, after);
  if (!ops.some((op) => op.kind !== " ")) return "";

  const changedIndexes = ops.flatMap((op, i) => (op.kind === " " ? [] : [i]));
  const groups = groupIndexes(changedIndexes, context, ops.length);

  const out: string[] = [];
  if (options.beforeLabel) out.push(`--- ${options.beforeLabel}`);
  if (options.afterLabel) out.push(`+++ ${options.afterLabel}`);

  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const group of groups) {
    // Advance the line counters over everything skipped before this hunk.
    for (; cursor < group.start; cursor++) {
      if (ops[cursor].kind !== "+") oldLine++;
      if (ops[cursor].kind !== "-") newLine++;
    }

    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = group.start; i <= group.end; i++) {
      const op = ops[i];
      body.push(op.kind + op.text);
      if (op.kind !== "+") oldCount++;
      if (op.kind !== "-") newCount++;
    }
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    out.push(...body);

    for (; cursor <= group.end; cursor++) {
      if (ops[cursor].kind !== "+") oldLine++;
      if (ops[cursor].kind !== "-") newLine++;
    }
  }
  return out.join("\n");
}

/** Merges changed-line indexes into hunk ranges padded by `context` lines. */
function groupIndexes(
  changed: number[],
  context: number,
  total: number
): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(total - 1, index + context);
    const last = groups[groups.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else groups.push({ start, end });
  }
  return groups;
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline yields a final empty element that isn't a real line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
