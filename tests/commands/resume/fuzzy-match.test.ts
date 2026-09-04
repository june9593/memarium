import { describe, it, expect } from "vitest";
import { findEntries } from "../../../src/commands/resume/fuzzy-match.js";
import type { IndexFile, IndexEntry } from "../../../src/types.js";

function mkEntry(overrides: Partial<IndexEntry>): IndexEntry {
  return {
    sessionId: overrides.sessionId ?? "44be6dba-566c-4481-9006-663001294111",
    shortId: (overrides.sessionId ?? "44be6dba-566c-4481-9006-663001294111").slice(0, 8),
    tool: "claude",
    project: "code-src",
    projectRaw: "/Users/me/code/src",
    startedAt: "2026-05-15T14:32:00Z",
    endedAt: "2026-05-15T16:18:00Z",
    nameSlug: "trace-memory-leak",
    displayName: "Trace memory leak",
    relativePath: "raw_sessions/claude/code-src/2026-05-15/trace-memory-leak__44be6dba.md",
    sourcePath: "/x.jsonl",
    sourceMtimeMs: 1,
    sourceSha256: "x",
    ...overrides,
  };
}

function mkIndex(entries: IndexEntry[]): IndexFile {
  const map: Record<string, IndexEntry> = {};
  for (const e of entries) map[`${e.tool}:${e.sessionId}`] = e;
  return { version: 1, entries: map };
}

describe("findEntries", () => {
  const a = mkEntry({ sessionId: "44be6dba-566c-4481-9006-663001294111" });
  const b = mkEntry({ sessionId: "44999999-1111-2222-3333-444444444444" });
  const c = mkEntry({ sessionId: "ffffffff-0000-0000-0000-000000000000" });
  const idx = mkIndex([a, b, c]);

  it("matches by exact full UUID", () => {
    expect(findEntries(idx, "44be6dba-566c-4481-9006-663001294111")).toEqual([a]);
  });

  it("matches by 8-char shortId", () => {
    expect(findEntries(idx, "44be6dba")).toEqual([a]);
  });

  it("matches by short prefix (< 8 chars)", () => {
    expect(findEntries(idx, "ffff")).toEqual([c]);
  });

  it("returns multiple when prefix is ambiguous", () => {
    const matches = findEntries(idx, "44");
    expect(matches.map((e) => e.sessionId).sort()).toEqual([
      "44999999-1111-2222-3333-444444444444",
      "44be6dba-566c-4481-9006-663001294111",
    ]);
  });

  it("returns empty array when no match", () => {
    expect(findEntries(idx, "deadbeef")).toEqual([]);
  });

  it("is case-insensitive on hex", () => {
    expect(findEntries(idx, "44BE6DBA")).toEqual([a]);
  });

  it("matches an exact source-specific shortId even when it is not a full-id prefix", () => {
    const codex = mkEntry({
      tool: "codex",
      sessionId: "019f0000-1111-7000-8000-0000aaaabbbb",
      shortId: "aaaabbbb",
    });
    expect(findEntries(mkIndex([codex]), "AAAABBBB")).toEqual([codex]);
  });

  it("keeps exact shortId collisions ambiguous", () => {
    const first = mkEntry({
      tool: "codex",
      sessionId: "019f0000-1111-7000-8000-0000aaaabbbb",
      shortId: "aaaabbbb",
    });
    const second = mkEntry({
      tool: "codex",
      sessionId: "019f0000-2222-7000-8000-0000aaaabbbb",
      shortId: "aaaabbbb",
    });
    expect(findEntries(mkIndex([first, second]), "aaaabbbb")).toEqual([first, second]);
  });
});
