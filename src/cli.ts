#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { findExistingUnwriteRoot, ensureUnwriteRoot } from "./paths";
import {
  openDb,
  listActions,
  getAction,
  fileHistory,
  searchActions,
  referencedHashes,
  pendingActions,
  stats,
  ActionRow,
} from "./db";
import { ObjectStore } from "./store";
import { revertAction } from "./revert";
import { readHookInput } from "./types";
import { runPreToolUse } from "./hooks/pre-tool-use";
import { runPostToolUse } from "./hooks/post-tool-use";
import { unifiedDiff, diffStat } from "./diff";
import { blameFile } from "./blame";
import { pickaxe } from "./pickaxe";
import {
  hookCommands,
  writeHookSettings,
  removeHookSettings,
  registeredHookCommands,
  ensureGitignore,
} from "./settings";

const color = makeColors();

const program = new Command();
program
  .name("unwrite")
  .description("Undo one thing Claude Code did, without undoing everything after it.")
  .version(readVersion());

program
  .command("init")
  .description("set up unwrite in the current project and wire it into Claude Code hooks")
  .option("--use-path", "register hooks as bare `unwrite ...` commands instead of absolute paths", false)
  .option("--local", "write hooks to .claude/settings.local.json instead of .claude/settings.json", false)
  .action((opts: { usePath: boolean; local: boolean }) => {
    const cwd = process.cwd();
    const unwriteRoot = path.join(cwd, ".unwrite");
    ensureUnwriteRoot(unwriteRoot);
    openDb(unwriteRoot).close(); // creates the schema

    const settingsPath = path.join(
      cwd,
      ".claude",
      opts.local ? "settings.local.json" : "settings.json"
    );
    writeHookSettings(settingsPath, hookCommands(opts.usePath, __filename));
    const addedIgnore = ensureGitignore(path.join(cwd, ".gitignore"));

    console.log(`${color.green("✓")} unwrite initialized in ${unwriteRoot}`);
    console.log(`${color.green("✓")} hooks registered in ${settingsPath}`);
    if (addedIgnore) console.log(`${color.green("✓")} added .unwrite/ to .gitignore`);
    console.log(
      `\n${color.bold("Restart Claude Code")} so it picks up the hooks — it only reads them at session ` +
        `start. After that every file write is snapshotted; ${color.bold("unwrite list")} shows them, ` +
        `${color.bold("unwrite doctor")} checks the wiring.`
    );
  });

program
  .command("uninstall")
  .description("remove unwrite's hooks from this project (keeps .unwrite/ and its history)")
  .action(() => {
    const cwd = process.cwd();
    let removed = false;
    for (const name of ["settings.json", "settings.local.json"]) {
      if (removeHookSettings(path.join(cwd, ".claude", name))) {
        console.log(`${color.green("✓")} removed unwrite hooks from .claude/${name}`);
        removed = true;
      }
    }
    if (!removed) console.log("No unwrite hooks were registered in this project.");
    console.log("History in .unwrite/ was left alone — delete that directory to remove it.");
  });

program
  .command("hook <event>")
  .description("internal: invoked by Claude Code hooks (event = pre|post)")
  .action((event: string) => {
    try {
      const input = readHookInput();
      if (event === "pre") runPreToolUse(input);
      else if (event === "post") runPostToolUse(input);
    } catch (err) {
      // Never break the agent's tool call over a logging failure.
      process.stderr.write(`unwrite hook ${event} error: ${(err as Error).message}\n`);
    }
    process.exit(0);
  });

program
  .command("list")
  .alias("log")
  .description("show recent tracked actions, newest first")
  .option("-n, --limit <n>", "max rows to show", "50")
  .option("-f, --file <path>", "only actions that touched this file")
  .option("-s, --session <id>", "only actions from this Claude Code session")
  .option("--since <iso>", "only actions at or after this ISO timestamp")
  .option("--edits-only", "hide barrier rows", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { limit: string; file?: string; session?: string; since?: string; editsOnly: boolean; json: boolean }) => {
    const db = openDb(requireRoot());
    const rows = listActions(db, {
      limit: Number(opts.limit),
      filePath: opts.file ? path.resolve(opts.file) : undefined,
      sessionId: opts.session,
      since: opts.since,
      includeBarriers: !opts.editsOnly,
    });
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("No tracked actions yet.");
      return;
    }
    for (const row of rows) console.log(formatRow(row));
  });

program
  .command("show <id>")
  .description("show one action in full: metadata, intent, and the diff it made")
  .option("--stat", "summary line only, no diff body", false)
  .action((idStr: string, opts: { stat: boolean }) => {
    const root = requireRoot();
    const db = openDb(root);
    const store = new ObjectStore(root);
    const action = getAction(db, Number(idStr));
    if (!action) exit(`No action ${idStr} found.`);

    console.log(formatRow(action));
    if (action.session_id) console.log(color.dim(`session ${action.session_id}`));
    if (action.is_barrier) {
      console.log(
        color.dim("\nBarrier action — side effects outside the file system, nothing to diff or revert.")
      );
      return;
    }

    const before = action.pre_hash ? store.get(action.pre_hash) : "";
    const after = action.post_hash ? store.get(action.post_hash) : "";
    const { added, removed } = diffStat(before, after);
    console.log(color.dim(`\n${rel(action.file_path)}  ${color.green(`+${added}`)} ${color.red(`-${removed}`)}`));
    if (opts.stat) return;

    const diff = unifiedDiff(before, after, {
      beforeLabel: action.pre_hash ? `a/${rel(action.file_path)} (before action ${action.id})` : "/dev/null",
      afterLabel: action.post_hash ? `b/${rel(action.file_path)} (after action ${action.id})` : "/dev/null",
    });
    console.log(diff ? colorizeDiff(diff) : color.dim("(no textual change)"));
  });

program
  .command("blame <file>")
  .description("per-line attribution: which agent action wrote each line, and why")
  .option("--json", "machine-readable output", false)
  .action((file: string, opts: { json: boolean }) => {
    const root = requireRoot();
    const db = openDb(root);
    const store = new ObjectStore(root);
    const filePath = path.resolve(file);

    let current: string;
    try {
      current = fs.readFileSync(filePath, "utf8");
    } catch {
      exit(`Cannot read ${filePath}.`);
    }

    const result = blameFile(fileHistory(db, filePath), (hash) => store.get(hash), current!);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            file: filePath,
            drift: result.drift,
            lines: result.lines.map((line) => ({
              line: line.lineNumber,
              text: line.text,
              action_id: line.action?.id ?? null,
              intent: line.action?.intent ?? null,
              timestamp: line.action?.timestamp ?? null,
              untracked: line.untracked,
            })),
          },
          null,
          2
        )
      );
      return;
    }

    if (result.drift) {
      console.log(
        color.yellow(
          "note: this file has changes unwrite never saw (edited outside the agent, or reverted by hand)."
        )
      );
    }
    const width = String(result.lines.length).length;
    for (const line of result.lines) {
      const tag = line.action
        ? color.cyan(`#${String(line.action.id).padEnd(4)}`) + " " + color.dim(shorten(line.action.intent ?? line.action.tool_name, 30).padEnd(30))
        : color.dim((line.untracked ? "untracked" : "pre-existing").padEnd(35) + " ");
      console.log(`${tag} ${color.dim(String(line.lineNumber).padStart(width))}  ${line.text}`);
    }
  });

program
  .command("search <query>")
  .description("find actions by intent, file path, tool name, or shell command")
  .option("-n, --limit <n>", "max rows to show", "25")
  .option(
    "-S, --content",
    "search file content instead: find the actions that added or removed this text",
    false
  )
  .action((query: string, opts: { limit: string; content: boolean }) => {
    const root = requireRoot();
    const db = openDb(root);
    const rows = opts.content
      ? pickaxe(db, new ObjectStore(root), query, Number(opts.limit))
      : searchActions(db, query, Number(opts.limit));
    if (rows.length === 0) {
      console.log(
        opts.content
          ? `No action added or removed "${query}".`
          : `Nothing matched "${query}". Try --content to search inside the files themselves.`
      );
      return;
    }
    for (const row of rows) console.log(formatRow(row));
  });

program
  .command("revert <ids...>")
  .description("revert one or more tracked actions by id, newest first")
  .option("--dry-run", "show what would change without touching any file", false)
  .option("--diff", "print the diff each revert applies", false)
  .action((idStrs: string[], opts: { dryRun: boolean; diff: boolean }) => {
    const root = requireRoot();
    const db = openDb(root);
    const store = new ObjectStore(root);

    const ids = idStrs.flatMap(expandIdArg);
    // Newest first: reverting later actions before earlier ones keeps each
    // merge base as close as possible to the file's current state.
    ids.sort((a, b) => b - a);

    let failures = 0;
    for (const id of ids) {
      const result = revertAction(db, store, id, { dryRun: opts.dryRun, format: rel });
      for (const warning of result.barrierWarnings) console.log(color.yellow(`warning: ${warning}`));
      if (result.conflict) console.log(color.yellow(result.message));
      else if (result.ok) console.log(`${color.green("✓")} ${result.message}`);
      else console.log(color.red(result.message));
      if ((opts.diff || opts.dryRun) && result.before !== undefined) {
        const diff = unifiedDiff(result.before, result.after ?? "", {
          beforeLabel: `a/${rel(result.filePath)}`,
          afterLabel: result.after === null ? "/dev/null" : `b/${rel(result.filePath)}`,
        });
        if (diff) console.log(colorizeDiff(diff));
      }
      if (!result.ok) failures++;
    }
    if (failures > 0) process.exitCode = 1;
  });

program
  .command("stats")
  .description("summarize what the agent has done in this project")
  .action(() => {
    const db = openDb(requireRoot());
    const s = stats(db);
    if (s.total === 0) {
      console.log("No tracked actions yet.");
      return;
    }
    console.log(`${color.bold("actions")}    ${s.total} across ${s.sessions} session(s)`);
    console.log(`${color.bold("edits")}      ${s.edits} file writes over ${s.files} file(s)`);
    console.log(`${color.bold("barriers")}   ${s.barriers} un-revertible side effects`);
    console.log(`${color.bold("reverted")}   ${s.reverted}${s.pending ? `, ${s.pending} still pending` : ""}`);
    console.log(`${color.bold("window")}     ${s.firstTimestamp} → ${s.lastTimestamp}`);
    if (s.topFiles.length > 0) {
      console.log(color.bold("\nmost-edited files"));
      for (const file of s.topFiles) console.log(`  ${String(file.edits).padStart(4)}  ${rel(file.file_path)}`);
    }
  });

program
  .command("doctor")
  .description("check that hooks are wired up and the history on disk is intact")
  .action(() => {
    const cwd = process.cwd();
    const root = findExistingUnwriteRoot(cwd);
    const problems: string[] = [];

    if (!root) {
      exit("No .unwrite/ found. Run 'unwrite init' in your project root first.");
    }
    console.log(`${color.green("✓")} history directory ${root}`);

    let wired = false;
    for (const name of ["settings.json", "settings.local.json"]) {
      const settingsPath = path.join(cwd, ".claude", name);
      if (!fs.existsSync(settingsPath)) continue;
      const pre = registeredHookCommands(settingsPath, "PreToolUse");
      const post = registeredHookCommands(settingsPath, "PostToolUse");
      if (pre.length === 0 && post.length === 0) continue;
      wired = true;
      console.log(`${color.green("✓")} hooks registered in .claude/${name}`);
      if (pre.length !== 1 || post.length !== 1) {
        problems.push(
          `.claude/${name} has ${pre.length} PreToolUse and ${post.length} PostToolUse unwrite hooks — ` +
            `expected exactly one of each. Re-run 'unwrite init' to normalize them.`
        );
      }
      for (const command of [...pre, ...post]) {
        const target = command.match(/"([^"]+\.js)"|(\S+\.js)/)?.[0]?.replace(/"/g, "");
        if (target && !fs.existsSync(target)) {
          problems.push(`hook command points at ${target}, which does not exist.`);
        }
      }
    }
    if (!wired) problems.push("no unwrite hooks found in .claude/settings.json — run 'unwrite init'.");

    const db = openDb(root!);
    const store = new ObjectStore(root!);
    const pending = pendingActions(db);
    if (pending.length > 0) {
      problems.push(
        `${pending.length} action(s) are stuck pending (ids ${pending.map((p) => p.id).join(", ")}) — ` +
          `their PostToolUse hook never ran, so they cannot be reverted.`
      );
    }

    const onDisk = new Set(store.list());
    const missing = [...referencedHashes(db)].filter((hash) => !onDisk.has(hash));
    if (missing.length > 0) {
      problems.push(`${missing.length} snapshot(s) referenced by the log are missing from .unwrite/objects.`);
    } else {
      console.log(`${color.green("✓")} all ${onDisk.size} snapshot(s) present`);
    }

    if (problems.length === 0) {
      console.log(`\n${color.green("unwrite is healthy.")}`);
      return;
    }
    console.log("");
    for (const problem of problems) console.log(`${color.red("✗")} ${problem}`);
    process.exitCode = 1;
  });

program
  .command("gc")
  .description("delete snapshots no longer referenced by the log")
  .option("--dry-run", "report what would be deleted without deleting it", false)
  .action((opts: { dryRun: boolean }) => {
    const root = requireRoot();
    const db = openDb(root);
    const store = new ObjectStore(root);
    const referenced = referencedHashes(db);
    const orphans = store.list().filter((hash) => !referenced.has(hash));
    const bytes = orphans.reduce((total, hash) => total + store.size(hash), 0);
    if (orphans.length === 0) {
      console.log("Nothing to collect — every snapshot is still referenced.");
      return;
    }
    if (!opts.dryRun) for (const hash of orphans) store.remove(hash);
    const verb = opts.dryRun ? "Would delete" : "Deleted";
    console.log(`${verb} ${orphans.length} orphaned snapshot(s), ${formatBytes(bytes)}.`);
  });

// Set once the project root is known, so output can show short paths.
let projectRoot: string | null = null;

function requireRoot(): string {
  const root = findExistingUnwriteRoot(process.cwd());
  if (!root) exit("No .unwrite/ found. Run 'unwrite init' in your project root first.");
  projectRoot = path.dirname(root!);
  return root!;
}

/** Absolute paths are stored, but project-relative ones are what people read. */
function rel(filePath: string | null | undefined): string {
  if (!filePath) return "";
  if (!projectRoot) return filePath;
  const relative = path.relative(projectRoot, filePath);
  return relative.startsWith("..") ? filePath : relative.split(path.sep).join("/");
}

function exit(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Accepts `12`, `9..12` and `9-12` so ranges of actions can be reverted at once. */
function expandIdArg(arg: string): number[] {
  const range = arg.match(/^(\d+)(?:\.\.|-)(\d+)$/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    const [low, high] = from <= to ? [from, to] : [to, from];
    return Array.from({ length: high - low + 1 }, (_, i) => low + i);
  }
  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) exit(`"${arg}" is not an action id or range (try 4, or 4..7).`);
  return [id];
}

function formatRow(row: ActionRow): string {
  const what = row.is_barrier
    ? `${row.tool_name} — ${row.barrier_detail}`
    : `${row.tool_name} ${rel(row.file_path)}`.trim();
  const flag = row.is_barrier
    ? color.yellow(" [barrier]")
    : row.status === "reverted"
      ? color.dim(` [reverted by #${row.reverted_by}]`)
      : row.status === "pending"
        ? color.red(" [pending]")
        : "";
  const intent = row.intent ? color.dim(`  — "${shorten(row.intent, 90)}"`) : "";
  return `${color.cyan(`#${row.id}`)}  ${color.dim(row.timestamp)}  ${what}${flag}${intent}`;
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function colorizeDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@")) return color.cyan(line);
      if (line.startsWith("---") || line.startsWith("+++")) return color.bold(line);
      if (line.startsWith("+")) return color.green(line);
      if (line.startsWith("-")) return color.red(line);
      return line;
    })
    .join("\n");
}

function makeColors() {
  const on = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const wrap = (code: string) => (text: string) => (on ? `[${code}m${text}[0m` : text);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    cyan: wrap("36"),
  };
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

program.parse();
