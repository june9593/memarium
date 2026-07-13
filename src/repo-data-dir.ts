/**
 * In-repo data directory used by memarium to store its indexes. The project
 * has been renamed twice: `.memvc/` → `.vibebook/` → `.memarium/`. A one-shot
 * migration in `migrateLegacyDataDir` renames the newest legacy dir it finds
 * (`.vibebook/`, else `.memvc/`) → `.memarium/` on first sync/digest run.
 *
 * Use these helpers (not raw string literals) anywhere a path inside this
 * directory is needed, so the next rename is a one-line change.
 */
import { join } from "node:path";

export const REPO_DATA_DIR = ".memarium";
/** Legacy in-repo data dirs to migrate FROM, newest first. */
export const LEGACY_REPO_DATA_DIRS = [".vibebook", ".memvc"] as const;

export const INDEX_REL = `${REPO_DATA_DIR}/index.json`;

export function dataDirAbs(repoPath: string): string {
  return join(repoPath, REPO_DATA_DIR);
}

export function indexAbs(repoPath: string): string {
  return join(repoPath, INDEX_REL);
}
