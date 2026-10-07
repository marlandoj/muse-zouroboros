#!/usr/bin/env bun
// cold-start-probe.ts — ZOU-485: independent held-out benchmark for never-before-seen
// models. Grades a provisional candidate BEFORE it has any production outcome samples.
//
// Hermetic / anti-Goodhart design:
//   • Probe set (references/cold-start-probe-set.json) is held out of any tuning corpus.
//   • Scoring is deterministic pattern-matching, NEVER LLM-judged — a candidate cannot
//     game a judge model.
//   • Runs in a minimal-env subprocess: only the candidate's provider key is exposed;
//     no other secrets, no workspace file reads beyond the probe set.
//   • Emits a per-candidate score artifact at ~/.zouroboros/cold-start-probes/<id>.json.
//
// Gate: candidates clearing the score threshold (default 0.6) advance to shadow
// promotion (ZOU-486). Below-threshold candidates are held/rejected.
//
// Usage:
//   bun cold-start-probe.ts probe [--model oc:glm-5.2] [--threshold 0.6] [--json]
//   bun cold-start-probe.ts show <modelId>
//   bun cold-start-probe.ts list [--json]
//
// Env: the candidate's provider API key (OPENCODE_API_KEY / SYNTHETIC_API_KEY /
//      OPENROUTER_API_KEY / KIMI_API_KEY) — only the matching provider key is read.
//      byok:<uuid> candidates route through /zo/ask instead (ZO_CLIENT_IDENTITY_TOKEN /
//      ZO_TOKEN), matching the catalog-byok probe + consensus-gate zo-byok direct route.

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { loadCandidates, getCandidate, updateCandidateStatus } from "./provisional-candidates";

const PROBE_SET_PATH = path.resolve(__dirname, "../references/cold-start-probe-set.json");
const PROBE_DIR = `${process.env.HOME}/.zouroboros/cold-start-probes`;
const DEFAULT_THRESHOLD = 0.6;
const OPENCODE_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

interface ProbeItem {
  id: string;
  prompt: string;
  expect: string[];
  category: string;
}

interface ProbeResultItem {
  itemId: string;
  category: string;
  response: string;
  correct: boolean;
}

interface ProbeArtifact {
  model: string;
  provider: string;
  scoredAt: string;
  threshold: number;
  score: number;
  correct: number;
  total: number;
  passed: boolean;
  items: ProbeResultItem[];
}

export function candidateProbeRouteId(candidate: Pick<ReturnType<typeof loadCandidates>[number], "id" | "provider">): string {
  return candidate.provider === "openrouter" && !candidate.id.startsWith("or:")
    ? `or:${candidate.id}`
    : candidate.id;
}

export function selectTargetedProvisionalCandidates(targets: string[]) {
  const targetSet = new Set(targets);
  return loadCandidates().filter(
    (candidate) => candidate.status === "provisional" && targetSet.has(candidateProbeRouteId(candidate)),
  );
}

function loadProbeSet(): ProbeItem[] {
  const raw = JSON.parse(fs.readFileSync(PROBE_SET_PATH, "utf-8"));
  return raw.items as ProbeItem[];
}

function scoreResponse(response: string, expect: string[]): boolean {
  const norm = response.toLowerCase().trim();
  return expect.some((e) => norm.includes(e.toLowerCase()));
}

export function providerForModel(model: string): { provider: string; endpoint: string; keyEnv: string; needsUa: boolean } {
  if (model.startsWith("byok:")) {
    // Zo BYOK configs have no direct vendor endpoint — they route through
    // /zo/ask with the workspace identity token, same as catalog-byok probes
    // and the consensus-gate zo-byok direct route.
    return { provider: "zo-byok", endpoint: "https://api.zo.computer/zo/ask", keyEnv: "ZO_CLIENT_IDENTITY_TOKEN", needsUa: false };
  }
  if (model.startsWith("oc:")) {
    return { provider: "opencode", endpoint: "https://opencode.ai/zen/v1/chat/completions", keyEnv: "OPENCODE_API_KEY", needsUa: true };
  }
  if (model.startsWith("hf:") || model.startsWith("syn:")) {
    return { provider: "synthetic", endpoint: "https://api.synthetic.new/openai/v1/chat/completions", keyEnv: "SYNTHETIC_API_KEY", needsUa: false };
  }
  if (model.startsWith("kimi:")) {
    return { provider: "kimi", endpoint: "https://api.moonshot.ai/v1/chat/completions", keyEnv: "KIMI_API_KEY", needsUa: false };
  }
  return { provider: "openrouter", endpoint: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY", needsUa: false };
}

export function modelForEndpoint(model: string): string {
  if (model.startsWith("byok:")) return model; // /zo/ask takes the full byok:<uuid> as model_name
  if (model.startsWith("oc:")) return model.slice(3);
  if (model.startsWith("or:")) return model.slice(3);
  if (model.startsWith("hf:")) return model;
  if (model.startsWith("kimi:")) return model.slice(5);
  return model;
}

async function runProbeOne(model: string, cfg: ReturnType<typeof providerForModel>, item: ProbeItem): Promise<ProbeResultItem> {
  const key = process.env[cfg.keyEnv] || (cfg.provider === "zo-byok" ? process.env.ZO_TOKEN : undefined);
  if (!key) throw new Error(`${cfg.keyEnv} not set for ${cfg.provider} probe`);
  if (cfg.provider === "zo-byok") {
    const resp = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { authorization: key, "content-type": "application/json" },
      body: JSON.stringify({ input: item.prompt, model_name: modelForEndpoint(model) }),
      signal: AbortSignal.timeout(180_000), // /zo/ask spawns a full session; slower than a raw vendor call
    });
    if (!resp.ok) throw new Error(`zo-byok HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 120)}`);
    const json: any = await resp.json();
    const text = (json?.output ?? "").toString();
    return { itemId: item.id, category: item.category, response: text.slice(0, 200), correct: scoreResponse(text, item.expect) };
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  if (cfg.needsUa) headers["User-Agent"] = OPENCODE_UA;
  const body = { model: modelForEndpoint(model), messages: [{ role: "user", content: item.prompt }], max_tokens: 256 };
  const resp = await fetch(cfg.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`${cfg.provider} HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 120)}`);
  const json: any = await resp.json();
  const choice = json?.choices?.[0];
  const content = (choice?.message?.content ?? "").toString();
  const reasoning = (choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? "").toString();
  const text = content || reasoning;
  return { itemId: item.id, category: item.category, response: text.slice(0, 200), correct: scoreResponse(text, item.expect) };
}

async function probeCandidate(model: string, threshold: number): Promise<ProbeArtifact> {
  const cfg = providerForModel(model);
  const items = loadProbeSet();
  const results: ProbeResultItem[] = [];
  for (const item of items) {
    try {
      results.push(await runProbeOne(model, cfg, item));
    } catch (e: any) {
      results.push({ itemId: item.id, category: item.category, response: `ERROR: ${e.message}`, correct: false });
    }
  }
  const correct = results.filter((r) => r.correct).length;
  const score = correct / items.length;
  const artifact: ProbeArtifact = {
    model, provider: cfg.provider, scoredAt: new Date().toISOString(),
    threshold, score, correct, total: items.length, passed: score >= threshold, items: results,
  };
  if (!fs.existsSync(PROBE_DIR)) fs.mkdirSync(PROBE_DIR, { recursive: true });
  const safe = model.replace(/[^a-z0-9._:-]/gi, "_");
  fs.writeFileSync(path.join(PROBE_DIR, `${safe}.json`), JSON.stringify(artifact, null, 2));
  updateCandidateStatus(model, score >= threshold ? "cold-start-passed" : "rejected", { coldStartScore: score });
  return artifact;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      model: { type: "string" },
      models: { type: "string" },
      threshold: { type: "string", default: String(DEFAULT_THRESHOLD) },
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0] ?? "probe";
  const threshold = parseFloat(values.threshold || String(DEFAULT_THRESHOLD));

  if (cmd === "show") {
    const model = positionals[1];
    if (!model) { console.error("Usage: show <modelId>"); process.exit(1); }
    const safe = model.replace(/[^a-z0-9._:-]/gi, "_");
    const p = path.join(PROBE_DIR, `${safe}.json`);
    if (!fs.existsSync(p)) { console.error(`No probe artifact for ${model}`); process.exit(1); }
    console.log(fs.readFileSync(p, "utf-8"));
    return;
  }

  if (cmd === "list") {
    if (!fs.existsSync(PROBE_DIR)) { console.log(values.json ? "[]" : "No probe artifacts yet."); return; }
    const files = fs.readdirSync(PROBE_DIR).filter((f) => f.endsWith(".json"));
    const arts = files.map((f) => JSON.parse(fs.readFileSync(path.join(PROBE_DIR, f), "utf-8")) as ProbeArtifact);
    if (values.json) { console.log(JSON.stringify(arts, null, 2)); return; }
    for (const a of arts) console.log(`${a.model.padEnd(28)} score=${a.score.toFixed(2)} ${a.passed ? "PASS" : "FAIL"} (${a.provider}, ${a.correct}/${a.total})`);
    return;
  }

  // cmd === "probe"
  if (values.all || values.models) {
    const candidates = values.models
      ? selectTargetedProvisionalCandidates(values.models.split(",").map((value) => value.trim()).filter(Boolean))
      : loadCandidates().filter((candidate) => candidate.status === "provisional");
    const artifacts: ProbeArtifact[] = [];
    for (const candidate of candidates) artifacts.push(await probeCandidate(candidate.id, threshold));
    if (values.json) console.log(JSON.stringify({ total: artifacts.length, artifacts }, null, 2));
    else if (!artifacts.length) console.log("No provisional candidates to probe.");
    else for (const artifact of artifacts) console.log(`${artifact.model} score=${artifact.score.toFixed(2)} ${artifact.passed ? "PASS" : "FAIL"}`);
    if (artifacts.some((artifact) => !artifact.passed)) process.exit(1);
    return;
  }
  if (!values.model) { console.error("Usage: probe --model <gateId>, probe --models <id,...>, or probe --all [--threshold 0.6] [--json]"); process.exit(1); }
  const cand = getCandidate(values.model);
  if (!cand) { console.error(`No provisional candidate for ${values.model}. Run 'provisional-candidates discover' first.`); process.exit(1); }
  const artifact = await probeCandidate(values.model, threshold);
  if (values.json) {
    console.log(JSON.stringify(artifact, null, 2));
  } else {
    console.log(`\nCold-start probe: ${values.model} (${artifact.provider})`);
    console.log(`Score: ${artifact.correct}/${artifact.total} = ${artifact.score.toFixed(2)}  (threshold ${threshold})`);
    console.log(artifact.passed ? "✅ PASSED — advances to shadow promotion (ZOU-486)." : "❌ FAILED — held/rejected.");
    for (const r of artifact.items) console.log(`  ${r.correct ? "✅" : "❌"} ${r.itemId.padEnd(10)} [${r.category}]  "${r.response.slice(0, 60)}"`);
  }
  process.exit(artifact.passed ? 0 : 1);
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
