# unwrite

[![CI](https://github.com/BillyBobMcgee/unwrite/actions/workflows/ci.yml/badge.svg)](https://github.com/BillyBobMcgee/unwrite/actions/workflows/ci.yml)

Undo one thing Claude Code did, without undoing everything after it.

## The problem

You're six steps into a session. Step 2 changed the auth header and it was
wrong. Steps 3 through 6 were fine, and one of them was slow and fiddly and you
don't want to do it again.

`/rewind` takes you back to step 2 and throws away 3 through 6. ccundo does the
same thing (its docs say it undoes "ALL operations that came after"). So your
options are: lose good work, or go digging through `git diff` and unpick the bad
change by hand.

That's the whole reason this exists. `unwrite revert 2` backs out step 2 and
leaves the rest alone.

## What it looks like

```console
$ unwrite list
#5  Write notes.scratch  — "Jotting a scratch note to myself."
#4  Edit  src/api.ts     — "Adding a post() helper alongside get() for the create endpoint."
#3  Bash — npm install undici [barrier]  — "Installing undici for the fetch polyfill."
#2  Edit  src/api.ts     — "Switching to basic auth so the client can talk to the staging box."
#1  Write src/api.ts     — "Scaffolding the API client with a plain fetch call."

$ unwrite revert 2
warning: action 3 ran Bash (npm install undici) — reverting these files won't undo that.
✓ Reverted action 2 on src/api.ts via three-way merge — later edits to that file are preserved.
```

And the file afterwards:

```js
export async function get(url) {
  const res = await fetch(url);            // #2 backed out
  return res.json();
}

export async function post(url, body) {    // #4 still here
  return fetch(url, { method: "POST", body: JSON.stringify(body) });
}
```

That's real output, not a mockup. `npm run demo` replays the whole session if
you want to watch it happen.

Those quoted strings after each action are what Claude said it was doing at the
time, lifted out of the session transcript. Turns out that's the most useful
column in the whole log.

## Install

Not on npm yet. From source:

```sh
git clone https://github.com/BillyBobMcgee/unwrite
cd unwrite
npm install && npm run build
npm link          # puts `unwrite` on your PATH
```

Then in whatever project you want tracked:

```sh
unwrite init
```

That creates `.unwrite/`, registers two hooks in `.claude/settings.json`, and
adds `.unwrite/` to your `.gitignore`.

**Restart Claude Code after this.** It reads hooks when the session starts, so
an already-open session won't pick them up, and you'll think nothing is being
recorded. Everyone hits this once. `unwrite doctor` will tell you if the wiring
is right.

## Commands

| | |
| --- | --- |
| `unwrite list` | what the agent has done, newest first |
| `unwrite show 4` | one action: its intent, and the diff it made |
| `unwrite blame src/api.ts` | which action wrote each line, and why |
| `unwrite search auth` | search intents, paths, shell commands |
| `unwrite search -S "API_KEY"` | find whichever action introduced that string |
| `unwrite revert 4` | back out that one action |
| `unwrite revert 4 --dry-run` | see what that would do first |
| `unwrite revert 9..12` | a range, applied newest-first |
| `unwrite doctor` | is anything broken |
| `unwrite gc` | drop snapshots nothing references anymore |
| `unwrite stats` | how much has the agent actually touched |
| `unwrite uninstall` | remove the hooks, keep the history |

`list` and `blame` take `--json` if you want to script against them.

## Two things I'd point at

**`blame`.** Same idea as `git blame`, except the unit is an agent action and
you get its intent instead of a commit message:

```console
$ unwrite blame src/api.ts
#1    Scaffolding the API client wi… 1  export async function get(url) {
#2    Switching to basic auth so th… 2    const res = await fetch(url, { headers: …
#1    Scaffolding the API client wi… 3    return res.json();
#4    Adding a post() helper alongs… 6  export async function post(url, body) {
untracked                           9  // I added this line myself
```

Lines you wrote show as `untracked`, lines that were there before you ran
`init` show as `pre-existing`. So you can always tell your code from the
agent's.

**`search -S`.** git's pickaxe, for agent actions. You find something weird in
your codebase, you have no idea when it appeared, this tells you which step of
which session put it there.

## How it works

Claude Code fires a hook before and after every tool call and hands it JSON on
stdin. `unwrite init` registers for both.

Before a `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, it reads the file as it
currently stands and stashes it. After, it reads the file again and stashes
that. So every tracked action is a before/after pair of snapshots tied to one
tool call. Snapshots are content-addressed the way git objects are, in
`.unwrite/objects/`, and the log itself is a SQLite table in
`.unwrite/log.sqlite`.

Anything that isn't a file write (`Bash`, `PowerShell`, `WebFetch`, MCP tools,
subagents) gets logged as a **barrier**: a marker saying something happened here
that reverting can't undo. Pure reads (`Read`, `Grep`, `Glob`, `TodoWrite`) and
tools like `AskUserQuestion` that don't change anything aren't logged at all.

The revert itself is a three-way merge, same trick `git revert` uses:

```
base   = the file right after the action you're reverting
ours   = the file as it is now
theirs = the file right before that action
```

base→ours is everything that's happened since. base→theirs is undoing just that
one action. Merge both against the shared base and you get both at once, which
is why later edits survive. If they genuinely overlap you get normal `<<<<<<<`
markers and the action stays marked un-reverted until you sort it out. No silent
bad merges.

A revert is written to the log as an action too, so if you change your mind,
revert the revert.

## Things it won't do

It won't try to undo `npm install lodash` or `rm -rf build/`. It tells you a
barrier ran and that the file revert didn't touch it. Guessing at that would be
worse than useless.

Same for network calls. They're logged, not replayed.

Text files only. Anything with NUL bytes in it gets skipped rather than
mangled by a UTF-8 round trip.

And it's not a git replacement. It's a fine-grained undo for one agent's work,
sitting alongside your commits.

## If something looks wrong

`unwrite list` empty after an edit? The hooks aren't firing. Restart the
session, and check `unwrite doctor`.

Rows stuck on `[pending]`? The post-hook didn't run for those. `doctor` names
them.

`.unwrite/` getting big? `unwrite gc`. Every write is snapshotted, so it does
grow, though identical content is only stored once.

## Development

Needs Node 22 or newer (`better-sqlite3` doesn't build below that).

```sh
npm test          # 39 tests, no Claude Code needed
npm run smoke     # drives the built CLI with real hook payloads
npm run demo      # the scripted session from the top of this README
npm run typecheck
```

The tests call the actual hook entry points against temp workspaces rather than
mocking them, so they cover the same path Claude Code takes. `demo.mjs` includes
a fake transcript, which is the only way to exercise intent extraction.

Both scripts leave their workspace on disk so you can poke around in it.

## Status

v0.2. It works, I use it, but it hasn't been through many hands yet. Bug reports
welcome, especially around merges that should have been clean and weren't.

MIT.
