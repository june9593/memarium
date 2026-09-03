import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter, parseCodexJsonl } from "../../src/sources/codex.js";
import type { NormalizedSession } from "../../src/types.js";

const fixturesDir = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "fixtures",
  "codex",
);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function discover(root = fixturesDir) {
  const found = [];
  for await (const session of new CodexAdapter(root).discover()) found.push(session);
  return found;
}

async function loadAll(root = fixturesDir): Promise<Map<string, NormalizedSession>> {
  const out = new Map<string, NormalizedSession>();
  for (const discovered of await discover(root)) {
    const session = await discovered.load();
    out.set(session.sessionId, session);
  }
  return out;
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memarium-codex-"));
  tempDirs.push(root);
  return root;
}

function jsonl(...rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

describe("CodexAdapter discovery", () => {
  it("discovers Desktop, interactive CLI, user forks, and archived sessions", async () => {
    const found = await discover();
    const loaded = await Promise.all(found.map((entry) => entry.load()));
    expect(loaded.map((session) => session.sessionId).sort()).toEqual([
      "019f0000-1111-7000-8000-0000aaaabbbb",
      "019f0000-2222-7000-8000-0000ccccdddd",
      "019f0000-5555-7000-8000-000033334444",
      "019f0000-6666-7000-8000-000055556666",
    ]);
    expect(found.some((entry) => entry.sourcePath.includes("archived_sessions"))).toBe(true);
  });

  it("excludes codex_exec and explicit subagent threads", async () => {
    const paths = (await discover()).map((entry) => entry.sourcePath);
    expect(paths.some((path) => path.includes("rollout-exec"))).toBe(false);
    expect(paths.some((path) => path.includes("rollout-subagent"))).toBe(false);
  });

  it("prefers an active rollout over an archived duplicate with the same full id", async () => {
    const root = makeRoot();
    const activeDir = join(root, "sessions", "2026", "05", "01");
    const archivedDir = join(root, "archived_sessions");
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(archivedDir, { recursive: true });
    const id = "019f0000-7777-7000-8000-000077778888";
    const rows = jsonl(
      { timestamp: "2026-05-01T00:00:00Z", type: "session_meta", payload: {
        id, timestamp: "2026-05-01T00:00:00Z", cwd: "/tmp/demo", originator: "codex-tui", source: "cli",
      } },
      { timestamp: "2026-05-01T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "keep the active copy" } },
    );
    writeFileSync(join(activeDir, `rollout-${id}.jsonl`), rows);
    writeFileSync(join(archivedDir, `rollout-${id}.jsonl`), rows);

    const found = await discover(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.sourcePath).toBe(join(activeDir, `rollout-${id}.jsonl`));
  });

  it("includes title and source location in the fingerprint", async () => {
    const root = makeRoot();
    cpSync(fixturesDir, root, { recursive: true });
    const before = await discover(root);
    const desktopBefore = before.find((entry) => entry.sourcePath.includes("rollout-desktop"))!;
    const index = join(root, "session_index.jsonl");
    writeFileSync(index, readFileSync(index, "utf8") + JSON.stringify({
      id: "019f0000-1111-7000-8000-0000aaaabbbb",
      thread_name: "Renamed desktop thread",
      updated_at: "2026-09-01T11:00:00Z",
    }) + "\n");
    const after = await discover(root);
    const desktopAfter = after.find((entry) => entry.sourcePath.includes("rollout-desktop"))!;
    expect(desktopAfter.sourceMtimeMs).toBe(desktopBefore.sourceMtimeMs);
    expect(desktopAfter.sourceSha256).not.toBe(desktopBefore.sourceSha256);
    expect((await desktopAfter.load()).displayName).toBe("Renamed desktop thread");
  });
});

describe("CodexAdapter parsing", () => {
  it("parses a current Desktop rollout without duplicating display and response records", async () => {
    const sessions = await loadAll();
    const session = sessions.get("019f0000-1111-7000-8000-0000aaaabbbb")!;

    expect(session.tool).toBe("codex");
    expect(session.shortId).toBe("aaaabbbb");
    expect(session.projectRaw).toBe("/Users/test/Documents/Codex/2026-09-01/demo");
    expect(session.project).toBe("2026-09-01-demo");
    expect(session.displayName).toBe("Desktop retry policy");
    expect(session.startedAt).toBe("2026-09-01T10:00:01.000Z");
    expect(session.endedAt).toBe("2026-09-01T10:00:09.001Z");

    const users = session.messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe("Fix the retry policy without changing the public API.");
    expect(session.messages.filter((message) => message.text === "I will inspect the retry path first.")).toHaveLength(1);
    expect(session.messages.filter((message) => message.text === "The retry policy is updated and tests pass.")).toHaveLength(1);
    expect(session.messages.some((message) => message.text.includes("Internal instructions"))).toBe(false);
    expect(session.messages.some((message) => message.text.includes("Internal review instructions"))).toBe(false);
    expect(session.messages.some((message) => message.text.includes("private UI state"))).toBe(false);

    const thinking = session.messages.flatMap((message) => message.contentBlocks ?? [])
      .filter((block) => block.type === "thinking");
    expect(thinking).toEqual([{ type: "thinking", thinking: "Inspect retry state" }]);

    const toolUses = session.messages.flatMap((message) => message.contentBlocks ?? [])
      .filter((block) => block.type === "tool_use");
    expect(toolUses).toHaveLength(2);
    expect(toolUses[0]).toMatchObject({ name: "exec", id: "call-desktop-1", input: { cmd: "git status --short" } });
    expect(toolUses[1]).toMatchObject({
      name: "apply_patch",
      id: "call-desktop-2",
      input: { patch: expect.stringContaining("*** Move to: src/retry.ts") },
    });
    const results = session.messages.flatMap((message) => message.contentBlocks ?? [])
      .filter((block) => block.type === "tool_result");
    expect(results).toEqual([
      { type: "tool_result", toolUseId: "call-desktop-1", content: " M src/retry.ts\ndone" },
      { type: "tool_result", toolUseId: "call-desktop-2", content: "Done!" },
    ]);
  });

  it("parses interactive CLI, keeps short real prompts, response-only legacy text, and repeated turns", async () => {
    const sessions = await loadAll();
    const session = sessions.get("019f0000-2222-7000-8000-0000ccccdddd")!;
    const userTexts = session.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text);

    expect(session.shortId).toBe("ccccdddd");
    expect(session.displayName).toBe("hi");
    expect(userTexts).toEqual([
      "hi",
      "Please update the retry configuration.",
      "Please preserve the visible request.",
      "run tests",
      "run tests",
    ]);
    expect(session.messages.filter((message) => message.text === "What would you like to change?")).toHaveLength(1);
    expect(session.messages.filter((message) => message.text === "The tests pass.")).toHaveLength(1);

    const toolUses = session.messages.flatMap((message) => message.contentBlocks ?? [])
      .filter((block) => block.type === "tool_use");
    expect(toolUses.map((block) => block.type === "tool_use" ? block.name : "")).toEqual(["exec_command", "apply_patch"]);
    const patch = toolUses[1];
    expect(patch).toMatchObject({ id: "call-cli-2" });
    if (patch?.type === "tool_use") expect(patch.input).toMatchObject({ patch: expect.stringContaining("src/config.ts") });

    const results = session.messages.flatMap((message) => message.contentBlocks ?? [])
      .filter((block) => block.type === "tool_result");
    expect(results[1]).toMatchObject({
      toolUseId: "call-cli-2",
      content: expect.stringContaining('"files"'),
    });
  });

  it("uses file mtime when valid records carry no timestamps", async () => {
    const root = makeRoot();
    const sessionDir = join(root, "sessions", "2026", "01", "02");
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, "rollout-no-time.jsonl");
    writeFileSync(path, jsonl(
      { type: "session_meta", payload: { id: "019f0000-8888-7000-8000-00009999aaaa", cwd: "/tmp/demo", originator: "codex-tui", source: "cli" } },
      { type: "event_msg", payload: { type: "user_message", message: "retain a real timestamp" } },
    ));
    const fallback = new Date("2026-01-02T03:04:05.000Z");
    utimesSync(path, fallback, fallback);
    const found = await discover(root);
    const session = await found[0]!.load();
    expect(session.startedAt).toBe(fallback.toISOString());
    expect(session.endedAt).toBe(fallback.toISOString());
  });

  it("uses remote-first project identity for a git-backed cwd", () => {
    const repo = makeRoot();
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/demo.git"]);
    const source = join(repo, "rollout.jsonl");
    const content = jsonl(
      { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: {
        id: "019f0000-9999-7000-8000-0000bbbbcccc", cwd: repo, originator: "codex-tui", source: "cli",
      } },
      { timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "use the stable project id" } },
    );
    writeFileSync(source, content);
    const session = parseCodexJsonl(source, content, new Map(), statSync(source).mtimeMs);
    expect(session.project).toBe("github.com-acme-demo");
  });

  it("keeps a different event-only tool inside a response span but suppresses its exact mirror", () => {
    const source = "/tmp/rollout-mixed-tools.jsonl";
    const id = "019f0000-bbbb-7000-8000-0000ffff0000";
    const rows: unknown[] = [
      { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: {
        id, cwd: "/tmp/demo", originator: "codex-tui", source: "cli",
      } },
      { timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: {
        type: "user_message", message: "exercise both tool lanes",
      } },
      { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: {
        type: "custom_tool_call", name: "exec", call_id: "response-tool", input: '{"cmd":"echo modern"}',
      } },
      { timestamp: "2026-01-01T00:00:03Z", type: "event_msg", payload: {
        type: "item_completed", item: {
          type: "CommandExecution", id: "event-only", command: ["echo", "different"],
          cwd: "/tmp/demo", aggregated_output: "different", status: "completed",
        },
      } },
      { timestamp: "2026-01-01T00:00:04Z", type: "event_msg", payload: {
        type: "item_completed", item: {
          type: "CommandExecution", id: "event-duplicate-a", command: ["echo", "modern"],
          cwd: "/tmp/demo", aggregated_output: "modern-a", status: "completed",
        },
      } },
      { timestamp: "2026-01-01T00:00:04.500Z", type: "event_msg", payload: {
        type: "item_completed", item: {
          type: "CommandExecution", id: "event-duplicate-b", command: ["echo", "modern"],
          cwd: "/tmp/demo", aggregated_output: "modern-b", status: "completed",
        },
      } },
      { timestamp: "2026-01-01T00:00:05Z", type: "response_item", payload: {
        type: "custom_tool_call_output", call_id: "response-tool", output: "modern",
      } },
    ];
    const session = parseCodexJsonl(source, jsonl(...rows), new Map(), Date.parse("2026-01-01T00:00:00Z"));
    const uses = session.messages.flatMap((message) => message.contentBlocks ?? [])
      .filter((block) => block.type === "tool_use");
    const results = session.messages.flatMap((message) => message.contentBlocks ?? [])
      .filter((block) => block.type === "tool_result");
    expect(uses).toHaveLength(3);
    const ids = uses.map((block) => block.type === "tool_use" ? block.id : "");
    expect(ids).toContain("response-tool");
    expect(ids).toContain("event-only");
    expect(ids.filter((id) => id?.startsWith("event-duplicate-"))).toHaveLength(1);
    expect(results).toHaveLength(3);
  });

  it("canonicalizes MCP names, namespaces, and object key order for tool correlation", () => {
    const source = "/tmp/rollout-mcp-tools.jsonl";
    const session = parseCodexJsonl(source, jsonl(
      { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: {
        id: "019f0000-cccc-7000-8000-000011112222", cwd: "/tmp/demo",
        originator: "codex-tui", source: "cli",
      } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: {
        type: "function_call", name: "mcp__files__read", call_id: "read-call",
        arguments: '{"path":"a.ts","line":1}',
      } },
      { timestamp: "2026-01-01T00:00:02Z", type: "event_msg", payload: {
        type: "item_completed", item: {
          type: "McpToolCall", id: "read-event", server: "files", tool: "read",
          arguments: { line: 1, path: "a.ts" }, result: { content: "a" },
        },
      } },
      { timestamp: "2026-01-01T00:00:03Z", type: "response_item", payload: {
        type: "function_call_output", call_id: "read-call", output: "a",
      } },
      { timestamp: "2026-01-01T00:00:04Z", type: "response_item", payload: {
        type: "function_call", namespace: "files", name: "write", call_id: "write-call",
        arguments: '{"path":"b.ts","text":"b"}',
      } },
      { timestamp: "2026-01-01T00:00:05Z", type: "event_msg", payload: {
        type: "item_completed", item: {
          type: "McpToolCall", id: "write-event", server: "files", tool: "write",
          arguments: { text: "b", path: "b.ts" }, result: { content: "ok" },
        },
      } },
      { timestamp: "2026-01-01T00:00:06Z", type: "response_item", payload: {
        type: "function_call_output", call_id: "write-call", output: "ok",
      } },
    ), new Map(), Date.parse("2026-01-01T00:00:00Z"));
    const uses = session.messages.flatMap((message) => message.contentBlocks ?? [])
      .filter((block) => block.type === "tool_use");
    expect(uses).toHaveLength(2);
    expect(uses.map((block) => block.type === "tool_use" ? block.name : ""))
      .toEqual(["files.read", "files.write"]);
  });

  it("keeps direct argv with different argument boundaries as distinct tools", () => {
    const source = "/tmp/rollout-argv-tools.jsonl";
    const session = parseCodexJsonl(source, jsonl(
      { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: {
        id: "019f0000-dddd-7000-8000-000033334444", cwd: "/tmp/demo",
        originator: "codex-tui", source: "cli",
      } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: {
        type: "custom_tool_call", name: "exec", call_id: "argv-call",
        input: '{"cmd":["echo","a b"]}',
      } },
      { timestamp: "2026-01-01T00:00:02Z", type: "event_msg", payload: {
        type: "item_completed", item: {
          type: "CommandExecution", id: "argv-event", command: ["echo", "a", "b"],
          cwd: "/tmp/demo", aggregated_output: "a b", status: "completed",
        },
      } },
      { timestamp: "2026-01-01T00:00:03Z", type: "response_item", payload: {
        type: "custom_tool_call_output", call_id: "argv-call", output: "a b",
      } },
    ), new Map(), Date.parse("2026-01-01T00:00:00Z"));
    const uses = session.messages.flatMap((message) => message.contentBlocks ?? [])
      .filter((block) => block.type === "tool_use");
    expect(uses).toHaveLength(2);
  });

  it("does not strip legitimate text merely because it contains a closing tag", () => {
    const source = "/tmp/rollout-legitimate.jsonl";
    const content = jsonl(
      { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: {
        id: "019f0000-aaaa-7000-8000-0000ddddeeee", cwd: "/tmp/demo", originator: "codex-tui", source: "cli",
      } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "Explain why </section> is valid HTML." }],
      } },
    );
    const session = parseCodexJsonl(source, content, new Map(), Date.parse("2026-01-01T00:00:00Z"));
    expect(session.messages[0]!.text).toBe("Explain why </section> is valid HTML.");
  });
});
