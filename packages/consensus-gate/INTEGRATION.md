# Consensus Gate — Zouroboros Integration

## Status: Phase 1 LIVE; Profile Valve SHADOW-READY (2026-07-11)

The consensus gate is **active in production**. It validates every procedure evolution in the Zouroboros memory pipeline before committing to `shared-facts.db`.

The Fast-to-Flagship profile valve is available to opt-in advisory callers. Flagship remains authoritative during calibration; no enforcement caller defaults to Fast.

---

## Architecture

```
evolveProcedure() or draftCandidate()
    ↓
execSync("consensus-gate.ts validate ...")
    ↓
Parallel fan-out to 3 models on synthetic.new
    ↓
Merged verdict → JSON on stdout
    ↓
  ✅ Unanimous  pass  → Save immediately
  ⚠️ Split       verdict → Log warning, proceed (graceful degradation)
  ❌ Unanimous   fail   → Reject + throw with issue list
```

---

## Model Lineup (synthetic.new)

| Vendor | Model | Role | Why |
|---|---|---|---|
| Zhipu | `hf:zai-org/GLM-5.2` | Coherence + implementation quality | Frontier reasoning, excels at code structure |
| Moonshot | `hf:moonshotai/Kimi-K2.6` | Edge cases + security + perf | Deep context window, thorough analysis |
| MiniMax | `hf:MiniMaxAI/MiniMax-M3` | Architectural consistency + cross-concerns | Balanced reasoning, good JSON compliance |

**Fallback:** If `SYNTHETIC_API_KEY` is missing, models fall through to Zo `/zo/ask` proxy. This degrades to the prior Claude/GPT/Gemini lineup.

---

## Provider Failover (OpenRouter → Opencode Zen)

synthetic.new is the **primary** provider. When it returns an empty or errored
verdict for a model (vendor-side degradation — empty body, `API error:`, or
`Call failed:`), the gate transparently **fails over to the same model**, first on
**OpenRouter**, then on **Opencode Zen**, using the first good verdict. synthetic.new
stays primary; the failovers only fire on failure, so vendor outages no longer
poison the consensus.

```
callVendor(model, prompt)
    ↓
synthetic.new  (primary)
    ↓ verdict empty / errored?  ──no──→  use it
    ↓ yes
OpenRouter  (same model, ID-mapped)
    ↓ verdict empty / errored?  ──no──→  use it
    ↓ yes
Opencode Zen  (same model, ID-mapped)
    ↓ verdict empty / errored?  ──no──→  use it
    ↓ yes
return synthetic's original verdict (preserve error context)
```

**Model ID mapping** — `hf:org/Model` (synthetic) → `org/model` slug (OpenRouter),
lowercased, with org aliases (`zai-org`→`z-ai`, `minimaxai`→`minimax`). Example:
`hf:zai-org/GLM-5.2` → `z-ai/glm-5.2`. Opencode Zen uses bare, org-less lowercase
slugs: `hf:zai-org/GLM-5.2` → `oc:glm-5.2` (the `oc:` prefix is stripped in the
request body). The `xai:` (grok) rung routes to x.ai directly and has no OpenRouter
or Opencode equivalent, so it does not fail over. The `kimi:` namespace routes
directly to Kimi API Platform at `api.moonshot.ai`; its prefix is stripped before
the OpenAI-compatible request is sent.

| Env var | Default | Effect |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required for OpenRouter failover; if absent, that hop is skipped |
| `CG_OPENROUTER_FAILOVER` | on | Set to `"0"` to disable the OpenRouter hop |
| `OPENCODE_API_KEY` | — | Required for Opencode Zen failover; if absent, that hop is skipped |
| `CG_OPENCODE_FAILOVER` | on | Set to `"0"` to disable the Opencode hop (e.g. balance exhausted) |
| `KIMI_API_KEY` | — | Required for direct `kimi:` models from Kimi API Platform |

**Sole-provider order** — with no `SYNTHETIC_API_KEY`, the gate uses OpenRouter
as the sole provider; with neither synthetic nor OpenRouter keys, it uses Opencode
Zen as the sole provider. When all vendor keys are absent, the gate still falls
through to the Zo `/zo/ask` proxy as before.

**Billed cost** — OpenRouter (`usage.cost`, requested with `usage:{include:true}`)
and Opencode Zen (top-level `cost`) both return a real per-call cost. The gate
records that figure verbatim in `cost_ledger` (`rate_source=<provider>-billed`,
`estimated=0`) rather than a token estimate.

---

## Phase 1: Procedure Evolution (ACTIVE)

**Location:** `zouroboros/packages/memory/src/standalone/memory.ts` → `evolveProcedure()` (line ~1103)

**Behavior:** After the LLM generates a new procedure step but before saving to `shared-facts.db`, exec the consensus gate. Unanimous failure blocks the evolution with a descriptive error. Split verdicts log a warning but proceed (soft gate — avoids deadlock on model disagreement).

```typescript
// Resolve the gate CLI relative to this repo checkout (packages/consensus-gate).
const consensusGatePath = "packages/consensus-gate/scripts/consensus-gate.ts";
const stepCode = JSON.stringify(validSteps, null, 2);

const validationOutput = execSync(
  `bun "${consensusGatePath}" validate --code ${JSON.stringify(stepCode)} --criteria "correctness,consistency,security" --label "procedure-${procedureName}-v${current.version + 1}"`,
  { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
);

const validationResult = JSON.parse(validationOutput);

if (validationResult.consensus.pass === false) {
  const issues = validationResult.verdicts
    .flatMap((v: any) => v.issues || [])
    .join("; ");
  throw new Error(
    `Consensus gate rejected evolved procedure: ${issues || "multiple concerns from vendors"}`
  );
}

if (validationResult.consensus.pass === null) {
  console.warn(`⚠️ Split verdict on procedure evolution: ${validationResult.status}`);
  console.warn(`   Disagreement details logged to consensus-gate.log`);
  console.warn(`   Procedure ID for audit: ${validationResult.id}`);
}
```

**Key design decisions:**
- **`proc.stdout.write`** used internally (not `console.log`) so `execSync` receives clean JSON
- **`try/catch` wrapper** around entire gate block: `ENOENT` (script missing), script crashes, or API timeout → warn + proceed (gate is a safety layer, not a hard blocker)
- **Unanimous-fail-only rejection** — split verdicts log but don't block. This avoids deadlock where GLM-5.2 is cautious and MiniMax is permissive. (Mimir escalation was considered for Phase 2 but Mimir has since been retired; splits escalate to the operator.)

---

## Lineup Selection Taxonomy

MoA and Consensus selection separates three questions:

1. **Role** — `deep-reasoning`, `coding`, `fast`, or `judge`.
2. **Capability tier** — frontier, strong, efficient, or experimental evidence status.
3. **Weight policy** — `any`, `open-only`, or `closed-only`.

Open versus closed weights is a deployment constraint, not a capability role. The same coding, fast, reasoning, or judge role can therefore be filled by either model class when its benchmark and health evidence qualify it.

```bash
# Build and persist an open-weight coding lineup.
bun packages/consensus-gate/scripts/lineup-picker.ts \
  --role coding \
  --weights open-only \
  --json

# Prove every selected route and schema before sending review content.
GATE_LINEUP_ROLE=coding \
GATE_LINEUP_WEIGHT_POLICY=open-only \
bun packages/consensus-gate/scripts/consensus-gate.ts preflight
```

Runtime precedence is `CONSENSUS_MODELS` → canonical role/weight selection → legacy profile preset → default panel. Explicit canonical selections fail closed when their persisted artifact is absent, stale, unhealthy, or schema-invalid.

Legacy translations remain available during migration: `flagship` → deep-reasoning/any, `coder` → coding/any, `open-weights` → deep-reasoning/open-only, and `fast` → fast/any.

---

## Profile Escalation Valve: Advisory Shadow (OPT-IN)

**First consumer:** `packages/bench/adapters/zourobench-adapter.ts` through `--profile-valve-shadow`.

For low-confidence benchmark judgments, the adapter can run Fast and Flagship sequentially with isolated `GATE_LINEUP_PROFILE` environments. Shadow mode records the comparison and returns Flagship, so downstream correctness semantics stay unchanged. Existing `--consensus-gate` behavior remains the default when the new flag is absent.

ZouroBench model coverage is synchronized in the opposite direction by
`scripts/zourobench-lineup-roster.ts`. It reads the current catalog-backed picker,
last-good persisted profiles, and the governed promotion target list, deduplicates
routes by canonical model identity, and writes
`packages/bench/data/zourobench/lineup-model-roster.json`. The bounded runner at
`packages/bench/scripts/lineup-model-bench.ts` advances one replicate per cycle
until a comparable five-run cohort is available for proposer/aggregator ranking.

| Control | Default | Effect |
|---|---|---|
| `--profile-valve-shadow` | off | Route eligible advisory judge calls through the profile valve in shadow mode |
| `--judge-confidence-threshold` | `0.7` | Invoke the configured advisory consensus path below this confidence |
| `PROFILE_ESCALATION_MIN_CONFIDENCE` | `0.8` | Fast-result escalation threshold inside the valve |
| `PROFILE_ESCALATION_MIN_SAMPLES` | `100` | Trusted promotion sample floor; artifacts cannot lower it |
| `PROFILE_ESCALATION_ARTIFACT_MAX_AGE_HOURS` | `24` | Artifact lifetime and maximum age of the latest shadow canary |
| `PROFILE_ESCALATION_LEDGER` | `~/.zouroboros/profile-escalation-shadow.jsonl` | Append-only comparison ledger |

Promotion to conditional Fast authority requires an artifact generated from the current ledger:

```bash
bun packages/consensus-gate/scripts/profile-escalation-promotion.ts \
  --min-days 7 \
  --min-samples 100 \
  --json
```

Eligibility requires at least seven distinct UTC observation days, the trusted comparable-sample floor, zero severe Flagship misses, one consistent current panel-fingerprint pair, and no malformed ledger rows. The artifact includes the ledger digest and ordered lineup fingerprints; any new shadow row or lineup change makes it stale. It also expires unless a fresh comparable shadow canary exists. Missing or invalid promotion evidence downgrades enforce mode back to shadow.

---

## Skill Crystallization (PLANNED)

**Where:** `zouroboros/packages/selfheal/src/crystallize/orchestrate.ts` → `orchestrateScan()` (before sending approval email)

Not yet wired. Will validate the SKILL.md body + generated scripts before emailing approval. Split verdicts will add a ⚠️ note to the email body. Unanimous rejections will reject the candidate immediately.

---

## Phase 3: Pre-merge CI Gate (PLANNED)

**Where:** GitHub Actions workflow `.github/workflows/ci.yml`

Not yet wired. Concept: run consensus gate on PR diff, fail CI on unanimous rejection.

---

## Logging & Audit

### Database
All raw results: `~/.zouroboros/consensus-gate.json` (JSON array)

### Append-only log
`~/.zouroboros/consensus-gate.log` — JSON Lines:

```json
{
  "timestamp": "2026-05-07T23:40:00Z",
  "consensus_id": "cg-1778197717312-7ox03j",
  "label": "procedure-xyz-step-4",
  "status": "split",
  "api": "synthetic.new",
  "verdict": {
    "pass": null,
    "confidence": 0.83,
    "models": {
      "hf:zai-org/GLM-5.2": { "pass": true, "issues": [] },
      "hf:moonshotai/Kimi-K2.6": { "pass": true, "issues": [] },
      "hf:MiniMaxAI/MiniMax-M3": { "pass": false, "issues": ["missing null-check"] }
    }
  }
}
```

Query recent unanimous rejections:
```bash
grep '"status":"rejected"' ~/.zouroboros/consensus-gate.log | tail -10
```

Query split verdicts:
```bash
grep '"status":"split"' ~/.zouroboros/consensus-gate.log | tail -5
```

---

## Runtime Fidelity Check

Run this anytime to verify the gate works end-to-end:

```bash
cd packages/consensus-gate   # repo root
bun scripts/consensus-gate.ts validate \
  --code "function risky(a) { eval(a); }" \
  --criteria "security,correctness" \
  --label "integration-test"
```

Expected: **REJECTED** with issues like "unsafe eval usage".

---

## Cost & Latency

| Metric | Value | Notes |
|---|---|---|
| Per validation | $0 (keyed) | SYNTHETIC_API_KEY covers usage |
| Failover spend | Provider-billed | Only when synthetic degrades and an OpenRouter/Opencode hop serves the call; real `cost` recorded to `cost_ledger` |
| Fallback latency | 15–45s | Zo `/zo/ask` proxy path |
| Direct latency | 6–12s | Synthetic.new parallel calls |
| Cadence | On every procedure evolution | Every zouroboros auto-shard triggers ~1 gate |
| p50 daily cost | $0 | No ephemeral per-call charges on the primary path |

---

## Known Model Quirks

| Model | Quirk | Mitigation |
|---|---|---|
| GLM-5.2 | Returns output in `reasoning_content`, not `content` | Script checks both fields |
| Kimi-K2.6 | Occasionally verbose even with `temperature: 0.2` | JSON regex extraction handles fences |
| MiniMax-M3 | Non-deterministic on trivial code (sometimes over-analyzes `x*2`) | Split verdict is soft, not blocking |

---

## Future Work

1. ~~**Mimir escalation** for split verdicts~~ — Mimir has been retired; splits escalate to the operator (Marlando).
2. **Skill crystallization gate** (Phase 2) — validate `SKILL.md` body before approval.
3. **CI gate** (Phase 3) — run on PR diffs.
4. **Retry with fewer models** if synthetic.new is rate-limiting (429).

---

## Related Skills

- `packages/consensus-gate/SKILL.md` — full skill documentation
- `packages/consensus-gate/scripts/consensus-gate.ts` — runnable implementation
- `agent-doctor` — diagnose scheduled agents
- Three-stage-eval — pre-swarm validation
