import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { simpleGit } from "simple-git";
import { runSync, type SyncOptions } from "../../src/commands/sync.js";
import { loadIndex, saveIndex } from "../../src/index-store.js";
import * as gitOps from "../../src/git-ops.js";

const id = "12345678-abcd-4000-8000-123456789abc";
const key = `copilot:${id}`;

describe("sync staging after filename migration", () => {
  let home: string;
  let repo: string;
  let remote: string;
  let storage: string;
  let options: SyncOptions;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "memarium-staging-"));
    vi.stubEnv("HOME", home);
    repo = join(home, "repo");
    remote = join(home, "origin.git");
    storage = join(home, "vscode");
    for (const dir of [repo, remote, storage]) mkdirSync(dir);
    await simpleGit(remote).raw(["init", "--bare", "-b", "device-test"]);
    const git = simpleGit(repo);
    await git.raw(["init", "-b", "device-test"]);
    await git.addConfig("user.name", "Test");
    await git.addConfig("user.email", "test@example.com");
    writeFileSync(join(repo, "README.md"), "fixture\n");
    mkdirSync(join(repo, ".memarium"));
    writeFileSync(join(repo, ".memarium/index.json"), JSON.stringify({ version: 1, entries: {} }));
    await git.add(["README.md", ".memarium/index.json"]);
    await git.commit("seed");
    await git.addRemote("origin", remote);
    await git.push("origin", "device-test");
    options = {
      repoPath: repo, repoUrl: remote, deviceBranch: "device-test", push: true,
      claudeRoot: join(home, "empty-claude"), vscodeRoot: storage,
      codexRoot: join(home, "empty-codex"),
    };
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function source(workspace: string, project: string, title: string) {
    const ws = join(storage, workspace);
    mkdirSync(join(ws, "chatSessions"), { recursive: true });
    writeFileSync(join(ws, "workspace.json"), JSON.stringify({
      folder: pathToFileURL(join(home, "projects", project)).href,
    }));
    const content = { version: 3, sessionId: id, customTitle: title, requests: [{
      requestId: workspace,
      message: { text: "Inspect the configuration loader" },
      response: [{ kind: "markdownContent", content: { value: "The configuration path was verified." } }],
      timestamp: Date.parse("2026-09-01T12:00:00Z"),
    }] };
    writeFileSync(join(ws, "chatSessions", `${id}.json`), JSON.stringify(content));
  }

  async function expectPublishedRender() {
    const idx = loadIndex(repo);
    expect(Object.keys(idx.entries)).toEqual([key]);
    const relativePath = idx.entries[key]!.relativePath;
    expect(existsSync(join(repo, relativePath))).toBe(true);
    const g = simpleGit(remote);
    const published = JSON.parse(await g.show(["device-test:.memarium/index.json"]));
    expect(published.entries[key].relativePath).toBe(relativePath);
    expect(await g.show([`device-test:${relativePath}`]))
      .toBe(readFileSync(join(repo, relativePath), "utf8"));
    const rawPaths = (await g.raw(["ls-tree", "-r", "--name-only", "-z", "device-test", "--", "raw_sessions"]))
      .split("\0").filter(Boolean);
    expect(rawPaths).toEqual([relativePath]);
  }

  it("stages the final render when duplicate workspaces create then delete an untracked intermediate file", async () => {
    source("workspace-a", "one", "第一次标题");
    source("workspace-b", "two", "最终标题");
    const result = await runSync(options);
    expect(result.pushed).toBe(true);
    await expectPublishedRender();
  }, 30_000);

  it("stages a deleted untracked old render without a missing pathspec", async () => {
    source("workspace-a", "one", "Old title");
    await runSync({ ...options, push: false });
    const oldPath = loadIndex(repo).entries[key]!.relativePath;
    expect(await simpleGit(repo).raw(["ls-files", "--", oldPath])).toBe("");
    source("workspace-a", "one", "New title");
    const result = await runSync(options);
    expect(result.pushed).toBe(true);
    expect(existsSync(join(repo, oldPath))).toBe(false);
    await expectPublishedRender();
  }, 30_000);

  it("recovers skipped replacement files and tracked deletions after an interrupted staging attempt", async () => {
    source("workspace-a", "one", "Tracked original");
    await runSync(options);
    const oldPath = loadIndex(repo).entries[key]!.relativePath;
    source("workspace-a", "one", "New title");
    const failing = vi.spyOn(gitOps, "commitAndPush").mockRejectedValueOnce(new Error("interrupted staging"));
    await expect(runSync(options)).rejects.toThrow("interrupted staging");
    failing.mockRestore();
    const newPath = loadIndex(repo).entries[key]!.relativePath;
    expect(existsSync(join(repo, newPath))).toBe(true);
    expect(existsSync(join(repo, oldPath))).toBe(false);
    writeFileSync(join(repo, "unrelated-notes.txt"), "must stay outside the sync commit");
    writeFileSync(join(repo, "raw_sessions/unindexed-notes.md"), "not a rendered indexed session");
    const retry = await runSync(options);
    expect(retry).toMatchObject({ newCount: 0, skippedCount: 1, pushed: true });
    await expectPublishedRender();
    expect(await simpleGit(repo).raw(["ls-files", "--", "unrelated-notes.txt", "raw_sessions/unindexed-notes.md"])).toBe("");
  }, 30_000);

  it("never deletes a path that the final index still references after an A-B-A discovery order", async () => {
    for (const name of ["workspace-a", "workspace-b", "workspace-c"]) {
      mkdirSync(join(storage, name));
    }
    const order = readdirSync(storage);
    source(order[0]!, "one", "Same title");
    source(order[1]!, "two", "Other title");
    source(order[2]!, "one", "Same title");
    for (const ws of order) {
      utimesSync(join(storage, ws, "chatSessions", `${id}.json`), new Date("2026-09-01"), new Date("2026-09-01"));
    }
    expect((await runSync({ ...options, push: false })).newCount).toBe(3);
    expect(existsSync(join(repo, loadIndex(repo).entries[key]!.relativePath))).toBe(true);
  }, 30_000);

  it("sends only pending raw paths to staging even with a large clean indexed archive", async () => {
    source("workspace-a", "one", "Original title");
    await runSync(options);
    const idx = loadIndex(repo);
    const entry = idx.entries[key]!;
    for (let i = 0; i < 500; i++) {
      const sessionId = `archived-${i}`;
      const path = `raw_sessions/copilot/archive-${i}.md`;
      writeFileSync(join(repo, path), `Archive ${i}`);
      idx.entries[`copilot:${sessionId}`] = { ...entry, sessionId, relativePath: path, sourcePath: join(home, `absent-${i}`) };
    }
    writeFileSync(join(repo, ".memarium/index.json"), JSON.stringify(idx, null, 2) + "\n");
    const git = simpleGit(repo);
    await git.add(["raw_sessions", ".memarium/index.json"]);
    await git.commit("seed a clean archive");
    await git.push("origin", "device-test");

    const commit = vi.spyOn(gitOps, "commitAndPush");
    const noop = await runSync(options);
    expect(noop.committed).toBe(false);
    expect(commit.mock.calls[0]![2].filter((p) => p.startsWith("raw_sessions/"))).toEqual([]);
    commit.mockClear();

    writeFileSync(join(repo, entry.relativePath), "Updated pending render");
    writeFileSync(join(repo, "raw_sessions/unindexed.md"), "not an indexed render");
    expect((await runSync(options)).pushed).toBe(true);
    expect(commit.mock.calls[0]![2].filter((p) => p.startsWith("raw_sessions/"))).toEqual([entry.relativePath]);
    expect(await simpleGit(remote).show([`device-test:${entry.relativePath}`])).toBe("Updated pending render");
    expect(await git.raw(["ls-files", "--", "raw_sessions/unindexed.md"])).toBe("");
  }, 30_000);

  it("does not stage a missing render still referenced by the final index when its source cannot load", async () => {
    source("workspace-a", "one", "Keep remote evidence");
    await runSync(options);
    const entry = loadIndex(repo).entries[key]!;
    const oldBody = readFileSync(join(repo, entry.relativePath), "utf8");
    rmSync(join(repo, entry.relativePath));
    writeFileSync(join(storage, "workspace-a", "chatSessions", `${id}.json`), '{"requests":');
    const commit = vi.spyOn(gitOps, "commitAndPush");
    await runSync(options);
    expect(commit.mock.calls[0]![2]).not.toContain(entry.relativePath);
    const remoteGit = simpleGit(remote);
    const published = JSON.parse(await remoteGit.show(["device-test:.memarium/index.json"]));
    expect(await remoteGit.show([`device-test:${published.entries[key].relativePath}`])).toBe(oldBody);
  }, 30_000);

  it.each([false, true])("keeps an actionable committed path after a case-only title change (legacy alias: %s)", async (legacyAlias, ctx) => {
    source("workspace-a", "one", "Foo");
    await runSync(options);
    if (legacyAlias) {
      const idx = loadIndex(repo);
      const alias = idx.entries[key]!.relativePath.replace("Foo__", "foo__");
      if (!existsSync(join(repo, alias))) { ctx.skip(); return; } // case-sensitive filesystem
      idx.entries[key]!.relativePath = alias;
      saveIndex(repo, idx);
    }
    source("workspace-a", "one", "foo");
    await runSync(options);
    expect(loadIndex(repo).entries[key]!.displayName).toBe("foo");
    await expectPublishedRender();
  }, 30_000);
});
