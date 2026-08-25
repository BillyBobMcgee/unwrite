import * as fs from "node:fs";

const MAX_INTENT_LENGTH = 300;

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
}

/**
 * Best-effort extraction of "why the agent did this": scans the session
 * transcript for the assistant text that accompanied (or immediately
 * preceded) the tool_use block matching `toolUseId`. Never throws —
 * a missing or malformed transcript just means no intent is recorded.
 */
export function extractIntent(transcriptPath: string, toolUseId: string): string | null {
  let lines: string[];
  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }

  let lastAssistantText: string | null = null;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const content: ContentBlock[] = entry.message?.content;
    if (!Array.isArray(content)) continue;

    const textBlocks = content.filter((b) => b.type === "text" && b.text);
    const toolUseBlock = content.find((b) => b.type === "tool_use" && b.id === toolUseId);

    if (textBlocks.length > 0) {
      lastAssistantText = textBlocks.map((b) => b.text).join(" ").trim();
    }

    if (toolUseBlock) {
      return truncate(lastAssistantText);
    }
  }

  return null;
}

function truncate(text: string | null): string | null {
  if (!text) return null;
  return text.length > MAX_INTENT_LENGTH ? text.slice(0, MAX_INTENT_LENGTH) + "…" : text;
}
