/**
 * Executor Selector — dynamic task→executor routing.
 *
 * Pure TypeScript heuristic (~5ms, zero API cost).
 * Replaces fixed executorId with intelligent best-fit routing.
 *
 * When a RoutingEngine is provided, Priority 4 uses 8-signal composite
 * scoring instead of simple tag matching.
 */

import type { Task, ExecutorRegistryEntry, ComplexityTier, BudgetSnapshot, HealthSnapshot } from '../types.js';
import type { RoutingEngine } from '../routing/engine.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Re-export from types.ts for backward compatibility
export type { BudgetSnapshot, HealthSnapshot } from '../types.js';

export interface ExecutorSelection {
  executorId: string;
  model?: string;
  confidence: number;
  reasoning: string;
  fallbacks: string[];
}

interface RoleResolution {
  executorId: string;
  model?: string;
}

/**
 * P1-3: Persona tool scope enforcement — registry-driven.
 *
 * Restrictions are declared on persona registry entries
 * (packages/swarm/assets/persona-registry.json, `forbiddenCapabilities`).
 * When a task carries a restricted persona, the selector excludes any
 * executor whose capabilities would give the persona access to the forbidden
 * toolset. Previously, persona restrictions (e.g. Financial Advisor "no
 * system tools") were advisory-only in prompt rules; the hardcoded map below
 * was the only mechanical enforcement. The registry is now the source of
 * truth; the map remains as a backwards-compat fallback for personas absent
 * from the registry.
 *
 * Fail-closed: a declared capability name the selector does not recognize
 * excludes the executor — its safety cannot be established (Art IX).
 * Personas absent from the registry (including harness labels like
 * "claude-code", which share the task.persona field) keep the previous
 * behavior of no restrictions, so routing never breaks on unknown names.
 */
const PERSONA_TOOL_RESTRICTIONS_FALLBACK: Record<string, string[]> = {
  "financial-advisor": ["shellExec", "fileWrite"],
};

/** Capability keys the selector understands (mirrors ExecutorCapabilities). */
const KNOWN_CAPABILITIES = new Set([
  "fileRead", "fileWrite", "shellExec", "webResearch", "imageGen", "mcp", "streaming",
]);

/** Harness names that are executor labels, not domain personas (mirrors bridge.ts). */
const HARNESS_LABELS = new Set([
  'codex', 'claude-code', 'hermes', 'gemini', 'kimi', 'opencode', 'pi',
  'codex-cli', 'claude code', 'hermes agent', 'gemini cli', 'codex cli',
  'kimi code cli', 'pi coding agent',
]);

interface RegistryPersonaEntry {
  id: string;
  name: string;
  forbiddenCapabilities?: string[];
}

let personaRegistryCache: RegistryPersonaEntry[] | null = null;

/** Load the persona registry once; empty on any failure (fail open to fallback). */
function loadPersonaRegistry(): RegistryPersonaEntry[] {
  if (personaRegistryCache !== null) return personaRegistryCache;
  let loaded: RegistryPersonaEntry[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const registryPath = join(here, '..', '..', 'assets', 'persona-registry.json');
    if (existsSync(registryPath)) {
      const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.personas || [];
      if (Array.isArray(list)) loaded = list;
    }
  } catch {
    loaded = [];
  }
  personaRegistryCache = loaded;
  return loaded;
}

/**
 * Resolve the forbidden capability names for a task persona: registry first,
 * hardcoded fallback second, none for harness labels / unknown names.
 * Exported for unit tests.
 */
export function resolvePersonaRestrictions(persona: string | undefined): string[] {
  if (!persona) return [];
  const normalized = persona.trim().toLowerCase();
  if (HARNESS_LABELS.has(normalized)) return [];
  const entry = loadPersonaRegistry().find(
    (p) => p.id?.toLowerCase() === normalized || p.name?.toLowerCase() === normalized,
  );
  if (entry && Array.isArray(entry.forbiddenCapabilities) && entry.forbiddenCapabilities.length > 0) {
    return entry.forbiddenCapabilities;
  }
  return PERSONA_TOOL_RESTRICTIONS_FALLBACK[normalized] ?? [];
}

/**
 * Check whether an executor's capabilities violate a persona's tool restrictions.
 * Returns a list of violating capability names (empty = clean). Unknown
 * capability names fail closed: the executor is excluded.
 */
function checkPersonaRestrictions(
  executor: ExecutorRegistryEntry,
  restrictedTools: string[],
): string[] {
  if (!restrictedTools.length || !executor.capabilities) return [];
  const violations: string[] = [];
  for (const tool of restrictedTools) {
    if (!KNOWN_CAPABILITIES.has(tool)) {
      violations.push(`${tool} (unknown capability — fail closed)`);
      continue;
    }
    if ((executor.capabilities as any)[tool]) {
      violations.push(tool);
    }
  }
  return violations;
}

const TAG_ROUTING: Record<string, string[]> = {
  'claude-code': ['reasoning', 'planning', 'architecture', 'system-design', 'complex', 'analysis'],
  'gemini': ['ui', 'frontend', 'visual', 'design', 'css', 'component', 'layout', 'prototyping'],
  'codex': ['backend', 'api', 'refactor', 'database', 'server', 'endpoint', 'migration'],
  'hermes': ['research', 'web', 'multi-platform', 'investigation', 'scraping', 'audit', 'review', 'memory', 'recall', 'institutional-history'],
  'opencode': ['vendor-neutral', 'model-comparison', 'multi-provider', 'provider-pinning'],
  'kimi': ['large-context', 'long-running', 'multimodal', 'moonshot', 'kimi'],
  'pi': ['focused', 'ephemeral', 'rapid-prototyping', 'provider-neutral', 'pi'],
};

const COST_RANKING = ['hermes', 'gemini', 'codex', 'claude-code', 'pi', 'kimi', 'opencode'];

const FALLBACK_CHAINS: Record<string, string[]> = {
  'claude-code': ['gemini', 'codex', 'hermes', 'pi'],
  'gemini': ['codex', 'claude-code', 'hermes', 'pi'],
  'codex': ['claude-code', 'gemini', 'hermes', 'pi'],
  'hermes': ['gemini', 'codex', 'claude-code', 'pi'],
  'opencode': ['pi', 'kimi', 'codex', 'claude-code'],
  'kimi': ['pi', 'opencode', 'gemini', 'claude-code'],
  'pi': ['gemini', 'opencode', 'kimi', 'codex', 'claude-code'],
};

export function inferComplexity(task: Task): ComplexityTier {
  const len = task.task.length;
  if (len < 100) return 'trivial';
  if (len < 300) return 'simple';
  if (len < 800) return 'moderate';
  return 'complex';
}

import { readSharedCatalog, selectShared } from '../routing/shared-catalog.js';

export function selectExecutor(
  task: Task,
  budget: BudgetSnapshot | null,
  health: HealthSnapshot,
  executors: ExecutorRegistryEntry[],
  roleResolution?: RoleResolution | null,
  routingEngine?: RoutingEngine | null,
): ExecutorSelection {
  if (task.executor === 'cursor') throw new Error('Cursor is retired from active selection');
  const availableIds = new Set(executors.map(e => e.id));

  // P1-3: Resolve persona tool restrictions from the registry (fallback: hardcoded
  // map) — exclude executors that give a restricted persona forbidden tools.
  const restrictedTools = resolvePersonaRestrictions(task.persona);
  let restrictedExecutors: Set<string> | undefined;
  if (restrictedTools.length > 0) {
    restrictedExecutors = new Set<string>();
    for (const e of executors) {
      const violations = checkPersonaRestrictions(e, restrictedTools);
      if (violations.length > 0) {
        restrictedExecutors.add(e.id);
        console.error(
          `[selector] persona "${task.persona}" forbids [${violations.join(",")}] — excluding executor "${e.id}"`
        );
      }
    }
  }

  const nativeCatalog=readSharedCatalog();
  const qualifiedHarnesses = new Set(selectShared('swarm',{catalog:nativeCatalog}).map(route => route.harness));
  if (nativeCatalog && (!task.executor || task.executor === 'auto')) {
    restrictedExecutors ??= new Set<string>();
    for (const id of availableIds) if (!qualifiedHarnesses.has(id) && id !== roleResolution?.executorId) restrictedExecutors.add(id);
    if (![...availableIds].some(id => !restrictedExecutors!.has(id) && health[id]?.state !== 'OPEN')) {
      throw new Error('No healthy, qualified native swarm harness is available');
    }
  }
  // Helper: filter fallback chain to registered, permitted, healthy executors.
  const safeFallbacks = (chain: string[]): string[] =>
    chain.filter(id => id !== 'cursor' && (!nativeCatalog || qualifiedHarnesses.has(id)) && availableIds.has(id) && !restrictedExecutors?.has(id) && health[id]?.state !== 'OPEN');

  // Priority 1: Explicit executorId in task (backward compat)
  if (task.executor && task.executor !== 'auto') {
    if (restrictedExecutors?.has(task.executor)) {
      console.error(
        `[selector] explicit executor "${task.executor}" blocked by persona restrictions — trying fallbacks`
      );
      const fallbacks = safeFallbacks(FALLBACK_CHAINS[task.executor] ?? []);
      if (fallbacks.length > 0) {
        return {
          executorId: fallbacks[0],
          confidence: 0.4,
          reasoning: `Explicit executor "${task.executor}" blocked by persona "${task.persona}" — falling back to "${fallbacks[0]}"`,
          fallbacks: fallbacks.slice(1),
        };
      }
      console.error(`[selector] no fallback available for blocked executor "${task.executor}"`);
    }
    return {
      executorId: task.executor,
      confidence: 1.0,
      reasoning: `Explicit executorId="${task.executor}" in task definition`,
      fallbacks: safeFallbacks(FALLBACK_CHAINS[task.executor] ?? []),
    };
  }

  // Priority 2: A healthy role binding is authoritative, even with composite routing enabled.
  if (roleResolution && availableIds.has(roleResolution.executorId) && !restrictedExecutors?.has(roleResolution.executorId)) {
    if (health[roleResolution.executorId]?.state !== 'OPEN') {
      return {
        executorId: roleResolution.executorId,
        model: roleResolution.model,
        confidence: 0.9,
        reasoning: `Resolved from healthy role binding`,
        fallbacks: safeFallbacks(FALLBACK_CHAINS[roleResolution.executorId] ?? []),
      };
    }
    const fallbacks = safeFallbacks(FALLBACK_CHAINS[roleResolution.executorId] ?? []);
    const fallback = fallbacks.find(id => availableIds.has(id) && health[id]?.state !== 'OPEN');
    if (fallback) {
      return {
        executorId: fallback,
        model: roleResolution.model,
        confidence: 0.6,
        reasoning: `Role executor "${roleResolution.executorId}" is unhealthy — falling back to "${fallback}"`,
        fallbacks: fallbacks.filter(id => id !== fallback),
      };
    }
  }

  // Priority 3: Budget override — if < 20% remaining, force cheapest (when no routing engine)
  if (!routingEngine && budget && budget.totalBudgetUSD > 0) {
    const remaining = budget.totalBudgetUSD - budget.totalSpentUSD;
    const pct = remaining / budget.totalBudgetUSD;
    if (pct < 0.20) {
      const cheapest = findCheapestHealthy(health, availableIds, restrictedExecutors);
      return {
        executorId: cheapest,
        confidence: 0.85,
        reasoning: `Budget at ${Math.round(pct * 100)}% — downgrading to cheapest executor "${cheapest}"`,
        fallbacks: safeFallbacks(FALLBACK_CHAINS[cheapest] ?? []),
      };
    }
  }

  // Priority 4: Composite routing via RoutingEngine (8-signal when available)
  if (routingEngine) {
    const complexity = inferComplexity(task);
    const decision = routingEngine.route(task, complexity, {
      budget,
      roleExecutorId: roleResolution?.executorId ?? null,
    });

    // P1-3: Check persona restrictions on routing engine decision
    if (restrictedExecutors?.has(decision.executorId)) {
      const fallbacks = safeFallbacks(FALLBACK_CHAINS[decision.executorId] ?? []);
      const fb = fallbacks.find(f => health[f]?.state !== 'OPEN' && availableIds.has(f));
      if (fb) {
        return {
          executorId: fb,
          confidence: 0.4,
          reasoning: `Routing engine selected "${decision.executorId}" but blocked by persona "${task.persona}" — falling back to "${fb}"`,
          fallbacks: fallbacks.filter(f => f !== fb),
        };
      }
      throw new Error('Routing decision is blocked and has no qualified permitted fallback');
    }

    // Check health — skip if circuit breaker open
    if (health[decision.executorId]?.state === 'OPEN') {
      const fallbacks = safeFallbacks(FALLBACK_CHAINS[decision.executorId] ?? []);
      const fallback = fallbacks.find(
        fb => health[fb]?.state !== 'OPEN' && availableIds.has(fb)
      );
      if (fallback) {
        return {
          executorId: fallback,
          confidence: 0.6,
          reasoning: `Primary "${decision.executorId}" circuit breaker OPEN — falling back to "${fallback}"`,
          fallbacks: fallbacks.filter(f => f !== fallback),
        };
      }
    }

    return {
      executorId: decision.executorId,
      model: roleResolution?.model,
      confidence: Math.min(0.95, decision.compositeScore),
      reasoning: `8-signal composite: score=${decision.compositeScore.toFixed(3)} via ${decision.method}`,
      fallbacks: safeFallbacks(FALLBACK_CHAINS[decision.executorId] ?? []),
    };
  }

  // Priority 4 fallback: Tag-based heuristic matching (legacy, no routing engine)
  const taskText = `${task.task} ${task.persona || ''} ${task.role || ''}`.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [executorId, tags] of Object.entries(TAG_ROUTING)) {
    if (!availableIds.has(executorId)) continue;
    // P1-3: skip executors restricted for this persona
    if (restrictedExecutors?.has(executorId)) continue;
    let score = 0;
    for (const tag of tags) {
      if (taskText.includes(tag)) score++;
    }
    scores[executorId] = score;
  }

  let bestId = 'claude-code';
  let bestScore = 0;
  for (const [id, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }

  // If all executors are restricted, fall back to the first unrestricted executor
  if (bestScore === 0 && restrictedExecutors) {
    for (const id of COST_RANKING) {
      if (availableIds.has(id) && !restrictedExecutors.has(id)) {
        bestId = id;
        break;
      }
    }
  }

  // Check health — skip if circuit breaker open
  if (health[bestId]?.state === 'OPEN') {
    const fallbacks = safeFallbacks(FALLBACK_CHAINS[bestId] ?? []);
    const fallback = fallbacks.find(
      fb => health[fb]?.state !== 'OPEN' && availableIds.has(fb)
    );
    if (fallback) {
      return {
        executorId: fallback,
        confidence: 0.6,
        reasoning: `Primary "${bestId}" circuit breaker OPEN — falling back to "${fallback}"`,
        fallbacks: fallbacks.filter(f => f !== fallback),
      };
    }
  }

  const confidence = bestScore > 0 ? Math.min(0.95, 0.5 + bestScore * 0.15) : 0.5;

  return {
    executorId: bestId,
    confidence,
    reasoning: bestScore > 0
      ? `Tag match: ${bestScore} tag(s) matched for "${bestId}"`
      : `No strong tag match — defaulting to "${bestId}"`,
    fallbacks: safeFallbacks(FALLBACK_CHAINS[bestId] ?? []),
  };
}

function findCheapestHealthy(health: HealthSnapshot, available: Set<string>, restrictedExecutors?: Set<string>): string {
  for (const id of COST_RANKING) {
    if (available.has(id) && health[id]?.state !== 'OPEN' && !restrictedExecutors?.has(id)) return id;
  }
  // Last resort: cheapest unrestricted executor (even if unhealthy)
  for (const id of COST_RANKING) {
    if (available.has(id) && !restrictedExecutors?.has(id)) return id;
  }
  return COST_RANKING[0];
}
