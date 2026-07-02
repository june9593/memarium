import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Resolved lazily (not module-level consts) so they always reflect the current
// HOME — important for tests that stub HOME, and correct for a CLI in general.
function configDir(): string { return join(homedir(), ".memarium"); }
function configPath(): string { return join(configDir(), "config.json"); }

/** One-shot: move the whole config dir from the old `~/.vibebook/` (project's
 *  pre-rename name) to `~/.memarium/` if the old one exists and the new one
 *  doesn't. Idempotent, best-effort. Covers config.json, session-repo/,
 *  aggregated/, usage/, local-proposals/ in one move, then rewrites the
 *  absolute `~/.vibebook/` paths stored inside config.json. Runs before reads. */
export function migrateLegacyConfigDir(): void {
  const legacy = join(homedir(), ".vibebook");
  const dir = configDir();
  if (existsSync(dir) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, dir);
    // Fix stored absolute paths (repoPath etc.) that pointed into ~/.vibebook.
    const p = configPath();
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf8");
      const fixed = raw.split(legacy).join(dir);
      if (fixed !== raw) writeFileSync(p, fixed);
    }
  } catch { /* best-effort */ }
}

/** Default cap on concurrent runner calls during the threading phase.
 *  claude-cli can comfortably handle 4 (each spawn is its own subprocess
 *  against the user's own Claude quota). anthropic-api also fine at 4. */
export const DEFAULT_THREADING_CONCURRENCY = 4;

/** Default attempts per threading batch before soft-failing it. */
export const DEFAULT_THREADING_MAX_ATTEMPTS = 3;

const Schema = z.object({
  repoPath: z.string(),
  repoUrl: z.string(),
  deviceBranch: z.string().default(""),
  runner: z.enum(["claude-cli", "anthropic-api"]).default("claude-cli"),
  /** When true, the user opted into the CI book-aggregation workflow
   *  (scripts/merge-books.mjs runs on push to any non-main branch and
   *  merges device books into main). Purely informational — the workflow
   *  yaml + script live in the user's repo, not driven by this flag. */
  enableAggregateCI: z.boolean().default(false),
  /** When true, include the assistant's reasoning/thinking content in synced
   *  raw_sessions/*.md files. Improves digest quality (the summarizing LLM
   *  can see WHY the assistant chose a path) but can grow each md file by
   *  30-100%. Recommended when summarizing with a 400K+ context model;
   *  recommended off when summarizing with a smaller model. Default: true. */
  includeReasoning: z.boolean().default(true),
  threadingConcurrency: z.number().int().positive().default(DEFAULT_THREADING_CONCURRENCY),
  threadingMaxAttempts: z.number().int().positive().default(DEFAULT_THREADING_MAX_ATTEMPTS),
  digestEnabled: z.boolean().default(true),
  /** Cross-device path translation: source-prefix → this-machine-prefix.
   *  Used by `memarium resume` to rewrite jsonl paths from another machine
   *  into local paths. Set via `memarium config --map-path A=B`. */
  pathMap: z.record(z.string()).optional(),
  /** Locale for the rendered book pages (book/index.md, book/_meta/timeline.md,
   *  per-project index pages). Drives string tables in merge-books.mjs via
   *  the MEMARIUM_LOCALE env var the workflow yml exports. Default "en". */
  bookLocale: z.enum(["en", "zh"]).default("en"),
});
export type Config = z.infer<typeof Schema>;

export function configExists(): boolean { migrateLegacyConfigDir(); return existsSync(configPath()); }

export function readConfig(): Config {
  migrateLegacyConfigDir();
  if (!existsSync(configPath())) throw new Error("memarium not initialized. Run `memarium init <repoUrl>`.");
  return Schema.parse(JSON.parse(readFileSync(configPath(), "utf8")));
}

export function writeConfig(cfg: Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}
