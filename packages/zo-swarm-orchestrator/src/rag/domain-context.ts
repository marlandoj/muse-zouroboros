/**
 * Domain Context Injection for Swarm Orchestrator
 *
 * Detects domain from task text/persona and fetches relevant operational
 * context from the memory system. This supplements RAG enrichment (SDK docs)
 * with domain-specific knowledge (service paths, production topology, etc.).
 *
 * Bridges the gap where PKA session briefings run at conversation level
 * but swarm-dispatched tasks don't carry that context.
 *
 * Customer-specific keyword lists belong in domain-context.local.json
 * (gitignored) — see DEFAULT_LOCAL_CONFIG_PATHS below. The public defaults
 * cover only generic verticals (zouroboros, infrastructure).
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getWorkspaceRoot } from 'zouroboros-core';

interface DomainDetection {
  domain: string | null;
  confidence: number;
  keywords: string[];
}

interface LocalContextConfig {
  domainKeywords?: Record<string, string[]>;
  replaceDefaults?: boolean;
}

const DEFAULT_LOCAL_CONFIG_PATHS = [
  process.env.ZOUROBOROS_DOMAIN_CONTEXT_CONFIG,
  `${process.cwd()}/domain-context.local.json`,
  `${homedir()}/.config/zouroboros/domain-context.local.json`,
].filter(Boolean) as string[];

const BUILT_IN_DOMAIN_KEYWORDS: Record<string, string[]> = {
  zouroboros: ['zouroboros', 'swarm', 'orchestrator', 'memory system', 'executor', 'seed eval', 'pipeline'],
  infrastructure: ['deploy', 'service', 'hosting', 'ci/cd', 'docker', 'nginx', 'ssl', 'dns'],
};

function loadLocalKeywords(): { keywords: Record<string, string[]>; replaceDefaults: boolean } {
  for (const path of DEFAULT_LOCAL_CONFIG_PATHS) {
    if (!existsSync(path)) continue;
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf-8')) as LocalContextConfig;
      return {
        keywords: cfg.domainKeywords || {},
        replaceDefaults: !!cfg.replaceDefaults,
      };
    } catch (err) {
      console.error(`[domain-context] Failed to load ${path}: ${(err as Error).message}`);
    }
  }
  return { keywords: {}, replaceDefaults: false };
}

const _local = loadLocalKeywords();
const DOMAIN_KEYWORDS: Record<string, string[]> = _local.replaceDefaults
  ? _local.keywords
  : { ...BUILT_IN_DOMAIN_KEYWORDS, ..._local.keywords };

export function detectDomain(taskText: string, persona?: string): DomainDetection {
  const lowerText = `${taskText} ${persona || ''}`.toLowerCase();

  let bestDomain: string | null = null;
  let bestScore = 0;
  let bestKeywords: string[] = [];

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const matched = keywords.filter(kw => lowerText.includes(kw));
    if (matched.length > bestScore) {
      bestScore = matched.length;
      bestDomain = domain;
      bestKeywords = matched;
    }
  }

  return {
    domain: bestDomain,
    confidence: bestScore > 0 ? Math.min(1, bestScore * 0.3) : 0,
    keywords: bestKeywords,
  };
}

/**
 * Fetches domain-specific operational context from the memory system.
 * Uses the memory CLI to search for relevant facts.
 */
export function fetchDomainContext(domain: string, keywords: string[]): string | null {
  const searchTerms = [...keywords, domain].join(' ');

  try {
    const result = spawnSync('bun', [
      join(getWorkspaceRoot(), 'Skills/zo-memory-system/scripts/memory.ts'),
      'hybrid',
      searchTerms,
      '--limit', '5',
    ], {
      timeout: 5000,
      encoding: 'utf-8',
      cwd: getWorkspaceRoot(),
    });

    if (result.status === 0 && result.stdout?.trim()) {
      return `## Domain Context (${domain})\n\n${result.stdout.trim()}\n\n---\n`;
    }
  } catch {
    // Non-blocking — proceed without domain context
  }

  return null;
}

/**
 * Enriches tasks with domain-specific context from the memory system.
 * Call this after RAG enrichment for comprehensive context injection.
 */
export function enrichTasksWithDomainContext(
  tasks: Array<{ id: string; task: string; persona?: string }>,
): { enrichedCount: number; domain: string | null } {
  if (tasks.length === 0) return { enrichedCount: 0, domain: null };

  // Detect domain from all task text combined for better signal
  const combinedText = tasks.map(t => t.task).join(' ');
  const combinedPersona = tasks.map(t => t.persona || '').join(' ');
  const detection = detectDomain(combinedText, combinedPersona);

  if (!detection.domain || detection.confidence < 0.3) {
    return { enrichedCount: 0, domain: null };
  }

  const context = fetchDomainContext(detection.domain, detection.keywords);
  if (!context) {
    return { enrichedCount: 0, domain: detection.domain };
  }

  let enrichedCount = 0;
  for (const task of tasks) {
    // Only inject if this task is relevant to the detected domain
    const taskDetection = detectDomain(task.task, task.persona);
    if (taskDetection.domain === detection.domain || detection.confidence >= 0.6) {
      task.task = context + task.task;
      enrichedCount++;
    }
  }

  return { enrichedCount, domain: detection.domain };
}
