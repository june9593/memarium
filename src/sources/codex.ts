import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import type { DiscoveredSession, SourceAdapter } from "./base.js";
import type { ContentBlock, NormalizedSession, SessionMessage } from "../types.js";
import { cachedProjectSlug } from "../project-identity.js";
import { deriveSlug } from "../slug.js";

interface CodexRecord {
  index: number;
  timestamp?: string;
  type: string;
  payload: Record<string, unknown>;
}

interface CodexHeader {
  id: string;
  cwd: string;
  timestamp?: string;
  originator: string;
  source: unknown;
  threadSource: unknown;
  parentThreadId?: string;
}

interface RolloutCandidate {
  sourcePath: string;
  sourceMtimeMs: number;
  header: CodexHeader;
  active: boolean;
}

interface ProjectedMessage {
  index: number;
  order: number;
  id?: string;
  role: "user" | "assistant" | "tool";
  text: string;
  reasoning?: string;
  timestamp?: string;
  contentBlocks: ContentBlock[];
  toolSignature?: string;
}

interface ToolSpan {
  start: number;
  end: number;
  signature?: string;
  toolUseId?: string;
  hasOutput: boolean;
}

const SYNTHETIC_TAGS = [
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "command-message",
  "command-name",
  "command-args",
  "task-notification",
  "environment_context",
  "permissions",
  "turn_aborted",
  "subagent_notification",
  "recommended-plugin",
  "in-app-browser-context",
  "codex_internal_context",
  "goal_context",
  "user_shell_command",
  "recommended_plugins",
  "skill",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "model_switch",
  "personality_spec",
  "token_budget",
];

const RESPONSE_TOOL_CALLS = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
  "web_search_call",
]);

const RESPONSE_TOOL_OUTPUTS = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
]);

export class CodexAdapter implements SourceAdapter {
  readonly name = "codex" as const;

  constructor(private readonly root: string = join(homedir(), ".codex")) {}

  async *discover(): AsyncIterable<DiscoveredSession> {
    if (!existsSync(this.root)) return;
    const titleMap = readTitleMap(join(this.root, "session_index.jsonl"));
    const candidates: RolloutCandidate[] = [];

    for (const [dir, active] of [
      [join(this.root, "sessions"), true],
      [join(this.root, "archived_sessions"), false],
    ] as const) {
      for (const sourcePath of collectRolloutPaths(dir)) {
        try {
          const st = statSync(sourcePath);
          if (st.size === 0) continue;
          const content = readFileSync(sourcePath, "utf8");
          const header = readHeaderFromContent(content);
          if (!header || shouldExclude(header)) continue;
          candidates.push({ sourcePath, sourceMtimeMs: st.mtimeMs, header, active });
        } catch {
          // A concurrently moved/deleted or unreadable rollout must not abort sync.
        }
      }
    }

    const selected = new Map<string, RolloutCandidate>();
    for (const candidate of candidates) {
      const current = selected.get(candidate.header.id);
      if (!current || preferCandidate(candidate, current)) {
        selected.set(candidate.header.id, candidate);
      }
    }

    for (const candidate of [...selected.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
      let content: string;
      let sourceMtimeMs: number;
      try {
        content = readFileSync(candidate.sourcePath, "utf8");
        sourceMtimeMs = statSync(candidate.sourcePath).mtimeMs;
      } catch {
        continue;
      }
      const indexedTitle = usableTitle(titleMap.get(candidate.header.id) ?? "");
      const location = relative(this.root, candidate.sourcePath);
      const sha = createHash("sha256")
        .update(content)
        .update("\0")
        .update(indexedTitle)
        .update("\0")
        .update(location)
        .update("\0full-session-id-path-v1")
        .digest("hex");
      yield {
        sourcePath: candidate.sourcePath,
        sourceMtimeMs,
        sourceSha256: sha,
        load: async () => parseCodexJsonl(
          candidate.sourcePath,
          content,
          titleMap,
          sourceMtimeMs,
        ),
      };
    }
  }
}

function collectRolloutPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) paths.push(path);
    }
  };
  visit(root);
  return paths;
}

function readTitleMap(path: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (!existsSync(path)) return titles;
  let content: string;
  try { content = readFileSync(path, "utf8"); } catch { return titles; }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof row.id === "string" && typeof row.thread_name === "string") {
        titles.set(row.id, row.thread_name);
      }
    } catch {
      // Append-only index: one malformed row does not invalidate later names.
    }
  }
  return titles;
}

function parseRecords(content: string): CodexRecord[] {
  const records: CodexRecord[] = [];
  let index = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    index++;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (!row || typeof row !== "object" || typeof row.type !== "string") continue;
      const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? row.payload as Record<string, unknown>
        : {};
      records.push({
        index,
        timestamp: validTimestamp(row.timestamp),
        type: row.type,
        payload,
      });
    } catch {
      // Rollouts are append-only and can end in a partial JSON row while live.
    }
  }
  return records;
}

function readHeaderFromContent(content: string): CodexHeader | null {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row?.type !== "session_meta") continue;
      const payload = objectValue(row.payload);
      const id = stringValue(payload.id) || stringValue(payload.session_id);
      if (!id) continue;
      return {
        id,
        cwd: stringValue(payload.cwd),
        timestamp: validTimestamp(payload.timestamp) ?? validTimestamp(row.timestamp),
        originator: stringValue(payload.originator),
        source: payload.source,
        threadSource: payload.thread_source,
        parentThreadId: stringValue(payload.parent_thread_id) || undefined,
      };
    } catch {
      // The canonical metadata can follow a malformed/partial leading row.
    }
  }
  return null;
}

function readHeader(records: CodexRecord[]): CodexHeader | null {
  for (const record of records) {
    if (record.type !== "session_meta") continue;
    const payload = record.payload;
    const id = stringValue(payload.id) || stringValue(payload.session_id);
    if (!id) continue;
    return {
      id,
      cwd: stringValue(payload.cwd),
      timestamp: validTimestamp(payload.timestamp) ?? record.timestamp,
      originator: stringValue(payload.originator),
      source: payload.source,
      threadSource: payload.thread_source,
      parentThreadId: stringValue(payload.parent_thread_id) || undefined,
    };
  }
  return null;
}

function shouldExclude(header: CodexHeader): boolean {
  const originator = header.originator.toLowerCase();
  if (originator === "codex_exec") return true;
  if (typeof header.source === "string" && header.source.toLowerCase() === "exec") return true;
  if (header.parentThreadId) return true;
  if (containsChildMarker(header.source) || containsChildMarker(header.threadSource)) return true;
  return false;
}

function containsChildMarker(value: unknown): boolean {
  if (typeof value === "string") return /subagent|guardian[_-]?review/i.test(value);
  if (Array.isArray(value)) return value.some(containsChildMarker);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    /subagent|guardian[_-]?review|thread_spawn/i.test(key) || containsChildMarker(child),
  );
}

function preferCandidate(next: RolloutCandidate, current: RolloutCandidate): boolean {
  if (next.active !== current.active) return next.active;
  if (next.sourceMtimeMs !== current.sourceMtimeMs) return next.sourceMtimeMs > current.sourceMtimeMs;
  return next.sourcePath < current.sourcePath;
}

export function parseCodexJsonl(
  sourcePath: string,
  content: string,
  titleMap: ReadonlyMap<string, string> = new Map(),
  sourceMtimeMs: number = sourceMtime(sourcePath),
): NormalizedSession {
  const records = parseRecords(content);
  const header = readHeader(records);
  const fallbackId = rolloutIdFromPath(sourcePath);
  const sessionId = header?.id || fallbackId;
  const shortId = shortCodexId(sessionId);
  const cwd = header?.cwd ?? "";
  const fallbackTime = validMtime(sourceMtimeMs);
  const recordTimes = records.flatMap((record) => record.timestamp ? [record.timestamp] : []);
  const startedAt = header?.timestamp ?? recordTimes[0] ?? fallbackTime;
  const endedAt = latestTimestamp(recordTimes) ?? header?.timestamp ?? fallbackTime;

  if (!header || shouldExclude(header)) {
    return emptySession(sourcePath, sessionId, shortId, cwd, startedAt, endedAt);
  }

  const displayMessages: ProjectedMessage[] = [];
  const responseMessages: ProjectedMessage[] = [];
  const responseReasoning: ProjectedMessage[] = [];
  const displayReasoning: ProjectedMessage[] = [];
  const responseTools: ProjectedMessage[] = [];
  const responseToolKeys = new Set<string>();
  const responseOutputKeys = new Set<string>();
  const eventTools: ProjectedMessage[] = [];
  const responseToolSpans = new Map<string, ToolSpan>();

  for (const record of records) {
    const subtype = stringValue(record.payload.type);
    if (record.type === "response_item") {
      if (subtype === "message") {
        const role = stringValue(record.payload.role);
        if (role !== "user" && role !== "assistant") continue;
        const rawText = role === "user"
          ? extractVisibleUserText(record.payload)
          : extractText(record.payload.content);
        const text = sanitizeCodexText(rawText);
        if (!text) continue;
        responseMessages.push(textMessage(record, role, text));
      } else if (subtype === "agent_message") {
        // ResponseItem::AgentMessage is inter-agent delivery: it always carries
        // author + recipient, not user-visible assistant output. Keep it out of
        // the transcript even when its input_text portion is readable.
        continue;
      } else if (subtype === "reasoning") {
        const reasoning = reasoningText(record.payload);
        if (reasoning) responseReasoning.push(reasoningMessage(record, reasoning));
      } else if (subtype === "image_generation_call") {
        const projected = responseImageGeneration(record);
        const callKey = projected[0]!.id ?? `${subtype}:${record.index}`;
        if (!responseToolKeys.has(callKey)) {
          responseToolKeys.add(callKey);
          responseTools.push(projected[0]!);
        }
        if (projected[1] && !responseOutputKeys.has(callKey)) {
          responseOutputKeys.add(callKey);
          responseTools.push(projected[1]);
        }
      } else if (RESPONSE_TOOL_CALLS.has(subtype)) {
        const projected = responseToolCall(record, subtype);
        const key = projected.id ?? `${subtype}:${record.index}`;
        if (!responseToolKeys.has(key)) {
          responseToolKeys.add(key);
          responseTools.push(projected);
        }
        extendToolSpan(responseToolSpans, key, record.index, {
          signature: projected.toolSignature,
          toolUseId: projected.id,
        });
      } else if (RESPONSE_TOOL_OUTPUTS.has(subtype)) {
        const projected = responseToolOutput(record);
        const key = projected.id ?? `${subtype}:${record.index}`;
        if (!responseOutputKeys.has(key)) {
          responseOutputKeys.add(key);
          responseTools.push(projected);
        }
        extendToolSpan(responseToolSpans, key, record.index, {
          hasOutput: projected.contentBlocks.some((block) =>
            block.type === "tool_result" && block.content.length > 0,
          ),
        });
      }
      continue;
    }

    if (record.type !== "event_msg") continue;
    if (subtype === "user_message" || subtype === "agent_message") {
      const role = subtype === "user_message" ? "user" : "assistant";
      const text = sanitizeCodexText(stringValue(record.payload.message));
      if (text) displayMessages.push(textMessage(record, role, text));
      continue;
    }
    if (subtype !== "item_completed") continue;
    const item = objectValue(record.payload.item);
    const itemType = stringValue(item.type);
    if (itemType === "UserMessage" || itemType === "AgentMessage") {
      const role = itemType === "UserMessage" ? "user" : "assistant";
      const text = sanitizeCodexText(extractText(item.content));
      if (text) {
        const projected = textMessage(record, role, text);
        projected.id = stringValue(item.id) || undefined;
        displayMessages.push(projected);
      }
    } else if (itemType === "Reasoning") {
      const reasoning = reasoningText(item);
      if (reasoning) {
        const projected = reasoningMessage(record, reasoning);
        projected.id = stringValue(item.id) || undefined;
        displayReasoning.push(projected);
      }
    } else if (itemType === "CommandExecution" || itemType === "McpToolCall") {
      eventTools.push(...eventToolMessages(record, item, itemType));
    }
  }

  const messages = [
    ...mergeTextLanes(displayMessages, responseMessages),
    ...mergeReasoningLanes(responseReasoning, displayReasoning),
    ...responseTools,
    ...eventToolsOutsideResponseSpans(eventTools, responseToolSpans),
  ]
    .sort((a, b) => a.index - b.index || a.order - b.order)
    .map(toSessionMessage);

  const firstUser = messages.find((message) => message.role === "user")?.text ?? "";
  const indexedTitle = usableTitle(titleMap.get(sessionId) ?? "");
  const title = indexedTitle || firstUser || shortId;
  const { slug, display } = deriveSlug(title);

  return {
    tool: "codex",
    sessionId,
    shortId,
    project: cachedProjectSlug(cwd),
    projectRaw: cwd,
    startedAt,
    endedAt,
    nameSlug: slug,
    displayName: display,
    messages,
    sourcePath,
  };
}

function mergeTextLanes(
  displayMessages: ProjectedMessage[],
  responseMessages: ProjectedMessage[],
): ProjectedMessage[] {
  const usedDisplay = new Set<number>();
  const unmatchedResponses: ProjectedMessage[] = [];
  for (const response of responseMessages) {
    const match = displayMessages.findIndex((display, index) =>
      !usedDisplay.has(index) && sameVisibleMessage(response, display),
    );
    if (match >= 0) usedDisplay.add(match);
    else unmatchedResponses.push(response);
  }
  return [...displayMessages, ...unmatchedResponses];
}

function sameVisibleMessage(a: ProjectedMessage, b: ProjectedMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.id && b.id && a.id === b.id) return true;
  return Math.abs(a.index - b.index) <= 3 && normalizeText(a.text) === normalizeText(b.text);
}

function mergeReasoningLanes(
  response: ProjectedMessage[],
  display: ProjectedMessage[],
): ProjectedMessage[] {
  const usedDisplay = new Set<number>();
  const out = [...response];
  for (const item of response) {
    const match = display.findIndex((candidate, index) =>
      !usedDisplay.has(index) && (
        (item.id && candidate.id && item.id === candidate.id) ||
        (Math.abs(item.index - candidate.index) <= 3 && item.reasoning === candidate.reasoning)
      ),
    );
    if (match >= 0) usedDisplay.add(match);
  }
  for (let i = 0; i < display.length; i++) {
    if (!usedDisplay.has(i)) out.push(display[i]!);
  }
  return out;
}

function extendToolSpan(
  spans: Map<string, ToolSpan>,
  key: string,
  index: number,
  update: { signature?: string; toolUseId?: string; hasOutput?: boolean },
): void {
  const span = spans.get(key);
  if (span) {
    span.start = Math.min(span.start, index);
    span.end = Math.max(span.end, index);
    if (update.signature) span.signature = update.signature;
    if (update.toolUseId) span.toolUseId = update.toolUseId;
    if (update.hasOutput) span.hasOutput = true;
  } else {
    spans.set(key, {
      start: index,
      end: index,
      hasOutput: update.hasOutput ?? false,
      ...(update.signature ? { signature: update.signature } : {}),
      ...(update.toolUseId ? { toolUseId: update.toolUseId } : {}),
    });
  }
}

/** Codex completion events do not carry the response call_id. Suppress an
 * event only when its normalized tool+input signature matches a nearby
 * response call; proximity alone must never erase a different event-only tool. */
function eventToolsOutsideResponseSpans(
  eventTools: ProjectedMessage[],
  spans: ReadonlyMap<string, ToolSpan>,
): ProjectedMessage[] {
  const unmatchedSpans = [...spans.values()];
  const matchedEvents = new Map<string, ToolSpan>();
  for (const event of eventTools) {
    if (!event.id || !event.toolSignature) continue;
    const match = unmatchedSpans.findIndex((span) =>
      span.signature === event.toolSignature &&
      event.index >= span.start - 1 && event.index <= span.end + 1,
    );
    if (match >= 0) {
      matchedEvents.set(event.id, unmatchedSpans[match]!);
      unmatchedSpans.splice(match, 1);
    }
  }

  const out: ProjectedMessage[] = [];
  for (const event of eventTools) {
    const span = event.id ? matchedEvents.get(event.id) : undefined;
    if (!span) {
      out.push(event);
      continue;
    }
    const result = event.contentBlocks.find((block) => block.type === "tool_result");
    if (!result || span.hasOutput) continue;
    out.push({
      ...event,
      id: span.toolUseId ?? event.id,
      contentBlocks: [{
        ...result,
        ...(span.toolUseId ? { toolUseId: span.toolUseId } : {}),
      }],
    });
  }
  return out;
}

function textMessage(
  record: CodexRecord,
  role: "user" | "assistant",
  text: string,
): ProjectedMessage {
  const id = stringValue(record.payload.id) || undefined;
  return {
    index: record.index,
    order: 0,
    id,
    role,
    text,
    timestamp: record.timestamp,
    contentBlocks: [{ type: "text", text }],
  };
}

function reasoningMessage(
  record: CodexRecord,
  reasoning: string,
): ProjectedMessage {
  return {
    index: record.index,
    order: 0,
    id: stringValue(record.payload.id) || undefined,
    role: "assistant",
    text: "",
    reasoning,
    timestamp: record.timestamp,
    contentBlocks: [{ type: "thinking", thinking: reasoning }],
  };
}

function responseImageGeneration(record: CodexRecord): ProjectedMessage[] {
  const payload = record.payload;
  const id = stringValue(payload.call_id) || stringValue(payload.id) || `codex-image-${record.index}`;
  const prompt = stringValue(payload.revised_prompt);
  const messages: ProjectedMessage[] = [{
    index: record.index,
    order: 0,
    id,
    role: "assistant",
    text: "",
    timestamp: record.timestamp,
    contentBlocks: [{
      type: "tool_use",
      name: "image_generation",
      input: prompt ? { prompt } : {},
      id,
    }],
  }];
  if (payload.result !== undefined && payload.result !== null) {
    messages.push({
      index: record.index,
      order: 1,
      id,
      role: "tool",
      text: "",
      timestamp: record.timestamp,
      contentBlocks: [{
        type: "tool_result",
        content: flattenToolOutput(payload.result),
        toolUseId: id,
      }],
    });
  }
  return messages;
}

function responseToolCall(record: CodexRecord, subtype: string): ProjectedMessage {
  const payload = record.payload;
  const id = stringValue(payload.call_id) || stringValue(payload.id) || undefined;
  let name = responseToolName(payload);
  let input: unknown;
  if (subtype === "function_call") input = parseMaybeJson(payload.arguments);
  else if (subtype === "custom_tool_call") {
    const parsed = parseMaybeJson(payload.input);
    input = name === "apply_patch" && typeof parsed === "string"
      ? { patch: parsed }
      : parsed;
  }
  else if (subtype === "local_shell_call") {
    name ||= "local_shell";
    input = payload.action ?? payload.command ?? {};
  } else if (subtype === "tool_search_call") {
    name ||= "tool_search";
    input = payload.arguments ?? { execution: payload.execution };
  } else {
    name ||= "web_search";
    input = payload.action ?? {};
  }
  return {
    index: record.index,
    order: 0,
    id,
    role: "assistant",
    text: "",
    timestamp: record.timestamp,
    contentBlocks: [{ type: "tool_use", name: name || subtype, input: input ?? {}, ...(id ? { id } : {}) }],
    toolSignature: toolSignature(name || subtype, input ?? {}),
  };
}

function responseToolOutput(record: CodexRecord): ProjectedMessage {
  const payload = record.payload;
  const id = stringValue(payload.call_id) || stringValue(payload.id) || undefined;
  const content = flattenToolOutput(payload.output ?? payload.tools ?? payload.result);
  return {
    index: record.index,
    order: 1,
    id,
    role: "tool",
    text: "",
    timestamp: record.timestamp,
    contentBlocks: [{ type: "tool_result", content, ...(id ? { toolUseId: id } : {}) }],
  };
}

function eventToolMessages(
  record: CodexRecord,
  item: Record<string, unknown>,
  itemType: string,
): ProjectedMessage[] {
  const id = stringValue(item.id) || `codex-event-${record.index}`;
  let name: string;
  let input: unknown;
  let output: unknown;
  if (itemType === "CommandExecution") {
    name = "exec";
    const command = Array.isArray(item.command)
      ? item.command.filter((part): part is string => typeof part === "string")
      : stringValue(item.command);
    input = { cmd: command, cwd: stringValue(item.cwd) };
    output = item.aggregated_output ?? item.formatted_output ?? item.stdout ?? item.stderr;
  } else {
    const server = stringValue(item.server);
    const tool = stringValue(item.tool) || "tool";
    name = server ? `${server}.${tool}` : tool;
    input = item.arguments ?? {};
    output = item.result ?? item.error;
  }
  const messages: ProjectedMessage[] = [{
    index: record.index,
    order: 0,
    id,
    role: "assistant",
    text: "",
    timestamp: record.timestamp,
    contentBlocks: [{ type: "tool_use", name, input, id }],
    toolSignature: toolSignature(name, input),
  }];
  if (output !== undefined) {
    messages.push({
      index: record.index,
      order: 1,
      id,
      role: "tool",
      text: "",
      timestamp: record.timestamp,
      contentBlocks: [{ type: "tool_result", content: flattenToolOutput(output), toolUseId: id }],
    });
  }
  return messages;
}

function toSessionMessage(message: ProjectedMessage): SessionMessage {
  const out: SessionMessage = {
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    contentBlocks: message.contentBlocks,
  };
  if (message.reasoning) out.reasoning = message.reasoning;
  return out;
}

function extractVisibleUserText(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const passthrough = objectValue(
    payload.internal_chat_message_metadata_passthrough ?? payload.metadata,
  );
  const kinds = Array.isArray(passthrough.content_item_kinds)
    ? passthrough.content_item_kinds
    : [];
  if (kinds.length === 0) return extractText(content);
  return content
    .map((item, index) => kinds[index] === "user.text" ? extractText([item]) : "")
    .filter(Boolean)
    .join("\n");
}

function reasoningText(payload: Record<string, unknown>): string {
  const summary = extractText(payload.summary ?? payload.summary_text);
  const content = extractText(payload.content ?? payload.raw_content);
  return sanitizeCodexText([summary, content].filter(Boolean).join("\n"));
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const texts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") texts.push(part);
    else if (part && typeof part === "object") {
      const row = part as Record<string, unknown>;
      if (typeof row.text === "string") texts.push(row.text);
      else if (typeof row.content === "string" || Array.isArray(row.content)) {
        const nested = extractText(row.content);
        if (nested) texts.push(nested);
      }
    }
  }
  return texts.join("\n");
}

function toolSignature(name: string, input: unknown): string {
  const canonicalName = canonicalToolName(name);
  const family = ["exec", "exec_command", "local_shell"].includes(canonicalName)
    ? "shell"
    : canonicalName;
  if (family === "shell") {
    const command = toolCommandText(input);
    if (command) return `shell:${command.trim()}`;
  }
  if (family === "apply_patch") {
    const patch = objectValue(input).patch;
    if (typeof patch === "string") return `apply_patch:${normalizeText(patch)}`;
  }
  return `${family}:${stableJson(input)}`;
}

function toolCommandText(input: unknown): string | null {
  if (typeof input === "string") return input;
  const row = objectValue(input);
  return commandTextForSignature(row.command) ?? commandTextForSignature(row.cmd);
}

function commandTextForSignature(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.filter((part): part is string => typeof part === "string");
  if (parts.length === 0) return null;
  const executable = parts[0]!.split(/[/\\]/).pop()!.toLowerCase();
  if (["sh", "bash", "zsh", "fish", "pwsh", "powershell", "powershell.exe", "cmd", "cmd.exe"].includes(executable)) {
    const commandFlag = parts.findIndex((part, index) =>
      index > 0 && (/^-[a-z]*c[a-z]*$/i.test(part) || /^--?command$/i.test(part) || /^\/c$/i.test(part)),
    );
    if (commandFlag >= 0 && parts[commandFlag + 1]) return parts[commandFlag + 1]!;
  }
  return parts.map(formatSignatureArg).join(" ");
}

function formatSignatureArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function responseToolName(payload: Record<string, unknown>): string {
  const name = stringValue(payload.name);
  const embedded = canonicalToolName(name);
  if (embedded !== name) return embedded;
  const namespace = canonicalToolName(stringValue(payload.namespace));
  if (!namespace || name.startsWith(namespace + ".")) return name;
  return name ? `${namespace}.${name}` : namespace;
}

function canonicalToolName(name: string): string {
  const parts = name.split("__");
  if (parts[0] === "mcp" && parts.length >= 3) {
    return `${parts[1]}.${parts.slice(2).join("__")}`;
  }
  if (parts[0] === "mcp" && parts.length === 2) return parts[1]!;
  return name;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}

function flattenToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const typedText = value.map((part) => {
      if (!part || typeof part !== "object") return null;
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? text : null;
    });
    if (typedText.every((part) => part !== null)) return typedText.join("");
  }
  if (value === undefined) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return value; }
}

function sanitizeCodexText(text: string): string {
  let value = text;
  for (const tag of SYNTHETIC_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi"), "");
  }
  value = value.replace(
    /<(external_[A-Za-z0-9_:-]+)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  value = value.replace(/<external_[A-Za-z0-9_:-]+\b[^>]*\/>/gi, "");
  value = value.replace(
    /^# AGENTS\.md instructions[^\n]*\r?\n\s*\r?\n<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i,
    "",
  );
  value = value.replace(/^# AGENTS\.md instructions[^\n]*\r?\n[\s\S]*?(?:\r?\n){2}/, "");
  if (/^# AGENTS\.md instructions/i.test(value.trimStart())) return "";
  if (/^<(?:environment_context|permissions|turn_aborted|subagent_notification|codex_internal_context|goal_context|user_shell_command|external_[A-Za-z0-9_:-]+)\b/i.test(value.trimStart())) return "";
  return value.trim();
}

function usableTitle(title: string): string {
  const value = sanitizeCodexText(title);
  if (!value || /^</.test(value) || /^Base directory for this skill:/i.test(value)) return "";
  return value;
}

function shortCodexId(id: string): string {
  const compact = id.replace(/-/g, "");
  return compact.slice(-8) || "untitled";
}

function rolloutIdFromPath(path: string): string {
  const file = basename(path, ".jsonl");
  const uuid = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
  return uuid ?? file.replace(/^rollout-/, "");
}

function sourceMtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return Date.now(); }
}

function validMtime(mtimeMs: number): string {
  return Number.isFinite(mtimeMs) && mtimeMs > 0
    ? new Date(mtimeMs).toISOString()
    : new Date().toISOString();
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function latestTimestamp(values: string[]): string | undefined {
  let latest: string | undefined;
  let latestMs = -Infinity;
  for (const value of values) {
    const ms = Date.parse(value);
    if (ms > latestMs) { latestMs = ms; latest = value; }
  }
  return latest;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function emptySession(
  sourcePath: string,
  sessionId: string,
  shortId: string,
  cwd: string,
  startedAt: string,
  endedAt: string,
): NormalizedSession {
  return {
    tool: "codex",
    sessionId,
    shortId,
    project: cachedProjectSlug(cwd),
    projectRaw: cwd,
    startedAt,
    endedAt,
    nameSlug: "untitled",
    displayName: "untitled",
    messages: [],
    sourcePath,
  };
}
