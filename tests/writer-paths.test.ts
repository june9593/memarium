import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
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
    const renamed = writeSession(repo, { ...session, project: "DEMO", nameSlug: "foo", displayName: "foo" });
    const physical = relative(realpathSync.native(target), realpathSync.native(join(repo, renamed.md))).split(sep).join("/");
    expect(renamed.md).toBe(`raw_sessions/${physical}`);
  });

  for (const component of ["raw_sessions", "project"]) {
    it(`preserves a ${component} symlink whose target differs only in case`, (ctx) => {
      const repo = join(root, "repo");
      const parent = component === "raw_sessions" ? repo : join(repo, "raw_sessions", "copilot");
      const name = component === "raw_sessions" ? "raw_sessions" : "demo";
      mkdirSync(parent, { recursive: true });
      const target = join(parent, name.toUpperCase());
      mkdirSync(target);
      // This pair cannot coexist on a case-insensitive filesystem.
      if (existsSync(join(parent, name))) {
        rmSync(root, { recursive: true, force: true });
        ctx.skip(); return;
      }
      symlinkSync(target, join(parent, name), process.platform === "win32" ? "junction" : "dir");
      const session: NormalizedSession = {
        tool: "copilot", sessionId: "12345678-abcd-4000-8000-123456789abc", shortId: "12345678",
        project: "demo", projectRaw: "/tmp/demo", nameSlug: "Foo", displayName: "Foo",
        startedAt: "2026-09-01T12:00:00Z", endedAt: "2026-09-01T12:00:00Z", sourcePath: join(root, "source.json"),
        messages: [{ role: "user", text: "Inspect configuration" }],
      };
      expect(writeSession(repo, session).md).toBe("raw_sessions/copilot/demo/2026-09-01/Foo__12345678.md");
    });
  }

  for (const component of ["raw_sessions", "project"]) {
    it(`records the actual spelling of a case-aliased ${component} symlink entry`, (ctx) => {
      const repo = join(root, "repo");
      const parent = component === "raw_sessions" ? repo : join(repo, "raw_sessions", "copilot");
      const name = component === "raw_sessions" ? "raw_sessions" : "demo";
      const target = join(root, "link-target");
      mkdirSync(parent, { recursive: true });
      mkdirSync(target);
      symlinkSync(target, join(parent, name.toUpperCase()), process.platform === "win32" ? "junction" : "dir");
      if (!existsSync(join(parent, name))) {
        rmSync(root, { recursive: true, force: true });
        ctx.skip(); return; // requires a case-insensitive lookup
      }
      // Another link to the same target must not be mistaken for this entry.
      symlinkSync(target, join(parent, "another-link"), process.platform === "win32" ? "junction" : "dir");
      const session: NormalizedSession = {
        tool: "copilot", sessionId: "12345678-abcd-4000-8000-123456789abc", shortId: "12345678",
        project: "demo", projectRaw: "/tmp/demo", nameSlug: "Foo", displayName: "Foo",
        startedAt: "2026-09-01T12:00:00Z", endedAt: "2026-09-01T12:00:00Z", sourcePath: join(root, "source.json"),
        messages: [{ role: "user", text: "Inspect configuration" }],
      };
      const expected = component === "raw_sessions"
        ? "RAW_SESSIONS/copilot/demo/2026-09-01/Foo__12345678.md"
        : "raw_sessions/copilot/DEMO/2026-09-01/Foo__12345678.md";
      const { md } = writeSession(repo, session);
      expect(md).toBe(expected);
      expect(existsSync(join(repo, md))).toBe(true);
    });
  }
});
