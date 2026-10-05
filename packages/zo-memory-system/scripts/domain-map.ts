#!/usr/bin/env bun
/**
 * domain-map.ts — Single source of truth for persona→domain mapping
 *
 * All persona→domain lookups should import from this file.
 * Domains match those in domain-classifier.ts: ffb, jhf-trading, zouroboros, infrastructure, personal, shared
 */

import type { Domain } from "./domain-classifier.ts";

export type { Domain };

/**
 * Maps persona slugs (IDENTITY filenames without .md) to their primary domain.
 * Personas not listed here default to "shared".
 */
export const PERSONA_DOMAIN_MAP: Record<string, Domain> = {
  // ── FFB (Fauna & Flora Botanicals) ──
  "brand-guardian": "ffb",
  "community-ambassador": "ffb",
  "ecommerce-merchandising-manager": "ffb",
  "marketing-content-creator": "ffb",
  "marketing-growth-hacker": "ffb",
  "marketing-instagram-curator": "ffb",
  "marketing-pinterest-specialist": "ffb",
  "marketing-reddit-community-builder": "ffb",
  "marketing-social-media-strategist": "ffb",
  "marketing-tiktok-strategist": "ffb",
  "marketing-twitter-engager": "ffb",
  "twitter-engager": "ffb",
  "email-automation-flow-designer": "ffb",
  "loyalty-program-architect": "ffb",
  "customer-success-manager": "ffb",
  "customer-support-specialist": "ffb",
  "ugc-content-coordinator": "ffb",
  "social-proof-collector": "ffb",
  "subscription-retention-specialist": "ffb",
  "pr-launch-specialist": "ffb",
  "event-experience-designer": "ffb",
  "conversion-rate-optimizer": "ffb",
  "content-gap-analyst": "ffb",
  "technical-seo-auditor": "ffb",
  "local-seo-strategist": "ffb",
  "video-seo-specialist": "ffb",
  "voice-search-optimizer": "ffb",
  "analytics-insights-reporter": "ffb",
  "competitive-intelligence-analyst": "ffb",

  // ── JHF Trading / Finance ──
  "financial-advisor": "jhf-trading",
  "financial-modeling-analyst": "jhf-trading",
  "financial-research-analyst": "jhf-trading",
  "quantitative-developer": "jhf-trading",
  "portfolio-risk-manager": "jhf-trading",
  "algorithmic-trading-strategist": "jhf-trading",
  "tax-optimization-strategist": "jhf-trading",
  "retirement-planning-advisor": "jhf-trading",
  "estate-planning-advisor": "jhf-trading",
  "insurance-risk-advisor": "jhf-trading",

  // ── Zouroboros (System / Memory / Swarm / AI Engineering) ──
  "ai-engineer": "zouroboros",
  "agents-orchestrator": "zouroboros",
  "memory-manager": "zouroboros",
  "machine-learning-engineer": "zouroboros",
  "senior-developer": "zouroboros",
  "backend-architect": "zouroboros",
  "frontend-developer": "zouroboros",
  "rapid-prototyper": "zouroboros",
  "reality-checker": "zouroboros",
  "project-shepherd": "zouroboros",
  "data-engineer": "zouroboros",
  "database-optimization-specialist": "zouroboros",
  "performance-engineer": "zouroboros",
  "technical-writer": "zouroboros",
  "developer-advocate": "zouroboros",
  "open-source-maintainer": "zouroboros",
  "unstuck-architect": "zouroboros",
  "unstuck-contrarian": "zouroboros",
  "unstuck-hacker": "zouroboros",
  "unstuck-researcher": "zouroboros",
  "unstuck-simplifier": "zouroboros",

  // ── Infrastructure / DevOps / Security ──
  "devops-automator": "infrastructure",
  "site-reliability-engineer": "infrastructure",
  "platform-engineer": "infrastructure",
  "infrastructure-as-code-architect": "infrastructure",
  "incident-response-coordinator": "infrastructure",
  "cybersecurity-analyst": "infrastructure",
  "data-privacy-officer": "infrastructure",
  "api-integration-specialist": "infrastructure",
  "n8n-workflow-engineer": "infrastructure",
  "terminal-integration-specialist": "infrastructure",

  // ── Personal / General ──
  "alaric": "personal",

  // ── Specialized (shared — cross-domain) ──
  "hermes-agent": "shared",
  "senior-project-manager": "shared",
  "studio-operations": "shared",
  "studio-producer": "shared",
  "business-strategy-consultant": "shared",
  "operations-efficiency-consultant": "shared",
  "hr-culture-builder": "shared",
  "recruitment-talent-acquisition": "shared",
  "sales-enablement-coach": "shared",
  "account-executive": "shared",
  "salesforce-administrator": "shared",
  "solutions-architect": "shared",
  "partnerships-outreach-coordinator": "shared",
  "legal-compliance-checker": "shared",
  "product-feedback-synthesizer": "shared",
  "product-sprint-prioritizer": "shared",
  "product-trend-researcher": "shared",
  "experiment-tracker": "shared",
  "architectux": "shared",
  "ux-researcher": "shared",
  "ui-designer": "shared",
  "visual-storyteller": "shared",
  "whimsy-injector": "shared",
  "accessibility-auditor": "shared",
  "mobile-app-builder": "shared",
  "app-store-optimizer": "shared",
  "game-developer": "shared",
  "blockchain-smart-contract-developer": "shared",
  "embedded-systems-engineer": "shared",
  "iot-systems-architect": "shared",
  "robotics-engineer": "shared",
  "macos-spatial-metal-engineer": "shared",
  "visionos-spatial-engineer": "shared",
  "xr-cockpit-interaction-specialist": "shared",
};

/**
 * Multi-domain personas — these pull briefings from ALL listed domains
 * instead of a single domain. Used by session-briefing.ts for aggregated context.
 */
export const MULTI_DOMAIN_PERSONAS: Record<string, Domain[]> = {
  "alaric": ["zouroboros", "jhf-trading", "ffb", "infrastructure", "personal"],
};

/**
 * Look up the domain for a persona slug. Returns "shared" if not mapped.
 */
export function getPersonaDomain(personaSlug: string): Domain {
  return PERSONA_DOMAIN_MAP[personaSlug] || "shared";
}

/**
 * Get all domains for a multi-domain persona. Returns null if single-domain.
 */
export function getPersonaDomains(personaSlug: string): Domain[] | null {
  return MULTI_DOMAIN_PERSONAS[personaSlug] || null;
}

/**
 * Get all persona slugs for a given domain.
 */
export function getPersonasForDomain(domain: Domain): string[] {
  return Object.entries(PERSONA_DOMAIN_MAP)
    .filter(([_, d]) => d === domain)
    .map(([slug]) => slug);
}

/**
 * Default persona pool definitions. Used by setup-pools CLI command.
 */
export const DEFAULT_POOLS: { name: string; description: string; members: string[] }[] = [
  {
    name: "engineering",
    description: "Core engineering and system development personas",
    members: [
      "ai-engineer", "agents-orchestrator", "memory-manager", "senior-developer",
      "backend-architect", "frontend-developer", "data-engineer", "database-optimization-specialist",
      "performance-engineer", "machine-learning-engineer", "rapid-prototyper",
    ],
  },
  {
    name: "finance",
    description: "Financial advisory, trading, and analysis personas",
    members: [
      "financial-advisor", "financial-modeling-analyst", "financial-research-analyst",
      "quantitative-developer", "portfolio-risk-manager", "algorithmic-trading-strategist",
      "tax-optimization-strategist", "retirement-planning-advisor", "estate-planning-advisor",
    ],
  },
  {
    name: "ffb-ops",
    description: "Fauna & Flora Botanicals marketing, operations, and support",
    members: [
      "brand-guardian", "marketing-content-creator", "marketing-growth-hacker",
      "marketing-instagram-curator", "marketing-tiktok-strategist", "marketing-social-media-strategist",
      "email-automation-flow-designer", "customer-success-manager", "customer-support-specialist",
      "ecommerce-merchandising-manager", "subscription-retention-specialist",
      "technical-seo-auditor", "analytics-insights-reporter", "conversion-rate-optimizer",
    ],
  },
  {
    name: "infrastructure",
    description: "DevOps, SRE, security, and platform personas",
    members: [
      "devops-automator", "site-reliability-engineer", "platform-engineer",
      "infrastructure-as-code-architect", "incident-response-coordinator",
      "cybersecurity-analyst", "data-privacy-officer",
    ],
  },
  {
    name: "leadership",
    description: "Cross-domain personas that benefit from broad knowledge",
    members: [
      "alaric", "senior-project-manager", "business-strategy-consultant",
      "project-shepherd", "reality-checker", "solutions-architect",
    ],
  },
];

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cmd = process.argv[2];

  if (cmd === "lookup" && process.argv[3]) {
    console.log(getPersonaDomain(process.argv[3]));
  } else if (cmd === "list-domain" && process.argv[3]) {
    const personas = getPersonasForDomain(process.argv[3] as Domain);
    console.log(`${process.argv[3]}: ${personas.length} personas`);
    personas.forEach(p => console.log(`  ${p}`));
  } else if (cmd === "stats") {
    const counts: Record<string, number> = {};
    for (const domain of Object.values(PERSONA_DOMAIN_MAP)) {
      counts[domain] = (counts[domain] || 0) + 1;
    }
    console.log("Persona→Domain distribution:");
    for (const [domain, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${domain.padEnd(16)} ${count}`);
    }
    console.log(`  ${"TOTAL".padEnd(16)} ${Object.keys(PERSONA_DOMAIN_MAP).length}`);
  } else if (cmd === "pools") {
    for (const pool of DEFAULT_POOLS) {
      console.log(`[${pool.name}] ${pool.description} (${pool.members.length} members)`);
      pool.members.forEach(m => console.log(`  ${m}`));
    }
  } else {
    console.log(`Usage:
  bun domain-map.ts lookup <persona-slug>     Get domain for a persona
  bun domain-map.ts list-domain <domain>      List personas in a domain
  bun domain-map.ts stats                     Show distribution
  bun domain-map.ts pools                     Show default pool definitions`);
  }
}
