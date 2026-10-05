#!/usr/bin/env bun
/**
 * Domain Classifier (T2 — PKA Session Briefing)
 * Classifies workspace files into knowledge domains via path heuristics.
 * Domains: ffb, jhf-trading, zouroboros, personal, infrastructure, shared
 */

import { Database } from "bun:sqlite";
import { parseArgs } from "util";

export type Domain = "ffb" | "jhf-trading" | "zouroboros" | "personal" | "infrastructure" | "shared";

interface DomainRule {
  domain: Domain;
  patterns: RegExp[];
}

export const DOMAIN_RULES: DomainRule[] = [
  {
    domain: "ffb",
    patterns: [
      /Skills\/ffb[-_]/i,
      /Notes\/FFB[_\/]/i,
      /fauna[-_]flora/i,
      /FFB[A-Z_]/,
      /Projects\/ffb\//i,
      /FAUNA_FLORA/i,
    ],
  },
  {
    domain: "jhf-trading",
    patterns: [
      /Projects\/jhf[-_]/i,
      /Skills\/backtesting[-_]/i,
      /Skills\/alpaca[-_]/i,
      /Skills\/alphavantage[-_]/i,
      /jackson[-_]heritage/i,
      /JHF[_\/]/,
      /Projects\/trading/i,
      /Investment_Analysis/i,
    ],
  },
  {
    domain: "zouroboros",
    patterns: [
      /Zouroboros\//i,
      /Skills\/zo[-_]/i,
      /Skills\/zouroboros/i,
      /Seeds\//i,
      /Skills\/autoloop\//i,
      /Skills\/spec[-_]first/i,
      /Skills\/three[-_]stage/i,
      /Skills\/unstuck/i,
      /Skills\/agent[-_]model[-_]healer/i,
    ],
  },
  {
    domain: "infrastructure",
    patterns: [
      /Infrastructure\//i,
      /Runbooks\//i,
      /Security\//i,
      /Scripts\//i,
      /\.zo\//,
      /Integrations\//i,
    ],
  },
  {
    domain: "personal",
    patterns: [
      /Documents\//i,
      /Notes\/(?!FFB)/i,
      /IDENTITY\//i,
      /Prompts\//i,
      /SOUL\.md$/i,
      /USER\.md$/i,
      /MEMORY\.md$/i,
    ],
  },
];

export function classifyDomain(filePath: string): Domain {
  for (const rule of DOMAIN_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(filePath)) {
        return rule.domain;
      }
    }
  }
  return "shared";
}

// --- CLI ---
if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      batch: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    console.log(`Usage:
  bun domain-classifier.ts <path>         Classify a single path
  bun domain-classifier.ts --batch        Classify all vault_files, print domain counts
  bun domain-classifier.ts --batch --json Output full classification as JSON`);
    process.exit(0);
  }

  if (values.batch) {
    const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.query("SELECT file_path FROM vault_files").all() as { file_path: string }[];
    db.close();

    const counts: Record<Domain, number> = {
      ffb: 0, "jhf-trading": 0, zouroboros: 0, personal: 0, infrastructure: 0, shared: 0,
    };
    const classified: { file_path: string; domain: Domain }[] = [];

    for (const row of rows) {
      const domain = classifyDomain(row.file_path);
      counts[domain]++;
      classified.push({ file_path: row.file_path, domain });
    }

    if (values.json) {
      console.log(JSON.stringify({ total: rows.length, counts, files: classified }, null, 2));
    } else {
      console.log(`Domain classification for ${rows.length} vault files:`);
      for (const [domain, count] of Object.entries(counts)) {
        const pct = ((count / rows.length) * 100).toFixed(1);
        console.log(`  ${domain.padEnd(16)} ${String(count).padStart(5)}  (${pct}%)`);
      }
    }
  } else if (positionals.length > 0) {
    const domain = classifyDomain(positionals[0]);
    console.log(domain);
  } else {
    console.error("Error: provide a file path or use --batch");
    process.exit(1);
  }
}
