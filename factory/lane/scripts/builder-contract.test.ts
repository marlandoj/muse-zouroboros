import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  builderCheckpointContract,
  isBuildArchetype,
  mayUseZoAskFallback,
} from "./builder-contract";

describe("factory builder contract", () => {
  test("classifies implementation archetypes", () => {
    for (const archetype of ["build", "bugfix", "feature", "fix", "implementation", "refactor"]) {
      expect(isBuildArchetype(archetype)).toBe(true);
    }
    expect(isBuildArchetype("research")).toBe(false);
  });

  test("never permits raw Zo fallback for build tickets", () => {
    expect(mayUseZoAskFallback("feature", { SF_EXEC_ZO_ASK_FALLBACK: "1" })).toBe(false);
    expect(mayUseZoAskFallback("research", { SF_EXEC_ZO_ASK_FALLBACK: "1" })).toBe(true);
    expect(mayUseZoAskFallback("research", {})).toBe(false);
    expect(mayUseZoAskFallback(undefined, { SF_EXEC_ZO_ASK_FALLBACK: "1" })).toBe(false);
  });

  test("requires harness tracking and durable sub-scope checkpoints", () => {
    const contract = builderCheckpointContract().join("\n");
    expect(contract).toContain("harness-tracked background execution");
    expect(contract).toContain("Commit each completed sub-scope");
    expect(contract).toContain("Never leave completed work only as untracked files");
  });

  test("both factory prompts consume the shared contract", () => {
    const source = readFileSync(join(import.meta.dir, "swarm-exec.ts"), "utf8");
    expect(source.match(/\.\.\.builderCheckpointContract\(\)/g)).toHaveLength(2);
    // de-Zo phase 2: the Zo fallback branch has been removed from swarm-exec.
    expect(source).not.toContain("mayUseZoAskFallback(ticketArchetype)");
    expect(source).not.toContain("api.zo.computer");
  });
});
