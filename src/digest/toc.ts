import type { SessionMessage, TocEntry, ContentBlock } from "../types.js";

/** Min length of sanitized user text to qualify as a "real" prompt (vs. a
 *  tool_result wrapper). Matches the writer's existing sanitizer gate. */
const USER_TEXT_MIN = 50;

/** Min length of an assistant's plain text reply (no tool_use) to count as
 *  a substantive "voice" turn worth listing in the TOC. Below this, the
 *  message is usually "OK", "done", or a brief acknowledgement. */
const ASSISTANT_TEXT_MIN = 200;

/** Bash sub-commands that signal a noteworthy VCS event. `git push` excluded:
 *  it's procedural, and we already capture the underlying commit/tag. */
const GIT_NOTEWORTHY_RE = /\bgit\s+(commit|tag)\b/;

/** Tools that materially mutate the repo. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
const SHELL_TOOLS = new Set(["Bash", "exec", "exec_command", "local_shell"]);

/**
 * Build an importance-based TOC. Tool-result-only turns are skipped; what
 * remains is real user prompts, file edits, commits, and substantive
 * assistant replies. Markers reflect what makes a turn noteworthy (a turn
 * may have multiple).
 *
 * @param messages SessionMessage[] in chronological order.
 * @param messageLineOffsets parallel array: messageLineOffsets[i] is the line
 *   number of message i's `## User`/`## Assistant` heading in the final
 *   rendered md. Consumers `Read offset:line` to jump straight to the turn.
 */
export function buildTocEntries(
  messages: SessionMessage[],
  messageLineOffsets: number[],
): TocEntry[] {
  const out: TocEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const markers = computeMarkers(m);
    if (!markers) continue;
    out.push({
      turn: i + 1,
      timestamp: m.timestamp ?? "",
      markers,
      preview: computePreview(m),
      line: messageLineOffsets[i] ?? 0,
    });
  }
  return out;
}

function computeMarkers(m: SessionMessage): string {
  const marks: string[] = [];

  if (m.role === "user" && m.text && m.text.length >= USER_TEXT_MIN) {
    marks.push("🧑");
  }

  if (m.role === "assistant") {
    let hasEdit = false;
    let hasCommit = false;
    for (const b of m.contentBlocks ?? []) {
      if (b.type !== "tool_use") continue;
      if (EDIT_TOOLS.has(b.name)) hasEdit = true;
      if (SHELL_TOOLS.has(b.name)) {
        const cmd = readCommand(b);
        if (cmd && GIT_NOTEWORTHY_RE.test(cmd)) hasCommit = true;
      }
    }
    if (hasCommit) marks.push("💾");
    if (hasEdit) marks.push("✏️");

    // Substantive text reply (no tool calls dominating it): a real "voice"
    // turn. We check after edit/commit so the markers stack naturally.
    if (m.text && m.text.length >= ASSISTANT_TEXT_MIN && !hasEdit && !hasCommit) {
      marks.push("🤖");
    }
  }

  return marks.join("");
}

function computePreview(m: SessionMessage): string {
  // Prefer user/assistant text. For tool-only turns, summarize the actions.
  if (m.text) return previewOf(m.text, 100);
  const actions: string[] = [];
  for (const b of m.contentBlocks ?? []) {
    if (b.type !== "tool_use") continue;
    if (EDIT_TOOLS.has(b.name)) {
      const fp = readEditPath(b);
      if (fp) actions.push(`${b.name} ${fp}`);
      else actions.push(b.name);
    } else if (SHELL_TOOLS.has(b.name)) {
      const cmd = readCommand(b);
      if (cmd) {
        const firstLine = cmd.split("\n", 1)[0]!.trim();
        actions.push(firstLine);
      }
    }
    if (actions.length >= 2) break;
  }
  return previewOf(actions.join(" · "), 100);
}

function readCommand(b: Extract<ContentBlock, { type: "tool_use" }>): string | null {
  const input = b.input as { command?: unknown; cmd?: unknown } | null;
  if (!input || typeof input !== "object") return null;
  return commandText(input.command) ?? commandText(input.cmd);
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? parts.join(" ") : null;
}

function readEditPath(b: Extract<ContentBlock, { type: "tool_use" }>): string | null {
  const input = b.input as { file_path?: unknown; patch?: unknown } | null;
  if (!input || typeof input !== "object") return null;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.patch !== "string") return null;
  return input.patch.match(/^\*\*\* (?:(?:Add|Update|Delete) File:|Move to:) (.+)$/m)?.[1]?.trim() ?? null;
}

function previewOf(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

/** Render the TOC as a markdown block ready to embed in the final md.
 *  Returns "" if no entries (e.g. session is entirely tool noise). */
export function renderTocMarkdown(entries: TocEntry[]): string {
  if (entries.length === 0) return "";
  const header =
    `# Table of Contents\n\n` +
    `Importance-based — real user turns (≥${USER_TEXT_MIN} chars), file edits, commits, and substantive assistant replies. Tool-result-only turns omitted.\n\n` +
    `| # | Time | Marker | Preview | Line |\n` +
    `|---|------|--------|---------|------|`;
  const rows = entries.map((e) => {
    const time = e.timestamp ? e.timestamp.slice(5, 16).replace("T", " ") : "—";
    const preview = escapeTableCell(e.preview);
    return `| ${e.turn} | ${time} | ${e.markers} | ${preview} | →L${e.line} |`;
  });
  return [header, ...rows].join("\n");
}

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
