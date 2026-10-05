#!/usr/bin/env bun
/**
 * inline-capture.ts — Per-message fact extraction
 *
 * Lightweight wrapper around fact-extractor for use in active conversation flows.
 * Called from memory-gate after memory injection decisions.
 *
 * Usage:
 *   bun inline-capture.ts --message "user message" --context "recent conversation context"
 *   bun inline-capture.ts --dry-run --message "..." --context "..."
 *
 * Exit codes:
 *   0 = facts extracted and stored (or would be stored in dry-run)
 *   0 = no facts to extract
 *   1 = error
 */

import { extractAndStoreFacts } from "./fact-extractor";

const MAX_CONTEXT_TOKENS = 3000; // ~12k chars, keeps inline fast

interface InlineOptions {
  message: string;
  context: string;
  source: string;
  persona: string;
  captureMode: "inline" | "batch";
  dryRun: boolean;
}

function parseArgs(): InlineOptions {
  const args = process.argv.slice(2);
  let message = "";
  let context = "";
  let source = "inline:unknown";
  let persona = "shared";
  let captureMode: "inline" | "batch" = "inline";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--message":
      case "-m":
        message = args[++i] || "";
        break;
      case "--context":
      case "-c":
        context = args[++i] || "";
        break;
      case "--source":
      case "-s":
        source = args[++i] || source;
        break;
      case "--persona":
      case "-p":
        persona = args[++i] || "shared";
        break;
      case "--batch":
        captureMode = "batch";
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  return { message, context, source, persona, captureMode, dryRun };
}

async function main() {
  const opts = parseArgs();

  if (!opts.message && !opts.context) {
    console.error("Usage: bun inline-capture.ts --message '...' --context '...' [--source x] [--dry-run]");
    process.exit(1);
  }

  // Build combined text: context first (recent), then message last
  // Reverse order so most recent context appears closest to the extraction trigger
  const combined = [opts.context.slice(-MAX_CONTEXT_TOKENS), opts.message]
    .filter(Boolean)
    .join("\n---\n");

  if (!combined.trim()) {
    process.exit(0);
  }

  const result = await extractAndStoreFacts(combined, {
    source: opts.source,
    persona: opts.persona,
    captureMode: opts.captureMode,
    dryRun: opts.dryRun,
  });

  if (result.stored.length > 0) {
    if (opts.dryRun) {
      console.log(`\n[inline-capture dry-run] Would store ${result.stored.length} facts from: ${opts.source}`);
      for (const f of result.stored) {
        console.log(`  ✓ [${f.entity}].${f.key} = "${f.value.slice(0, 60)}"`);
        console.log(`    ${f.decay_class} | ${f.category} | conf: ${f.confidence}`);
      }
    } else {
      console.log(`[inline-capture] Stored ${result.stored.length} facts (${result.duration_ms}ms)`);
    }
    process.exit(0);
  } else {
    if (opts.dryRun) {
      console.log(`[inline-capture dry-run] No extractable facts from: ${opts.source}`);
    }
    process.exit(0);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`[inline-capture error] ${err}`);
    process.exit(1);
  });
}
