#!/usr/bin/env node
// Aggregate every device branch's memory into main.
//
// Called from .github/workflows/memarium-aggregate.yml — checked-in on main,
// runs on every push to a non-main branch. Purely mechanical; never touches
// an LLM. Two independent producers feed the device branch: the in-session
// /memarium skill writes typed memory (+ entities, qa), and `memarium sync`
// (npm CLI) writes/pushes raw_sessions. This script merges all those device
// branches into main.
//
// Aggregation passes — each independent, keyed off its own device-branch index:
//   raw_sessions/    — union by tool:sessionId, latest sourceMtimeMs wins (P7).
//   memory/          — union by id, latest updatedAt wins; typed-memory md.
//   memory/entities/ — union by id (its own .memarium/index.entity.json).
//   memory/qa/       — union by id (its own .memarium/index.qa.json).
//
// Algorithm:
//   1. List remote device branches (refs/remotes/origin/*, minus main + HEAD).
//   2. For each, read its spool/memory/entity/qa index via `git show`.
//   3. Union each collection; copy files from the origin device branch.
//   4. Prune main-side files that no live device still claims.
//   5. git add + commit (no-op if nothing changed).
//
// The caller (yaml step) takes care of `git push`.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const SPOOL_INDEX_PATH = ".memarium/index.json";
const AGGREGATED_INDEX_PATH = ".memarium/index.aggregated.json";
const MEMORY_INDEX_PATH = ".memarium/index.memory.json";
const ENTITY_INDEX_PATH = ".memarium/index.entity.json";
const QA_INDEX_PATH = ".memarium/index.qa.json";

/**
 * Guard against path-traversal attacks in memory entry paths.
 * A device's index.memory.json could (if malicious or corrupted) point
 * entry.path outside memory/ (e.g. ".github/workflows/foo.yml", "../../x").
 * Only allow relative paths that start with "memory/" and contain no ".."
 * segments or absolute-path markers.
 */
function isSafeMemoryPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  // must be a relative path under memory/, no traversal
  const norm = p.split("\\").join("/");
  if (norm.startsWith("/")) return false;
  if (!norm.startsWith("memory/")) return false;
  if (norm.split("/").some((seg) => seg === "..")) return false;
  return true;
}

/**
 * Guard against path-traversal attacks in entity entry paths.
 * Identical logic to isSafeMemoryPath but restricted to memory/entities/,
 * and further requires a .md suffix (entity prune only deletes *.md, so a
 * non-md file would persist). Entries that fail this check are logged and
 * skipped.
 */
function isSafeEntityPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  const norm = p.split("\\").join("/");
  if (norm.startsWith("/")) return false;
  if (!norm.startsWith("memory/entities/")) return false;
  if (norm.split("/").some((seg) => seg === "..")) return false;
  if (!norm.endsWith(".md")) return false;
  return true;
}

/**
 * Guard against path-traversal in qa entry paths. Identical to isSafeEntityPath
 * but restricted to memory/qa/ and requires a .md suffix (prune only deletes *.md).
 */
function isSafeQaPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  const norm = p.split("\\").join("/");
  if (norm.startsWith("/")) return false;
  if (!norm.startsWith("memory/qa/")) return false;
  if (norm.split("/").some((seg) => seg === "..")) return false;
  if (!norm.endsWith(".md")) return false;
  return true;
}

function sh(cmd, args) {
  return execSync([cmd, ...args].join(" "), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function shOk(cmd, args) {
  try {
    return { ok: true, stdout: sh(cmd, args) };
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err.stderr ?? "") };
  }
}

function listDeviceBranches() {
  const raw = sh("git", ["for-each-ref", "--format='%(refname:short)'", "refs/remotes/origin/"]);
  return raw
    .split("\n")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter(Boolean)
    .filter((ref) => ref !== "origin/HEAD" && ref !== "origin/main")
    .filter((ref) => !ref.includes("->"))
    .map((ref) => ({ ref, device: ref.replace(/^origin\//, "") }));
}

function readFileFromBranch(ref, path) {
  const r = shOk("git", ["show", `${ref}:${path}`]);
  return r.ok ? r.stdout : null;
}

/** Read the device-side spool index (.memarium/index.json). Keyed by
 *  `${tool}:${sessionId}`. Used by the raw_sessions aggregation pass
 *  added in 0.8.0 to union every device's raw .md files into main. */
function loadSpoolIndexFromBranch(ref) {
  const content = readFileFromBranch(ref, SPOOL_INDEX_PATH);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed.version !== 1 || !parsed.entries) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read the device-side memory index (.memarium/index.memory.json).
 *  Added in 0.8.6 to union typed memory entries across devices. */
function loadMemoryIndexFromBranch(ref) {
  const content = readFileFromBranch(ref, MEMORY_INDEX_PATH);
  if (content === null) return null;
  try {
    const idx = JSON.parse(content);
    if (!idx || idx.version !== 1 || !idx.entries) return null;
    return idx;
  } catch {
    return null;
  }
}

/** Read the device-side entity index (.memarium/index.entity.json).
 *  Mirrors loadMemoryIndexFromBranch — unions entity wiki pages across devices. */
function loadEntityIndexFromBranch(ref) {
  const content = readFileFromBranch(ref, ENTITY_INDEX_PATH);
  if (content === null) return null;
  try {
    const idx = JSON.parse(content);
    if (!idx || idx.version !== 1 || !idx.entries) return null;
    return idx;
  } catch {
    return null;
  }
}

/** Read the device-side qa index (.memarium/index.qa.json). Mirrors
 *  loadEntityIndexFromBranch — unions distilled Q&A pages across devices. */
function loadQaIndexFromBranch(ref) {
  const content = readFileFromBranch(ref, QA_INDEX_PATH);
  if (content === null) return null;
  try {
    const idx = JSON.parse(content);
    if (!idx || idx.version !== 1 || !idx.entries) return null;
    return idx;
  } catch {
    return null;
  }
}

/**
 * Parse a date-ish value to epoch milliseconds, or null when it isn't a
 * parseable string.
 *
 * It has to live here rather than be imported: this file is a standalone .mjs
 * executed by `node assets/scripts/merge-books.mjs` from the CI workflow
 * (assets/workflows/memarium-aggregate.yml) with no build step and no deps.
 */
function epochMs(v) {
  if (typeof v !== "string") return null;
  const ts = Date.parse(v);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Should `candidate`'s updatedAt displace `existing`'s when unioning the same
 * id across device branches?
 *
 * The three aggregation passes below (memory / entities / qa) used to compare
 * `updatedAt` as RAW LEXICAL STRINGS, which is not chronological across the
 * mixed ISO forms the writers actually emit (plain `YYYY-MM-DD`, `...Z`
 * timestamps, and offset timestamps). An offset form like
 * `2026-05-05T14:30:00-10:00` is `2026-05-06T00:30Z` in UTC — LATER than
 * `2026-05-05T23:00:00Z` — yet it sorts lexically BEFORE it, so the stale copy
 * won. That matters more here than at the plugin's read surfaces: this is the
 * CI aggregator, so the wrong winner's md + index entry is PERSISTED into the
 * aggregated tree on main.
 *
 * The comparison is on FULL TIMESTAMPS (epoch ms), deliberately not coarsened
 * to calendar days. Day granularity would fix the cross-day case above but
 * would ALSO silently change same-day pairs that lexical order already ordered
 * correctly (`...T22:00:00Z` vs `...T01:00:00Z`, or a `...T08:00:00Z` timestamp
 * vs a bare `2026-05-06`) into traversal-order ties. Epoch-ms comparison fixes
 * only the mixed-ISO-form bug and leaves every other pair deciding exactly as
 * it did before.
 *
 * Rules:
 *  - the chronologically later updatedAt wins, at full timestamp resolution;
 *  - EXACTLY equal instants → false, so the already-seen entry keeps winning.
 *    That tie is resolved by branch traversal order (git for-each-ref, i.e.
 *    refname order), as it always was;
 *  - an unparseable / missing updatedAt never displaces a parseable one, and
 *    when both are unparseable the existing entry is kept.
 *
 * The plugin-side counterpart (memarium-plugin #65,
 * `source-resolver.mergeIndexById`) intentionally uses DAY granularity instead:
 * there a same-day pair must register as a TIE so a same-day sibling edit
 * reaches the write guard's divergence check. This pass has no divergence
 * check — it just picks a winner and persists it — so coarsening here would
 * only throw away ordering information.
 */
function isNewerTimestamp(candidate, existing) {
  const c = epochMs(candidate);
  if (c === null) return false;          // garbage/absent never wins (incl. both-garbage)
  const e = epochMs(existing);
  if (e === null) return true;           // any readable date beats an unreadable one
  return c > e;                          // exactly equal → false: traversal order decides
}

function writeRel(relPath, content) {
  const abs = join(REPO_ROOT, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------- main ----------------

function main() {
  const branches = listDeviceBranches();
  if (branches.length === 0) {
    console.log("no device branches found — nothing to aggregate");
    return;
  }
  console.log(`found ${branches.length} device branch(es): ${branches.map((b) => b.device).join(", ")}`);

  // -------- raw_sessions: union by tool:sessionId, latest sourceMtimeMs wins --------
  // P7 (0.8.0): cross-device raw_sessions aggregation. Devices push only their
  // own raw_sessions/ to their device branch; main holds the union so any
  // device can `memarium resume <id>` against any other device's session.
  // Pure plaintext blob copy — `git show` yields the session md as-is.
  const rawByKey = new Map(); // "tool:sessionId" -> { ref, device, entry }
  for (const { ref, device } of branches) {
    const spoolIdx = loadSpoolIndexFromBranch(ref);
    if (!spoolIdx) {
      console.log(`  ${device}: no v1 .memarium/index.json — no raw_sessions to aggregate`);
      continue;
    }
    for (const e of Object.values(spoolIdx.entries)) {
      if (!e || !e.tool || !e.sessionId || !e.relativePath) continue;
      const k = `${e.tool}:${e.sessionId}`;
      const existing = rawByKey.get(k);
      if (!existing || (e.sourceMtimeMs ?? 0) > (existing.entry.sourceMtimeMs ?? 0)) {
        rawByKey.set(k, { ref, device, entry: e });
      }
    }
  }
  const keptRawPaths = [];
  const aggregatedEntries = {};
  for (const [k, { ref, device, entry }] of rawByKey.entries()) {
    const body = readFileFromBranch(ref, entry.relativePath);
    if (body === null) {
      console.log(`  warn: ${ref}:${entry.relativePath} missing despite spool index; skipping`);
      continue;
    }
    writeRel(entry.relativePath, body);
    keptRawPaths.push(entry.relativePath);
    aggregatedEntries[k] = { ...entry, originDevice: device };
  }
  console.log(`raw_sessions: kept ${keptRawPaths.length} unique sessions from ${branches.length} device branch(es)`);

  // Write the union index ONLY when at least one device had spool data.
  // Skipping the file when no device has run `memarium sync` yet keeps the
  // test's "no aggregated artifacts when no spool" guarantee.
  if (keptRawPaths.length > 0) {
    writeRel(
      AGGREGATED_INDEX_PATH,
      JSON.stringify({ version: 1, entries: aggregatedEntries }, null, 2) + "\n",
    );
  }

  // -------- memory: union by id, latest updatedAt wins (0.8.6) --------
  const memByKey = new Map(); // id -> { ref, device, entry }
  let anyMemoryIndexSeen = false;
  for (const { ref, device } of branches) {
    const memIdx = loadMemoryIndexFromBranch(ref);
    if (!memIdx) continue;
    anyMemoryIndexSeen = true;
    for (const e of Object.values(memIdx.entries)) {
      if (!e || !e.id || !e.path) continue;
      if (!isSafeMemoryPath(e.path)) {
        console.log(`memory: skipping entry ${e.id} with unsafe path ${JSON.stringify(e.path)}`);
        continue;
      }
      const relPath = e.path.split("\\").join("/");
      if (relPath.startsWith("memory/entities/")) continue;   // entity pass owns this subtree
      if (relPath.startsWith("memory/qa/")) continue;         // qa pass owns this subtree
      const existing = memByKey.get(e.id);
      if (!existing || isNewerTimestamp(e.updatedAt, existing.entry.updatedAt)) {
        memByKey.set(e.id, { ref, device, entry: e });
      }
    }
  }
  const keptMemoryPaths = [];
  const aggregatedMemory = {};
  for (const [id, { ref, device, entry }] of memByKey.entries()) {
    const relPath = entry.path.split("\\").join("/");
    const body = readFileFromBranch(ref, relPath);
    if (body === null) continue;
    writeRel(relPath, body);
    keptMemoryPaths.push(relPath);
    aggregatedMemory[id] = { ...entry, path: relPath, originDevice: device };
  }

  // prune stale aggregated memory md (entries removed on all devices)
  // Scoped to memory/ but skips memory/_primer/ (generated, not indexed)
  // and memory/entities/ (managed by the entity pass below).
  // GUARD: only run the prune when at least one device contributed a memory
  // index this run. If anyMemoryIndexSeen is false we have no authoritative
  // view of what should exist, so wiping main's memory/ would be data loss
  // (e.g. a device that hasn't upgraded yet has no index.memory.json).
  if (anyMemoryIndexSeen) {
    const keptSet = new Set(keptMemoryPaths);
    const memDir = join(REPO_ROOT, "memory");
    if (existsSync(memDir)) {
      const stack = [memDir];
      while (stack.length) {
        const cur = stack.pop();
        let ents;
        try { ents = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const d of ents) {
          const abs = join(cur, d.name);
          if (d.isDirectory()) { stack.push(abs); continue; }
          if (!d.name.endsWith(".md")) continue;
          const rel = relative(REPO_ROOT, abs).split("\\").join("/");
          // never prune generated primers; only prune indexed memory md
          if (rel.startsWith("memory/_primer/")) continue;
          // entity files are managed exclusively by the entity pass below
          if (rel.startsWith("memory/entities/")) continue;
          if (rel.startsWith("memory/qa/")) continue;
          if (!keptSet.has(rel)) { try { unlinkSync(abs); } catch {} }
        }
      }
    }
  }

  // Always rewrite the index when at least one device had a memory index,
  // so a fully-removed entry set produces an empty index rather than a stale one.
  if (anyMemoryIndexSeen) {
    writeRel(MEMORY_INDEX_PATH, JSON.stringify({ version: 1, entries: aggregatedMemory }, null, 2) + "\n");
  }
  console.log(`memory: kept ${keptMemoryPaths.length} entries from ${branches.length} device branch(es)`);

  // -------- entities: union by id, latest updatedAt wins --------
  // Mirrors the memory pass 1:1 but scoped to memory/entities/ and
  // reading from .memarium/index.entity.json on each device branch.
  const entityByKey = new Map(); // id -> { ref, device, entry }
  let anyEntityIndexSeen = false;
  for (const { ref, device } of branches) {
    const entityIdx = loadEntityIndexFromBranch(ref);
    if (!entityIdx) continue;
    anyEntityIndexSeen = true;
    for (const e of Object.values(entityIdx.entries)) {
      if (!e || !e.id || !e.path) continue;
      if (!isSafeEntityPath(e.path)) {
        console.log(`entities: skipping entry ${e.id} with unsafe path ${JSON.stringify(e.path)}`);
        continue;
      }
      const existing = entityByKey.get(e.id);
      if (!existing || isNewerTimestamp(e.updatedAt, existing.entry.updatedAt)) {
        entityByKey.set(e.id, { ref, device, entry: e });
      }
    }
  }
  const keptEntityPaths = [];
  const aggregatedEntities = {};
  for (const [id, { ref, device, entry }] of entityByKey.entries()) {
    const relPath = entry.path.split("\\").join("/");
    const body = readFileFromBranch(ref, relPath);
    if (body === null) continue;
    writeRel(relPath, body);
    keptEntityPaths.push(relPath);
    aggregatedEntities[id] = { ...entry, path: relPath, originDevice: device };
  }

  // prune stale entity md (entries removed on all devices)
  // Scoped exclusively to memory/entities/ — the memory pass above never touches this subtree.
  // GUARD: only run the prune when at least one device contributed an entity
  // index this run. If anyEntityIndexSeen is false, keptEntityPaths is empty
  // and running the prune would wipe ALL of main's memory/entities/ — data loss
  // (e.g. a device that hasn't upgraded yet has no index.entity.json).
  if (anyEntityIndexSeen) {
    const keptEntitySet = new Set(keptEntityPaths);
    const entityDir = join(REPO_ROOT, "memory", "entities");
    if (existsSync(entityDir)) {
      const stack = [entityDir];
      while (stack.length) {
        const cur = stack.pop();
        let ents;
        try { ents = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const d of ents) {
          const abs = join(cur, d.name);
          if (d.isDirectory()) { stack.push(abs); continue; }
          if (!d.name.endsWith(".md")) continue;
          const rel = relative(REPO_ROOT, abs).split("\\").join("/");
          if (!keptEntitySet.has(rel)) { try { unlinkSync(abs); } catch {} }
        }
      }
    }
  }

  // Always rewrite the index when at least one device had an entity index.
  if (anyEntityIndexSeen) {
    writeRel(ENTITY_INDEX_PATH, JSON.stringify({ version: 1, entries: aggregatedEntities }, null, 2) + "\n");
  }
  console.log(`entities: kept ${keptEntityPaths.length} entries from ${branches.length} device branch(es)`);

  // -------- qa: union by id, latest updatedAt wins --------
  // Mirrors the entity pass 1:1 but scoped to memory/qa/ and reading from
  // .memarium/index.qa.json on each device branch.
  const qaByKey = new Map(); // id -> { ref, device, entry }
  let anyQaIndexSeen = false;
  for (const { ref, device } of branches) {
    const qaIdx = loadQaIndexFromBranch(ref);
    if (!qaIdx) continue;
    anyQaIndexSeen = true;
    for (const e of Object.values(qaIdx.entries)) {
      if (!e || !e.id || !e.path) continue;
      if (!isSafeQaPath(e.path)) {
        console.log(`qa: skipping entry ${e.id} with unsafe path ${JSON.stringify(e.path)}`);
        continue;
      }
      const existing = qaByKey.get(e.id);
      if (!existing || isNewerTimestamp(e.updatedAt, existing.entry.updatedAt)) {
        qaByKey.set(e.id, { ref, device, entry: e });
      }
    }
  }
  const keptQaPaths = [];
  const aggregatedQa = {};
  for (const [id, { ref, device, entry }] of qaByKey.entries()) {
    const relPath = entry.path.split("\\").join("/");
    const body = readFileFromBranch(ref, relPath);
    if (body === null) continue;
    writeRel(relPath, body);
    keptQaPaths.push(relPath);
    aggregatedQa[id] = { ...entry, path: relPath, originDevice: device };
  }

  if (anyQaIndexSeen) {
    const keptQaSet = new Set(keptQaPaths);
    const qaDir = join(REPO_ROOT, "memory", "qa");
    if (existsSync(qaDir)) {
      const stack = [qaDir];
      while (stack.length) {
        const cur = stack.pop();
        let ents;
        try { ents = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const d of ents) {
          const abs = join(cur, d.name);
          if (d.isDirectory()) { stack.push(abs); continue; }
          if (!d.name.endsWith(".md")) continue;
          const rel = relative(REPO_ROOT, abs).split("\\").join("/");
          if (!keptQaSet.has(rel)) { try { unlinkSync(abs); } catch {} }
        }
      }
    }
  }

  if (anyQaIndexSeen) {
    writeRel(QA_INDEX_PATH, JSON.stringify({ version: 1, entries: aggregatedQa }, null, 2) + "\n");
  }
  console.log(`qa: kept ${keptQaPaths.length} entries from ${branches.length} device branch(es)`);

  // -------- prune --------
  pruneRawSessions(keptRawPaths);

  // -------- commit --------
  // Build add list dynamically: raw_sessions/ and .memarium/index.aggregated.json
  // each only exist when at least one device contributed to the corresponding
  // aggregation. `git add` on a non-existent path is a hard error, so we gate
  // per-path.
  const addPaths = [];
  if (existsSync(join(REPO_ROOT, "raw_sessions"))) addPaths.push("raw_sessions/");
  if (existsSync(join(REPO_ROOT, AGGREGATED_INDEX_PATH))) addPaths.push(AGGREGATED_INDEX_PATH);
  if (existsSync(join(REPO_ROOT, "memory"))) addPaths.push("memory/");
  if (existsSync(join(REPO_ROOT, MEMORY_INDEX_PATH))) addPaths.push(MEMORY_INDEX_PATH);
  if (existsSync(join(REPO_ROOT, ENTITY_INDEX_PATH))) addPaths.push(ENTITY_INDEX_PATH);
  if (existsSync(join(REPO_ROOT, QA_INDEX_PATH))) addPaths.push(QA_INDEX_PATH);
  if (addPaths.length === 0) {
    console.log("nothing to aggregate (no raw_sessions, no memory)");
    return;
  }
  sh("git", ["add", ...addPaths]);
  const status = sh("git", ["status", "--porcelain"]);
  if (!status.trim()) {
    console.log("no changes to commit");
    return;
  }
  const msg = `memarium aggregate: ${keptRawPaths.length} raw_sessions, +${keptMemoryPaths.length} memory, +${keptEntityPaths.length} entities, +${keptQaPaths.length} qa across ${branches.length} device(s)`;
  sh("git", ["commit", "-m", JSON.stringify(msg)]);
  console.log(`committed: ${msg}`);
}

// ---------------- pruning ----------------

/**
 * Walk raw_sessions/ on main and remove any .md not in the kept set — the
 * cross-device raw_sessions aggregation's prune (P7). Sweeps now-empty parent
 * directories so a device retiring doesn't leave its <tool>/<project>/<date>/
 * skeleton behind.
 */
function pruneRawSessions(keptRawPaths) {
  const liveSet = new Set(keptRawPaths);
  const rawRoot = join(REPO_ROOT, "raw_sessions");
  if (!existsSync(rawRoot)) return;
  const dirsTouched = new Set();
  const stack = [rawRoot];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const rel = abs.slice(REPO_ROOT.length + 1);
        if (!liveSet.has(rel)) {
          rmSync(abs, { force: true });
          dirsTouched.add(dirname(abs));
        }
      }
    }
  }
  // Sweep empty dirs upward from each touched dir.
  for (const d of dirsTouched) {
    let cur = d;
    while (cur.startsWith(rawRoot) && cur !== rawRoot) {
      let entries = [];
      try { entries = readdirSync(cur); } catch { break; }
      if (entries.length > 0) break;
      try { rmSync(cur, { recursive: false, force: true }); } catch { break; }
      cur = dirname(cur);
    }
  }
}

main();
