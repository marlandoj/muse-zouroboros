/**
 * Wayfinder seam for bridge-run tasks.
 *
 * Factory and campaign executors run through bridge scripts, not the ACP
 * transport, so without this seam no bridge task is ever ranked and the
 * registry's `acp.wayfinder` block is inert. The seam reuses the transport's
 * ranking helpers unchanged and keeps their two rules:
 *
 * - Shadow (the default): rank out of band, detached, never touch the prompt.
 * - Canary/live: rank synchronously and append the suggestion to the prompt,
 *   only when the registry mode asks for it AND `WAYFINDER_LIVE_INJECT=1` is in
 *   this process's environment. Unsetting that flag turns injection off on the
 *   next dispatch, whatever the registry says.
 *
 * For a bridge, canary is bounded to one executor: `canaryHarness` may name the
 * executor id (e.g. "claude-code") as well as the ranking harness.
 *
 * Every entry point is fail-safe: a missing engine, a crashed or slow ranking,
 * or an unreadable trace resolves to "no suggestion" and the task proceeds with
 * its prompt unmodified. A suggester that can break a task is worse than none.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  dispatchWayfinderShadow,
  formatWayfinderPromptSuffix,
  labelWayfinderSuggestion,
  resolveWayfinderLivePick,
  wayfinderInjectionArmed,
  type WayfinderSuggestion,
} from './transport/acp-transport.js';
import type { WayfinderShadowConfig } from './types.js';

/** One task's ranking, carried from dispatch to the post-attempt label. */
export interface BridgeWayfinderRanking {
  suggestion: WayfinderSuggestion;
  executorId: string;
  /** True only when the suggestion was appended to the dispatched prompt. */
  injected: boolean;
  /** Text appended to the prompt; empty for shadow and dry-run. */
  promptSuffix: string;
  pick?: string;
  /** Wall time the dispatch spent on ranking (live is synchronous, shadow is detached). */
  elapsedMs: number;
  startedAtMs: number;
}

/** Read an executor's `acp.wayfinder` block from a registry file. Never throws. */
export function readWayfinderConfig(registryPath: string, executorId: string): WayfinderShadowConfig | undefined {
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf-8')) as { executors?: Array<{ id?: string; acp?: { wayfinder?: WayfinderShadowConfig } }> };
    return parsed.executors?.find((e) => e?.id === executorId)?.acp?.wayfinder;
  } catch {
    return undefined;
  }
}

/**
 * Whether this bridge dispatch injects. Same gate as the transport
 * (`wayfinderInjectionArmed`), plus: in canary mode a `canaryHarness` equal to
 * the executor id arms that executor only.
 */
export function bridgeInjectionArmed(
  config: WayfinderShadowConfig | undefined,
  executorId: string,
  env: Record<string, string | undefined>,
): boolean {
  if (!config?.enabled) return false;
  if (env.WAYFINDER_LIVE_INJECT !== '1') return false;
  if (config.mode === 'canary' && (config.canaryHarness ?? '').trim() === executorId) return true;
  return wayfinderInjectionArmed(config, env as Record<string, string>);
}

/**
 * Rank one bridge task. Shadow dispatches a detached ranking and returns at
 * once; an armed canary/live dispatch waits for the pick (bounded by the
 * config's timeoutMs) and returns the prompt suffix. Never throws.
 */
export async function rankBridgeTask(
  task: { id: string; task: string },
  executorId: string,
  config: WayfinderShadowConfig | undefined,
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<BridgeWayfinderRanking | undefined> {
  const startedAtMs = Date.now();
  try {
    if (!config?.enabled) return undefined;
    const e = env as Record<string, string>;
    const t = task as Parameters<typeof dispatchWayfinderShadow>[0];
    if (bridgeInjectionArmed(config, executorId, env)) {
      const live = await resolveWayfinderLivePick(t, config, e, cwd);
      // A failed live ranking already cost its time; do not rank twice.
      if (!live) return undefined;
      const dryRun = env.WAYFINDER_DRY_RUN === '1';
      return {
        suggestion: {
          invocationId: live.invocationId, harness: live.harness, taskId: task.id, rowPath: live.rowPath,
          engineDir: live.engineDir, stateHome: live.stateHome, roots: live.roots,
        },
        executorId,
        injected: !dryRun,
        promptSuffix: dryRun ? '' : formatWayfinderPromptSuffix(live),
        pick: live.pick,
        elapsedMs: Date.now() - startedAtMs,
        startedAtMs,
      };
    }
    const suggestion = dispatchWayfinderShadow(t, { ...config, mode: 'shadow' }, e, cwd);
    if (!suggestion) return undefined;
    return { suggestion, executorId, injected: false, promptSuffix: '', elapsedMs: Date.now() - startedAtMs, startedAtMs };
  } catch {
    return undefined;
  }
}

/** Claude Code's per-project transcript directory for a working directory. */
export function claudeProjectDir(cwd: string, env: Record<string, string | undefined>): string {
  const configDir = (env.CLAUDE_CONFIG_DIR ?? '').trim() || join((env.HOME ?? '').trim() || homedir(), '.claude');
  return join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * Files the agent opened with a read-like tool, from Claude Code transcripts in
 * `dir` written since `sinceMs`. Same rule as the ACP trace: only a file the
 * agent read counts, so a mention in text or a shell `cat` is not adoption.
 */
export function claudeTranscriptReadPaths(dir: string, sinceMs: number): Set<string> {
  const paths = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return paths;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (st.mtimeMs < sinceMs || st.size > MAX_TRANSCRIPT_BYTES) continue;
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.includes('tool_use')) continue;
        let row: { message?: { content?: unknown } };
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const content = Array.isArray(row.message?.content) ? row.message.content : [];
        for (const item of content as Array<{ type?: unknown; name?: unknown; input?: Record<string, unknown> }>) {
          if (item?.type !== 'tool_use' || typeof item.name !== 'string') continue;
          if (!/^(read|view|notebookread)$/i.test(item.name.replace(/[^\w]/g, ''))) continue;
          const p = item.input?.file_path ?? item.input?.path ?? item.input?.notebook_path;
          if (typeof p === 'string' && p) paths.add(p);
        }
      }
    } catch {
      continue;
    }
  }
  return paths;
}

/**
 * Executors whose bridge leaves a readable tool trace. Others are not labelled:
 * an outcome row claiming "not used" for a trace nobody read would be a false
 * negative, and the shadow row alone is still on disk for later review.
 */
export function bridgeReadPaths(
  executorId: string,
  cwd: string,
  sinceMs: number,
  env: Record<string, string | undefined>,
): Set<string> | undefined {
  if (executorId !== 'claude-code') return undefined;
  const dir = claudeProjectDir(cwd, env);
  if (!existsSync(dir)) return undefined;
  return claudeTranscriptReadPaths(dir, sinceMs);
}

/** Label the ranking with what the agent read, via the engine's outcome log. Never throws. */
export function labelBridgeTask(
  ranking: BridgeWayfinderRanking,
  cwd: string,
  env: Record<string, string | undefined>,
): boolean {
  try {
    const readPaths = bridgeReadPaths(ranking.executorId, cwd, ranking.startedAtMs, env);
    if (!readPaths) return false;
    labelWayfinderSuggestion(ranking.suggestion, readPaths);
    return true;
  } catch {
    return false;
  }
}
