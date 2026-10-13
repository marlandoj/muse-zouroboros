#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

const outputPath = process.argv[2];
if (!outputPath) {
  console.error("Usage: coding-cascade-preflight.ts <output.json>");
  process.exit(2);
}
// Zo Computer was retired on 2026-10-03 and no longer exists. The legacy
// /zo/ask transport probe (previously quarantined behind
// SF_EXEC_ZO_ASK_FALLBACK=1) has been removed entirely. This script is now a
// no-op that records the removal; the Zouroboros System is harness-only.
writeFileSync(
  outputPath,
  `${JSON.stringify({ zo_ask: "removed", reason: "Zo Computer retired 2026-10-03 — Zouroboros System is harness-only" }, null, 2)}\n`,
);
console.log("coding-cascade preflight skipped: Zo /zo/ask transport removed (harness-only)");
process.exit(0);
