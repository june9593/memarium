import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { readConfig } from "../config.js";
import { migrateLegacyDataDir } from "../migrate.js";
import { ensureRepo, commitToMainViaWorktree } from "../git-ops.js";

/**
 * Resolve the path to a bundled asset. The build emits to `dist/src/commands/`
 * (because tsconfig has rootDir="." and includes both bin/ and src/), while
 * dev runs from `src/commands/`. Probe both layouts plus npm-global ones.
 */
function assetPath(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", rel),       // src/commands/
    resolve(here, "..", "..", "..", rel), // dist/src/commands/
    resolve(here, "..", "..", "..", "..", rel),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `memarium bundled asset not found: ${rel}. Tried:\n  ${candidates.join("\n  ")}\nIf you installed memarium from npm, please file an issue.`,
  );
}

const WORKFLOW_REL = ".github/workflows/memarium-aggregate.yml";
const SCRIPT_REL = "scripts/merge-books.mjs";

/**
 * Read the workflow yaml template and substitute the user's `bookLocale`
 * into the `MEMARIUM_LOCALE` env line. Done at install time so the
 * locale travels with the workflow on main (not pulled per-CI-run).
 */
function renderWorkflowYaml(bookLocale: string): string {
  const raw = readFileSync(assetPath("assets/workflows/memarium-aggregate.yml"), "utf8");
  return raw.replace("__MEMARIUM_LOCALE__", bookLocale);
}

/**
 * `memarium workflow init` — install the CI aggregation workflow + merge
 * script directly onto the **main** branch (where GitHub Actions actually
 * reads them from), without touching the user's current device branch or
 * working tree.
 *
 * Why main instead of the device branch: GitHub Actions only resolves
 * workflow files from the default branch. If we wrote them to a device
 * branch, every CI run would fail with MODULE_NOT_FOUND on the merge
 * script (because main, where the workflow checks out, doesn't have it).
 * That was the 0.5.0 → 0.5.2 cold-start bug.
 *
 * Local-only repos (no repoUrl) still get files written to the device
 * branch's working tree for completeness, but won't push anywhere.
 */
export async function workflowInitCmd(opts: { force?: boolean; noPush?: boolean } = {}): Promise<void> {
  const cfg = readConfig();

  // Local-only mode: write into the current working tree like before.
  // Nothing to push — no CI matters in this mode anyway.
  if (!cfg.repoUrl) {
    const yamlTarget = join(cfg.repoPath, WORKFLOW_REL);
    const scriptTarget = join(cfg.repoPath, SCRIPT_REL);
    if ((existsSync(yamlTarget) || existsSync(scriptTarget)) && !opts.force) {
      if (existsSync(yamlTarget)) console.log(chalk.yellow(`already exists: ${yamlTarget}`));
      if (existsSync(scriptTarget)) console.log(chalk.yellow(`already exists: ${scriptTarget}`));
      console.log(chalk.gray("  re-run with --force to overwrite"));
      return;
    }
    mkdirSync(dirname(yamlTarget), { recursive: true });
    writeFileSync(yamlTarget, renderWorkflowYaml(cfg.bookLocale));
    mkdirSync(dirname(scriptTarget), { recursive: true });
    writeFileSync(scriptTarget, readFileSync(assetPath("assets/scripts/merge-books.mjs"), "utf8"));
    console.log(chalk.green(`workflow + script written under ${cfg.repoPath}`));
    console.log(chalk.gray("Local-only mode: no remote configured — CI aggregation has no effect."));
    return;
  }

  // Remote-mode: install on main via a temp worktree so we don't disturb the
  // user's device branch or working tree.
  if (opts.noPush) {
    console.log(chalk.yellow(
      "  --no-push is incompatible with the new workflow-init flow (which writes\n" +
      "  directly to origin/main via a temp worktree). To inspect files locally,\n" +
      "  see assets/workflows/memarium-aggregate.yml + assets/scripts/merge-books.mjs\n" +
      "  in the memarium npm package.",
    ));
    return;
  }

  // Opportunistic: rename the newest legacy data dir (`.vibebook/`, else
  // `.memvc/`) → `.memarium/` if the user skipped it on earlier syncs. This
  // happens on the user's main working tree (device branch), independent of
  // the main-side workflow push below.
  const dataDirMig = await migrateLegacyDataDir(cfg.repoPath);
  if (dataDirMig.migrated) {
    console.log(chalk.green(`renamed legacy ${dataDirMig.from}/ → .memarium/ ${dataDirMig.viaGit ? "(via git mv)" : ""}`));
  }

  const git = await ensureRepo(cfg.repoPath, cfg.repoUrl);
  console.log(chalk.cyan("Installing workflow + script on origin/main..."));
  const r = await commitToMainViaWorktree(
    git,
    cfg.repoPath,
    async (worktreePath) => {
      const yamlAbs = join(worktreePath, WORKFLOW_REL);
      const scriptAbs = join(worktreePath, SCRIPT_REL);
      const newYaml = renderWorkflowYaml(cfg.bookLocale);
      const newScript = readFileSync(assetPath("assets/scripts/merge-books.mjs"), "utf8");
      // If the file is already present on main and we're not --force, skip.
      if (!opts.force && existsSync(yamlAbs) && existsSync(scriptAbs)) {
        const existingYaml = readFileSync(yamlAbs, "utf8");
        const existingScript = readFileSync(scriptAbs, "utf8");
        if (existingYaml === newYaml && existingScript === newScript) {
          // Nothing changes; tell the worktree commit step to no-op.
          return [];
        }
      }
      mkdirSync(dirname(yamlAbs), { recursive: true });
      writeFileSync(yamlAbs, newYaml);
      mkdirSync(dirname(scriptAbs), { recursive: true });
      writeFileSync(scriptAbs, newScript);
      return [WORKFLOW_REL, SCRIPT_REL];
    },
    "memarium: install / update CI aggregation workflow + merge-books script",
    (stage) => console.log(chalk.gray(`  ${stage}`)),
  );
  if (r.committed && r.pushed) {
    console.log(chalk.green(`\n✓ workflow + script pushed to origin/main`));
    console.log(chalk.gray("The workflow fires on every push to a non-main branch."));
    console.log(chalk.gray("Each device's `memarium sync` will trigger it; CI merges all device book/s into main."));
  } else if (!r.committed) {
    console.log(chalk.gray("\nMain already has the latest workflow + script (no-op)."));
  } else {
    console.log(chalk.yellow("\n! committed locally on the temp worktree but push failed."));
    console.log(chalk.cyan("  Inspect ~/.memarium/session-repo, fetch origin/main, and retry."));
  }
}
