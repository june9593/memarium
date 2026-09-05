import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { commitAndPush } from "../src/git-ops.js";

describe("bounded git staging", () => {
  let home: string;
  let repo: string;
  let remote: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "memarium-stage-pathspec-"));
    vi.stubEnv("HOME", home);
    repo = join(home, "repo"); remote = join(home, "origin.git");
    mkdirSync(repo); mkdirSync(remote);
    await simpleGit(remote).raw(["init", "--bare", "-b", "main"]);
    const git = simpleGit(repo);
    await git.raw(["init", "-b", "main"]);
    await git.addConfig("user.name", "Test");
    await git.addConfig("user.email", "test@example.com");
    writeFileSync(join(repo, "README.md"), "fixture");
    await git.add(["README.md"]);
    await git.commit("seed");
    await git.addRemote("origin", remote);
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("stages a selection exceeding argv limits through a literal NUL pathspec file", async () => {
    mkdirSync(join(repo, "raw_sessions"));
    const selected = `raw_sessions/${"a".repeat(100)}[12].md`;
    const unselected = `raw_sessions/${"a".repeat(100)}1.md`;
    writeFileSync(join(repo, selected), "selected content");
    writeFileSync(join(repo, unselected), "unselected content");
    const paths = Array.from({ length: 20000 }, () => selected);
    expect(Buffer.byteLength(paths.join("\0"))).toBeGreaterThan(2 * 1024 * 1024);
    const git = simpleGit(repo);
    const calls = vi.spyOn(git, "raw");
    const result = await commitAndPush(git, "large selection", paths, "main");
    expect(result.pushed).toBe(true);
    const add = calls.mock.calls.find(([args]) => args.includes("add"))?.[0];
    expect(add).toContain("--literal-pathspecs");
    expect(add).toContain("--pathspec-file-nul");
    const pathspec = add!.find((arg) => arg.startsWith("--pathspec-from-file="))!.split("=")[1]!;
    expect(existsSync(pathspec)).toBe(false);
    expect(await simpleGit(remote).show([`main:${selected}`])).toBe(readFileSync(join(repo, selected), "utf8"));
    expect(await git.raw(["ls-files", "--", unselected])).toBe("");
  }, 30_000);

  it("cleans the temporary pathspec file after a staging failure", async () => {
    const git = simpleGit(repo);
    const calls = vi.spyOn(git, "raw");
    await expect(commitAndPush(git, "missing", ["raw_sessions/absent.md"], "main")).rejects.toThrow();
    const add = calls.mock.calls.find(([args]) => args.includes("add"))?.[0];
    expect(add).toContain("--pathspec-file-nul");
    const pathspec = add!.find((arg) => arg.startsWith("--pathspec-from-file="))!.split("=")[1]!;
    expect(existsSync(pathspec)).toBe(false);
    expect((await git.log()).total).toBe(1);
  });
});
