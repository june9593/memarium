# memarium

Cross-device sync for your AI coding sessions.

`memarium` is the npm CLI half of a two-package system. It collects
Claude Code + VS Code Copilot Chat sessions on every machine you use,
pushes them to a private git repo, and lets you `resume` a session
on a different laptop than where it started.

For digest + recall (chronicles, topics, "what did past-me figure out"
queries), install the **Claude Code plugin**:

```text
/plugin marketplace add june9593/memarium-plugin
/plugin install memarium
```

The plugin is independent — install it without the npm CLI if you only
work on one machine. Install both if you want sync + digest.

## Install

```sh
npm install -g memarium
memarium init
```

The wizard walks you through:

1. **Sync to a remote git repo?** (yes/no — local-only is also valid)
2. **Repo URL** + local checkout path
3. **Stable device name** for this machine's git branch (defaults to a
   cleaned hostname; pick a physical label like `mini2` if it drifts)

CI cross-device aggregation is auto-enabled when you sync to a remote, and
assistant reasoning is always included in synced markdown.

After init, push your sessions:

```sh
memarium sync
```

## Cross-device resume (NEW in 0.5.0)

Once you've sync'd from machine A, machine B can resume a session that
started on A:

```sh
# On machine B (after `memarium sync` pulls A's session-repo):
memarium list-sessions --since 7d           # Find sessions from this week
memarium resume <sessionId>                  # Copy jsonl + emit `claude --resume` hint
```

If A and B have different home dir layouts (e.g. `/Users/yueA` vs
`/Users/yueB`), tell memarium how to translate paths once:

```sh
memarium config --map-path /Users/yueA=/Users/yueB
```

After that, `memarium resume` rewrites all absolute paths in the jsonl
during copy, so `claude --resume` lands in the right local cwd.

Each resume is a **fork** — B gets a fresh sessionId so you can
continue on B without colliding with A if A also keeps chatting on
the same source session. The fork's origin is recorded in
`~/.memarium/resume-forks.json` and stamped onto the spool index entry
on the next `memarium sync` (as `originSessionId`), so plugin-side
digest tooling can later reason about same-source threads.

## Commands

| Command | What it does |
|---|---|
| `memarium init` | Interactive wizard. One-time setup. |
| `memarium sync` | Extract local sessions, push to your device branch. |
| `memarium list-sessions [--project --since --device]` | List sessions in spool, sortable for resume. |
| `memarium resume <sessionId>` | Copy jsonl into `~/.claude/projects/`, print `claude --resume` hint. |
| `memarium config [--map-path FROM=TO]` | Read or modify `~/.memarium/config.json`. |
| `memarium upgrade` | `npm install -g memarium@latest`. |
| `memarium doctor` | Health check: CLI, config, spool state, plugin install status. |
| `memarium workflow <init\|...>` | Install GitHub Actions for cross-device aggregation. |
| `memarium list` | List sessions in spool (simple table). |
| `memarium show <ref>` | Print one session's markdown to stdout. |
| `memarium cat <path>` | Print one file from the spool to stdout. |

## Files written

- `~/.memarium/config.json` — your settings (`mode 0600`)
- `~/.memarium/session-repo/` — git working tree of your private memory repo
  - `raw_sessions/<tool>/<project>/<date>/*.{md,raw.json,jsonl}` — sync-rendered session copies plus the original jsonl (preserved for resume)
  - `.memarium/index.json` — spool index (co-owned with the plugin)
  - `book/` and `.memarium/index.book.json` — written by the plugin if you have it installed

The npm CLI does not touch `book/` or `.memarium/index.book.json` — those
are the plugin's domain. The plugin in turn does not touch `.git/` or
`config.json` — those are sync's.

## Migration from v0.4.x

If you upgraded from v0.4.x and miss `memarium prepare` / `publish` /
`recall` / `serve` / `build-site` — those moved to the Claude Code plugin.
Install it as shown at the top of this README. Your existing
`~/.memarium/session-repo/` data is unchanged; the plugin reads it and
writes its own additions there.

### Note for v0.4.x upgraders: spool format is single-`.md`-per-session

Starting in 0.6.0, sync writes a **single `.md` per session** under
`raw_sessions/<tool>/<project>/<date>/` — no `.raw.json` or `.jsonl`
sibling. The `.md` carries everything via YAML frontmatter (commits,
files_touched, tools_used, candidate_decisions) plus a `# Table of
Contents` block with `→L<line>` jump offsets and the body. `memarium
resume` reads this `.md` directly; for sessions larger than ~200 KB it
embeds only the manifest + TOC inline and points Claude at the on-disk
file (chunked mode, 0.7.0+).

If you have a pre-0.6 spool with old `.raw.json` / `.jsonl` siblings
sitting around, the cleanest path is to wipe and re-sync:

```sh
rm -rf ~/.memarium/session-repo/raw_sessions
memarium sync
```

If your repo also accumulated duplicate `.md` files or `1970-01-01/`
empty-shell dirs from the 0.5–0.7.0 Copilot extractor bugs, run
`memarium prune` (added 0.7.1) to clean orphans first.

See [CHANGELOG](./CHANGELOG.md) for the full breaking-change list.

## Repo layout (for contributors)

- `src/` — TypeScript source
  - `commands/` — one file per CLI subcommand
  - `commands/resume/` — list-sessions, resume, path-rewrite, config-pathmap
  - `digest/{project-filter,session-signal}.ts` — sync-side filtering helpers (the rest of the dir was moved to the plugin)
  - `sources/` — Claude Code + Copilot adapters (sync uses both)
- `tests/` — vitest, parallel structure to src/
- `assets/{workflows,scripts}` — GitHub Actions YAML + cross-device aggregate script
- `bin/memarium.ts` — commander entry, built to `dist/bin/memarium.js`

## License

MIT
