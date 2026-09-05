import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../src/writer.js";
import type { NormalizedSession } from "../src/types.js";

describe("writer logical paths", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "memarium-writer-paths-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it.each([false, true])("retains raw_sessions when it is a symlink (external: %s)", (external) => {
    const repo = join(root, "repo");
    const target = join(external ? root : repo, "storage");
    mkdirSync(repo);
    mkdirSync(target);
    symlinkSync(target, join(repo, "raw_sessions"), process.platform === "win32" ? "junction" : "dir");
    const session: NormalizedSession = {
      tool: "copilot", sessionId: "12345678-abcd-4000-8000-123456789abc", shortId: "12345678",
      project: "demo", projectRaw: "/tmp/demo", nameSlug: "Foo", displayName: "Foo",
      startedAt: "2026-09-01T12:00:00Z", endedAt: "2026-09-01T12:00:00Z", sourcePath: join(root, "source.json"),
      messages: [{ role: "user", text: "Inspect configuration" }],
    };
    const written = writeSession(repo, session);
    expect(written.md).toBe("raw_sessions/copilot/demo/2026-09-01/Foo__12345678.md");
    expect(existsSync(join(repo, written.md))).toBe(true);
  });
});
