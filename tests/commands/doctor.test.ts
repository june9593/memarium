import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { doctorCmd } from "../../src/commands/doctor.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

describe("doctor legacy spool guidance", () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "memarium-doctor-"));
    repo = join(home, "session repo");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("MEMARIUM_DIR", join(home, ".memarium"));
    vi.stubEnv("PATH", join(home, "bin"));
    mkdirSync(join(home, "bin"));
    mkdirSync(join(home, ".memarium"));
    mkdirSync(join(home, ".claude/plugins/marketplaces/memarium-plugin"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".memarium"));
    mkdirSync(join(repo, "raw_sessions/claude/project-a"), { recursive: true });
    mkdirSync(join(repo, "raw_sessions/copilot/project-b"), { recursive: true });
    writeFileSync(join(home, ".memarium/config.json"), JSON.stringify({ repoPath: repo, repoUrl: "", deviceBranch: "fixture-machine" }));
    writeFileSync(join(repo, "raw_sessions/claude/project-a/retained.md"), "Only retained rendered copy");
    writeFileSync(join(repo, ".memarium/index.json"), JSON.stringify({ version: 1, entries: {
      "claude:retained": { sessionId: "retained", tool: "claude", relativePath: "raw_sessions/claude/project-a/retained.md", sourcePath: join(home, "source-no-longer-present.jsonl") },
    } }));
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "fixture-version\n", stderr: "", pid: 0, output: [], signal: null } as ReturnType<typeof spawnSync>);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  function snapshot() {
    const files: Record<string, string> = {};
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile()) files[relative(home, p)] = readFileSync(p, "utf8");
      }
    }
    walk(home);
    return files;
  }
  function output() { return vi.mocked(console.log).mock.calls.map((args) => args.join(" ")).join("\n"); }

  it("warns without recommending blanket deletion or resetting the shared index", async () => {
    writeFileSync(join(repo, "raw_sessions/claude/project-a/retained.raw.json"), "legacy source A");
    writeFileSync(join(repo, "raw_sessions/copilot/project-b/source-only.jsonl"), "legacy source B");
    const before = snapshot();
    await doctorCmd();
    const text = output();
    expect(text).toContain("1 .raw.json files, 1 .jsonl files");
    expect(text).toMatch(/back up.*session repo/i);
    expect(text).toMatch(/do not.*(?:delete|reset).*index/i);
    expect(text).toContain("source device");
    expect(text).toContain("individually verified");
    expect(text).toContain("memarium sync");
    expect(text).not.toContain("-delete");
    expect(text).not.toMatch(/\brm\b[^\n]*index\.json/);
    expect(text).not.toContain("regenerates index");
    expect(snapshot()).toEqual(before);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
  it.each(["only.raw.json", "only.jsonl"])("gives the same safe workflow for %s alone", async (name) => {
    writeFileSync(join(repo, "raw_sessions/copilot/project-b", name), "legacy data");
    await doctorCmd();
    expect(output()).toContain("individually verified");
    expect(output()).not.toContain("-delete");
    expect(process.exit).toHaveBeenCalledWith(0);
  });
  it("does not show legacy cleanup advice for a clean single-Markdown spool", async () => {
    const before = snapshot();
    await doctorCmd();
    expect(output()).not.toContain("0.5.x spool residue");
    expect(output()).not.toContain("individually verified");
    expect(output()).toContain("All checks passed");
    expect(snapshot()).toEqual(before);
  });
});
