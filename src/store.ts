import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "./hash";
import { objectsDir } from "./paths";

/**
 * Content-addressed blob store, git-object-style: objects/<first 2 hex>/<rest>.
 * Storing by hash means identical content (e.g. a file that round-trips
 * back to an earlier state) is only ever written to disk once.
 */
export class ObjectStore {
  constructor(private readonly unwriteRoot: string) {}

  put(content: string): string {
    const hash = sha256(content);
    const file = this.pathFor(hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
    return hash;
  }

  get(hash: string): string {
    try {
      return fs.readFileSync(this.pathFor(hash), "utf8");
    } catch {
      throw new Error(
        `Snapshot ${hash.slice(0, 12)} is missing from .unwrite/objects — it was pruned or deleted, so this action can no longer be reverted.`
      );
    }
  }

  /** Every hash currently on disk, for gc and integrity checks. */
  list(): string[] {
    const root = objectsDir(this.unwriteRoot);
    if (!fs.existsSync(root)) return [];
    const hashes: string[] = [];
    for (const prefix of fs.readdirSync(root)) {
      const dir = path.join(root, prefix);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const rest of fs.readdirSync(dir)) hashes.push(prefix + rest);
    }
    return hashes;
  }

  remove(hash: string): void {
    try {
      fs.unlinkSync(this.pathFor(hash));
    } catch {
      // Already gone — nothing to prune.
    }
  }

  size(hash: string): number {
    try {
      return fs.statSync(this.pathFor(hash)).size;
    } catch {
      return 0;
    }
  }

  has(hash: string): boolean {
    return fs.existsSync(this.pathFor(hash));
  }

  private pathFor(hash: string): string {
    return path.join(objectsDir(this.unwriteRoot), hash.slice(0, 2), hash.slice(2));
  }
}
