import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VSCodeCopilotAdapter } from "../../src/sources/vscode-copilot.js";

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "copilot");

describe("VSCodeCopilotAdapter", () => {
  let storage: string;
  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), "memvc-ws-"));
    const ws = join(storage, "hashA");
    mkdirSync(join(ws, "chatSessions"), { recursive: true });
    cpSync(join(fixturesDir, "workspace.json"), join(ws, "workspace.json"));
    cpSync(
      join(fixturesDir, "vscode-copilot-session.json"),
      join(ws, "chatSessions", "sess-aaaa1111.json"),
    );
  });

  it("parses Copilot chat JSON into NormalizedSession", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    expect(found.length).toBe(1);
    const s = await found[0].load();
    expect(s.tool).toBe("copilot");
    expect(s.sessionId).toBe("sess-aaaa1111");
    expect(s.shortId).toBe("sess-aaa");
    expect(s.project).toBe("code-demo");
    expect(s.displayName).toBe("Improve authentication retries");
    expect(s.nameSlug).toBe("Improve-authentication-retries");
    expect(s.messages.length).toBe(3);  // "Thanks" (6 chars) sanitized away
    expect(s.messages[0].role).toBe("user");
    expect(s.messages[1].role).toBe("assistant");
    expect(s.messages[2].role).toBe("assistant");  // "You're welcome." survives
  });
});

describe("VSCodeCopilotAdapter — chatSessions jsonl (rolling-window state log)", () => {
  let storage: string;
  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), "memvc-ws-jsonl-"));
    const ws = join(storage, "hashB");
    mkdirSync(join(ws, "chatSessions"), { recursive: true });
    cpSync(join(fixturesDir, "workspace.json"), join(ws, "workspace.json"));
    cpSync(
      join(fixturesDir, "vscode-copilot-chatsessions.jsonl"),
      join(ws, "chatSessions", "sess-bbbb2222.jsonl"),
    );
  });

  it("reconstructs ALL turns from chronological snapshot events (not just the last)", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    expect(found.length).toBe(1);
    const s = await found[0].load();
    expect(s.tool).toBe("copilot");
    expect(s.sessionId).toBe("sess-bbbb2222");
    // 3 user turns + 3 assistant turns = 6 messages
    const userMsgs = s.messages.filter((m) => m.role === "user");
    const assistantMsgs = s.messages.filter((m) => m.role === "assistant");
    expect(userMsgs.length).toBe(3);
    expect(assistantMsgs.length).toBe(3);
    expect(userMsgs[0].text).toBe("First user turn");
    expect(userMsgs[1].text).toBe("Second user turn");
    expect(userMsgs[2].text).toBe("Third user turn asks a question");
  });

  it("extracts thinking + toolInvocationSerialized as contentBlocks", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    const s = await found[0].load();
    const turn2 = s.messages.filter((m) => m.role === "assistant")[1];
    expect(turn2.reasoning).toBe("thinking about turn two");
    expect(turn2.contentBlocks).toBeDefined();
    const kinds = turn2.contentBlocks!.map((b) => b.type);
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");
    const toolUse = turn2.contentBlocks!.find((b) => b.type === "tool_use") as any;
    expect(toolUse.name).toBe("mcp_demo_search");
    expect(toolUse.id).toBe("call-1");
  });

  it("uses the latest customTitle patch instead of the first or last user turn", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    const s = await found[0].load();
    expect(s.displayName).toBe("Final Copilot session title");
    expect(s.nameSlug).toBe("Final-Copilot-session-title");
  });
});

describe("VSCodeCopilotAdapter — title fallback + migration fingerprint", () => {
  it("falls back to the first user turn when customTitle is absent", async () => {
    const storage = mkdtempSync(join(tmpdir(), "memvc-ws-no-title-"));
    const ws = join(storage, "hashNoTitle");
    mkdirSync(join(ws, "chatSessions"), { recursive: true });
    cpSync(join(fixturesDir, "workspace.json"), join(ws, "workspace.json"));
    writeFileSync(join(ws, "chatSessions", "no-title.jsonl"), [
      JSON.stringify({ kind: 0, v: { version: 3, sessionId: "no-title", requests: [] } }),
      JSON.stringify({ kind: 2, k: ["requests"], v: [{
        message: { text: "Fallback title from first user turn" },
        response: [{ kind: "markdownContent", content: { value: "reply" } }],
        timestamp: 1750000000000,
      }] }),
    ].join("\n") + "\n");

    const found = [];
    for await (const discovered of new VSCodeCopilotAdapter(storage).discover()) found.push(discovered);
    expect((await found[0]!.load()).displayName).toBe("Fallback title from first user turn");
  });

  it("salts chat-session fingerprints so existing first-prompt filenames migrate once", async () => {
    const storage = mkdtempSync(join(tmpdir(), "memvc-ws-fingerprint-"));
    const ws = join(storage, "hashFingerprint");
    mkdirSync(join(ws, "chatSessions"), { recursive: true });
    cpSync(join(fixturesDir, "workspace.json"), join(ws, "workspace.json"));
    const sourcePath = join(ws, "chatSessions", "fingerprint.jsonl");
    cpSync(join(fixturesDir, "vscode-copilot-chatsessions.jsonl"), sourcePath);
    const rawSha = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");

    const found = [];
    for await (const discovered of new VSCodeCopilotAdapter(storage).discover()) found.push(discovered);
    expect(found[0]!.sourceSha256).not.toBe(rawSha);
  });
});

describe("VSCodeCopilotAdapter — dedupe chatSessions/ vs transcripts/ for same sessionId", () => {
  let storage: string;
  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), "memvc-ws-dedupe-"));
    const ws = join(storage, "hashC");
    mkdirSync(join(ws, "chatSessions"), { recursive: true });
    mkdirSync(join(ws, "GitHub.copilot-chat", "transcripts"), { recursive: true });
    cpSync(join(fixturesDir, "workspace.json"), join(ws, "workspace.json"));
    // Both sources, SAME sessionId. The dedupe must yield only chatSessions/.
    cpSync(
      join(fixturesDir, "vscode-copilot-chatsessions.jsonl"),
      join(ws, "chatSessions", "shared-id-aaaa.jsonl"),
    );
    writeFileSync(
      join(ws, "GitHub.copilot-chat", "transcripts", "shared-id-aaaa.jsonl"),
      JSON.stringify({ type: "user.message", timestamp: "2026-05-22T10:00:00Z", data: { content: "transcript user msg should be ignored" } }) + "\n",
    );
  });

  it("yields only chatSessions/ when both sources have the same sessionId in one workspace", async () => {
    const adapter = new VSCodeCopilotAdapter(storage);
    const found = [];
    for await (const d of adapter.discover()) found.push(d);
    expect(found).toHaveLength(1);
    expect(found[0].sourcePath).toContain(join("chatSessions", "shared-id-aaaa.jsonl"));
    expect(found[0].sourcePath).not.toContain(join("transcripts", "shared-id-aaaa.jsonl"));
  });

  it("still yields transcripts/ for sessionIds that have NO chatSessions/ counterpart", async () => {
    // Add a transcript-only session
    const ws = join(storage, "hashC");
    writeFileSync(
      join(ws, "GitHub.copilot-chat", "transcripts", "transcript-only-bbbb.jsonl"),
      JSON.stringify({ type: "user.message", timestamp: "2026-05-22T10:00:00Z", data: { content: "this transcript-only session should survive the dedupe" } }) + "\n",
    );
    const adapter = new VSCodeCopilotAdapter(storage);
    const sourcePaths: string[] = [];
    for await (const d of adapter.discover()) sourcePaths.push(d.sourcePath);
    expect(sourcePaths).toHaveLength(2);
    expect(sourcePaths.some((p) => p.endsWith(join("chatSessions", "shared-id-aaaa.jsonl")))).toBe(true);
    expect(sourcePaths.some((p) => p.endsWith(join("transcripts", "transcript-only-bbbb.jsonl")))).toBe(true);
  });
});


// Exercise title state independently of request snapshots: titles must not
// change message bodies or identities, and clearing is not an older-title fallback.
describe("VSCodeCopilotAdapter — title state", () => {
  let storage: string;
  let chatDir: string;
  const id = "12345678-abcd-4000-8000-123456789abc";
  const requests = [{
    message: { text: "Keep the original user prompt in the transcript." },
    response: [{ kind: "markdownContent", content: { value: "Original assistant response." } }],
    timestamp: 1750000000000,
  }];

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), "memarium-title-state-"));
    chatDir = join(storage, "workspace/chatSessions");
    mkdirSync(chatDir, { recursive: true });
    cpSync(join(fixturesDir, "workspace.json"), join(storage, "workspace/workspace.json"));
  });
  afterEach(() => rmSync(storage, { recursive: true, force: true }));

  async function load(extension: "json" | "jsonl", content: string) {
    writeFileSync(join(chatDir, `${id}.${extension}`), content);
    const discovered = [];
    for await (const d of new VSCodeCopilotAdapter(storage).discover()) discovered.push(d);
    expect(discovered).toHaveLength(1);
    return { discovered: discovered[0]!, session: await discovered[0]!.load() };
  }

  it("reads an initial-only JSONL title, retaining short non-English names", async () => {
    const { session } = await load("jsonl", JSON.stringify({
      kind: 0, v: { version: 3, sessionId: id, customTitle: "  登录  ", requests },
    }));
    expect(session.displayName).toBe("登录");
    expect(session.nameSlug).toBe("登录");
    expect(session.sessionId).toBe(id);
    expect(session.messages[0]!.text).toBe(requests[0]!.message.text);
  });

  it.each(["", "  ", null, 123, { title: "not a string" }])(
    "falls back for a legacy JSON customTitle of %j",
    async (customTitle) => {
      const { session } = await load("json", JSON.stringify({ version: 3, customTitle, requests }));
      expect(session.displayName).toBe(requests[0]!.message.text);
    },
  );

  it.each(["", "  ", null, undefined])("a final clearing patch (%j) removes the former title", async (value) => {
    const { session } = await load("jsonl", [
      JSON.stringify({ kind: 0, v: { sessionId: id, customTitle: "Former title", requests } }),
      JSON.stringify({ kind: 1, k: ["customTitle"], v: value }),
    ].join("\n"));
    expect(session.displayName).toBe(requests[0]!.message.text);
  });

  it("ignores unrelated state and incomplete JSON after a valid rename", async () => {
    const { session } = await load("jsonl", [
      JSON.stringify({ kind: 0, v: { sessionId: id, customTitle: "Initial", requests } }),
      JSON.stringify({ kind: 1, k: ["customTitle"], v: 'Plan: /auth/login? (v2)' }),
      JSON.stringify({ kind: 1, k: ["inputState", "customTitle"], v: "not a session title" }),
      '{"kind":1,"k":["customTitle"],"v":',
    ].join("\n"));
    expect(session.displayName).toBe("Plan: /auth/login? (v2)");
    expect(session.nameSlug).toBe("Plan-auth-login-v2");
    expect(session.messages.map((m) => m.text)).toEqual([
      requests[0]!.message.text, "Original assistant response.",
    ]);
  });

  it("falls back to shortId for a nonempty session without a title or user text", async () => {
    const { session } = await load("json", JSON.stringify({
      version: 3, requests: [{ ...requests[0], message: { text: "" } }],
    }));
    expect(session.messages).toHaveLength(1);
    expect(session.displayName).toBe(id.slice(0, 8));
  });

  it.each(["json", "jsonl"] as const)("versions the %s fingerprint without modifying the source", async (extension) => {
    const state = { version: 3, customTitle: "Provider title", requests };
    const content = JSON.stringify(extension === "json" ? state : { kind: 0, v: state });
    const first = await load(extension, content);
    expect(first.discovered.sourceSha256).not.toBe(createHash("sha256").update(content).digest("hex"));
    expect(readFileSync(join(chatDir, `${id}.${extension}`), "utf8")).toBe(content);
    const second = [];
    for await (const d of new VSCodeCopilotAdapter(storage).discover()) second.push(d);
    expect(second[0]!.sourceSha256).toBe(first.discovered.sourceSha256);
    expect(second[0]!.sourceMtimeMs).toBe(first.discovered.sourceMtimeMs);
  });
});
