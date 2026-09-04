import { readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { readConfig } from "../config.js";
import { loadIndex } from "../index-store.js";
import type { IndexEntry } from "../types.js";

export async function showCmd(ref: string): Promise<void> {
  const cfg = readConfig();
  const idx = loadIndex(cfg.repoPath);
  const entries: IndexEntry[] = Object.values(idx.entries);
  let hit = entries.find((entry) => entry.sessionId === ref);
  if (!hit) {
    const shortMatches = entries.filter((entry) => entry.shortId === ref);
    if (shortMatches.length > 1) {
      console.log(chalk.red([
        `ambiguous session shortId "${ref}":`,
        ...shortMatches.map((entry) => `  ${entry.sessionId}  ${entry.displayName}`),
        "use one of the full session IDs above",
      ].join("\n")));
      return;
    }
    hit = shortMatches[0] ?? entries.find((entry) =>
      entry.nameSlug === ref || entry.displayName === ref
    );
  }
  if (!hit) {
    console.log(chalk.red(`no session matching "${ref}"`));
    return;
  }
  const mdRel = hit.relativePath.replace(/\.raw\.json$/, ".md");
  const abs = join(cfg.repoPath, mdRel);
  process.stdout.write(readFileSync(abs).toString("utf8"));
}
