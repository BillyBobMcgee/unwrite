// End-to-end smoke test: drives the built CLI exactly the way Claude Code
// would — hook payloads on stdin, then the user-facing commands.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.resolve(process.argv[2] ?? path.join(repoRoot, "dist", "cli.js"));
if (!fs.existsSync(CLI)) {
  console.error(`No CLI at ${CLI} — run \`npm run build\` first.`);
  process.exit(1);
}
const project = fs.mkdtempSync(path.join(os.tmpdir(), "unwrite-smoke-"));

function unwrite(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf8",
    input: opts.input,
  });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`unwrite ${args.join(" ")} failed (${res.status}):\n${res.stderr}${res.stdout}`);
  }
  return (res.stdout || "") + (res.stderr || "");
}

let counter = 0;
function agentWrite(file, content, toolName = "Write") {
  const filePath = path.join(project, file);
  const id = `toolu_${++counter}`;
  const payload = {
    session_id: "smoke-session",
    transcript_path: path.join(project, "transcript.jsonl"),
    cwd: project,
    tool_name: toolName,
    tool_input: { file_path: filePath },
    tool_use_id: id,
  };
  unwrite(["hook", "pre"], { input: JSON.stringify({ ...payload, hook_event_name: "PreToolUse" }) });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  unwrite(["hook", "post"], {
    input: JSON.stringify({
      ...payload,
      hook_event_name: "PostToolUse",
      tool_response: { filePath, success: true },
    }),
  });
  return id;
}

function agentBash(command) {
  unwrite(["hook", "pre"], {
    input: JSON.stringify({
      session_id: "smoke-session",
      transcript_path: path.join(project, "transcript.jsonl"),
      cwd: project,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: `toolu_${++counter}`,
    }),
  });
}

const section = (title) => console.log(`\n=== ${title} ===`);

section("init");
console.log(unwrite(["init"]));

section("agent activity");
agentWrite("src/api.ts", "export function get() {\n  return fetch(url);\n}\n");
agentWrite("src/api.ts", 'export function get() {\n  return fetch(url, { headers: { auth: "BROKEN" } });\n}\n', "Edit");
agentBash("npm install lodash");
agentWrite(
  "src/api.ts",
  'export function get() {\n  return fetch(url, { headers: { auth: "BROKEN" } });\n}\n\nexport const retries = 3;\n',
  "Edit"
);
agentWrite("scratch.txt", "delete me\n");
console.log(unwrite(["list"]));

section("stats");
console.log(unwrite(["stats"]));

section("show #2");
console.log(unwrite(["show", "2"]));

section("search BROKEN");
console.log(unwrite(["search", "auth"]));

section("blame src/api.ts");
console.log(unwrite(["blame", "src/api.ts"]));

section("dry-run revert of the bad edit (#2)");
console.log(unwrite(["revert", "2", "--dry-run"]));
const stillBroken = fs.readFileSync(path.join(project, "src/api.ts"), "utf8");
if (!stillBroken.includes("BROKEN")) throw new Error("dry run modified the file!");

section("revert #2 for real");
console.log(unwrite(["revert", "2"]));
const after = fs.readFileSync(path.join(project, "src/api.ts"), "utf8");
console.log(after);
if (after.includes("BROKEN")) throw new Error("revert did not remove the bad edit");
if (!after.includes("retries = 3")) throw new Error("revert lost the later edit");

section("revert a creation (#5 scratch.txt)");
console.log(unwrite(["revert", "5"]));
if (fs.existsSync(path.join(project, "scratch.txt"))) throw new Error("creation revert left the file");

section("undo the undo");
console.log(unwrite(["list", "-n", "3"]));

section("doctor");
console.log(unwrite(["doctor"], { allowFail: true }));

section("gc --dry-run");
console.log(unwrite(["gc", "--dry-run"]));

section("uninstall");
console.log(unwrite(["uninstall"]));

console.log(`\nAll smoke checks passed.`);
console.log(`Workspace left behind for poking at: ${project}`);
