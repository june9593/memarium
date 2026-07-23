import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { simpleGit } from "simple-git";

/**
 * Integration test for assets/scripts/merge-books.mjs.
 *
 * Sets up a fake bare remote with device branches, each carrying typed
 * memory / entities / qa (via .memarium/index.{memory,entity,qa}.json) plus
 * raw_sessions (via .memarium/index.json). Runs merge-books.mjs on a clone
 * of main and asserts each pass unions by id/session (latest wins), prunes
 * stale files, guards path traversal, and commits.
 */

const SCRIPT_PATH = new URL("../../assets/scripts/merge-books.mjs", import.meta.url).pathname;

interface RawSessionSeed {
  /** e.g. "claude:abc12345-..." — the key in .memarium/index.json */
  sessionId: string;
  tool: "claude" | "copilot";
  project: string;
  startedAt: string;
  sourceMtimeMs: number;
  body: string;
}

interface MemorySeed {
  id: string;
  type: string;
  project: string | null;
  updatedAt: string;
  title: string;
  body: string;
  /** Override the path stored in index.memory.json (for traversal tests). */
  path?: string;
}

interface EntitySeed {
  id: string;
  updatedAt: string;
  title: string;
  body: string;
  /** slug determines the filename; defaults to last segment of id */
  slug?: string;
  /** project/namespace under memory/entities/; defaults to "_global" */
  project?: string;
  /** Override the path stored in index.entity.json (for traversal tests). */
  path?: string;
}

interface QaSeed {
  id: string;
  updatedAt: string;
  question: string;
  answerSummary: string;
  body: string;
  /** slug determines the filename; defaults to last segment of id */
  slug?: string;
  /** project/namespace under memory/qa/; defaults to "_global" */
  project?: string;
  /** Override the path stored in index.qa.json (for traversal tests). */
  path?: string;
}

interface BranchSeed {
  device: string;
  /** raw_sessions to plant + register in .memarium/index.json (P7) */
  rawSessions?: RawSessionSeed[];
  /** typed memory entries to plant + register in .memarium/index.memory.json (0.9) */
  memories?: MemorySeed[];
  /** entity wiki pages to plant + register in .memarium/index.entity.json */
  entities?: EntitySeed[];
  /** qa pages to plant + register in .memarium/index.qa.json */
  qa?: QaSeed[];
}

let bareRemote: string;
let workspace: string;

// git init/clone/push under load easily exceed vitest's 5s default. Each
// it() spins up a bare remote + 2-3 clones; bump per-test + per-hook budget.
const T = 60_000;

async function setupBranch(seed: BranchSeed): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `memarium-merge-seed-${seed.device}-`));
  await simpleGit().clone(bareRemote, dir);
  const g = simpleGit(dir);
  await g.addConfig("user.email", "t@example.com");
  await g.addConfig("user.name", "Tester");
  try {
    await g.checkout(["-b", seed.device]);
  } catch {
    await g.checkout(seed.device);
  }

  mkdirSync(join(dir, ".memarium"), { recursive: true });

  // P7: raw_sessions + .memarium/index.json (spool index).
  if (seed.rawSessions && seed.rawSessions.length > 0) {
    const spoolIndex = {
      version: 1,
      entries: {} as Record<string, unknown>,
    };
    for (const rs of seed.rawSessions) {
      const date = rs.startedAt.slice(0, 10);
      const shortId = rs.sessionId.slice(0, 8);
      const rel = `raw_sessions/${rs.tool}/${rs.project}/${date}/seed__${shortId}.md`;
      writeFileTo(dir, rel, rs.body);
      spoolIndex.entries[`${rs.tool}:${rs.sessionId}`] = {
        sessionId: rs.sessionId,
        shortId,
        tool: rs.tool,
        project: rs.project,
        projectRaw: `/Users/test/${rs.project}`,
        startedAt: rs.startedAt,
        endedAt: rs.startedAt,
        nameSlug: "seed",
        displayName: "seed",
        relativePath: rel,
        sourcePath: `/fake/${rs.sessionId}.jsonl`,
        sourceMtimeMs: rs.sourceMtimeMs,
        sourceSha256: `sha-${rs.sessionId}`,
      };
    }
    writeFileSync(join(dir, ".memarium", "index.json"), JSON.stringify(spoolIndex, null, 2));
  }

  // memories: plant .md files + .memarium/index.memory.json (0.9)
  if (seed.memories && seed.memories.length > 0) {
    const entries: Record<string, unknown> = {};
    for (const m of seed.memories) {
      const scope = m.project ?? "_global";
      const slug = m.id.split("/").pop()!;
      const rel = `memory/${m.type}/${scope}/${slug}.md`;
      const mdContent = `---\nid: ${m.id}\ntype: ${m.type}\nupdatedAt: ${m.updatedAt}\ntitle: ${m.title}\n---\n\n${m.body}`;
      writeFileTo(dir, rel, mdContent);
      // Use explicit path override when provided (e.g. for path-traversal tests)
      const indexedPath = m.path !== undefined ? m.path : rel;
      entries[m.id] = {
        id: m.id,
        type: m.type,
        project: m.project,
        updatedAt: m.updatedAt,
        title: m.title,
        path: indexedPath,
        status: "active",
        originDevice: null,
      };
    }
    writeFileSync(join(dir, ".memarium", "index.memory.json"), JSON.stringify({ version: 1, entries }, null, 2));
  }

  // entities: plant .md files + .memarium/index.entity.json
  if (seed.entities && seed.entities.length > 0) {
    const entityEntries: Record<string, unknown> = {};
    for (const e of seed.entities) {
      const scope = e.project ?? "_global";
      const slug = e.slug ?? e.id.split("/").pop()!;
      const rel = `memory/entities/${scope}/${slug}.md`;
      const mdContent = `---\nid: ${e.id}\nupdatedAt: ${e.updatedAt}\ntitle: ${e.title}\n---\n\n${e.body}`;
      writeFileTo(dir, rel, mdContent);
      const indexedPath = e.path !== undefined ? e.path : rel;
      entityEntries[e.id] = {
        id: e.id,
        path: indexedPath,
        updatedAt: e.updatedAt,
        title: e.title,
        originDevice: null,
      };
    }
    writeFileSync(join(dir, ".memarium", "index.entity.json"), JSON.stringify({ version: 1, entries: entityEntries }, null, 2));
  }

  // qa: plant .md files + .memarium/index.qa.json
  if (seed.qa && seed.qa.length > 0) {
    const qaEntries: Record<string, unknown> = {};
    for (const e of seed.qa) {
      const scope = e.project ?? "_global";
      const slug = e.slug ?? e.id.split("/").pop()!;
      const rel = `memory/qa/${scope}/${slug}.md`;
      const mdContent = `---\nid: ${e.id}\nupdatedAt: ${e.updatedAt}\nquestion: ${e.question}\nanswerSummary: ${e.answerSummary}\n---\n\n${e.body}`;
      writeFileTo(dir, rel, mdContent);
      const indexedPath = e.path !== undefined ? e.path : rel;
      qaEntries[e.id] = {
        id: e.id,
        path: indexedPath,
        updatedAt: e.updatedAt,
        question: e.question,
        answerSummary: e.answerSummary,
        originDevice: null,
      };
    }
    writeFileSync(join(dir, ".memarium", "index.qa.json"), JSON.stringify({ version: 1, entries: qaEntries }, null, 2));
  }

  await g.add(".");
  await g.commit(`seed ${seed.device}`);
  await g.push("origin", seed.device, ["-u"]);
  rmSync(dir, { recursive: true, force: true });
}

function writeFileTo(dir: string, rel: string, body: string) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

async function setupMainOrphan(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "memarium-merge-main-seed-"));
  await simpleGit().clone(bareRemote, dir);
  const g = simpleGit(dir);
  await g.addConfig("user.email", "t@example.com");
  await g.addConfig("user.name", "Tester");
  await g.checkout(["--orphan", "main"]);
  await g.raw(["rm", "-rf", "--cached", "--ignore-unmatch", "."]);
  writeFileSync(join(dir, ".keep"), "initial\n");
  await g.add(".keep");
  await g.commit("init main");
  await g.push("origin", "main", ["-u"]);
  rmSync(dir, { recursive: true, force: true });
}

beforeEach(async () => {
  bareRemote = mkdtempSync(join(tmpdir(), "memarium-merge-bare-"));
  await simpleGit(bareRemote).init({ "--bare": null });
  await setupMainOrphan();
  workspace = mkdtempSync(join(tmpdir(), "memarium-merge-work-"));
}, T);

afterEach(() => {
  if (bareRemote) rmSync(bareRemote, { recursive: true, force: true, maxRetries: 3 });
  if (workspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
});

async function runMerge(env: NodeJS.ProcessEnv = {}): Promise<{ clone: string }> {
  await simpleGit().clone(bareRemote, workspace);
  const g = simpleGit(workspace);
  await g.addConfig("user.email", "bot@example.com");
  await g.addConfig("user.name", "memarium-bot");
  await g.checkout("main");
  execSync(`node ${SCRIPT_PATH}`, { cwd: workspace, stdio: "pipe", env: { ...process.env, ...env } });
  return { clone: workspace };
}

describe("merge-books.mjs (memory aggregation)", () => {
  it("creates a commit with a memory-aggregate message", async () => {
    await setupBranch({
      device: "Mac.lan",
      memories: [
        { id: "semantic/code-src/a", type: "semantic", project: "code-src",
          updatedAt: "2026-06-01", body: "fact", title: "fact A" },
      ],
    });
    const { clone } = await runMerge();
    const g = simpleGit(clone);
    const log = await g.log();
    expect(log.all[0].message).toMatch(/memarium aggregate/);
    expect(log.all[0].message).toMatch(/\+1 memory/);
  }, T);

  it("aggregates raw_sessions/ + writes .memarium/index.aggregated.json (P7)", async () => {
    await setupBranch({
      device: "Mac.lan",
      rawSessions: [
        {
          sessionId: "sess-mac-aaaa", tool: "claude", project: "code-src",
          startedAt: "2026-04-20T10:00:00.000Z", sourceMtimeMs: 1_000_000,
          body: "# md from Mac.lan (sess-mac)\n",
        },
        {
          sessionId: "sess-shared", tool: "claude", project: "code-src",
          startedAt: "2026-04-20T11:00:00.000Z", sourceMtimeMs: 1_000_000,
          body: "# OLD body from Mac.lan\n",
        },
      ],
    });
    await setupBranch({
      device: "Mac-mini",
      rawSessions: [
        {
          sessionId: "sess-mini-bbbb", tool: "copilot", project: "acme-web",
          startedAt: "2026-04-22T09:00:00.000Z", sourceMtimeMs: 2_000_000,
          body: "# md from Mac-mini (sess-mini)\n",
        },
        {
          sessionId: "sess-shared", tool: "claude", project: "code-src",
          startedAt: "2026-04-20T11:00:00.000Z", sourceMtimeMs: 2_000_000,
          body: "# NEW body from Mac-mini (won via higher mtime)\n",
        },
      ],
    });

    await runMerge();

    const macMd = join(workspace, "raw_sessions/claude/code-src/2026-04-20/seed__sess-mac.md");
    const miniMd = join(workspace, "raw_sessions/copilot/acme-web/2026-04-22/seed__sess-min.md");
    const sharedMd = join(workspace, "raw_sessions/claude/code-src/2026-04-20/seed__sess-sha.md");
    expect(existsSync(macMd)).toBe(true);
    expect(existsSync(miniMd)).toBe(true);
    expect(existsSync(sharedMd)).toBe(true);
    // dedupe by tool:sessionId — Mac-mini's newer body wins for sess-shared
    expect(readFileSync(sharedMd, "utf8")).toContain("NEW body from Mac-mini");

    const aggPath = join(workspace, ".memarium/index.aggregated.json");
    expect(existsSync(aggPath)).toBe(true);
    const agg = JSON.parse(readFileSync(aggPath, "utf8"));
    expect(agg.version).toBe(1);
    expect(Object.keys(agg.entries).sort()).toEqual([
      "claude:sess-mac-aaaa",
      "claude:sess-shared",
      "copilot:sess-mini-bbbb",
    ]);
    // originDevice annotation lets consumers tell "which machine wrote this"
    expect(agg.entries["claude:sess-mac-aaaa"].originDevice).toBe("Mac.lan");
    expect(agg.entries["copilot:sess-mini-bbbb"].originDevice).toBe("Mac-mini");
    expect(agg.entries["claude:sess-shared"].originDevice).toBe("Mac-mini");
  }, T);

  it("doesn't write raw_sessions/ or .memarium/index.aggregated.json when no device has a spool index", async () => {
    // A memory-only device (no rawSessions → no .memarium/index.json) must
    // still aggregate memory cleanly, and the raw_sessions artifacts must NOT appear.
    await setupBranch({
      device: "Mac.lan",
      memories: [
        { id: "semantic/p/m1", type: "semantic", project: "p",
          updatedAt: "2026-04-20", body: "m1", title: "M1" },
      ],
    });
    await runMerge();
    expect(existsSync(join(workspace, "raw_sessions"))).toBe(false);
    expect(existsSync(join(workspace, ".memarium/index.aggregated.json"))).toBe(false);
    // memory still aggregated normally
    expect(existsSync(join(workspace, "memory/semantic/p/m1.md"))).toBe(true);
  }, T);

  it("aggregates raw_sessions from a device that only has raw_sessions (no memory yet)", async () => {
    // Device has only raw_sessions (no /memarium digest has been run anywhere
    // yet). raw_sessions aggregation is independent of any memory index.
    await setupBranch({
      device: "Mac.lan",
      rawSessions: [{
        sessionId: "sess-only-raw", tool: "claude", project: "code-src",
        startedAt: "2026-04-20T10:00:00.000Z", sourceMtimeMs: 1_000_000,
        body: "# md from a device that never ran /memarium digest\n",
      }],
    });

    await runMerge();

    // raw_sessions IS aggregated on its own
    expect(existsSync(join(workspace, "raw_sessions/claude/code-src/2026-04-20/seed__sess-onl.md"))).toBe(true);
    const agg = JSON.parse(readFileSync(join(workspace, ".memarium/index.aggregated.json"), "utf8"));
    expect(Object.keys(agg.entries)).toEqual(["claude:sess-only-raw"]);
    // no book/ is ever produced
    expect(existsSync(join(workspace, "book"))).toBe(false);
  }, T);

  it("aggregates memory/ + index.memory.json across devices, union by id, latest wins (0.9 memory)", async () => {
    await setupBranch({
      device: "Mac.lan",
      memories: [
        { id: "semantic/code-src/a", type: "semantic", project: "code-src",
          updatedAt: "2026-06-01", body: "older", title: "fact A" },
        { id: "core/_global/rule", type: "core", project: null,
          updatedAt: "2026-06-01", body: "never publish", title: "rule" },
      ],
    });
    await setupBranch({
      device: "Mac-mini",
      memories: [
        { id: "semantic/code-src/a", type: "semantic", project: "code-src",
          updatedAt: "2026-06-09", body: "NEWER wins", title: "fact A" },
        { id: "procedural/code-src/b", type: "procedural", project: "code-src",
          updatedAt: "2026-06-09", body: "how-to", title: "playbook B" },
      ],
    });

    await runMerge();

    const aMd = readFileSync(join(workspace, "memory/semantic/code-src/a.md"), "utf8");
    expect(aMd).toContain("NEWER wins");
    expect(existsSync(join(workspace, "memory/core/_global/rule.md"))).toBe(true);
    expect(existsSync(join(workspace, "memory/procedural/code-src/b.md"))).toBe(true);

    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.memory.json"), "utf8"));
    expect(Object.keys(idx.entries).sort()).toEqual([
      "core/_global/rule", "procedural/code-src/b", "semantic/code-src/a",
    ]);
    expect(idx.entries["semantic/code-src/a"].originDevice).toBe("Mac-mini");
  }, T);

  it("skips memory entries with unsafe paths (path traversal guard)", async () => {
    await setupBranch({
      device: "Mac.lan",
      memories: [
        // Safe entry — should be aggregated normally
        { id: "semantic/code-src/safe", type: "semantic", project: "code-src",
          updatedAt: "2026-06-01", body: "safe content", title: "safe entry" },
        // Malicious entry: path points outside memory/ via ../
        { id: "evil/traversal/id", type: "semantic", project: null,
          updatedAt: "2026-06-01", body: "should be ignored", title: "evil",
          path: "../../evil.md" },
        // Malicious entry: absolute path
        { id: "evil/absolute/id", type: "semantic", project: null,
          updatedAt: "2026-06-01", body: "should be ignored", title: "evil2",
          path: "/etc/passwd" },
        // Malicious entry: outside memory/ but relative
        { id: "evil/github/id", type: "semantic", project: null,
          updatedAt: "2026-06-01", body: "should be ignored", title: "evil3",
          path: ".github/workflows/x.yml" },
      ],
    });

    await runMerge();

    // Safe entry was written
    expect(existsSync(join(workspace, "memory/semantic/code-src/safe.md"))).toBe(true);

    // Traversal attempts were NOT written outside memory/
    expect(existsSync(join(workspace, "evil.md"))).toBe(false);
    // Parent-directory traversal: workspace/../evil.md must not exist
    const parentEvil = join(workspace, "..", "evil.md");
    expect(existsSync(parentEvil)).toBe(false);

    // The aggregated index must not contain malicious ids
    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.memory.json"), "utf8"));
    expect(Object.keys(idx.entries)).not.toContain("evil/traversal/id");
    expect(Object.keys(idx.entries)).not.toContain("evil/absolute/id");
    expect(Object.keys(idx.entries)).not.toContain("evil/github/id");
    // Only safe entry survives
    expect(Object.keys(idx.entries)).toEqual(["semantic/code-src/safe"]);
  }, T);

  it("memory pass skips entries whose path falls under memory/entities/ (subtree isolation)", async () => {
    // A corrupted/malicious index.memory.json could list an entry whose path
    // is memory/entities/... — the memory UNION pass must skip it even though
    // isSafeMemoryPath() accepts it (memory/entities/ is a valid memory/ prefix).
    // The entity pass must remain the sole writer of that subtree.
    await setupBranch({
      device: "Mac.lan",
      memories: [
        // Normal memory entry — should be aggregated
        { id: "semantic/code-src/normalFact", type: "semantic", project: "code-src",
          updatedAt: "2026-06-01", body: "safe memory body", title: "normal" },
        // Entry whose path sneaks into memory/entities/; isSafeMemoryPath passes
        // it but the memory pass must skip it
        { id: "entity/sneaky/id", type: "semantic", project: null,
          updatedAt: "2026-06-01", body: "should not be written by memory pass", title: "sneaky",
          path: "memory/entities/code-src/x.md" },
      ],
    });

    await runMerge();

    // Normal memory entry was written
    expect(existsSync(join(workspace, "memory/semantic/code-src/normalFact.md"))).toBe(true);

    // The sneaky entity-subtree path must NOT have been written by the memory pass
    expect(existsSync(join(workspace, "memory/entities/code-src/x.md"))).toBe(false);

    // And it must not appear in the aggregated memory index
    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.memory.json"), "utf8"));
    expect(Object.keys(idx.entries)).not.toContain("entity/sneaky/id");
    expect(Object.keys(idx.entries)).toEqual(["semantic/code-src/normalFact"]);
  }, T);

  it("prunes stale aggregated memory md when entries are removed on all devices", async () => {
    // Plant a stale memory file directly on main (simulates a prior merge
    // that included entry y, which has since been removed on all devices).
    // runMerge clones the remote fresh, so we pre-place it in the workspace
    // dir after the clone but before the script runs. To do that cleanly,
    // use a custom runMerge flow: clone, plant stale file, then run script.
    await setupBranch({
      device: "Mac.lan",
      memories: [
        // Only entry x exists — y was removed
        { id: "semantic/code-src/x", type: "semantic", project: "code-src",
          updatedAt: "2026-06-01", body: "entry x", title: "X" },
      ],
    });

    // Clone workspace + plant the stale y.md before running the script
    await simpleGit().clone(bareRemote, workspace);
    const g = simpleGit(workspace);
    await g.addConfig("user.email", "bot@example.com");
    await g.addConfig("user.name", "memarium-bot");
    await g.checkout("main");

    // Plant the orphan stale file that should be pruned
    const staleAbs = join(workspace, "memory/semantic/code-src/y.md");
    mkdirSync(dirname(staleAbs), { recursive: true });
    writeFileSync(staleAbs, "# stale entry y — should be pruned\n");

    // Run the script directly (bypass runMerge to reuse the already-cloned workspace)
    execSync(`node ${SCRIPT_PATH}`, { cwd: workspace, stdio: "pipe", env: process.env });

    // entry x was aggregated
    expect(existsSync(join(workspace, "memory/semantic/code-src/x.md"))).toBe(true);
    // stale entry y.md was pruned
    expect(existsSync(staleAbs)).toBe(false);

    // Aggregated index reflects current state (only x)
    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.memory.json"), "utf8"));
    expect(Object.keys(idx.entries)).toEqual(["semantic/code-src/x"]);
    expect(Object.keys(idx.entries)).not.toContain("semantic/code-src/y");
  }, T);

  it("aggregates memory/entities/ + index.entity.json across devices, union by id, latest wins", async () => {
    await setupBranch({
      device: "Mac.lan",
      entities: [
        { id: "code-src/Tab", project: "code-src", updatedAt: "2026-06-01T10:00:00.000Z",
          title: "Tab", body: "older body for Tab" },
        { id: "_global/Acme", project: "_global", updatedAt: "2026-06-01T10:00:00.000Z",
          title: "Acme", body: "web framework" },
      ],
    });
    await setupBranch({
      device: "Mac-mini",
      entities: [
        // Same id, newer updatedAt — should win
        { id: "code-src/Tab", project: "code-src", updatedAt: "2026-06-09T10:00:00.000Z",
          title: "Tab", body: "NEWER body for Tab" },
        // Distinct id — should be merged in
        { id: "code-src/Widget", project: "code-src", updatedAt: "2026-06-09T11:00:00.000Z",
          title: "Widget", body: "web contents entry" },
      ],
    });

    await runMerge();

    // Newer body wins for the shared id
    const tabMd = readFileSync(join(workspace, "memory/entities/code-src/Tab.md"), "utf8");
    expect(tabMd).toContain("NEWER body for Tab");

    // Distinct ids from both devices survive
    expect(existsSync(join(workspace, "memory/entities/_global/Acme.md"))).toBe(true);
    expect(existsSync(join(workspace, "memory/entities/code-src/Widget.md"))).toBe(true);

    // index.entity.json written with all three entries
    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.entity.json"), "utf8"));
    expect(idx.version).toBe(1);
    expect(Object.keys(idx.entries).sort()).toEqual([
      "_global/Acme", "code-src/Tab", "code-src/Widget",
    ]);
    // originDevice stamped from the winning branch for the collision
    expect(idx.entries["code-src/Tab"].originDevice).toBe("Mac-mini");
    expect(idx.entries["_global/Acme"].originDevice).toBe("Mac.lan");
  }, T);

  it("skips entity entries with unsafe paths (path traversal guard)", async () => {
    await setupBranch({
      device: "Mac.lan",
      entities: [
        // Safe entry — should be aggregated
        { id: "code-src/SafeEntity", project: "code-src", updatedAt: "2026-06-01T00:00:00.000Z",
          title: "Safe", body: "safe entity" },
        // Traversal via ..
        { id: "evil/traversal", project: "_global", updatedAt: "2026-06-01T00:00:00.000Z",
          title: "evil", body: "should be skipped", path: "../../evil.md" },
        // Absolute path
        { id: "evil/absolute", project: "_global", updatedAt: "2026-06-01T00:00:00.000Z",
          title: "evil2", body: "should be skipped", path: "/etc/passwd" },
        // Outside memory/entities/ but still under memory/ (wrong subtree)
        { id: "evil/wrong-subtree", project: "_global", updatedAt: "2026-06-01T00:00:00.000Z",
          title: "evil3", body: "should be skipped", path: "memory/core/x.md" },
        // Non-.md file inside memory/entities/ — entity prune only deletes *.md
        // so a non-md file would persist; the guard must reject it.
        { id: "evil/non-md", project: "_global", updatedAt: "2026-06-01T00:00:00.000Z",
          title: "evil4", body: "should be skipped", path: "memory/entities/_global/.gitignore" },
        { id: "evil/txt", project: "_global", updatedAt: "2026-06-01T00:00:00.000Z",
          title: "evil5", body: "should be skipped", path: "memory/entities/_global/x.txt" },
      ],
    });

    await runMerge();

    // Safe entry written
    expect(existsSync(join(workspace, "memory/entities/code-src/SafeEntity.md"))).toBe(true);

    // Malicious paths must not have been written
    expect(existsSync(join(workspace, "evil.md"))).toBe(false);
    expect(existsSync(join(workspace, "..", "evil.md"))).toBe(false);
    expect(existsSync(join(workspace, "memory/core/x.md"))).toBe(false);
    expect(existsSync(join(workspace, "memory/entities/_global/.gitignore"))).toBe(false);
    expect(existsSync(join(workspace, "memory/entities/_global/x.txt"))).toBe(false);

    // index.entity.json must contain only the safe entry
    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.entity.json"), "utf8"));
    expect(Object.keys(idx.entries)).toEqual(["code-src/SafeEntity"]);
    expect(Object.keys(idx.entries)).not.toContain("evil/traversal");
    expect(Object.keys(idx.entries)).not.toContain("evil/absolute");
    expect(Object.keys(idx.entries)).not.toContain("evil/wrong-subtree");
    expect(Object.keys(idx.entries)).not.toContain("evil/non-md");
    expect(Object.keys(idx.entries)).not.toContain("evil/txt");
  }, T);

  it("entity pass: backslash paths in index are normalized so read/write use forward slashes", async () => {
    // Reproduces the GitHub Copilot review finding: a device's index.entity.json
    // stores a Windows-style backslash path. isSafeEntityPath accepts it
    // (it normalizes internally), but prior to the fix the downstream
    // readFileFromBranch / writeRel / keptEntityPaths / index all used the
    // original backslash value, causing a silent drop (git show with backslash
    // path fails) and a mismatched index entry.
    //
    // setupBranch always writes the actual .md file at the forward-slash path;
    // we override `path` in the entity index to the backslash form.
    await setupBranch({
      device: "Win-device",
      entities: [
        {
          id: "code-src/x",
          project: "code-src",
          updatedAt: "2026-06-09T10:00:00.000Z",
          title: "X",
          body: "backslash path entity",
          // Real file is at memory/entities/code-src/x.md (forward slashes).
          // Index entry records the Windows backslash form to trigger the bug.
          path: "memory\\entities\\code-src\\x.md",
        },
      ],
    });

    await runMerge();

    // The entity MUST have been aggregated at the normalized forward-slash path.
    const entityMd = join(workspace, "memory/entities/code-src/x.md");
    expect(existsSync(entityMd)).toBe(true);
    expect(readFileSync(entityMd, "utf8")).toContain("backslash path entity");

    // The written index.entity.json must store the normalized (forward-slash) path.
    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.entity.json"), "utf8"));
    expect(idx.entries["code-src/x"].path).toBe("memory/entities/code-src/x.md");
  }, T);

  it("memory pass: backslash paths in index are normalized so read/write use forward slashes", async () => {
    // Same latent issue for the memory pass.
    await setupBranch({
      device: "Win-device",
      memories: [
        {
          id: "semantic/code-src/y",
          type: "semantic",
          project: "code-src",
          updatedAt: "2026-06-09T10:00:00.000Z",
          title: "Y",
          body: "backslash path memory",
          // Real file is at memory/semantic/code-src/y.md; index uses backslashes.
          path: "memory\\semantic\\code-src\\y.md",
        },
      ],
    });

    await runMerge();

    const memMd = join(workspace, "memory/semantic/code-src/y.md");
    expect(existsSync(memMd)).toBe(true);
    expect(readFileSync(memMd, "utf8")).toContain("backslash path memory");

    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.memory.json"), "utf8"));
    expect(idx.entries["semantic/code-src/y"].path).toBe("memory/semantic/code-src/y.md");
  }, T);

  it("memory prune does NOT delete entity files; entity prune only touches memory/entities/", async () => {
    // Plant both a memory entry and an entity entry from a device branch.
    // Also pre-plant a stale entity file on main (simulates a prior merge).
    // After merge: memory prune must leave entity files alone; entity prune
    // removes the stale entity file but leaves memory files intact.
    await setupBranch({
      device: "Mac.lan",
      memories: [
        { id: "semantic/code-src/memEntry", type: "semantic", project: "code-src",
          updatedAt: "2026-06-01T00:00:00.000Z", body: "memory body", title: "mem" },
      ],
      entities: [
        { id: "code-src/LiveEntity", project: "code-src", updatedAt: "2026-06-01T00:00:00.000Z",
          title: "LiveEntity", body: "live entity" },
      ],
    });

    // Clone and pre-plant a stale entity file that should be pruned
    await simpleGit().clone(bareRemote, workspace);
    const g = simpleGit(workspace);
    await g.addConfig("user.email", "bot@example.com");
    await g.addConfig("user.name", "memarium-bot");
    await g.checkout("main");

    const staleEntityAbs = join(workspace, "memory/entities/code-src/StaleEntity.md");
    mkdirSync(dirname(staleEntityAbs), { recursive: true });
    writeFileSync(staleEntityAbs, "# stale entity — should be pruned\n");

    execSync(`node ${SCRIPT_PATH}`, { cwd: workspace, stdio: "pipe", env: process.env });

    // Memory entry survived
    expect(existsSync(join(workspace, "memory/semantic/code-src/memEntry.md"))).toBe(true);
    // Live entity survived
    expect(existsSync(join(workspace, "memory/entities/code-src/LiveEntity.md"))).toBe(true);
    // Stale entity pruned by entity pass
    expect(existsSync(staleEntityAbs)).toBe(false);
  }, T);

  it("entity prune is SKIPPED when no device has an entity index (no-index-no-prune)", async () => {
    // Reproduces the data-loss bug: main has pre-existing entity pages from
    // a prior merge, but this run's device branches have NO index.entity.json
    // (e.g. the device hasn't upgraded yet). Without the guard, keptEntityPaths
    // would be [] and the prune walk would delete all memory/entities/**/*.md.
    //
    // Device branch: raw_sessions but NO entities key.
    await setupBranch({
      device: "Mac.lan",
      rawSessions: [{
        sessionId: "sess-no-entity", tool: "claude", project: "code-src",
        startedAt: "2026-06-01T00:00:00.000Z", sourceMtimeMs: 1_000_000,
        body: "# raw only\n",
      }],
      // No `entities` field → no .memarium/index.entity.json on this device
    });

    // Clone main and pre-plant entity pages that must survive
    await simpleGit().clone(bareRemote, workspace);
    const g = simpleGit(workspace);
    await g.addConfig("user.email", "bot@example.com");
    await g.addConfig("user.name", "memarium-bot");
    await g.checkout("main");

    const prePlantedA = join(workspace, "memory/entities/code-src/Tab.md");
    const prePlantedB = join(workspace, "memory/entities/_global/Acme.md");
    mkdirSync(dirname(prePlantedA), { recursive: true });
    mkdirSync(dirname(prePlantedB), { recursive: true });
    writeFileSync(prePlantedA, "# Tab — pre-existing entity page\n");
    writeFileSync(prePlantedB, "# Acme — pre-existing entity page\n");

    // Run the merge (no entity index on any device branch)
    execSync(`node ${SCRIPT_PATH}`, { cwd: workspace, stdio: "pipe", env: process.env });

    // Pre-planted entity pages must still exist — the prune must NOT have run
    expect(existsSync(prePlantedA)).toBe(true);
    expect(readFileSync(prePlantedA, "utf8")).toContain("Tab — pre-existing");
    expect(existsSync(prePlantedB)).toBe(true);
    expect(readFileSync(prePlantedB, "utf8")).toContain("Acme — pre-existing");

    // index.entity.json must NOT have been written (anyEntityIndexSeen is false)
    expect(existsSync(join(workspace, ".memarium/index.entity.json"))).toBe(false);
  }, T);

  it("memory prune is SKIPPED when no device has a memory index (no-index-no-prune)", async () => {
    // Same latent bug for the memory pass: if no device has index.memory.json,
    // the prune must not run and must not wipe pre-existing memory/**/*.md
    // (excluding memory/entities/, which is the entity pass's territory).
    await setupBranch({
      device: "Mac.lan",
      rawSessions: [{
        sessionId: "sess-no-memory", tool: "claude", project: "code-src",
        startedAt: "2026-06-01T00:00:00.000Z", sourceMtimeMs: 1_000_000,
        body: "# raw only\n",
      }],
      // No `memories` field → no .memarium/index.memory.json on this device
    });

    // Clone main and pre-plant a memory md that must survive
    await simpleGit().clone(bareRemote, workspace);
    const g = simpleGit(workspace);
    await g.addConfig("user.email", "bot@example.com");
    await g.addConfig("user.name", "memarium-bot");
    await g.checkout("main");

    const prePlanted = join(workspace, "memory/semantic/code-src/oldFact.md");
    mkdirSync(dirname(prePlanted), { recursive: true });
    writeFileSync(prePlanted, "# oldFact — pre-existing memory page\n");

    execSync(`node ${SCRIPT_PATH}`, { cwd: workspace, stdio: "pipe", env: process.env });

    // Pre-planted memory page must survive — the prune must NOT have run
    expect(existsSync(prePlanted)).toBe(true);
    expect(readFileSync(prePlanted, "utf8")).toContain("oldFact — pre-existing");

    // index.memory.json must NOT have been written (anyMemoryIndexSeen is false)
    expect(existsSync(join(workspace, ".memarium/index.memory.json"))).toBe(false);
  }, T);

  it("aggregates memory/qa/ + index.qa.json across devices, union by id, latest wins", async () => {
    await setupBranch({
      device: "Mac.lan",
      qa: [
        { id: "qa/code-src/how-to-build-aaaa1111", project: "code-src", updatedAt: "2026-06-01T10:00:00.000Z",
          question: "How do I build?", answerSummary: "old answer", body: "old full body" },
      ],
    });
    await setupBranch({
      device: "Mac-mini",
      qa: [
        { id: "qa/code-src/how-to-build-aaaa1111", project: "code-src", updatedAt: "2026-06-09T10:00:00.000Z",
          question: "How do I build?", answerSummary: "NEW answer", body: "new full body" },
        { id: "qa/code-src/how-to-test-bbbb2222", project: "code-src", updatedAt: "2026-06-09T11:00:00.000Z",
          question: "How do I test?", answerSummary: "run vitest", body: "test body" },
      ],
    });

    await runMerge();

    const buildMd = readFileSync(join(workspace, "memory/qa/code-src/how-to-build-aaaa1111.md"), "utf8");
    expect(buildMd).toContain("new full body");
    expect(existsSync(join(workspace, "memory/qa/code-src/how-to-test-bbbb2222.md"))).toBe(true);

    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.qa.json"), "utf8"));
    expect(idx.version).toBe(1);
    expect(Object.keys(idx.entries).sort()).toEqual([
      "qa/code-src/how-to-build-aaaa1111", "qa/code-src/how-to-test-bbbb2222",
    ]);
    expect(idx.entries["qa/code-src/how-to-build-aaaa1111"].answerSummary).toBe("NEW answer");
    expect(idx.entries["qa/code-src/how-to-build-aaaa1111"].originDevice).toBe("Mac-mini");
  }, T);

  it("qa prune is SKIPPED when no device has a qa index (no-index-no-prune)", async () => {
    await setupBranch({
      device: "Mac.lan",
      rawSessions: [{
        sessionId: "sess-no-qa", tool: "claude", project: "code-src",
        startedAt: "2026-06-01T00:00:00.000Z", sourceMtimeMs: 1_000_000,
        body: "# raw only\n",
      }],
    });

    await simpleGit().clone(bareRemote, workspace);
    const g = simpleGit(workspace);
    await g.addConfig("user.email", "bot@example.com");
    await g.addConfig("user.name", "memarium-bot");
    await g.checkout("main");

    const prePlanted = join(workspace, "memory/qa/code-src/pre-existing.md");
    mkdirSync(dirname(prePlanted), { recursive: true });
    writeFileSync(prePlanted, "# pre-existing qa page\n");

    execSync(`node ${SCRIPT_PATH}`, { cwd: workspace, stdio: "pipe", env: process.env });

    expect(existsSync(prePlanted)).toBe(true);
    expect(readFileSync(prePlanted, "utf8")).toContain("pre-existing");
    expect(existsSync(join(workspace, ".memarium/index.qa.json"))).toBe(false);
  }, T);

  it("skips qa entries with unsafe paths (path traversal guard)", async () => {
    await setupBranch({
      device: "Mac.lan",
      qa: [
        // Safe entry — should be aggregated
        { id: "qa/code-src/safe-aaaa1111", project: "code-src", updatedAt: "2026-06-09T10:00:00.000Z",
          question: "Safe?", answerSummary: "yes", body: "safe body" },
        // Traversal via ..
        { id: "qa/evil/traversal", project: "_global", updatedAt: "2026-06-09T10:00:00.000Z",
          question: "Evil?", answerSummary: "no", body: "should be skipped", path: "../../etc/escape.md" },
        // Absolute path
        { id: "qa/evil/absolute", project: "_global", updatedAt: "2026-06-09T10:00:00.000Z",
          question: "Evil2?", answerSummary: "no", body: "should be skipped", path: "/etc/passwd.md" },
        // Outside memory/qa/ but still under memory/ (wrong subtree)
        { id: "qa/evil/wrong-subtree", project: "_global", updatedAt: "2026-06-09T10:00:00.000Z",
          question: "Evil3?", answerSummary: "no", body: "should be skipped", path: "memory/entities/_global/x.md" },
        // Non-.md file inside memory/qa/ — qa prune only deletes *.md
        // so a non-md file would persist; the guard must reject it.
        { id: "qa/evil/non-md", project: "_global", updatedAt: "2026-06-09T10:00:00.000Z",
          question: "Evil4?", answerSummary: "no", body: "should be skipped", path: "memory/qa/_global/evil.txt" },
      ],
    });

    await runMerge();

    // Safe entry written
    expect(existsSync(join(workspace, "memory/qa/code-src/safe-aaaa1111.md"))).toBe(true);

    // Malicious paths must not have been written
    expect(existsSync(join(workspace, "etc/escape.md"))).toBe(false);
    expect(existsSync(join(workspace, "..", "etc/escape.md"))).toBe(false);
    expect(existsSync(join(workspace, "memory/entities/_global/x.md"))).toBe(false);
    expect(existsSync(join(workspace, "memory/qa/_global/evil.txt"))).toBe(false);

    // index.qa.json must contain only the safe entry
    const idx = JSON.parse(readFileSync(join(workspace, ".memarium/index.qa.json"), "utf8"));
    expect(Object.keys(idx.entries)).toEqual(["qa/code-src/safe-aaaa1111"]);
    expect(Object.keys(idx.entries)).not.toContain("qa/evil/traversal");
    expect(Object.keys(idx.entries)).not.toContain("qa/evil/absolute");
    expect(Object.keys(idx.entries)).not.toContain("qa/evil/wrong-subtree");
    expect(Object.keys(idx.entries)).not.toContain("qa/evil/non-md");
  }, T);
});
