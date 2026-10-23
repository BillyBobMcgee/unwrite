# Changelog

## Unreleased

Fixed:

- `PowerShell` and `Agent` calls showed up as raw JSON in `list` and `show`.
  They show the command or task now.
- Tools that don't change files like `ToolSearch` and `AskUserQuestion` aren't
  logged anymore.
- `blame` gave Claude credit for lines you added between its edits.
- Deleted then rewritten files kept their old blame.

## 0.2.0

Mostly this release is the stuff that was missing to make it usable day to day,
plus a handful of bugs that only showed up once I ran it end to end properly.

New:

- `blame` — per-line attribution, showing which action wrote each line and what
  it said it was doing. Your own edits show as `untracked` so you can tell them
  apart.
- `search` over intents, paths and shell commands. `-S` searches the snapshots
  themselves and finds whichever action added or removed a string.
- `show <id>` for a single action's diff and intent.
- `revert --dry-run`, which works out the exact merge (conflicts included)
  without writing anything.
- `revert` takes several ids, and `9..12` ranges. Applied newest-first.
- `doctor`, `gc`, `stats`, `uninstall`.
- `--json` on `list` and `blame`.
- Tests, and CI on Linux/macOS/Windows across Node 20 and 22.

Fixed:

- Re-running `init` appended a second copy of its own hooks instead of replacing
  them, so every write got snapshotted twice.
- Hooks now point at the CLI by absolute path, so they work without a global
  install. `--use-path` gives you the old portable form if you'd rather commit
  the settings file.
- `NotebookEdit` was never tracked at all. It passes `notebook_path`, not
  `file_path`.
- Failed and denied tool calls left a pending row describing a write that never
  happened. They're recorded as aborted now.
- Binary files were being corrupted by a UTF-8 round trip. Skipped instead.
- Reverting a file creation that had been edited since used to just give up. A
  three-way merge against an empty base reports conflicts for changes that don't
  actually overlap, so that case subtracts the created lines instead.
- Merges were manufacturing conflicts out of the phantom empty line you get from
  `split("\n")` on a file with a trailing newline. This broke real merges, not
  just edge cases.
- Restoring a deleted file recorded a snapshot hash that was never written to
  disk, so `doctor` reported the history as damaged. Found by running the demo.
- A revert that deletes a file can itself be reverted now.
- `store.get` on a pruned snapshot says what happened instead of throwing
  `ENOENT`.
- SQLite gets a busy timeout, so two hooks firing at once wait their turn.

## 0.1.0

First version. Hook-based snapshotting, `list`, and `revert <id>` via three-way
merge, with barrier detection.
