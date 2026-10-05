import { compareAblation, selectShadowAblation, staleAssumptions, validateRegistry, type AssumptionRegistry, type AblationSample } from "./harness-assumptions";

let failures = 0;
const check = (name: string, pass: boolean) => { if (!pass) failures++; console.log(`${pass ? "PASS" : "FAIL"} ${name}`); };
const registry: AssumptionRegistry = { schema_version: 1, assumptions: [{
  id: "cheap-probe", statement: "probe helps", owner: "factory", evidence: ["trace"], model_generation: "v1",
  estimated_cost_usd: 0, review_date: "2026-01-01", risk: "low", domains: ["routing"],
}] };
check("valid registry", validateRegistry(registry).length === 0);
check("stale assumption surfaced", staleAssumptions(registry, new Date("2026-07-11T00:00:00Z")).length === 1);
check("low-risk assumption selected", selectShadowAblation(registry, new Date("2026-07-11T00:00:00Z"))?.id === "cheap-probe");

const unsafe = structuredClone(registry);
unsafe.assumptions[0].domains = ["security"];
check("security domain requires forbidden risk", validateRegistry(unsafe).some((e) => e.includes("must be forbidden")));
const timestampDate = structuredClone(registry);
timestampDate.assumptions[0].review_date = "2026-10-01T00:00:00Z";
check("review date requires YYYY-MM-DD", validateRegistry(timestampDate).some((e) => e.includes("YYYY-MM-DD")));
let unsafeBlocked = false;
try { compareAblation({ ...unsafe.assumptions[0], risk: "forbidden" }, [], []); } catch { unsafeBlocked = true; }
check("forbidden domain cannot be ablated", unsafeBlocked);

const sample = (quality: number, cost: number, latency: number, rework = false): AblationSample => ({ quality, cost_usd: cost, latency_ms: latency, rework });
const underpowered = compareAblation(registry.assumptions[0], [sample(1, 1, 100)], [sample(1, 0.5, 80)]);
check("underpowered comparison cannot decide", underpowered.decision === "insufficient_data");
const removal = compareAblation(registry.assumptions[0], Array(5).fill(sample(1, 1, 100)), Array(5).fill(sample(1, 0.5, 80)));
check("safe improvement recommends remove", removal.decision === "remove" && removal.rollback.includes("restore assumption"));

process.exit(failures === 0 ? 0 : 1);
