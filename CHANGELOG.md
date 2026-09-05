# Changelog

## 0.17.2 — 2026-09-06

### Bound staging and preserve case-only renames

- Query pending raw-session changes before intersecting with final index
  references; no-op syncs no longer pass the entire archive to `git add`.
  Stage through a private, NUL-delimited literal pathspec file to avoid argv
  limits even during large migrations (Git 2.25+). Always clean up that file.
- Do not stage a missing render as deleted while the final index still refers
  to it, including when the local source is temporarily malformed.
- Protect canonical final-index paths during old-render cleanup. On
  case-insensitive filesystems, retain the actual filename spelling in the
  index so Git can retrieve the updated render after a case-only title change.
- Pin duplicate-source mtimes and vary their fingerprints to guarantee the
  A → B → A regression processes all three copies. Cover argv overflow,
  literal paths, temp-file cleanup, pending-only staging, and remote path reads.

## 0.17.1 — 2026-09-05

### Fix staging and retry after session filename migration

- Rebuild raw-session staging paths from the final index's existing renders
  plus Git-tracked deletions, rather than transient per-run write/removal lists.
  A duplicate workspace can create then remove an untracked intermediate file;
  passing that missing filename to `git add` previously aborted the sync.
- Include already-indexed renders on retry so a prior interrupted staging
  attempt cannot publish an index without its replacement Markdown. Unindexed
  raw files and unrelated repository files are not swept into staging.
- Keep any render referenced by the final index, including the current session:
  an A → B → A discovery order must not delete the final A render.
- Regression tests use local bare Git repositories to reproduce the exact
  missing-pathspec failure, untracked old-title cleanup, interrupted retries,
  Unicode paths, and repeated workspace discovery.

After upgrading, re-run sync normally. Do not delete the spool index or reset
existing local changes to recover from the staging failure.

## 0.17.0 — 2026-09-05

### Prefer Copilot's persisted session title

- Read `customTitle` from legacy chat JSON and the initial state plus subsequent
  top-level title patches in chat-session JSONL. Prefer the latest provider
  title, then the first real user message, then the session's display short ID.
  Clearing the title restores the fallback; transcript-only sessions retain
  their existing first-user-message naming.
- Version chat-session fingerprints so an upgrade reimports unchanged local
  JSON/JSONL once. Existing ID-based upserts and post-save path cleanup replace
  old first-prompt filenames without changing session IDs, source data, or the
  index schema. No separate bulk-rename script is needed.
- Verify initial titles, short/non-English titles, clearing, malformed title
  rows, stable fingerprints, and a full migration/rename/clear/push sequence
  against a local bare git remote. Codex's existing `thread_name` support is
  unchanged; update both packages when using the CLI and plugin together.

## 0.16.9 — 2026-09-04

### Synchronize the Codex/agent contributor guide

Stop ignoring the local-only stale `AGENTS.md` and commit it as a mirror of the
current `CLAUDE.md` contributor guide, so Codex and other AGENTS-aware tools see
the same memarium architecture, paths, source adapters, release rules, and no-LLM
boundary. A regression test requires both files to remain byte-identical.

## 0.16.8 — 2026-09-04

### Filter hidden Codex context and repair legacy Windows index paths

- Honor per-content `content_item_kinds` metadata and retain only `user.text`
  items from response-role user messages. Legacy fallback stripping now covers
  internal/goal/user-shell and dynamic external context wrappers.
- Preserve event-only MCP failure details by falling back from missing `result`
  to `error` and emitting the paired tool result.
- Normalize loaded spool-index `relativePath` backslashes to `/`, so the next
  sync repairs existing Windows Claude/Copilot/Codex entries rather than only
  writing new sessions portably.

## 0.16.7 — 2026-09-04

### Preserve Codex image-generation traces

Project `response_item.image_generation_call` into an `image_generation`
`tool_use` with the revised prompt and a paired `tool_result` carrying the
generated result. Large image payloads flow through the writer's existing
tool-result truncation. A current-schema Desktop fixture locks the pair.

## 0.16.6 — 2026-09-04

### Preflight branch sync and reject ambiguous `show` short IDs

- Complete repository/branch synchronization before any extraction, index write,
  or stale-render cleanup. A failed `fastForwardBranch()` now returns with zero
  extraction changes, so re-running reconstructs the complete write/removal set
  instead of leaving an unstaged replacement behind.
- Make `memarium show <shortId>` reject collisions and print every full session
  ID, matching resume's collision-safe behavior.

## 0.16.5 — 2026-09-04

### Preserve portable paths, shell results, and collision diagnostics

- Persist writer `relativePath` values with `/` separators on every platform,
  while using native joins only for filesystem writes. Windows-synced sessions
  therefore remain valid `git show ref:path` inputs for aggregation/resume.
- When a response `local_shell_call` mirrors a `CommandExecution`, suppress only
  the duplicate use and preserve/remap the event's captured result if no response
  output exists.
- Preserve internal whitespace in shell correlation signatures so quoted argv
  values with one versus two spaces remain distinct.
- Show full session IDs in resume ambiguity errors for colliding Codex tail IDs.
- Defer superseded-render deletion until the replacement index has persisted, so
  a failed save cannot leave the stored index pointing at a deleted file.

## 0.16.4 — 2026-09-03

### Make Codex tool correlation one-to-one and canonical

- Consume each matching response span after suppressing one completed-event
  mirror, so a legitimately repeated identical event invocation remains.
- Canonicalize `mcp__server__tool`, separate `namespace` + `name`, and
  `server.tool` event forms to one rendered identity.
- Sort object keys recursively before signature serialization and preserve
  direct argv boundaries in signatures, preventing equivalent objects from
  duplicating and distinct argv arrays from collapsing together.
- Make the active-vs-archived adapter test separator-independent on Windows.

## 0.16.3 — 2026-09-03

### Close Codex collision and correlation gaps

- Keep the 8-character Codex tail id for display/lookup, but use the sanitized
  full thread UUID in rendered filenames so equal tails cannot overwrite one
  another. The Codex source fingerprint carries a storage-format marker so a
  prior short-id render is re-written and removed through the existing guarded
  path cleanup.
- Correlate response-backed and completed-event tools by normalized tool family
  plus input content, using record proximity only as a tie-breaker. A different
  event-only command inside a response span is retained; only an actual mirror
  is suppressed.
- Preserve direct local-shell argv boundaries with JSON-style argument quoting,
  while rendering `sh`/`zsh`/PowerShell/cmd command payloads directly. This keeps
  multi-word commit messages and TOC previews intact.

## 0.16.2 — 2026-09-03

### Harden current Codex tool and injected-context parsing

- Accept `local_shell_call.action.command` string arrays in manifest/TOC shell
  extraction.
- Normalize raw custom `apply_patch` input and include `*** Move to:` rename
  destinations in `files_touched`.
- Strip the full current `# AGENTS.md ... <INSTRUCTIONS>` wrapper, including
  multi-paragraph instructions, while preserving following user text.
- Merge response and completed-event tool lanes per nearby invocation so mixed
  rollouts retain older event-only tools without duplicating current response
  calls. `ResponseItem::AgentMessage` remains intentionally excluded because it
  is author/recipient inter-agent delivery, not visible assistant output.
- Fix the duplicate marketing-page paragraph tag found during review.

## 0.16.1 — 2026-09-03

### Fix Windows non-git project paths (#37)

`projectSlugFromPath()` now splits both `/` and `\` separators and drops a
standalone drive-letter segment before deriving the parent/basename slug. A
Windows cwd such as `E:\downloads\sample-project\TICKET-1234\2026-08-06`
therefore becomes `TICKET-1234-2026-08-06` instead of placing the raw `E:`
path beneath `raw_sessions/` and failing `mkdirSync` with `ENOENT`. Remote-based
project identities are unchanged. Regression coverage locks both the direct
slug helper and the no-remote `resolveProjectIdSync()` path.

## 0.16.0 — 2026-09-03

### Add Codex Desktop and interactive Codex CLI JSONL sync

- Add a third source adapter for active and archived `~/.codex` rollout JSONL,
  shared by Codex Desktop and interactive Codex CLI. `codex exec` and explicit
  subagent/guardian child threads are excluded by default.
- Reconcile Codex display events with response items so injected context and
  duplicate UI/protocol records do not become conversation turns; retain
  plaintext reasoning and legacy/current/custom tool calls with structured
  results.
- Use the full Codex thread UUID as identity and a UUIDv7-safe tail shortId for
  display. Resume lookup now accepts an exact stored shortId as well as a full
  ID prefix.
- Use remote-first project identity, latest append-only Codex titles, and
  guarded cleanup when a title rename changes the rendered Markdown path.
- Extend manifest/TOC extraction for Codex shell and `apply_patch` tools, and
  verify existing cross-device aggregation accepts `tool: codex` unchanged.

## 0.15.2 — 2026-08-10

### Fix: CI aggregation compared `updatedAt` lexically, so a stale copy could win

`assets/scripts/merge-books.mjs` unions each device branch's `memory/`,
`memory/entities/` and `memory/qa/` by id, keeping the entry with the newest
`updatedAt`. All three passes picked the winner with a raw string comparison
(`(e.updatedAt ?? "") > (existing.entry.updatedAt ?? "")`), which is **not**
chronological across the mixed-but-valid ISO forms the writers emit — plain
`YYYY-MM-DD`, `...Z` timestamps, and offset timestamps.

Concretely, `2026-05-05T14:30:00-10:00` is `2026-05-06T00:30Z` in UTC — a later
calendar day than `2026-05-05T23:00:00Z` — yet it sorts lexically *before* it.
A garbage value was worse: `"not-a-date" > "2026-05-06"` is `true`, so an
unreadable date could evict a healthy entry.

This matters more here than at the plugin's read surfaces (fixed separately in
memarium-plugin #65): merge-books is the CI aggregator, so the wrong winner's
`.md` body and index entry are **persisted** into the aggregated tree on `main`,
not merely shown in a read view.

All three sites now share one local helper, `isNewerTimestamp()`, so they cannot
drift apart again:

- the chronologically later `updatedAt` wins, compared at **full timestamp
  resolution** (`Date.parse` → epoch milliseconds) rather than as raw strings;
- exactly equal instants → the already-seen entry keeps winning. That tie is
  resolved by branch traversal order, exactly as it was; no new tie-break was
  introduced;
- an unparseable or missing `updatedAt` never displaces a parseable one, and
  when both are unparseable the existing entry is kept.

Apart from the mixed-ISO-form case this fix exists to correct, every pair
decides exactly as it did before: a same-day pair with different times still
resolves to the later time, and a `...T08:00:00Z` timestamp still beats a bare
`2026-05-06` on the same day. An earlier draft of this fix compared calendar
days, which would have quietly turned both of those into traversal-order ties —
a behavior change well beyond the bug.

The plugin-side counterpart (memarium-plugin #65,
`source-resolver.mergeIndexById`) does use day granularity, deliberately: there
a same-day pair must register as a *tie* so a same-day sibling edit reaches the
write guard's divergence check. This pass has no divergence check — it just
picks a winner and persists it — so coarsening here would only discard ordering
information.

The helper lives in the script rather than being imported because
`merge-books.mjs` is a standalone `.mjs` run by `node` in CI with no build step.

Also in this release: `package-lock.json` picked up the `vibebook` → `memarium`
package name and `bin` entries it had been missing since the rename.

## 0.15.1 — 2026-08-04

### Publish the scrubbed sources (no behavior change)

0.15.0 was published on 2026-07-14, before the repository was scrubbed of
personal and company-internal identifiers on 2026-07-23. The published tarball
therefore still shipped those strings in `dist/` and `README.md`. This release
exists to make `latest` point at the scrubbed sources.

- CLI help text: the `config --map-path` example is now
  `/Users/alice=/Users/bob` (was a maintainer-derived path pair).
- Comments and doc examples across `src/` no longer carry a corporate DHCP
  hostname, maintainer-derived device/path names, or project-identifying
  references; `README.md` and the aggregate workflow/`merge-books.mjs` headers
  were updated to match (the workflow's display name is now
  "memarium aggregate memory", matching the post-book reality).
- Also carries the test-only guard added in #35, which locks that CI
  aggregation passes a memory's `archived` status + `archivedAt`/`archivedReason`
  through unchanged — the npm-side contract for the plugin's 0.20.0 archival
  feature. `merge-books.mjs` itself needed no change.

**Nothing executable changed**: no logic, no CLI behavior beyond the one help
string, no schema. Upgrading is optional unless you care about the shipped
strings.

## 0.15.0 — 2026-07-13

### Drop the book aggregation pass (Phase C2, npm side)

The plugin went memory-only in 0.18 (it no longer produces a `book/`); this
removes the matching book machinery from the npm CLI + CI aggregator. Purely
dead-code removal — the raw_sessions / memory / entity / qa passes are
untouched.

- **`assets/scripts/merge-books.mjs`:** removed the book pass entirely —
  `loadBookIndexFromBranch`, the chronicle/topic/card collection + copy +
  prune (`pruneStale` / `pruneSubdir` / `pruneTopicsDir`), and the whole
  catalog renderer (`regenCatalog` + `renderFront` / `renderTimeline` /
  `strings` / `renderProjectIndex` / helpers). The script keeps its filename
  (`doctor` checks for it) and still aggregates raw_sessions/memory/entity/qa.
- **`memarium-aggregate.yml` + `workflow.ts`:** dropped the `MEMARIUM_LOCALE`
  env line + the `bookLocale`→placeholder substitution (book rendering is gone,
  so there are no locale-dependent strings left to render).
- **`config.ts` / `init.ts` / `init-wizard.ts`:** removed the `bookLocale`
  config field.
- **`repo-data-dir.ts`:** removed `BOOK_INDEX_REL` / `bookIndexAbs`.
- De-book'd user-facing strings in `sync` / `doctor` / `init-wizard` / `cli`.

Tests: rewrote `merge-books.test.ts` around the memory passes (dropped the
book seeds/assertions); updated `workflow` / `sync` / resume / materialize
tests. 270 tests green, tsc + build clean.

**Latent CI note:** existing installs keep running the old book-aware
aggregator until the user re-runs `memarium workflow init` (which pushes the
new script + yaml to `origin/main`). The old script still aggregates
raw_sessions/memory/entity/qa correctly in the meantime — book aggregation
just no-ops once devices stop producing `book/`.

## 0.14.0 — 2026-07-03

### `doctor`: drop the memex check

memarium captures insights + recalls them natively now (plugin 0.14 — the
`/memarium-retro` skill + a Stop-hook nudge, plus a recall nudge on
SessionStart), so `doctor` no longer probes for the external `memex` CLI or
suggests installing it. The `memex availability` health line and the
`readMemexVersion()` helper are removed; `doctor`'s remaining checks (CLI
version, npm latest, plugin manifest, config presence, cross-device overlay
freshness) are unchanged. Paired with `memarium-plugin` 0.14.0, which drops
memex from recall/digest/publish and adds the native proactive digest + recall.

## 0.13.1 — 2026-07-02

**Fix: harden the `~/.vibebook` → `~/.memarium` config-dir migration.** Follow-up to 0.13.0's rename:

- **Aggregated worktree repair.** The bulk `renameSync` staled the read-only `aggregated/` worktree's *absolute* back-link to `session-repo`. `refreshAggregatedWorktree` only rebuilds when `aggregated/.git` is absent, so the dangling link silently degraded cross-device recall until a manual `rm`. Now `git worktree repair` runs after the move.
- **Tilde repoPath.** `config.json` may legally store `repoPath` as `~/.vibebook/session-repo`. The move only rewrote the *expanded* path, so a tilde path stayed pointing at the old (moved-away) dir. Both the expanded and literal-`~` forms are now rewritten.
- **Bounded git spawn.** The `git worktree repair` `spawnSync` now has a 10s timeout so a hung git can't stall the migration path (which runs before reads).

+5 tests. Mirrored in `memarium-plugin` 0.13.1.

## 0.13.0 — 2026-07-02

### Renamed: vibebook → **memarium**

The project is renamed **vibebook → memarium** ("mem" + "-arium" = a place where
memory lives). This npm package is now published as `memarium`; the old
`vibebook` package is deprecated and points here.

- **CLI**: `memarium` (with a short `mema` alias) — `memarium sync`, `mema doctor`, etc.
- **Config dir**: `~/.vibebook/` → `~/.memarium/`. Auto-migrated on first run
  (`migrateLegacyConfigDir`): the whole dir is moved and absolute `~/.vibebook/`
  paths stored inside `config.json` (e.g. `repoPath`) are rewritten.
- **In-repo data dir**: `.vibebook/` → `.memarium/`. Auto-migrated on first
  sync/digest (`migrateLegacyDataDir` walks the legacy chain — `.vibebook/`,
  else `.memvc/` — to `.memarium/` via `git mv`, preserving history).
- **CI**: `vibebook-aggregate.yml` → `memarium-aggregate.yml`; `merge-books.mjs`
  + env vars (`VIBEBOOK_LOCALE` → `MEMARIUM_LOCALE`, etc.). The dead
  `vibebook-pages.yml` book-site workflow, the `workflow pages-init` command,
  and `site-template/` were **removed** — the npm-side `build-site`/`serve`
  commands moved to the plugin back in 0.5, leaving that path broken.
- Internals: config paths now resolve lazily from `$HOME` (more robust; also
  fixes a latent test-isolation issue).

Coordinated with the `memarium-plugin` (ex `vibebook-plugin`) rename. Existing
users: just upgrade — the config + data dirs migrate themselves. `tsc` clean;
274 tests.

## 0.12.0 — 2026-07-01

### `doctor`: cross-device overlay freshness (P1)

`vibebook doctor` now checks the cross-device overlay (`~/.vibebook/aggregated`,
the read-only worktree of `origin/main` that the plugin's recall/primer read for
sibling-device memory — plugin 0.12 / P0b). It warns when the overlay is missing
("recall sees only this device's memory") or behind `origin/main` ("may miss
recent sibling-device memory"), with `vibebook sync` as the fix. Offline-safe —
compares local refs only, no network. Only runs when a remote is configured.

## 0.11.0 — 2026-06-30

### Project identity from the git remote (P0a)

The project a session/memory belongs to was keyed on `projectSlugFromPath` —
the **last two path segments** of the cwd (`~/code/demo` → `code-demo`). The
same repo at a different path per machine (`~/work/memvc`, `~/projects/memvc`)
split into different projects, so raw_sessions folders, memory ids, and book
never aggregated across devices. This is the foundation for cross-device
aggregate/recall.

Project identity is now the normalized git **`origin` remote** (identical on
every clone), with the legacy path slug as fallback for non-git / no-remote
projects:

- `src/project-identity.ts`: `canonicalProjectId()` collapses ssh-scp /
  `https` / `ssh://` / `git://` / credentialed remote forms to one `host/path`
  id; `resolveProjectId` (async) + `resolveProjectIdSync` + memoized
  `cachedProjectSlug` turn a cwd into a filesystem-safe slug
  (`github.com-june9593-vibebook`), remote-first with path fallback.
- **Read** chokepoint (`project-resolve.ts resolveProjectFromCwd[WithIndex]`)
  prefers the remote slug and falls back to the path slug, so existing
  path-slug data still resolves during the transition (sync, no async ripple).
- **Write** sites (`sources/claude-code.ts`, `sources/vscode-copilot.ts`,
  `content-project-inference.ts` known roots) assign the remote slug; the
  unknown-path inference fallback stays path-based.

Migration of existing path-slug data is **not** shipped — wipe + re-digest
locally, or let new data accumulate under the remote slug. +29 tests.

## 0.10.0 — 2026-06-24

### Removed: at-rest encryption (git-crypt filter)

The opt-in raw-sessions encryption layer (off by default since 0.8.2) is
**removed**. The git clean/smudge filter, `crypt` / `config --encrypt`
commands, passphrase store, and per-repo salt are all gone. The recommended
guard for private session data is a **private git remote** (plus GitHub
push protection, which sync now points you at when a real secret is
detected). Encryption added significant surface — deterministic-IV crypto,
salt distribution to CI, two-prefix filter wiring — for a default-off
feature almost nobody enabled.

**Migration (only if you turned encryption ON — it was off by default):**

> ⚠️ **Before upgrading to 0.10.0, decrypt your spool while still on
> v0.8.x.** Run `vibebook config --encrypt false` then `vibebook sync` to
> re-commit `raw_sessions/` as plaintext and push. Once you're on 0.10.0,
> vibebook no longer wires the git-crypt filter, so any commits still in
> ciphertext become unreadable on checkout.

After upgrading, `~/.vibebook/passphrase` and `.vibebook/repo-salt.json`
are inert — vibebook never reads them again. You can delete them manually;
0.10.0 leaves them untouched so a downgrade stays possible. Configs carrying
the old `encrypt` / `salt` keys still load — the schema ignores unknown keys.

## 0.8.6 — 2026-06-10

### Cross-device typed memory (vibebook Memory OS v1)

The vibebook **plugin** 0.3.0 introduces a typed-memory layer: durable
`memory/<type>/<scope>/<slug>.md` files + a `.vibebook/index.memory.json`
index, so a new session in a project starts already familiar with it. This
npm release adds the transport + aggregation half so that memory flows
cross-device just like `raw_sessions/` and `book/`.

**1. `sync` stages `memory/`.** The plugin's `memory-write` writes the
typed-memory layer into the working tree but doesn't push. `vibebook sync`
now also stages `memory/` + `.vibebook/index.memory.json` onto the device
branch (alongside `raw_sessions/`), so the memory reaches the branch CI
aggregates. `commitAndPush` no-ops when nothing changed, so this is free
when there's no memory.

**2. `merge-books` aggregates memory across devices.** The CI aggregator
unions each device branch's `memory/` + `index.memory.json` into `main`:
**union by `id`, latest `updatedAt` wins**, stamping `originDevice` with the
winning device. Mirrors the existing `raw_sessions/` aggregation pass —
tool-agnostic, no schema coupling.

## 0.8.5 — 2026-05-25

### `vibebook resume` — size-adaptive prompt construction

Two related cosmetic + UX fixes caught during 2026-05-25 dogfood of
the first cross-device resume:

**1. Adaptive size formatting.** Pre-0.8.5 the prompt always reported
file size as `MB.toFixed(1)`, so a 33 KB file rendered as
`"It is 0.0 MB — large enough that you should NOT Read the whole
file at once"` — self-contradictory and confusing. Now formats as
`B` / `KB` / `MB` adaptively.

**2. Skip chunked navigation for sub-50KB files.** Chunked mode
(header inline + on-disk Read) is overhead for small files — it
costs 1-2 extra `Read` tool round-trips for no benefit when the
whole md fits in one prompt. Pre-0.8.5 the chunked-vs-embed switch
was purely on `manifest_version: 1` presence; now also requires
`size >= CHUNKED_THRESHOLD_BYTES` (= 50 KB). Below that, full-embed
mode pastes the whole md into the prompt for one-shot context.

The threshold is generous (50 KB ≈ 5000 tokens, comfortable even in
200 K context models). 5 MB+ sessions still go chunked.

### Tests

- 4 new cases: size as KB (not "0.0 MB"), size as bytes for tiny
  files, full-embed for sub-50KB md with manifest_version, chunked
  for ≥50KB md.
- 252/252 vitest passing (was 248 in 0.8.4; +4 new).

## 0.8.4 — 2026-05-25

### `vibebook doctor` — multi-install detection

A user can end up with `vibebook` installed simultaneously to multiple
npm prefixes (Homebrew's `/opt/homebrew/lib/node_modules/` AND nvm's
`~/.nvm/versions/node/<v>/lib/node_modules/`). `vibebook upgrade` lands
in whichever `npm` runs first, but the shell resolves `vibebook` by
PATH order — so users routinely upgrade one install while continuing
to run the other. Bit the maintainer twice on 2026-05-25 alone.

`doctor` now walks every `PATH` directory, lists every `vibebook`
binary found with its `--version`, and marks the first (= what the
shell picks) with `→`. When ≥2 distinct installs exist, it warns
and prints a one-line uninstall fix targeted at the losing prefixes.

### `vibebook sync` — orphan index entry prune

Pre-0.8.4, deleting a session from `~/.claude/projects/` (or its
Copilot equivalent) left its `.vibebook/index.json` entry in place
forever. CI aggregate (0.8.0+) then logged `missing despite spool
index; skipping` for each stale entry, eating log noise and never
cleaning up its aggregated mirror on main.

Fix: after the discover/extract loop, walk `idx.entries` and remove
any entry whose `sourcePath` no longer exists AND whose
`relativePath` (the rendered md) is also gone. Keeps cross-device
aggregated entries safe — those have no local sourcePath but their md
exists in the aggregated worktree, so the second condition protects
them.

### Tests

- 2 new sync cases: orphan-prunes-when-both-gone, retain-when-md-still-exists
- 248/248 vitest passing (was 246 in 0.8.3; +2 new). No new doctor test — that one runs against real PATH and is better validated by the maintainer's eyeball.

## 0.8.3 — 2026-05-25

### Bug fix — raw_sessions aggregation now runs even without books

`assets/scripts/merge-books.mjs` early-returned when no device branch
had `.vibebook/index.book.json`. The P7 raw_sessions aggregation
pass (0.8.0) sat below that gate, so on a setup where users have
synced raw_sessions but no one has run `/vibebook` digest yet,
**`raw_sessions/` + `.vibebook/index.aggregated.json` were never
written to main**.

Symptom (caught 2026-05-25 after the maintainer's two-device fresh sync): CI ran
4 times all `success`, but main's tree only had `.github/`, `scripts/`,
and `.gitignore`. Logs showed `no device branch had a v2 BookIndex —
nothing to aggregate`. The cross-device resume overlay had nothing
to mirror because main had nothing to mirror from.

Fix: book and raw_sessions aggregation are now fully independent.
The book early-return was removed; the raw_sessions loop iterates
ALL device branches (was `perDevice` which required v2 BookIndex,
now `branches`); the commit phase gates each path's `git add` on
existence.

Behavior on each combination:

| Devices have books? | Devices have raw_sessions? | Result |
|---|---|---|
| yes | yes | both aggregated (unchanged) |
| no  | yes | raw_sessions only aggregated (**fix**) |
| yes | no  | books only (unchanged) |
| no  | no  | `nothing to aggregate` exits cleanly |

### Tests

- 1 new merge-books case: "raw_sessions aggregated when NO device has v2 BookIndex"
- 246/246 vitest passing (was 245 in 0.8.2; +1 new).

## 0.8.2 — 2026-05-25

### Encryption is no longer the default

The interactive `vibebook init` wizard no longer asks "Encrypt raw
session files before commit?" (Q3) or "Passphrase?" (Q4). New repos
default to **plaintext storage**.

Why: the body-encryption layer was half-baked. Filenames (= the first
~100 chars of each user prompt, derived by `deriveSlug`) and
`.vibebook/index.json` (full `displayName` per session) always leaked
to the remote in plaintext, so an attacker with repo read access could
already reconstruct the conversation topic. The threat model "GitHub
or someone with read access sees content" wasn't actually addressed.

The REAL risk — accidentally pasting an API key into a session and
pushing it — is covered by GitHub's secret-scanning push protection
(free on private repos as of 2024-09): AWS keys, GitHub PATs, OpenAI
`sk-*`, Anthropic `sk-ant-*`, and ~40 other partner patterns get
rejected at push time with `GH013`. The body-encryption layer didn't
help with that either.

### Opt-in paths preserved

Power users who want encryption can still enable it explicitly:

- **At init**: `vibebook init <url> --encrypt --passphrase <pp>`
  (non-interactive flag, unchanged from 0.5.x)
- **On an existing repo**: `vibebook config --encrypt true` — flips
  config + re-wires the git crypt filter. Force-encrypt of already-
  plaintext blobs requires `rm -rf raw_sessions && vibebook sync`.

### New: `vibebook config --encrypt false`

Opt out of encryption on a previously-encrypted repo. Flips
`~/.vibebook/config.json`'s `encrypt: false`, removes the per-clone
git crypt filter from `.git/config`, strips the
`raw_sessions/** filter=vibebook` line from `.gitattributes` (leaving
other user-added lines intact), and refreshes the working tree.

Existing already-encrypted blobs on the remote stay encrypted until
their source jsonl changes triggers a re-sync. To force-decrypt
everything now: `rm -rf raw_sessions && vibebook sync`.

Idempotent: running `--encrypt false` on a non-encrypted repo prints
"nothing to change" and exits.

### Tests

- 5 new `config-encrypt.test.ts` cases covering: false-flip filter
  teardown, .gitattributes line-precise strip (preserves user-added
  lines), idempotent no-op, true-flip filter re-wire, input validation.
- 245/245 vitest passing (was 240 in 0.8.1; +5 new).

## 0.8.1 — 2026-05-25

### Bug fix

- **Device branches now inherit `.github/workflows/vibebook-aggregate.yml`
  from main on every sync.** GitHub Actions on `push` events reads the
  workflow definition from THE PUSHED BRANCH (not from the default
  branch), so a device branch without `.github/workflows/` silently
  never triggers CI — and the user sees a fresh `vibebook sync` push
  with no aggregate run.

  Symptom: today's Mac-mini-2 push (sha `4b807114`, "+67 sessions",
  2026-05-25 08:41) triggered no CI run because Mac-mini-2's tree on
  remote had no `.github/`. Stale aggregate state on main: 4 days
  behind reality, main hadn't received an aggregate commit since
  2026-05-21.

  Root cause: `vibebook workflow init` (0.5.3+) writes the yml to
  main correctly, but never seeds new device branches with it. Fresh
  device branches were the dead zone.

  Fix: in `src/commands/sync.ts`, before staging, fetch `origin/main`
  and `git show origin/main:.github/workflows/vibebook-aggregate.yml`
  into the device branch's working tree. Stage it alongside
  raw_sessions/ + index. Idempotent: skipped when content already
  matches; silently no-ops when main has no workflow yet (pre-`workflow
  init` brand-new remote).

### Tests

- 3 new sync cases covering: fresh-branch inheritance, no-op when
  identical, silent skip when main has no workflow.
- 240/240 vitest passing (was 237 in 0.8.0; +3 new).

## 0.8.0 — 2026-05-23

P7 from the roadmap (locked Option A on 2026-05-22): **cross-device
raw_sessions aggregation**. Before this, `vibebook resume <id>` could only
see sessions captured by THIS device — to resume a session from a sibling
machine you had to manually `git checkout <device-branch>` first. Now
sibling-device sessions show up in `list-sessions` and `resume` works
seamlessly against them.

### How it works

Three coordinated pieces:

1. **`assets/scripts/merge-books.mjs` extension.** Besides aggregating
   `book/` into main, the workflow now also walks each device branch's
   `raw_sessions/` (via the device's `.vibebook/index.json`), unions
   them into main (dedup by `tool:sessionId`, latest `sourceMtimeMs`
   wins, latest `originDevice` annotated), and writes
   `.vibebook/index.aggregated.json` carrying the union with
   `originDevice` per entry. Pure git plumbing — ciphertext blobs are
   copied as-is so encryption works without CI having the passphrase.
   Prunes raw_sessions on main when a device retires a session.

2. **Sync overlay** (`src/aggregated-store.ts`, new). After a successful
   push, sync creates/refreshes a SECOND git worktree at
   `~/.vibebook/aggregated/` checked out on `main`. The worktree shares
   `.git` with `~/.vibebook/session-repo/` so the smudge filter is
   inherited (encrypted files decrypt automatically). Best-effort —
   failures (no main yet, network drop) are logged and don't break sync.

3. **`list-sessions` + `resume` updates.** Both now read BOTH the device's
   own `.vibebook/index.json` AND the aggregated worktree's
   `index.aggregated.json`. Entries are deduped by `tool:sessionId`;
   when a session exists in both, the own copy wins. `resume` resolves
   the `.md` path under the aggregated worktree for sibling-device
   sessions, so cross-device resume "just works" once a sync has refreshed
   the overlay.

### Migration

Existing repos pick this up automatically:
- Next CI aggregate run (triggered by any device push) writes the new
  `.vibebook/index.aggregated.json` + populates `raw_sessions/` on main.
- Next `vibebook sync` on each device creates `~/.vibebook/aggregated/`.
- `vibebook list-sessions` then shows sibling-device sessions in the
  output; `vibebook resume <id>` against them spawns Claude with the
  cross-device context.

No flags, no manual setup needed beyond `npm install -g vibebook@0.8.0`.

### Tests

- 2 new merge-books integration tests: raw_sessions aggregation + dedup,
  and "no spool data = no aggregate artifacts" negative case.
- 1 new list-sessions test: own + aggregated merge with `isOwn` flag and
  duplicate handling.
- 237/237 vitest passing (was 234 in 0.7.1; +3 new).

## 0.7.1 — 2026-05-23

Audit on the maintainer's first 0.7.0 sync surfaced 83 orphan .md files and 142
empty-shell .md files. Both are Copilot-specific extractor bugs.

### Bug fixes

- **Copilot adapter: dedupe `chatSessions/` and `transcripts/` for the
  same sessionId.** VS Code stores the same conversation in TWO formats
  inside one workspace: `chatSessions/<id>.jsonl` (rolling-window state
  log, fixed in 0.6.2/0.7.0) and `GitHub.copilot-chat/transcripts/<id>.jsonl`
  (older event-stream). Pre-0.7.1 both got yielded as independent sources;
  they produce different first-user prompts and different `startedAt`
  timestamps for the same conversation, so the writer emitted two .md
  files at different paths. The index keys by sessionId so only the
  last-processed write got registered — the other became an orphan.
  77 distinct shortIds were duplicated in the maintainer's repo (~85 orphan files).

  Fix: per workspace, when both source formats have the same sessionId,
  yield ONLY `chatSessions/` (the authoritative log we just hardened).
  `transcripts/` remains the fallback for sessions where `chatSessions/`
  doesn't exist.

- **Sync skips empty-shell sessions (0 messages).** VS Code creates a
  `chatSessions/<id>.jsonl` for every chat tab the user opens — even
  ones they immediately close — and many of those files only carry
  `kind=0` init + a `kind=1` metadata patch with no actual `requests`.
  Pre-0.7.1 sync wrote one `1970-01-01/untitled__<id>.md` per shell
  (epoch fallback because `startedAt` was empty). 142 such files
  appeared across 43 different project dirs on the maintainer's machine.

  Fix: skip writes when `session.messages.length === 0` in `runSync`.
  Generalizes across sources, not just Copilot.

### New: `vibebook prune`

Clean up the orphan .md files that pre-0.7.1 syncs left behind. Scans
`raw_sessions/*.md` and reports files NOT referenced by
`.vibebook/index.json`. Default is dry-run; pass `--apply` to delete.
Empty parent dirs are removed after their last file goes away.

```sh
vibebook prune           # list orphans (dry-run)
vibebook prune --apply   # delete them
```

## 0.7.0 — 2026-05-22

Make raw_sessions md **navigable** so digest and resume can handle huge
sessions (9MB+, 10000+ turns) without loading the whole body. Quality >
size: 200MB md files are fine, as long as consumers can read what they
need without OOM.

### New: per-session manifest + Table of Contents

Every newly-rendered `raw_sessions/*.md` now embeds, at the top:

- **`manifest_version: 1`** (signal field for back-compat detection)
- **Frontmatter manifest** with auto-extracted facts:
  - `user_turns` / `assistant_turns` — total counts
  - `tools_used` — histogram of tool_use.name
  - `commits` — `git commit` / `git tag` events parsed from Bash tool_use,
    each with the resulting line number in the rendered md
  - `files_touched` — deduped union of Read/Edit/Write/MultiEdit file_paths
    (capped at 200, first-seen)
  - `candidate_decisions` — user-text turns matching decision-marker
    keywords (我决定 / decided to / let's go with / 最后采用 / ok merged),
    capped at 20. Heuristic only — digest skill treats as hints, not facts.
- **`# Table of Contents` block** — importance-based jump table.
  Includes a row for each real user turn (≥50 chars), file edit (Edit /
  Write / MultiEdit), commit, and substantive assistant reply (≥200 chars
  with no tool calls). Each row carries a `→L<line>` column = absolute
  line of that turn's heading in the rendered md. Tool-result-only turns
  are omitted.

Real-world numbers on the maintainer's 4ec14999 session: 9.14MB → 9.81MB (~700KB
header), 4900 user / 6941 assistant turns, 100 commits captured, 1966
TOC rows. Every sampled TOC offset lands on the right `## User` or
`## Assistant` heading.

### Resume: chunked context loading

`vibebook resume <id>` detects `manifest_version: 1` and switches to
**chunked mode**: the prompt embeds only the header (frontmatter +
manifest + TOC) inline, then points Claude at the on-disk md and
instructs it to `Read offset:<line>` for the turns it needs. The
resuming Claude orients via the manifest, picks 3–5 relevant rows
from the TOC, and pulls just those segments — no longer trying to
load 9MB into the context window.

For pre-0.7 sessions (no `manifest_version`), the existing full-embed
behavior remains unchanged.

### Companion: vibebook-plugin SKILL.md P3 update

The `/vibebook` write skill (separate `june9593/vibebook-plugin` repo,
commit `84cff9f` on main) now checks for `manifest_version: 1` on every
raw session md and uses the chunked navigation pattern when present.
The fan-out size table is recalibrated from "total md size" to
"effective read size" — a 9MB navigable md has ~100KB effective read
size, so most sessions stay in the inline tier.

### Implementation notes

- New `src/digest/manifest.ts` + `src/digest/toc.ts` — pure functions,
  testable in isolation (19 new tests).
- `src/writer.ts` is now a two-pass renderer: render body first to
  compute per-message line offsets, then build manifest + TOC with
  prefix-patched absolute line numbers.
- `src/commands/resume/render-prompt.ts` adds `extractMdHeader` and
  `renderResumePromptChunked`; old functions retained for back-compat.
- 227 vitest passing (up from 198 in 0.6.3; +29 new tests).

## 0.6.3 — 2026-05-22

### Bug fixes

- **Claude extractor now filters `isMeta=true` entries.** These are
  system-injected pseudo-messages (slash-command skill body, command
  output replays) — not real user input. Symptom: a session that
  started with `hi` + `/vibebook` (both too short to survive the
  sanitizer's 10-char gate) would derive its displayName from the
  injected `/vibebook` skill template, producing files like
  `Step-0-—-Detect-the-mode-DO-THIS-FIRST-Before-anything-else-__a18dc3af.md`
  with no real user prompts in the body. Real-world hit count on
  the maintainer's machine: ≥1 session per project that runs `/vibebook` from a
  short opener.

  After the fix: such sessions still get written (their tool blocks
  carry real information), but their `displayName` falls back to
  `untitled` instead of a misleading skill-template excerpt.

## 0.6.2 — 2026-05-22

### Bug fixes

- **Copilot extractor (`chatSessions/<id>.jsonl`) reconstructs all turns
  instead of just the last one.** VS Code stores Copilot Chat as a live
  state log: each `kind=2 k=["requests"]` event is a snapshot whose
  rolling window only shows the latest turn — but the conceptual
  `requests` array grows monotonically across turns, and subsequent
  patches reference `k=["requests", N, …]` with N as the chronological
  turn index. Previous code treated each snapshot as a full replacement,
  so multi-turn agent sessions captured ~5–8% of the actual conversation
  (and the same session showed up split across multiple `.md` files in
  `raw_sessions/` as each sync re-rendered whichever turn was current).
  Fix walks events chronologically and APPENDS snapshot elements to a
  growing `turns` array.

- **Copilot agent-mode responses now extract `thinking` reasoning and
  `toolInvocationSerialized` tool calls.** Previously only
  `markdownContent` was extracted, which left agent sessions (which
  use thinking + tool calls and rarely emit markdownContent directly)
  with no assistant content at all. New extractor emits
  `ContentBlock[]` with thinking + tool_use + tool_result blocks so the
  resume context shows what tools were run.

### Tests

- 4 new Copilot tests covering chronological turn reconstruction,
  `thinking`/`toolInvocationSerialized` extraction, and
  `displayName`-from-first-turn derivation. Test fixtures reorganized
  into `tests/fixtures/claude/` and `tests/fixtures/copilot/` to keep
  the two adapters' recursive `.jsonl` discovery from cross-contaminating.

## 0.6.1 — 2026-05-21

Fast follow-up to 0.6.0 covering the gaps exposed by the maintainer's fresh-init
test on mini2: a real bug that blocked auto workflow install, plus
overdue wizard polish.

### Bug fixes

- **`vibebook workflow init` no longer fails when the user's primary
  working tree is on `main`.** Previously the worktree helper used
  `git checkout -B main` inside the temp worktree, which git refuses
  when `main` is already checked out elsewhere (very common after
  fresh `vibebook init` — local default branch is `main`). Failure was:
  `fatal: 'main' is already used by worktree at <repoPath>`. Fix:
  worktree now uses a unique temp branch name (`vibebook-tmp-main-<ts>-<rand>`)
  and pushes with `git push origin HEAD:main`, then cleans up the
  temp branch ref in `finally`.

### Wizard polish (init wizard goes from 9 questions to 7)

- **Q6 (Enable CI aggregation?) dropped** — now auto-true when
  sync-to-remote, auto-false when local-only. Workflow init still
  runs at the end of init (now succeeds even on `main` thanks to
  the bug fix above). Escape hatch: edit `~/.vibebook/config.json`
  to set `enableAggregateCI: false`.
- **Q7 (Include reasoning?) dropped** — reasoning blocks are part
  of the context.md content-block stream by design in 0.6+;
  truncation already handles size. The config field is retained for
  backward compat but is always `true`.
- **Q6 (was Q8): device name default now strips `.local`, `.lan`,
  and corp FQDN suffixes**. So `Mac-mini-2.local` defaults to
  `Mac-mini-2` rather than the volatile mDNS form. Still warns if
  the cleaned name looks DHCP-like.
- **Closing message refreshed** to make cross-device flow obvious:
  "Try on this machine: vibebook sync", then "On ANOTHER machine
  after vibebook init + vibebook sync: vibebook list-sessions +
  vibebook resume `<id>`".

## 0.6.0 — 2026-05-21

### BREAKING — Spool format simplified to single context.md per session

Pre-0.6: each session produced `.md` + `.raw.json` + `.jsonl` in the spool.
0.6: only `.md`, but the `.md` is now a *full conversation context* —
includes `tool_use` blocks, `tool_result` blocks, `thinking` blocks, and
YAML frontmatter with session metadata.

### BREAKING — `vibebook resume` mechanism changed

Pre-0.6: tried to inject jsonl into `~/.claude/projects/` so
`claude --resume <id>` would pick it up. Dogfooded on 2026-05-20 — doesn't
work cross-device because Claude Code reads more state than just the
jsonl file.

0.6: spawns a fresh `claude` session passing the prior session's context
markdown as the first user prompt. Claude reads it, acknowledges,
awaits next instruction. No reverse-engineering of Claude Code internals;
uses standard `claude [prompt]` public CLI.

### NEW commands / flags

- `vibebook resume <id-or-prefix> [--print] [--cwd <path>]` — shortId,
  prefix, or full UUID all accepted. `--print` skips spawn, prints the
  invocation for manual paste. `--cwd` overrides project-match validation.

### Drops

- `~/.vibebook/resume-forks.json` registry (no fork tracking needed)
- `IndexEntry.originSessionId` field (no longer written; still read for
  back-compat)
- jsonl + raw.json in spool (no longer written)
- `vibebook doctor` orphan-jsonl + oversized-jsonl checks (irrelevant
  when spool has no jsonl). New: 0.5.x residue check + fork-registry
  residue check, both with cleanup commands.

### Truncation

Large `tool_result` / `tool_use.input` blocks (>20 KB) are truncated in
the rendered `.md` to first 30 + last 10 lines (or first 4000 + last
1000 chars for single-line blocks), with a footer noting size. This
keeps large multi-file sessions (gigabytes of file reads) under
GitHub's 100 MB push limit. Override with `VIBEBOOK_FULL_TOOL_RESULTS=1`.

### Migration

- First `vibebook sync` after upgrade writes new-format `.md` *only* for
  sessions whose source jsonl mtime/sha changed. To force re-extract
  existing sessions in the new format:
  ```
  rm ~/.vibebook/session-repo/.vibebook/index.json
  vibebook sync
  ```
- Old `.raw.json` / `.jsonl` files in the spool aren't auto-deleted;
  `vibebook doctor` reports them with cleanup commands.
- `~/.vibebook/resume-forks.json` from 0.5.1 is dead; `doctor` reports it.
- vibebook-plugin needs no update — it already reads `.md` (just sees
  richer content now).

## 0.5.3 — 2026-05-20

Cross-device dogfood round 2 exposed the **CI aggregation workflow was
fundamentally broken**: it lived on the user's device branch but GitHub
Actions only resolves workflows from `main`. Every first-time push hit
`MODULE_NOT_FOUND` on the merge script. Fixed end-to-end in this release
along with three smaller follow-ups.

### Bug fixes

- **`vibebook workflow init` now installs to `origin/main`** via a temp
  worktree (instead of the user's device branch). This means the very
  first push after `vibebook init` triggers a fully-working CI run — no
  more cold-start `MODULE_NOT_FOUND`. The user's working tree, current
  branch, and uncommitted changes are untouched. Existing users with
  workflow/script copies on a device branch should clean those up; see
  the new `vibebook doctor` warning for the exact command.

- **`vibebook init` wizard now actually installs the workflow** when Q6
  (enable CI aggregation) is answered yes. Previously it just set the
  config flag and asked you to run `vibebook workflow init` later. Now
  it does both in one shot — main has the workflow before you ever push.

- **`merge-books.mjs` rendered strings are now localized.** The book
  index, project pages, and timeline page used to hard-code Chinese
  headings ("笔记本", "聚合自 N 台设备", "篇流水账", …). Now driven by
  `bookLocale: "en" | "zh"` in `~/.vibebook/config.json` (default `"en"`),
  substituted into the workflow yml at install time as `VIBEBOOK_LOCALE`.

- **`vibebook doctor` flags workflow residue on the device branch.** Pre-
  0.5.3 users probably still have `.github/workflows/vibebook-aggregate.yml`
  and `scripts/merge-books.mjs` checked in on their device branch. Doctor
  now points it out and prints the exact `git rm` + push commands to clean
  it up.

### Migration

Existing 0.5.x users:

1. `vibebook upgrade` to 0.5.3 (or `npm i -g vibebook@latest`).
2. `vibebook workflow init` — this time it pushes to `origin/main`,
   fixing your CI run. (Idempotent: safe to run even if you already
   manually seeded `main`.)
3. (Optional, but recommended) `vibebook doctor` will tell you if your
   device branch still has stale workflow + script copies, with the
   exact cleanup command.

## 0.5.2 — 2026-05-20

Dogfood pass on a second machine (mini2) exposed six small but real bugs
in 0.5.0 / 0.5.1. All fixed here. No schema changes.

### Bug fixes

- **`hasUnchanged()` now checks the file actually exists in the working tree.**
  Previously sync only compared source mtime + sha256, so after switching
  to a new device branch (where `raw_sessions/` is incomplete), sync looked
  at the still-committed `index.json` and skipped re-extracting — the new
  branch would stay perpetually incomplete. Now any missing indexed file
  is treated as stale.

- **Oversized jsonl no longer breaks `git push`.** When a Claude / Copilot
  session's `.jsonl` exceeds 95 MB, sync now skips the jsonl copy (still
  writes `.md` + `.raw.json` so the digest is intact) and warns. Files
  between 50 – 95 MB still copy but trigger a soft warning. Prevents the
  `GH001: Large files detected` push reject that 0.5.0 / 0.5.1 hit on
  long Copilot sessions in monorepo projects.

- **`vibebook doctor` reports oversized jsonl.** Scans the spool for
  `.jsonl > 50 MB` and shows the worst offenders, with a one-liner fix
  command when any of them exceed GitHub's 100 MB hard cap.

- **`init` wizard adopts plugin-first directories.** If the user installed
  `vibebook-plugin` first and the plugin wrote `book/` + `raw_sessions/`
  before the npm CLI was installed, init used to refuse with
  `"is not empty and is not a git repo"`. It now offers to `git init` in
  place + add the remote + create a fresh branch with the plugin data
  preserved as the first commit. Nothing is deleted or moved.

- **Stable device branch name.** `os.hostname()` on macOS drifts across
  networks (mDNS in home wifi → `Mac-mini-2.local`, corp DHCP → something
  like `CORP-DHCP-7X2.corp.example.com`, iPhone hotspot → another),
  causing sync to push to a new branch each time. Two fixes:
  - **Init wizard Q8**: explicitly ask for a stable device name and warn
    when the hostname default looks volatile.
  - **`vibebook config --device <name>`**: existing users can fix their
    config after the fact. Output prints the `git branch -D / git push
    --delete` commands to clean up any drift-created branches.
  - **`vibebook doctor`** flags drift-prone deviceBranch values.

### Migration note (0.4.x → 0.5.x)

If you're upgrading from a 0.4.x install, the first `vibebook upgrade`
will error with `Cannot find module '.../commands/plugin-install.js'`.
This is the old 0.4.x `upgrade.ts` (already loaded in the process) trying
to invoke a subcommand that 0.5.0 removed. The npm install half already
succeeded; **just run `vibebook upgrade` a second time** and it works.
No data loss either way.

## 0.5.1 — 2026-05-14

### NEW — Resume forks the session

`vibebook resume <sessionId>` now treats each resume as a **fork**:
the new copy on this device gets a fresh sessionId so two devices
resuming the same source session can continue in parallel without
clobbering each other when their spools sync up.

- A new `~/.vibebook/resume-forks.json` registry maps every freshly
  forked sessionId to its origin.
- The next `vibebook sync` stamps the origin onto the spool's index
  entry as `originSessionId`, so plugin-side digest tooling can later
  group same-source threads.
- `vibebook resume` output now shows the fork: `Session forked: abc123 → <new-uuid>`.

This closes the open design question from the v0.5.0 roadmap: "B 推回时怎么标记是 resumed-from-A".

## 0.5.0 — 2026-05-14

### BREAKING — Major slim, paired with the new vibebook plugin

`vibebook` 0.5.0 is **a deliberate amputation** of the npm package
to its sync transport responsibility. Digest + recall + the static
site renderer all moved to the Claude Code plugin at
[june9593/vibebook-plugin](https://github.com/june9593/vibebook-plugin).
The two products co-own the same `~/.vibebook/session-repo/` spool
with sessionId-keyed entries — install one, both, or neither.

If you used these commands in v0.4.x, they're gone:

| Removed | Where it lives now |
|---|---|
| `vibebook prepare` | Plugin (`/vibebook` skill drives this internally) |
| `vibebook publish` | Plugin |
| `vibebook recall` | Plugin (`/vibebook-recall` skill) |
| `vibebook serve` / `build-site` | Plugin (`/vibebook` site rendering) |
| `vibebook catalog-regen` | Plugin |
| `vibebook list-projects` | Plugin |
| `vibebook plugin-install` | Marketplace install: `/plugin install vibebook` |
| `init` Q5 (digest enabled), Q8 (memex), plugin-install side effect | Removed from wizard |

To recover digest + recall:

```text
/plugin marketplace add june9593/vibebook-plugin
/plugin install vibebook
```

Your existing `~/.vibebook/session-repo/` data continues to work
unchanged — the plugin reads it and writes its own additions there.

### BREAKING — Spool format adds original jsonl

Sync now preserves the original `.jsonl` from `~/.claude/projects/`
into the spool alongside the existing `.md` + `.raw.json`. This is
required by the new `vibebook resume` command.

**If you upgraded from v0.4.x:** your existing spool only has
`.md` + `.raw.json` — those sessions cannot be resumed across
machines. To enable resume retroactively:

```sh
rm -rf ~/.vibebook/session-repo/raw_sessions
vibebook sync
```

This re-renders all your local sessions and now also preserves
their original `.jsonl`. Bookmarks (the `book/` directory written
by the plugin) are unaffected and stay intact.

If you don't care about resuming pre-0.5 sessions, do nothing —
new sessions sync'd after the upgrade work for sync + push + the
plugin's chronicle digest. Old ones trigger a `vibebook doctor`
warning but otherwise behave normally.

### NEW — Cross-device session resume

Three new commands:

- `vibebook list-sessions [--project --since --device]` — find resumable sessions across all devices in the spool.
- `vibebook resume <sessionId>` — copy a spool session's jsonl into `~/.claude/projects/<encoded-cwd>/<id>.jsonl` and print the `cd <project> && claude --resume <id>` command to run.
- `vibebook config --map-path FROM=TO` — register a cross-device path translation (e.g. `/Users/alice=/Users/bob`) used by `resume` to rewrite jsonl paths.

Resume does NOT yet do fork bookkeeping (if both A and B resume the same session and continue, the diverging jsonls each ship at next sync). That's deferred to v0.5.1.

### Other changes

- `runner-check` removed (the runner abstraction died in v0.4.0 when digest moved to in-session Claude).
- `init-wizard` slimmed: 9 questions → 7. Closing message now suggests `/plugin install vibebook` for digest + recall.
- `doctor` checks for the vibebook plugin (`~/.claude/plugins/marketplaces/vibebook-plugin/`) and prints a `warn` line if missing. Also warns about `.raw.json` files without sibling `.jsonl` (pre-0.5 sessions that can't be resumed).
- `upgrade` no longer runs `plugin-install` at the end — recommends `/plugin update vibebook` instead.
- Config schema gains optional `pathMap?: Record<string, string>` for cross-device path translation.
- Test suite: 158 tests pass (down from 203 after removing tests for deleted commands; 17 new resume tests added).
