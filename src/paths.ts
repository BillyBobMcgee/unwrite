import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Locates the .unwrite directory for a project. Walks upward from
 * `startDir` looking for an existing .unwrite/ (mirrors how git finds
 * .git). Returns null if the project was never `unwrite init`-ed.
 */
export function findExistingUnwriteRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, ".unwrite");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function objectsDir(unwriteRoot: string): string {
  return path.join(unwriteRoot, "objects");
}

export function dbPath(unwriteRoot: string): string {
  return path.join(unwriteRoot, "log.sqlite");
}

export function ensureUnwriteRoot(unwriteRoot: string): void {
  fs.mkdirSync(objectsDir(unwriteRoot), { recursive: true });
}
