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
 * (packages/zo-swarm-orchestrator/assets/persona-registry.json, `forbiddenCapabilities`).
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
 * Harness labels like "claude-code" (which share the task.persona field)
 * carry no restrictions. Unknown persona names fail closed: the selector
 * throws rather than routing an unrecognized persona unrestricted —
 * register the persona (with explicit forbiddenCapabilities, possibly
 * empty) or use a harness label.
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
 * hardcoded fallback second. Harness labels (executor names, not personas)
 * carry no restrictions. Unknown names fail closed: the selector refuses to
 * route rather than silently running an unrecognized persona unrestricted.
 * Exported for unit tests.
 */
export function resolvePersonaRestrictions(persona: string | undefined): string[] {
  if (!persona) return [];
  const normalized = persona.trim().toLowerCase();
  if (HARNESS_LABELS.has(normalized)) return [];
  const entry = loadPersonaRegistry().find(
    (p) => p.id?.toLowerCase() === normalized || p.name?.toLowerCase() === normalized,
  );
  if (entry) {
    return Array.isArray(entry.forbiddenCapabilities) ? entry.forbiddenCapabilities : [];
  }
  if (normalized in PERSONA_TOOL_RESTRICTIONS_FALLBACK) {
    return PERSONA_TOOL_RESTRICTIONS_FALLBACK[normalized];
  }
  throw new Error(
    `Unknown persona "${persona}": not a harness label, not in the persona registry, ` +
    `and not in the fallback map. Refusing to route unrestricted. ` +
    `Add the persona to packages/zo-swarm-orchestrator/assets/persona-registry.json ` +
    `(with explicit forbiddenCapabilities, possibly empty) or use a harness label.`,
  );
}

/**
 * An executor is routable only when its health is explicitly CLOSED or
 * HALF_OPEN. Missing health data fails closed: unknown health is not
 * routable. (Previously, missing health was treated as healthy because
 * `undefined !== 'OPEN'`.)
 */
function isHealthy(entry: { state: string } | undefined): boolean {
  return entry?.state === 'CLOSED' || entry?.state === 'HALF_OPEN';
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
    if (![...availableIds].some(id => !restrictedExecutors!.has(id) && isHealthy(health[id]))) {
      throw new Error('No healthy, qualified native swarm harness is available');
    }
  }
  // Helper: filter fallback chain to registered, permitted, healthy executors.
  const safeFallbacks = (chain: string[]): string[] =>
    chain.filter(id => id !== 'cursor' && (!nativeCatalog || qualifiedHarnesses.has(id)) && availableIds.has(id) && !restrictedExecutors?.has(id) && isHealthy(health[id]));

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
    // Governance 2026-10-14: explicit executor with missing/unhealthy status
    // fails closed — fall back to healthy alternatives rather than routing blind.
    if (!isHealthy(health[task.executor])) {
      const fallbacks = safeFallbacks(FALLBACK_CHAINS[task.executor] ?? []);
      if (fallbacks.length > 0) {
        console.error(
          `[selector] explicit executor "${task.executor}" not healthy — falling back to "${fallbacks[0]}"`
        );
        return {
          executorId: fallbacks[0],
          confidence: 0.4,
          reasoning: `Explicit executor "${task.executor}" not healthy — falling back to "${fallbacks[0]}"`,
          fallbacks: fallbacks.slice(1),
        };
      }
      throw new Error(
        `Explicit executor "${task.executor}" is not healthy and has no healthy fallbacks. ` +
        `Refusing to route to an executor with unknown or unhealthy status.`,
      );
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
    if (isHealthy(health[roleResolution.executorId])) {
      return {
        executorId: roleResolution.executorId,
        model: roleResolution.model,
        confidence: 0.9,
        reasoning: `Resolved from healthy role binding`,
        fallbacks: safeFallbacks(FALLBACK_CHAINS[roleResolution.executorId] ?? []),
      };
    }
    const fallbacks = safeFallbacks(FALLBACK_CHAINS[roleResolution.executorId] ?? []);
    const fallback = fallbacks.find(id => availableIds.has(id) && isHealthy(health[id]));
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
      const fb = fallbacks.find(f => isHealthy(health[f]) && availableIds.has(f));
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

    // Check health — skip if not explicitly healthy (fail closed on missing data)
    if (!isHealthy(health[decision.executorId])) {
      const fallbacks = safeFallbacks(FALLBACK_CHAINS[decision.executorId] ?? []);
      const fallback = fallbacks.find(
        fb => isHealthy(health[fb]) && availableIds.has(fb)
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
    // Governance 2026-10-14: skip executors without explicit healthy status.
    // Missing health data fails closed — unknown health is not routable.
    if (!isHealthy(health[executorId])) continue;
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
      if (availableIds.has(id) && !restrictedExecutors.has(id) && isHealthy(health[id])) {
        bestId = id;
        break;
      }
    }
  }

  // Check health — skip if not explicitly healthy (fail closed on missing data)
  if (!isHealthy(health[bestId])) {
    const fallbacks = safeFallbacks(FALLBACK_CHAINS[bestId] ?? []);
    const fallback = fallbacks.find(
      fb => isHealthy(health[fb]) && availableIds.has(fb)
    );
    if (fallback) {
      const reason = health[bestId]?.state === 'OPEN'
        ? `Primary "${bestId}" circuit breaker OPEN — falling back to "${fallback}"`
        : `Primary "${bestId}" not healthy — falling back to "${fallback}"`;
      return {
        executorId: fallback,
        confidence: 0.6,
        reasoning: reason,
        fallbacks: fallbacks.filter(f => f !== fallback),
      };
    }
    throw new Error(
      `No healthy executor available: "${bestId}" is not healthy and has no healthy fallbacks. ` +
      `Refusing to route to an executor with unknown or unhealthy status.`,
    );
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
    if (available.has(id) && isHealthy(health[id]) && !restrictedExecutors?.has(id)) return id;
  }
  // Last resort: cheapest unrestricted executor (even if unhealthy)
  for (const id of COST_RANKING) {
    if (available.has(id) && !restrictedExecutors?.has(id)) return id;
  }
  return COST_RANKING[0];
}
