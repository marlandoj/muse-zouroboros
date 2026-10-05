import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOutcomePolicy, type IntakeTicket } from "./dispatcher";

const priorPolicy = process.env.FACTORY_OUTCOME_POLICY_PATH;
const priorCatalog = process.env.FACTORY_OUTCOME_MODEL_CATALOG_PATH;
afterEach(() => {
  if (priorPolicy === undefined) delete process.env.FACTORY_OUTCOME_POLICY_PATH;
  else process.env.FACTORY_OUTCOME_POLICY_PATH = priorPolicy;
  if (priorCatalog === undefined) delete process.env.FACTORY_OUTCOME_MODEL_CATALOG_PATH;
  else process.env.FACTORY_OUTCOME_MODEL_CATALOG_PATH = priorCatalog;
});

const ticket: IntakeTicket = {
  linear_id: "linear-1", identifier: "ZOU-T", title: "test", description: "## Archetype\nbugfix",
  url: "", state: "Todo", labels: [], created_at: "2026-07-11", updated_at: "2026-07-11",
};

describe("outcome routing production integration", () => {
  it("loads only a promoted policy with a vendor-diverse chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "outcome-integration-"));
    try {
      const policyPath = join(dir, "policy.json");
      const catalogPath = join(dir, "catalog.json");
      writeFileSync(catalogPath, JSON.stringify([
        { model_id: "a:model", provider: "a", risk_cap: "high" },
        { model_id: "b:model", provider: "b", risk_cap: "high" },
      ]));
      writeFileSync(policyPath, JSON.stringify({
        schema: "zouroboros.outcome-routing-policy.v1", promoted_at: "2026-07-11T00:00:00Z", new_run_coverage: 0.97,
        routes: { '["bugfix","high"]': {
          route_key: "bugfix", risk_tier: "high", primary_model_id: "a:model", fallback_model_ids: ["b:model"],
          evidence: { primary_score: 0.2, primary_n: 30, shadow_compared: 30, shadow_agreement_lower: 0.6 },
        } },
      }));
      process.env.FACTORY_OUTCOME_POLICY_PATH = policyPath;
      process.env.FACTORY_OUTCOME_MODEL_CATALOG_PATH = catalogPath;
      expect(resolveOutcomePolicy(ticket, "high")?.model_id).toBe("a:model");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("stamps the promoted chain and exact join into the execution path", () => {
    const source = readFileSync(join(import.meta.dir, "swarm-exec.ts"), "utf8");
    expect(source).toContain("outcome-policy.applied");
    expect(source).toContain("exec.routing_join");
    expect(source).toContain("exactJoinId(joinIdentity)");
  });
});
