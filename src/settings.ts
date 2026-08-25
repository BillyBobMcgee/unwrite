import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Recognizes unwrite's own hook entries in a settings file, in both the
 * `unwrite hook pre` form and the absolute `node "…/dist/cli.js" hook pre`
 * form. Matching the subcommand alone would be too eager, so the command must
 * also name unwrite or point at the CLI file.
 */
const HOOK_SUBCOMMAND = /\bhook\s+(?:pre|post)\b/;
const HOOK_OWNER = /unwrite|cli\.js/i;

export interface HookCommands {
  pre: string;
  post: string;
}

/**
 * Builds the shell commands Claude Code will run for each hook event.
 *
 * By default they point at this exact CLI file through the running Node
 * binary, so the hooks keep working whether unwrite was installed globally,
 * linked, or is just a checkout on disk. `--use-path` opts into the shorter
 * `unwrite hook pre` form for people who want portable, machine-independent
 * settings they can commit.
 */
export function hookCommands(usePath: boolean, cliPath: string): HookCommands {
  if (usePath) return { pre: "unwrite hook pre", post: "unwrite hook post" };
  const node = quote(process.execPath);
  const cli = quote(path.resolve(cliPath));
  return { pre: `${node} ${cli} hook pre`, post: `${node} ${cli} hook post` };
}

function quote(value: string): string {
  return value.includes(" ") ? `"${value}"` : value;
}

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

/**
 * Registers (or refreshes) the unwrite hooks in a settings file without
 * disturbing anyone else's. Re-running `unwrite init` replaces the previous
 * unwrite entries rather than appending duplicates, which would snapshot every
 * file twice.
 */
export function writeHookSettings(settingsPath: string, commands: HookCommands): void {
  const settings = readSettings(settingsPath);
  settings.hooks ??= {};

  for (const [event, command] of [
    ["PreToolUse", commands.pre],
    ["PostToolUse", commands.post],
  ] as const) {
    const existing: HookEntry[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const others = existing.filter((entry) => !isUnwriteEntry(entry));
    others.push({ matcher: "*", hooks: [{ type: "command", command }] });
    settings.hooks[event] = others;
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export function removeHookSettings(settingsPath: string): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  const settings = readSettings(settingsPath);
  if (!settings.hooks) return false;
  let changed = false;
  for (const event of ["PreToolUse", "PostToolUse"]) {
    const existing: HookEntry[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const others = existing.filter((entry) => !isUnwriteEntry(entry));
    if (others.length !== existing.length) changed = true;
    if (others.length === 0) delete settings.hooks[event];
    else settings.hooks[event] = others;
  }
  if (changed) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return changed;
}

export function readSettings(settingsPath: string): any {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8")) ?? {};
  } catch (err) {
    throw new Error(`${settingsPath} is not valid JSON (${(err as Error).message}) — fix it and retry.`);
  }
}

export function isUnwriteEntry(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((hook) => {
    const command = hook.command ?? "";
    return HOOK_SUBCOMMAND.test(command) && HOOK_OWNER.test(command);
  });
}

export function registeredHookCommands(settingsPath: string, event: string): string[] {
  const settings = readSettings(settingsPath);
  const entries: HookEntry[] = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
  return entries
    .filter(isUnwriteEntry)
    .flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? ""))
    .filter(Boolean);
}

export function ensureGitignore(gitignorePath: string, line = ".unwrite/"): boolean {
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, line + "\n", "utf8");
    return true;
  }
  const existing = fs.readFileSync(gitignorePath, "utf8");
  if (existing.split("\n").some((entry) => entry.trim() === line)) return false;
  fs.appendFileSync(gitignorePath, (existing.endsWith("\n") ? "" : "\n") + line + "\n", "utf8");
  return true;
}
