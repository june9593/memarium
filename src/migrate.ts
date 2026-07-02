import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { LEGACY_REPO_DATA_DIRS, REPO_DATA_DIR } from "./repo-data-dir.js";

/**
 * One-shot migration for repos created before per-device-branches existed.
 *
 * If the local repo has a `main` branch but no `<device>` branch, rename
 * main → <device> (preserving history) so the device branch becomes the
 * new write target. `main` is left unborn on purpose — it will be re-created
 * later (manually or by a future merge-to-main command) as the aggregate view.
 *
 * No-op when:
 *   - the device branch already exists (migration was already done, or a
 *     fresh clone is already on the right branch)
 *   - there is no `main` branch to rename
 */
export async function migrateLegacyMainToDevice(
  repoPath: string,
  deviceBranch: string,
): Promise<{ migrated: boolean }> {
  const git = simpleGit(repoPath);
  const local = await git.branchLocal();
  if (local.all.includes(deviceBranch)) return { migrated: false };
  if (!local.all.includes("main")) return { migrated: false };

  if (local.current !== "main") await git.checkout("main");
  await git.branch(["-m", "main", deviceBranch]);
  return { migrated: true };
}

/**
 * One-shot migration: rename an in-repo legacy data dir → `.memarium/`.
 *
 * The project was renamed memvc → vibebook → memarium. Any sync/digest run
 * that finds a legacy dir (`.vibebook/`, else `.memvc/`) and no `.memarium/`
 * moves it via `git mv` (so history follows) and stages it for the next
 * commit. Returns the legacy dir it migrated from (for logging).
 *
 * No-op when:
 *   - the repo has no legacy dir (fresh repo, or migration already done)
 *   - the repo already has `.memarium/` (migration already done)
 *   - the repo isn't a git repo (we still do a non-git rename so non-pushing
 *     local-only mode works)
 */
export async function migrateLegacyDataDir(
  repoPath: string,
): Promise<{ migrated: boolean; viaGit: boolean; from?: string }> {
  const target = join(repoPath, REPO_DATA_DIR);
  if (existsSync(target)) return { migrated: false, viaGit: false };
  const from = LEGACY_REPO_DATA_DIRS.find((d) => existsSync(join(repoPath, d)));
  if (!from) return { migrated: false, viaGit: false };

  const isGitRepo = existsSync(join(repoPath, ".git"));
  if (isGitRepo) {
    const git = simpleGit(repoPath);
    // git mv preserves history. Use the directory form; git stages every file
    // under it. The result is staged but not committed — runSync's commit
    // bundles it with the rest of the sync's paths.
    await git.raw(["mv", from, REPO_DATA_DIR]);
    return { migrated: true, viaGit: true, from };
  }

  // Non-git fallback: plain rename. Used by local-only mode + tests that
  // never init a git repo.
  const { renameSync } = await import("node:fs");
  renameSync(join(repoPath, from), target);
  return { migrated: true, viaGit: false, from };
}

/** Returns the list of repo-rooted paths a successful data-dir migration produces, suitable for `git add`. */
export function migratedDataDirPaths(repoPath: string): string[] {
  const dir = join(repoPath, REPO_DATA_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => `${REPO_DATA_DIR}/${f}`);
}
