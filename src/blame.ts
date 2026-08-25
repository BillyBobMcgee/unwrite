import { diffComm } from "node-diff3";
import { ActionRow } from "./db";
import { splitLines } from "./diff";

export interface BlameLine {
  lineNumber: number;
  text: string;
  /** The action that last wrote this line, or null if it predates tracking. */
  action: ActionRow | null;
  /** True when the line was written outside the agent's tool calls. */
  untracked: boolean;
}

export interface BlameResult {
  lines: BlameLine[];
  /** The file on disk no longer matches the last snapshot unwrite recorded. */
  drift: boolean;
}

type Attribution = { action: ActionRow | null; untracked: boolean };

/**
 * Per-line attribution for a file: which agent action last wrote each line,
 * and with what stated intent.
 *
 * Every tracked action for the file is replayed oldest-first. For each step
 * the previous version is compared with the new one; lines that survive
 * unchanged keep whoever wrote them, and lines in the changed region are
 * credited to the action that produced them. Anything already present before
 * the first snapshot stays unattributed, and anything the current file has
 * that the last snapshot doesn't is marked untracked (a human edit, another
 * tool, a rebase).
 */
export function blameFile(
  history: ActionRow[],
  loadObject: (hash: string) => string,
  currentContent: string
): BlameResult {
  const currentLines = splitLines(currentContent);

  if (history.length === 0) {
    return {
      drift: true,
      lines: currentLines.map((text, i) => ({
        lineNumber: i + 1,
        text,
        action: null,
        untracked: true,
      })),
    };
  }

  const first = history[0];
  let lines = first.pre_hash ? splitLines(loadObject(first.pre_hash)) : [];
  let attribution: Attribution[] = lines.map(() => ({ action: null, untracked: false }));

  for (const action of history) {
    if (!action.post_hash) continue;
    const next = splitLines(loadObject(action.post_hash));
    attribution = carryForward(lines, next, attribution, { action, untracked: false });
    lines = next;
  }

  const drift = !sameLines(lines, currentLines);
  if (drift) {
    attribution = carryForward(lines, currentLines, attribution, { action: null, untracked: true });
    lines = currentLines;
  }

  return {
    drift,
    lines: lines.map((text, i) => ({
      lineNumber: i + 1,
      text,
      action: attribution[i]?.action ?? null,
      untracked: attribution[i]?.untracked ?? true,
    })),
  };
}

/**
 * Maps attributions from `from` onto `to`: unchanged lines keep their existing
 * author, and every line that only exists in `to` is credited to `author`.
 */
function carryForward(
  from: string[],
  to: string[],
  attribution: Attribution[],
  author: Attribution
): Attribution[] {
  const next: Attribution[] = [];
  let cursor = 0;
  for (const chunk of diffComm(from, to)) {
    if (chunk.common) {
      for (let i = 0; i < chunk.common.length; i++) {
        next.push(attribution[cursor] ?? author);
        cursor++;
      }
    } else {
      cursor += chunk.buffer1?.length ?? 0;
      for (let i = 0; i < (chunk.buffer2?.length ?? 0); i++) next.push(author);
    }
  }
  return next;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
