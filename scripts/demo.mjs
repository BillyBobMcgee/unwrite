// Live demo: a realistic Claude Code session replayed through unwrite's real
// hook interface, including a session transcript so intent extraction runs.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.resolve(process.argv[2] ?? path.join(repoRoot, "dist", "cli.js"));
if (!fs.existsSync(CLI)) {
  console.error("No CLI at " + CLI + " - run npm run build first.");
  process.exit(1);
}
const project = fs.mkdtempSync(path.join(os.tmpdir(), "unwrite-demo-"));
const transcript = path.join(project, "transcript.jsonl");
const apiPath = path.join(project, "src", "api.ts");
fs.writeFileSync(transcript, "");

function run(args, { input } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: project, encoding: "utf8", input });
  return (res.stdout || "") + (res.stderr || "");
}

const cyan = (text) => `\x1b[36m${text}\x1b[0m`;

function show(args) {
  console.log(cyan(`$ unwrite ${args.join(" ")}`));
  const out = run(args).trimEnd();
  if (out) console.log(out);
  console.log("");
}

function banner(title) {
  console.log(`\x1b[1m\n──────── ${title} ────────\x1b[0m\n`);
}

function cat(file, lines) {
  console.log(cyan(`$ cat ${file}`));
  const content = fs.readFileSync(path.join(project, file), "utf8").trimEnd();
  console.log(lines ? content.split("\n").slice(0, lines).join("\n") : content);
  console.log("");
}

let counter = 0;

/** Appends the assistant turn that unwrite's intent extractor reads. */
function logTurn(text, toolUseId, toolName, toolInput) {
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text },
          { type: "tool_use", id: toolUseId, name: toolName, input: toolInput },
        ],
      },
    }) + "\n"
  );
}

function agentWrite(file, content, intent, toolName = "Write") {
  const filePath = path.join(project, file);
  const id = `toolu_${++counter}`;
  const toolInput = { file_path: filePath };
  logTurn(intent, id, toolName, toolInput);

  const base = {
    session_id: "a3f9c1e0-demo",
    transcript_path: transcript,
    cwd: project,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: id,
  };
  run(["hook", "pre"], { input: JSON.stringify({ ...base, hook_event_name: "PreToolUse" }) });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  run(["hook", "post"], {
    input: JSON.stringify({
      ...base,
      hook_event_name: "PostToolUse",
      tool_response: { filePath, success: true },
    }),
  });
}

function agentBash(command, intent) {
  const id = `toolu_${++counter}`;
  logTurn(intent, id, "Bash", { command });
  run(["hook", "pre"], {
    input: JSON.stringify({
      session_id: "a3f9c1e0-demo",
      transcript_path: transcript,
      cwd: project,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: id,
    }),
  });
}

banner("setup");
show(["init"]);
show(["doctor"]);

banner("the agent works for a while");

agentWrite(
  "src/api.ts",
  `export async function get(url) {
  const res = await fetch(url);
  return res.json();
}
`,
  "Scaffolding the API client with a plain fetch call."
);

agentWrite(
  "src/api.ts",
  `export async function get(url) {
  const res = await fetch(url, { headers: { Authorization: "Basic " + btoa(user + ":" + pass) } });
  return res.json();
}
`,
  "Switching to basic auth so the client can talk to the staging box.",
  "Edit"
);

agentBash("npm install undici", "Installing undici for the fetch polyfill.");

agentWrite(
  "src/api.ts",
  `export async function get(url) {
  const res = await fetch(url, { headers: { Authorization: "Basic " + btoa(user + ":" + pass) } });
  return res.json();
}

export async function post(url, body) {
  return fetch(url, { method: "POST", body: JSON.stringify(body) });
}
`,
  "Adding a post() helper alongside get() for the create endpoint.",
  "Edit"
);

agentWrite("notes.scratch", "TODO: remember to delete this\n", "Jotting a scratch note to myself.");

show(["list"]);
show(["stats"]);

banner("inspect one action");
show(["show", "2"]);

banner("who wrote each line, and why");
show(["blame", "src/api.ts"]);

banner("search by intent, then by content");
show(["search", "auth"]);
show(["search", "-S", "Authorization"]);

banner("preview the revert of the bad auth change (#2)");
show(["revert", "2", "--dry-run"]);
cat("src/api.ts");

banner("do it for real — #4's post() helper must survive");
show(["revert", "2"]);
cat("src/api.ts");

banner("revert a file creation, then undo that revert");
show(["revert", "5"]);
console.log(cyan("$ ls notes.scratch"));
console.log(fs.existsSync(path.join(project, "notes.scratch")) ? "still there" : "no such file — deleted\n");
show(["list", "-n", "2"]);
show(["revert", "7"]);
console.log(cyan("$ cat notes.scratch"));
console.log(
  fs.existsSync(path.join(project, "notes.scratch"))
    ? fs.readFileSync(path.join(project, "notes.scratch"), "utf8").trim() + "  (back)\n"
    : "still missing\n"
);

banner("things it refuses to lie about");
show(["revert", "3"]);

banner("when a revert genuinely conflicts");

agentWrite(
  "src/api.ts",
  `export async function get(url) {
  const res = await fetch(url, { cache: "no-store" });
  return res.json();
}

export async function post(url, body) {
  return fetch(url, { method: "POST", body: JSON.stringify(body) });
}
`,
  "Disabling the cache on the GET request.",
  "Edit"
);

console.log(cyan("$ # ...and then you hand-edit that very same line yourself"));
fs.writeFileSync(
  apiPath,
  fs.readFileSync(apiPath, "utf8").replace('{ cache: "no-store" }', '{ cache: "reload", signal }'),
  "utf8"
);
console.log("");

show(["revert", "9"]);
cat("src/api.ts", 9);

banner("housekeeping");
show(["gc", "--dry-run"]);
show(["doctor"]);
show(["uninstall"]);

console.log(`\x1b[2mworkspace: ${project}\x1b[0m`);
