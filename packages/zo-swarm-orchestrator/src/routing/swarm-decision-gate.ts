#!/usr/bin/env bun

/**
 * Swarm Decision Gate — determines whether a task warrants formal swarm orchestration
 *
 * Pure TypeScript heuristic (~5ms, zero API cost). Evaluates 7 weighted signals
 * to score task complexity and parallelism potential.
 *
 * Exit codes:
 *   0 = SWARM — engage full swarm pipeline (score > 0.45 or FORCE override)
 *   2 = DIRECT — skip swarm, execute directly (score < 0.30)
 *   3 = SUGGEST — recommend swarm but proceed direct (score 0.30–0.45)
 *   1 = error
 *
 * Usage:
 *   bun swarm-decision-gate.ts "<user message>"
 *   bun swarm-decision-gate.ts --json "<user message>"
 *   bun swarm-decision-gate.ts --help
 */

// ─── Signal weights (must sum to 1.0) ───────────────────────────────────────

const WEIGHTS = {
  parallelism:          0.20,
  scopeBreadth:         0.15,
  qualityGates:         0.15,
  crossDomain:          0.15,
  deliverableComplexity: 0.15,
  mutationRisk:         0.10,
  durationSignal:       0.10,
} as const;

// ─── Thresholds ─────────────────────────────────────────────────────────────

const THRESHOLD_SWARM  = 0.45;
const THRESHOLD_SUGGEST = 0.30;
const BIAS_DIRECT_PENALTY = 0.15;

// ─── Override detection ─────────────────────────────────────────────────────

const FORCE_SWARM_PATTERNS = [
  /\buse\s+swarm\s+orchestrat/i,
  /\buse\s+swarm\b(?!\s+(bench|decision|gate|orchestrator|system))/i,
  /\bswarm\s+this\b/i,
  /\brun\s+(it\s+)?through\s+(the\s+)?swarm\b/i,
  /\bengage\s+(the\s+)?swarm\b/i,
  /\bfull\s+swarm\s+pipeline\b/i,
  /\bswarm\s+execution\b/i,
  /\bthrough\s+(the\s+)?swarm\s+pipeline\b/i,
];

// Questions about swarm should NOT trigger force override
const SWARM_QUESTION_PATTERNS = [
  /\bhow\s+(has|did|does|do|will|would|can|could|should)\b.*\bswarm\b/i,
  /\bwhat\s+(is|are|was|were|does|did)\b.*\bswarm\b/i,
  /\bswarm.*(changed|work|function|operate|look|mean)/i,
  /\b(run|test|bench|validate|verify)\s+(a\s+)?swarm.?bench\b/i,
];

const BIAS_DIRECT_PATTERNS = [
  /\bjust\s+(quickly?\s+)?/i,
  /\bquick(ly)?\b/i,
  /\bsimple\b/i,
  /\breal\s+quick\b/i,
  /\bjust\s+do\b/i,
];

function detectOverride(msg: string): "force_swarm" | "bias_direct" | null {
  // Questions about swarm are never force overrides
  for (const p of SWARM_QUESTION_PATTERNS) {
    if (p.test(msg)) return null;
  }
  for (const p of FORCE_SWARM_PATTERNS) {
    if (p.test(msg)) return "force_swarm";
  }
  for (const p of BIAS_DIRECT_PATTERNS) {
    if (p.test(msg)) return "bias_direct";
  }
  return null;
}

// ─── Signal scorers (each returns 0.0–1.0) ──────────────────────────────────

function scoreParallelism(msg: string): number {
  const lower = msg.toLowerCase();
  let score = 0;

  // Multiple action verbs separated by connectors
  const actionVerbs = lower.match(/\b(implement|build|create|deploy|analyze|research|test|write|fix|update|migrate|refactor|evaluate|audit|review|generate|design|integrate|configure|setup|install|digest|catalogue|catalog|compare|compile|identify|scan|index|map|extract|aggregate|prioritize|cross.?reference|transform|produce|deliver|send|compose|assess|profile|optimize|draft|publish|merge|document|benchmark|consolidate|reconfigure|ingest)\b/g);
  const uniqueVerbs = new Set(actionVerbs || []);
  if (uniqueVerbs.size >= 5) score += 0.5;
  else if (uniqueVerbs.size >= 4) score += 0.4;
  else if (uniqueVerbs.size >= 3) score += 0.3;
  else if (uniqueVerbs.size >= 2) score += 0.15;

  // Conjunctions suggesting parallel work
  const conjunctions = (lower.match(/\b(and then|and also|as well as|plus|along with|additionally|meanwhile|in parallel|concurrently|simultaneously)\b/g) || []).length;
  if (conjunctions >= 2) score += 0.3;
  else if (conjunctions >= 1) score += 0.15;

  // "each" / "every" / "all" + plural noun implies iterative parallel work
  if (/\b(each|every)\s+\w+/i.test(lower) && uniqueVerbs.size >= 2) score += 0.15;

  // Numbered/bulleted lists
  if (/(?:\d+[\.\)]\s|\-\s|\*\s).*(?:\d+[\.\)]\s|\-\s|\*\s)/s.test(msg)) score += 0.2;

  // Multiple phases/waves/steps mentioned
  if (/\b(phase|wave|stage|step)\s*\d/i.test(msg)) score += 0.1;

  // Numeric quantity indicators ("9 components", "21 tests", "3 strategies")
  const numericItems = lower.match(/\b(\d+)\s+(component|route|page|test|endpoint|feature|strateg|module|package|service|worker|agent|skill|step|task|item|asset|model|transport|adapter|check|function|method|hook|rule|seed|wave|domain)s?\b/g) || [];
  const totalNumericItems = numericItems.reduce((sum, m) => {
    const n = parseInt(m);
    return sum + (isNaN(n) ? 0 : n);
  }, 0);
  if (totalNumericItems >= 10) score += 0.5;
  else if (totalNumericItems >= 5) score += 0.4;
  else if (totalNumericItems >= 3) score += 0.3;
  else if (totalNumericItems >= 2) score += 0.2;

  // Comma-separated named items (e.g., "ExecutorTransport, BridgeTransport, ACPTransport")
  // Look for 3+ capitalized/technical terms separated by commas
  const commaSeparated = msg.match(/(?:[A-Z][\w]+(?:Transport|Layer|Module|Service|Strategy|Gate|Client|Provider|Manager|Handler|Worker|Adapter|Bridge|Plugin|Hook|System)?(?:\s+\w+)?\s*,\s*){2,}[A-Z][\w]+/g) || [];
  if (commaSeparated.length > 0) score += 0.3;

  // Comma-separated lowercase features (e.g., "domain tagging, cross-persona promotion, memory-gate skip")
  const commaFeatures = lower.match(/(?:[\w\s-]+,\s+){2,}(?:and\s+)?[\w\s-]+/g) || [];
  const featureCount = commaFeatures.reduce((sum, m) => sum + m.split(/,/).length, 0);
  if (featureCount >= 4) score += 0.3;
  else if (featureCount >= 3) score += 0.2;

  return Math.min(score, 1.0);
}

function scoreScopeBreadth(msg: string): number {
  const lower = msg.toLowerCase();
  let score = 0;

  // File/path references
  const fileRefs = (msg.match(/(?:\/[\w\-\.]+){2,}|[\w\-]+\.(ts|js|py|yaml|json|md|sh|tsx|jsx|css|html)/g) || []).length;
  if (fileRefs >= 5) score += 0.4;
  else if (fileRefs >= 3) score += 0.25;
  else if (fileRefs >= 1) score += 0.1;

  // Multiple systems/domains referenced
  const domains = [
    /\b(database|db|sql|postgres|sqlite|duckdb|schema|migration)\b/,
    /\b(api|endpoint|route|server|backend|handler)\b/,
    /\b(ui|frontend|component|page|dashboard|react)\b/,
    /\b(deploy|hosting|service|docker|ci|cd|pipeline|production)\b/,
    /\b(memory|recall|episodic|procedural)\b/,
    /\b(test|spec|benchmark|eval|coverage)\b/,
    /\b(email|sms|notification|alert|report|pdf)\b/,
    /\b(auth|security|token|credential)\b/,
    /\b(swarm|orchestrat|executor|agent)\b/,
    /\b(git|repo|repository|codebase|branch|pr|commit)\b/,
    /\b(skill|plugin|hook|pattern|architecture)\b/,
    /\b(ecosystem|system|platform|framework)\b/,
    /\b(blog|social|content|marketing|post|article|media)\b/,
    /\b(npm|package|publish|release|changelog|version)\b/,
  ];
  const domainHits = domains.filter(d => d.test(lower)).length;
  if (domainHits >= 4) score += 0.4;
  else if (domainHits >= 3) score += 0.3;
  else if (domainHits >= 2) score += 0.15;

  // "across" / "entire" / "whole" / "all" scope amplifiers
  if (/\b(across|entire|whole|all|every|full|comprehensive|end.to.end)\b/i.test(lower)) score += 0.2;

  // Migration / abstraction signals suggest touching multiple layers
  if (/\b(migrat|abstract|transport|layer|adapter)\b/i.test(lower)) score += 0.15;

  // Multiple named entities to compare/research (e.g., "MAGMA, MemEvolve, and Supermemory")
  const namedEntities = msg.match(/[A-Z][\w-]*(?:\s+[A-Z][\w-]*)*/g) || [];
  const uniqueEntities = new Set(namedEntities.filter(e => e.length > 2));
  if (uniqueEntities.size >= 4) score += 0.3;
  else if (uniqueEntities.size >= 3) score += 0.2;

  return Math.min(score, 1.0);
}

function scoreQualityGates(msg: string): number {
  const lower = msg.toLowerCase();
  let score = 0;

  // Explicit quality requirements
  const qualityTerms = [
    /\b(test|tests|testing|tsc|typecheck|lint|build)\b/,
    /\b(acceptance\s+criteria|ac\b|criteria)\b/,
    /\b(verify|validate|confirm|check|ensure|assert)\b/,
    /\b(eval|evaluat|benchmark|score|metric)\b/,
    /\b(review|audit|inspect|post.?flight)\b/,
    /\b(ci|cd|pipeline|green|passing)\b/,
  ];
  const qualityHits = qualityTerms.filter(t => t.test(lower)).length;
  if (qualityHits >= 3) score += 0.5;
  else if (qualityHits >= 2) score += 0.3;
  else if (qualityHits >= 1) score += 0.15;

  // Structured output expectations
  if (/\b(report|pdf|document|summary|matrix|roadmap|checklist)\b/i.test(lower)) score += 0.25;

  // Multiple deliverable types
  if (/\b(email|send|deliver)\b/i.test(lower) && /\b(report|pdf|document)\b/i.test(lower)) score += 0.25;

  return Math.min(score, 1.0);
}

function scoreCrossDomain(msg: string): number {
  const lower = msg.toLowerCase();
  let score = 0;

  // Executor type signals
  const executorSignals = [
    /\b(research|investigate|explore|deep\s+dive|analyze|compare)\b/,    // research executor
    /\b(implement|code|build|refactor|fix|write\s+code|migrate|abstract)\b/, // code executor
    /\b(design|ui|ux|visual|layout|wireframe|dashboard)\b/,              // design executor
    /\b(deploy|publish|host|service|production|release)\b/,              // ops executor
    /\b(test|benchmark|eval|validate|verify)\b/,                         // qa executor
    /\b(document|report|write.up|summarize|blog|pr\b|readme)\b/,        // writing executor
    /\b(social|marketing|content|campaign|newsletter|announce)\b/,       // content executor
    /\b(configur|setup|provision|register|bootstrap|architect)\b/,       // infra executor
  ];
  const executorHits = executorSignals.filter(s => s.test(lower)).length;
  if (executorHits >= 4) score += 0.5;
  else if (executorHits >= 3) score += 0.35;
  else if (executorHits >= 2) score += 0.2;

  // Explicit multi-agent / delegation language
  if (/\b(subagent|delegate|parallel\s+agent|multi.?agent|specialist)\b/i.test(lower)) score += 0.3;

  // Cross-system integration
  if (/\b(integrate|integration|connect|bridge|sync)\b/i.test(lower)) score += 0.2;

  return Math.min(score, 1.0);
}

function scoreDeliverableComplexity(msg: string): number {
  const lower = msg.toLowerCase();
  let score = 0;

  // Multiple output artifacts
  const artifacts = [
    /\b(report|pdf)\b/,
    /\b(email|send)\b/,
    /\b(code|implement|script)\b/,
    /\b(deploy|publish|site|page)\b/,
    /\b(diagram|chart|visual)\b/,
    /\b(database|schema|migration)\b/,
    /\b(config|configuration|setup)\b/,
    /\b(test|spec|benchmark)\b/,
    /\b(seed|yaml|spec)\b/,
    /\b(pr|pull\s+request|commit)\b/,
    /\b(blog\s+post|article|post|readme|documentation|guide)\b/,
    /\b(social|assets|media|banner|image)\b/,
    /\b(announcement|newsletter|campaign)\b/,
  ];
  const artifactHits = artifacts.filter(a => a.test(lower)).length;
  if (artifactHits >= 4) score += 0.5;
  else if (artifactHits >= 3) score += 0.35;
  else if (artifactHits >= 2) score += 0.2;

  // Structured format requirements
  if (/\b(matrix|roadmap|checklist|plan|inventory|catalogue|catalog)\b/i.test(lower)) score += 0.25;

  // Multi-step delivery chain
  if (/\b(then|after|finally|once\s+done|when\s+complete|followed\s+by)\b/i.test(lower)) score += 0.25;

  return Math.min(score, 1.0);
}

function scoreMutationRisk(msg: string): number {
  const lower = msg.toLowerCase();
  let score = 0;

  // Production-affecting changes
  if (/\b(production|prod|live|deploy|publish|release)\b/i.test(lower)) score += 0.3;

  // Multiple file mutations
  if (/\b(refactor|migrate|rename|restructure|rewrite|overhaul)\b/i.test(lower)) score += 0.3;

  // Service/infrastructure changes
  if (/\b(service|server|database|schema|migration|config)\b/i.test(lower) &&
      /\b(update|change|modify|create|delete|remove)\b/i.test(lower)) score += 0.2;

  // Shared state / cross-boundary
  if (/\b(shared|cross.?boundary|multi.?process|env\s+var|global)\b/i.test(lower)) score += 0.2;

  return Math.min(score, 1.0);
}

function scoreDuration(msg: string): number {
  const lower = msg.toLowerCase();
  let score = 0;

  // Word count as proxy for task complexity
  const wordCount = msg.split(/\s+/).length;
  if (wordCount > 150) score += 0.3;
  else if (wordCount > 80) score += 0.2;
  else if (wordCount > 40) score += 0.1;

  // Explicit time/effort indicators
  if (/\b(comprehensive|thorough|deep|exhaustive|complete|full|three.stage|end.to.end)\b/i.test(lower)) score += 0.25;

  // Architectural / systemic effort
  if (/\b(migrat|pipeline|architecture|abstraction|transport|dashboard|framework)\b/i.test(lower)) score += 0.15;

  // Multiple phases or iterations
  if (/\b(phase|iteration|sprint|cycle|round|pass)\b/i.test(lower)) score += 0.25;

  // "all" / "every" / "each" amplifiers suggesting exhaustive work
  if (/\b(all|every|each)\b/i.test(lower) && wordCount > 20) score += 0.2;

  return Math.min(score, 1.0);
}

// ─── Archetype detection ──────────────────────────────────────────────────────
// Recognizes common task patterns that are inherently SWARM/SUGGEST-worthy
// even if individual signal scores are modest. Returns a bonus 0.0–0.35.

function scoreArchetypes(msg: string): number {
  const lower = msg.toLowerCase();
  let bonus = 0;

  // Pattern: "implement/build X with/including [feature], [feature], [feature], and [feature]"
  // Multi-feature implementation with comma-separated capabilities
  if (/\b(implement|build|create|develop|add)\b.*\b(with|including|featuring)\b.*,.*,/i.test(lower)) {
    const commaCount = (lower.match(/,/g) || []).length;
    if (commaCount >= 3) bonus += 0.4;
    else bonus += 0.3;
  }

  // Pattern: numeric scale indicators — "N components", "N routes", "N tests"
  const numericMatches = lower.match(/\b\d+\s+\w+/g) || [];
  const numericValues = numericMatches.map(m => parseInt(m)).filter(n => !isNaN(n) && n >= 2);
  const totalNumericScale = numericValues.reduce((a, b) => a + b, 0);
  if (numericValues.length >= 2 && totalNumericScale >= 10) bonus += 0.35;
  else if (numericValues.length >= 2 || totalNumericScale >= 8) bonus += 0.3;
  else if (totalNumericScale >= 5) bonus += 0.25;
  else if (totalNumericScale >= 3) bonus += 0.15;

  // Pattern: migration/abstraction — always multi-layer
  if (/\b(migrat|abstract)/i.test(lower) && /\b(from\b.*\bto\b|layer|client|model|system)\b/i.test(lower)) bonus += 0.25;

  // Pattern: multi-entity comparison/research
  if (/\b(compare|versus|vs\.?|evaluate|research)\b/i.test(lower)) {
    const entities = lower.split(/,|\band\b/).length;
    if (entities >= 4) bonus += 0.3;
    else if (entities >= 3) bonus += 0.25;
    else if (entities >= 2) bonus += 0.15;
  }

  // Pattern: dashboard/page with multiple sub-components
  if (/\b(dashboard|page|site|app)\b/i.test(lower) && /\b(route|component|endpoint|api|widget|panel|section)\b/i.test(lower)) bonus += 0.2;

  // Pattern: pipeline with email/PDF delivery at the end
  if (/\b(email|send|deliver)\b/i.test(lower) && /\b(pdf|report|summary)\b/i.test(lower) &&
      /\b(analyz|research|evaluat|audit|review|implement|build|deploy|test)\b/i.test(lower)) bonus += 0.2;

  // Pattern: publish/release pipeline with multiple packages/artifacts
  if (/\b(publish|release)\b/i.test(lower) && /\b(all|every|multiple|packages?)\b/i.test(lower)) bonus += 0.2;

  // Pattern: PR/commit + generalization/refactor + registry/community
  if (/\b(pr|pull\s+request)\b/i.test(lower) && /\b(skill|plugin|tool|package)\b/i.test(lower) &&
      /\b(communit|registr|upstream|open.?source)\b/i.test(lower)) bonus += 0.2;

  // Pattern: evaluation/audit with structured methodology
  if (/\b(three.stage|full|comprehensive)\b/i.test(lower) && /\b(eval|audit|review|assessment)\b/i.test(lower)) bonus += 0.2;

  // Pattern: set up / configure + architecture decision
  if (/\b(set\s*up|configure|architect)\b/i.test(lower) && /\b(bridge|architecture|pattern|framework|bot)\b/i.test(lower)) bonus += 0.15;

  // Pattern: blog/content creation (multi-step pipeline)
  // Pattern: blog/content creation (multi-step pipeline: strategist → writer → humanizer + 3 route updates)
  if (/\b(blog\s+post|write\s+a\s+blog|create\s+a?\s*blog|draft\s+a?\s*blog|publish\s+a?\s*blog)\b/i.test(lower)) bonus += 0.45;

  return Math.min(bonus, 0.45); // Cap archetype bonus
}

// ─── Main scoring engine ────────────────────────────────────────────────────

interface SwarmDecision {
  decision: "SWARM" | "DIRECT" | "SUGGEST" | "FORCE_SWARM";
  score: number;
  signals: Record<string, number>;
  weightedSignals: Record<string, number>;
  override: "force_swarm" | "bias_direct" | null;
  reason: string;
  directive: string;
  performanceMs: number;
}

function evaluate(msg: string): SwarmDecision {
  const start = performance.now();

  const override = detectOverride(msg);

  // Score all signals
  const signals = {
    parallelism:           scoreParallelism(msg),
    scopeBreadth:          scoreScopeBreadth(msg),
    qualityGates:          scoreQualityGates(msg),
    crossDomain:           scoreCrossDomain(msg),
    deliverableComplexity: scoreDeliverableComplexity(msg),
    mutationRisk:          scoreMutationRisk(msg),
    durationSignal:        scoreDuration(msg),
  };

  // Compute weighted score
  const weightedSignals: Record<string, number> = {};
  let totalScore = 0;
  for (const [key, value] of Object.entries(signals)) {
    const weight = WEIGHTS[key as keyof typeof WEIGHTS];
    const weighted = value * weight;
    weightedSignals[key] = Number(weighted.toFixed(4));
    totalScore += weighted;
  }

  // Density bonus: short messages with multiple active signals are high-complexity
  const wordCount = msg.split(/\s+/).length;
  const activeSignals = Object.values(signals).filter(v => v > 0).length;
  if (wordCount <= 25 && activeSignals >= 3) {
    totalScore *= 1.5;
  } else if (wordCount <= 40 && activeSignals >= 4) {
    totalScore *= 1.4;
  } else if (wordCount <= 40 && activeSignals >= 3) {
    totalScore *= 1.3;
  }

  // Archetype boost: common task patterns that are inherently complex
  const archetypeBoost = scoreArchetypes(msg);
  totalScore += archetypeBoost;

  // Apply bias
  if (override === "bias_direct") {
    totalScore = Math.max(0, totalScore - BIAS_DIRECT_PENALTY);
  }

  totalScore = Number(totalScore.toFixed(4));

  // Decision
  let decision: SwarmDecision["decision"];
  let reason: string;
  let directive: string;

  if (override === "force_swarm") {
    decision = "FORCE_SWARM";
    reason = "User explicitly requested swarm orchestration — override engaged.";
    directive = buildDirective("SWARM", totalScore, signals);
  } else if (totalScore >= THRESHOLD_SWARM) {
    decision = "SWARM";
    const topSignals = Object.entries(weightedSignals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k);
    reason = `Score ${totalScore.toFixed(2)} exceeds SWARM threshold (${THRESHOLD_SWARM}). Top signals: ${topSignals.join(", ")}.`;
    directive = buildDirective("SWARM", totalScore, signals);
  } else if (totalScore >= THRESHOLD_SUGGEST) {
    decision = "SUGGEST";
    reason = `Score ${totalScore.toFixed(2)} in SUGGEST range (${THRESHOLD_SUGGEST}–${THRESHOLD_SWARM}). Swarm may add value but isn't required.`;
    directive = buildDirective("SUGGEST", totalScore, signals);
  } else {
    decision = "DIRECT";
    reason = `Score ${totalScore.toFixed(2)} below DIRECT threshold (${THRESHOLD_SUGGEST}). Direct execution is appropriate.`;
    directive = "";
  }

  const performanceMs = Number((performance.now() - start).toFixed(1));

  return { decision, score: totalScore, signals, weightedSignals, override, reason, directive, performanceMs };
}

function buildDirective(mode: "SWARM" | "SUGGEST", score: number, signals: Record<string, number>): string {
  const topSignal = Object.entries(signals).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  if (mode === "SWARM") {
    return [
      `[Swarm Decision Gate: SWARM — score ${score.toFixed(2)}]`,
      "This task warrants formal swarm orchestration. Engage the full pipeline:",
      "1. Spec Interview → produce seed YAML with tasks, ACs, DAG, exit conditions",
      "2. Seed Eval Gate → validate paths, schemas, DAG conflicts",
      "3. User Approval → present seed for sign-off before execution",
      "4. DAG Execution → dispatch through swarm orchestrator",
      "5. Post-Flight Eval → 3-stage evaluation (mechanical, AC, consensus)",
      "6. Gap Audit → reachability, data prereqs, cross-boundary, eval-production parity",
      `Primary driver: ${topSignal}`,
    ].join("\n");
  }

  return [
    `[Swarm Decision Gate: SUGGEST — score ${score.toFixed(2)}]`,
    "This task could benefit from swarm orchestration but doesn't strictly require it.",
    `Primary signal: ${topSignal}. Consider whether the task has independent workstreams`,
    "that would benefit from parallel execution and structured quality gates.",
    "Proceeding with direct execution. User can override with 'use swarm orchestration'.",
  ].join("\n");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`swarm-decision-gate — Determines whether a task warrants swarm orchestration

Usage:
  bun swarm-decision-gate.ts "<user message>"
  bun swarm-decision-gate.ts --json "<user message>"

Exit codes:
  0  SWARM or FORCE_SWARM — engage full swarm pipeline
  2  DIRECT — skip swarm, execute directly
  3  SUGGEST — swarm recommended but not required
  1  Error

Signals (7, weighted):
  parallelism           (20%)  Multiple independent workstreams
  scopeBreadth          (15%)  Files/systems/domains touched
  qualityGates          (15%)  Structured validation needed
  crossDomain           (15%)  Multiple executor types required
  deliverableComplexity (15%)  Multiple output artifacts
  mutationRisk          (10%)  Production/shared state changes
  durationSignal        (10%)  Estimated effort/complexity

Thresholds:
  > 0.60  SWARM    — full pipeline mandatory
  0.35–0.60  SUGGEST — recommended, proceed direct
  < 0.35  DIRECT   — direct execution

Overrides:
  "use swarm" / "swarm this"  → FORCE_SWARM (bypass scoring)
  "just" / "quick" / "simple" → BIAS_DIRECT (penalty -0.15)`);
    process.exit(0);
  }

  const jsonMode = args.includes("--json");
  const flagIndices = new Set<number>();
  const jsonIdx = args.indexOf("--json");
  if (jsonIdx !== -1) flagIndices.add(jsonIdx);

  const message = args.filter((_, idx) => !flagIndices.has(idx)).join(" ");

  if (!message) {
    console.error("No message provided.");
    process.exit(1);
  }

  const result = evaluate(message);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.directive) {
      console.log(result.directive);
      console.log(`\n[gate] decision=${result.decision} score=${result.score} override=${result.override || "none"} ${result.performanceMs}ms`);
    } else {
      console.log(`[Swarm Decision Gate: ${result.decision} — score ${result.score.toFixed(2)}]`);
      console.log(result.reason);
      console.log(`[gate] ${result.performanceMs}ms`);
    }
  }

  // Exit codes
  switch (result.decision) {
    case "SWARM":
    case "FORCE_SWARM":
      process.exit(0);
    case "DIRECT":
      process.exit(2);
    case "SUGGEST":
      process.exit(3);
  }
}

main();
