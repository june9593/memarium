# memarium

Cross-device sync for your AI coding sessions.

`memarium` is the npm CLI half of a two-package system. It collects
Claude Code, VS Code Copilot Chat, Codex Desktop, and interactive Codex
CLI sessions on every machine you use, pushes them to a private git repo,
and lets you `resume` a session
on a different laptop than where it started.

For digest + recall (typed memory — episodes, decisions, "what did
past-me figure out" queries), install the **Claude Code plugin**:

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

## Supported session sources

- Claude Code (`~/.claude/projects/`)
- VS Code Copilot Chat (`workspaceStorage`)
- Codex Desktop and interactive Codex CLI (`~/.codex/sessions/` and
  `~/.codex/archived_sessions/`)

`codex exec` batch runs and Codex's internal subagent/guardian child threads
are intentionally excluded from the default sync corpus.

Rendered titles and filenames prefer the provider's own session name when
available (`Copilot customTitle`, `Codex thread_name`), then fall back to the
first real user message. Copilot titles include both stored initial titles and
later renames; clearing a title restores the fallback.

After upgrading, the next sync reimports local Copilot `chatSessions` once,
including unchanged JSON/JSONL files. It updates the same session-ID index entry
and removes a superseded rendered filename only after saving the new index.
No manual rename script or index reset is needed; source sessions are untouched.
If you use both packages, update the CLI and plugin so they agree on titles.
Sessions whose source is no longer on this device keep their existing names;
resync them on the device holding the source. `memarium prune` can preview any
older unindexed orphan files separately.

## Cross-device resume

Once you've synced from machine A, machine B can continue any indexed source
session in a fresh Claude Code conversation:

```sh
# On machine B (after `memarium sync` refreshes the aggregated spool):
memarium list-sessions --since 7d
memarium resume <sessionId-or-shortId>
```

`resume` reads the rendered session Markdown and supplies it as context to a
new `claude` process. It does not copy source JSONL, mutate Claude internals,
or natively resume a Codex/Copilot thread.

If A and B have different home directory layouts (for example
`/Users/alice` vs `/Users/bob`), configure the path translation once:

```sh
memarium config --map-path /Users/alice=/Users/bob
```

## Commands

| Command | What it does |
|---|---|
| `memarium init` | Interactive wizard. One-time setup. |
| `memarium sync` | Extract local sessions, push to your device branch. |
| `memarium list-sessions [--project --since --device]` | List sessions in spool, sortable for resume. |
| `memarium resume <sessionId>` | Start fresh Claude Code with the rendered source session as context. |
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
  - `raw_sessions/<tool>/<project>/<date>/*.md` — one rendered Markdown file per source session
  - `.memarium/index.json` — spool index (co-owned with the plugin)
  - `memory/` and `.memarium/index.memory.json` (+ `index.entity.json` / `index.qa.json`) — written by the plugin if you have it installed

The npm CLI does not touch `memory/` or the plugin's memory indexes — those
are the plugin's domain. The plugin in turn does not touch `.git/` or
`config.json` — those are sync's.

## Migration from v0.4.x

If you upgraded from v0.4.x and miss `memarium prepare` / `recall` —
digest + recall now run in-session via the Claude Code plugin's
`/memarium` and `/memarium-recall` skills (the old `publish` / `serve` /
`build-site` book commands were retired in the book→memory collapse).
Install the plugin as shown at the top of this README. Your existing
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
  - `sources/` — Claude Code, Copilot, and Codex adapters
- `tests/` — vitest, parallel structure to src/
- `assets/{workflows,scripts}` — GitHub Actions YAML + cross-device aggregate script
- `bin/memarium.ts` — commander entry, built to `dist/bin/memarium.js`

## License

MIT
