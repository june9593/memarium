import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("agent contributor guides", () => {
  it("keeps AGENTS.md identical to the canonical CLAUDE.md", () => {
    const claude = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    expect(agents).toBe(claude);
  });
});
