import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { migrateLegacyConfigDir } from "../src/config.js";

describe("migrateLegacyConfigDir", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mema-cfgmig-"));
    vi.stubEnv("HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function plantLegacy(cfg: Record<string, unknown>): string {
    const legacy = join(home, ".vibebook");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
    return legacy;
  }

  it("moves ~/.vibebook → ~/.memarium and rewrites the absolute repoPath in config.json", () => {
    plantLegacy({ repoPath: join(home, ".vibebook", "session-repo"), repoUrl: "", deviceBranch: "" });
    migrateLegacyConfigDir();
    expect(existsSync(join(home, ".vibebook"))).toBe(false);
    expect(existsSync(join(home, ".memarium"))).toBe(true);
    const raw = readFileSync(join(home, ".memarium", "config.json"), "utf8");
    expect(JSON.parse(raw).repoPath).toBe(join(home, ".memarium", "session-repo"));
    // The most error-prone part: no stale ~/.vibebook path leaks through.
    expect(raw).not.toContain(".vibebook");
  });

  it("no-op when ~/.memarium already exists (never touches legacy)", () => {
    plantLegacy({ repoPath: "x" });
    mkdirSync(join(home, ".memarium"), { recursive: true });
    migrateLegacyConfigDir();
    expect(existsSync(join(home, ".vibebook"))).toBe(true); // untouched
  });

  it("no-op (no throw) when legacy ~/.vibebook is absent", () => {
    expect(() => migrateLegacyConfigDir()).not.toThrow();
    expect(existsSync(join(home, ".memarium"))).toBe(false);
  });

  it("rewrites a literal-tilde repoPath (~/.vibebook → ~/.memarium)", () => {
    // config.json may legally store repoPath with a literal ~ (finalize.test.ts).
    // The move must rewrite it too, else the ~ re-expands to the old location.
    plantLegacy({ repoPath: "~/.vibebook/session-repo", repoUrl: "", deviceBranch: "" });
    migrateLegacyConfigDir();
    const raw = readFileSync(join(home, ".memarium", "config.json"), "utf8");
    expect(JSON.parse(raw).repoPath).toBe("~/.memarium/session-repo");
    expect(raw).not.toContain(".vibebook");
  });

  it("repairs the aggregated worktree so it stays usable after the move", () => {
    // Reproduce the real layout: a session-repo with a linked `aggregated/`
    // worktree, both under ~/.vibebook. The worktree stores its link to the
    // repo as an ABSOLUTE path, so a bulk dir rename staled it before this fix.
    const legacy = join(home, ".vibebook");
    const repo = join(legacy, "session-repo");
    const agg = join(legacy, "aggregated");
    mkdirSync(repo, { recursive: true });
    const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    g(["init", "-b", "main"]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "hi\n");
    g(["add", "."]);
    g(["commit", "-m", "init"]);
    // In reality the session-repo sits on a device branch while the aggregated
    // worktree checks out `main`; mirror that so `worktree add … main` is legal.
    g(["checkout", "-b", "device"]);
    g(["worktree", "add", agg, "main"]);
    writeFileSync(join(legacy, "config.json"), JSON.stringify({ repoPath: repo }) + "\n");

    migrateLegacyConfigDir();

    const newRepo = join(home, ".memarium", "session-repo");
    const newAgg = join(home, ".memarium", "aggregated");
    expect(existsSync(join(newAgg, ".git"))).toBe(true);
    // The worktree resolves cleanly from its new location — no fatal "not a
    // working tree" — proving the absolute back-link was repaired.
    const st = execFileSync("git", ["-C", newAgg, "status", "--porcelain"], { stdio: "pipe" }).toString();
    expect(st).toBe("");
    // …and the main repo lists the worktree at its NEW path.
    const list = execFileSync("git", ["-C", newRepo, "worktree", "list"], { stdio: "pipe" }).toString();
    expect(list).toContain(newAgg);
  });
});
