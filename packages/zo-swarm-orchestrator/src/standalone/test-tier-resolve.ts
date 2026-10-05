#!/usr/bin/env bun

import { $ } from "bun";

const SCRIPT = "/home/workspace/Skills/zo-swarm-orchestrator/scripts/tier-resolve.ts";

interface TestCase {
  prompt: string;
  expectTier: string;
  expectTaskType: string;
  expectComboNot?: string[];
  expectComboOneOf?: string[];
  label: string;
}

const cases: TestCase[] = [
  {
    label: "Trivial general: time question",
    prompt: "What time is it in Arizona",
    expectTier: "trivial",
    expectTaskType: "general",
    expectComboOneOf: ["light", "swarm-light"],
    expectComboNot: ["heavy", "swarm-heavy", "failover", "swarm-failover", "mid", "swarm-mid"],
  },
  {
    label: "Trivial general: greeting",
    prompt: "Hello how are you",
    expectTier: "trivial",
    expectTaskType: "general",
    expectComboOneOf: ["light", "swarm-light"],
    expectComboNot: ["heavy", "swarm-heavy", "failover", "swarm-failover"],
  },
  {
    label: "Trivial general: weather",
    prompt: "What is the weather like today",
    expectTier: "trivial",
    expectTaskType: "general",
    expectComboOneOf: ["light", "swarm-light"],
    expectComboNot: ["heavy", "swarm-heavy", "failover", "swarm-failover"],
  },
  {
    label: "Trivial coding: simple fix",
    prompt: "fix the typo in README.md",
    expectTier: "trivial",
    expectTaskType: "documentation",
    expectComboOneOf: ["light", "swarm-light"],
    expectComboNot: ["heavy", "swarm-heavy", "failover", "swarm-failover"],
  },
  {
    label: "Simple review: review + diff + check (v2: multiple analysis signals)",
    prompt: "review this function and check the diff for issues",
    expectTier: "simple",
    expectTaskType: "review",
    expectComboOneOf: ["light", "swarm-light"],
    expectComboNot: ["heavy", "swarm-heavy", "failover", "swarm-failover"],
  },
  {
    label: "Moderate: debug + grep + review",
    prompt: "debug the auth flow, then grep for the error handler and review the fix",
    expectTier: "moderate",
    expectTaskType: "debugging",
    expectComboNot: ["failover", "swarm-failover"],
  },
  {
    label: "Complex: full audit across files",
    prompt: "analyse the codebase, then run git diff, review all /src/utils.ts /src/index.ts /src/config.ts /src/router.ts files and audit for security issues",
    expectTier: "complex",
    expectTaskType: "analysis",
  },
  {
    label: "Trivial general: capital question",
    prompt: "What is the capital of France",
    expectTier: "trivial",
    expectTaskType: "general",
    expectComboOneOf: ["light", "swarm-light"],
    expectComboNot: ["heavy", "swarm-heavy", "failover", "swarm-failover", "mid", "swarm-mid"],
  },
  {
    label: "Trivial general: math",
    prompt: "What is 2 + 2",
    expectTier: "trivial",
    expectTaskType: "general",
    expectComboOneOf: ["light", "swarm-light"],
    expectComboNot: ["heavy", "swarm-heavy", "failover", "swarm-failover"],
  },
  {
    label: "Moderate planning: architecture design (v2 concept + planning detection)",
    prompt: "plan and design a new microservice architecture for the payment system",
    expectTier: "moderate",
    expectTaskType: "planning",
    expectComboNot: ["failover", "swarm-failover"],
  },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const tc of cases) {
  const result = await $`bun ${SCRIPT} --json ${tc.prompt}`.text();
  let data: any;
  try {
    data = JSON.parse(result);
  } catch {
    console.log(`❌ ${tc.label}: PARSE ERROR`);
    console.log(`   Output: ${result.slice(0, 200)}`);
    failed++;
    failures.push(`${tc.label}: JSON parse error`);
    continue;
  }

  const tier = data.complexity?.tier;
  const taskType = data.complexity?.inferredTaskType;
  const resolved = data.resolvedCombo;
  const errs: string[] = [];

  if (tier !== tc.expectTier) errs.push(`tier: got "${tier}", expected "${tc.expectTier}"`);
  if (taskType !== tc.expectTaskType) errs.push(`taskType: got "${taskType}", expected "${tc.expectTaskType}"`);
  if (tc.expectComboOneOf && !tc.expectComboOneOf.includes(resolved)) {
    errs.push(`combo: got "${resolved}", expected one of [${tc.expectComboOneOf.join(", ")}]`);
  }
  if (tc.expectComboNot) {
    for (const bad of tc.expectComboNot) {
      if (resolved === bad) errs.push(`combo must NOT be "${bad}", but got "${resolved}"`);
    }
  }

  if (errs.length === 0) {
    console.log(`✅ ${tc.label} → ${resolved} (tier=${tier}, type=${taskType})`);
    passed++;
  } else {
    console.log(`❌ ${tc.label} → ${resolved} (tier=${tier}, type=${taskType})`);
    for (const e of errs) console.log(`   ${e}`);
    failed++;
    failures.push(`${tc.label}: ${errs.join("; ")}`);
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${cases.length} total`);
if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
