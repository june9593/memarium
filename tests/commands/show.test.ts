import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("showCmd", () => {
  let home: string;
  let repo: string;
  const ids = [
    "019f0000-aaaa-7000-8000-1111deadbeef",
    "019f0000-bbbb-7000-8000-2222deadbeef",
  ];

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "memarium-show-"));
    vi.stubEnv("HOME", home);
    repo = join(home, ".memarium/session-repo");
    mkdirSync(join(home, ".memarium"), { recursive: true });
    mkdirSync(join(repo, ".memarium"), { recursive: true });
    writeFileSync(join(home, ".memarium/config.json"), JSON.stringify({
      repoPath: repo,
      repoUrl: "",
      deviceBranch: "test",
      runner: "claude-cli",
    }));
    const entries: Record<string, unknown> = {};
    ids.forEach((sessionId, index) => {
      const relativePath = `raw_sessions/codex/demo/2026-01-01/session-${index}__${sessionId}.md`;
      mkdirSync(join(repo, "raw_sessions/codex/demo/2026-01-01"), { recursive: true });
      writeFileSync(join(repo, relativePath), `session ${index}\n`);
      entries[`codex:${sessionId}`] = {
        sessionId,
        shortId: "deadbeef",
        tool: "codex",
        project: "demo",
        projectRaw: "/tmp/demo",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:01Z",
        nameSlug: "same-title",
        displayName: `same title ${index}`,
        relativePath,
        sourcePath: `/tmp/${index}.jsonl`,
        sourceMtimeMs: 1,
        sourceSha256: `${index}`,
      };
    });
    writeFileSync(join(repo, ".memarium/index.json"), JSON.stringify({ version: 1, entries }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects an ambiguous shortId and prints both full session IDs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { showCmd } = await import("../../src/commands/show.js");
      await showCmd("deadbeef");
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(ids[0]!);
      expect(output).toContain(ids[1]!);
      expect(write).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
  });

  it("still shows an exact full session ID", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { showCmd } = await import("../../src/commands/show.js");
      await showCmd(ids[1]!);
      expect(write).toHaveBeenCalledWith(expect.stringContaining("session 1"));
    } finally {
      write.mockRestore();
    }
  });
});
