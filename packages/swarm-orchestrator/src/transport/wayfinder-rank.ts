/**
 * Wayfinder ranking helpers: rank a task against the skill catalog through the
 * Wayfinder engine (shadow, detached; or live, bounded), read the per-invocation
 * row, and label it through the engine's outcome log.
 *
 * Kept apart from acp-transport.ts so bridge-run callers can rank without loading
 * the ACP transport and its dependencies; acp-transport.ts re-exports all of it.
 */
import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { Task, WayfinderShadowConfig } from '../types.js';

/**
 * Rank the skill catalog for a task, out of band, and append the would-be pick to
 * the Wayfinder shadow log.
 *
 * Two properties matter and both are load-bearing:
 *
 * 1. The prompt is never altered. This is shadow mode: the factory records what a
 *    live suggester would have proposed and the operator decides later. The
 *    returned handle exists only so the caller can match the ranking against the
 *    agent's tool trace once the task finishes.
 * 2. Nothing is awaited, at dispatch or afterwards. Ranking costs roughly a second
 *    of interpreter and model startup. The child is detached, its stdio is fully
 *    disconnected from this process, and the task proceeds immediately. The pick is
 *    deliberately not read back here either: by the time a task completes the
 *    ranking has long since landed on disk, so the label step can read it for free.
 *
 * Any failure - missing engine, missing interpreter, non-zero exit - is silent by
 * construction. A suggester that can break a task is worse than no suggester.
 */
export function dispatchWayfinderShadow(
  task: Task,
  config: WayfinderShadowConfig | undefined,
  env: Record<string, string>,
  cwd: string,
): WayfinderSuggestion | undefined {
  // This function implements the shadow path only: rank out of band, log,
  // never touch the prompt. Canary/live injection goes through
  // resolveWayfinderLivePick. Anything else here suggests nothing.
  if (config?.mode !== undefined && config?.mode !== 'shadow') return undefined;
  const setup = wayfinderRankSetup(task, config, env, cwd);
  if (!setup) return undefined;

  const childEnv: Record<string, string> = { ...env, WAYFINDER_HOME: setup.stateHome, PYTHONDONTWRITEBYTECODE: '1' };
  if (setup.roots) childEnv.WAYFINDER_SKILLS_ROOTS = setup.roots;
  else delete childEnv.WAYFINDER_SKILLS_ROOTS;
  // Detached so a task timeout or adapter teardown cannot reap the ranking half
  // way through, and 'ignore' on stdout so no part of this host's stdio - which
  // includes a live JSON-RPC ACP pipe - can be reached by a stray write.
  const child = spawn('bash', ['-c', setup.script], {
    env: childEnv,
    cwd,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.on('error', () => {});
  child.on('exit', () => {});
  child.unref();

  return {
    invocationId: setup.invocationId,
    harness: setup.harness,
    taskId: task.id,
    engineDir: setup.engineDir,
    stateHome: setup.stateHome,
    roots: setup.roots,
    rowPath: setup.rowPath,
  };
}

interface WayfinderRankSetup {
  engineDir: string;
  harness: string;
  stateHome: string;
  roots: string;
  timeoutMs: number;
  invocationId: string;
  script: string;
  rowPath: string;
}

/**
 * Shared ranking setup for the shadow and live paths: resolves the engine,
 * state dir, and catalog roots, and builds the exact ranking program.
 * Returns undefined when ranking cannot run (disabled, no engine, no state).
 * Pure setup — no process is spawned here.
 */
function wayfinderRankSetup(
  task: Task,
  config: WayfinderShadowConfig | undefined,
  env: Record<string, string>,
  cwd: string,
): WayfinderRankSetup | undefined {
  if (!config?.enabled) return undefined;
  const engineDir = (config.engineDir ?? env.WAYFINDER_DIR ?? '').trim();
  const entrypoint = engineDir ? joinPath(engineDir, 'engine/run.py') : '';
  if (!entrypoint || !existsSync(entrypoint)) return undefined;

  const harness = (config.harness ?? 'factory').trim() || 'factory';
  const stateHome = wayfinderStateHome(config.home ?? env.WAYFINDER_HOME, cwd);
  if (!stateHome) return undefined;
  const roots = (
    config.skillsRoots?.length ? config.skillsRoots.join(':') : env.WAYFINDER_SKILLS_ROOTS ?? ''
  ).trim();
  const timeoutMs = clampNumber(config.timeoutMs, env.WAYFINDER_TIMEOUT_MS, 1_000, 120_000, 15_000);

  // Generated up front: the engine echoes it onto the row, and the outcome row keys
  // off it, so a task that dies before the child finishes is still resolvable.
  const invocationId = randomUUID();
  const script = wayfinderRankScript({
    python: wayfinderPython(env),
    entrypoint,
    harness,
    stateHome,
    roots,
    cwd,
    timeoutMs,
    invocationId,
    event: { prompt: task.task ?? '', session_id: task.id, cwd },
  });

  return {
    engineDir,
    harness,
    stateHome,
    roots,
    timeoutMs,
    invocationId,
    script,
    rowPath: wayfinderRowPath(stateHome, invocationId),
  };
}

/** A ranking resolved synchronously for prompt injection. */
export interface WayfinderLivePick {
  pick: string;
  pickPath?: string;
  invocationId: string;
  rowPath: string;
  harness: string;
  engineDir: string;
  stateHome: string;
  roots: string;
}

/**
 * Whether live injection is armed for this dispatch. Pure and testable.
 * Canary additionally requires the harness to match the canary harness;
 * everything degrades to false without WAYFINDER_LIVE_INJECT=1.
 */
export function wayfinderInjectionArmed(
  config: WayfinderShadowConfig | undefined,
  env: Record<string, string>,
): boolean {
  const mode = config?.mode ?? 'shadow';
  if (mode !== 'live' && mode !== 'canary') return false;
  if (env.WAYFINDER_LIVE_INJECT !== '1') return false;
  if (mode === 'live') return true;
  const harness = (config?.harness ?? 'factory').trim() || 'factory';
  const canaryHarness = (config?.canaryHarness ?? harness).trim() || harness;
  return harness === canaryHarness;
}

/**
 * Pure formatter for the injected suggestion. Kept separate so the exact
 * prompt text is testable without spawning anything.
 */
export function formatWayfinderPromptSuffix(pick: { pick: string; pickPath?: string }): string {
  const where = pick.pickPath ? ` (${pick.pickPath})` : '';
  return `\n\n[WAYFINDER SUGGESTION]\nRelevant skill for this task: ${pick.pick}${where}. Consider reading its SKILL.md if it applies to the task.`;
}

/**
 * Live-injection path: run the ranking synchronously, bounded by timeoutMs,
 * and return the pick for prompt injection.
 *
 * Fail-safe by construction: the flag gate, any setup failure, a ranking
 * timeout or crash, and a missing/empty pick all resolve to undefined, and
 * the caller proceeds with the unmodified prompt. A suggester that can break
 * a task is worse than no suggester — same rule as the shadow path.
 */
export async function resolveWayfinderLivePick(
  task: Task,
  config: WayfinderShadowConfig | undefined,
  env: Record<string, string>,
  cwd: string,
): Promise<WayfinderLivePick | undefined> {
  // Without the explicit flag, live resolution degrades to nothing; the
  // caller falls back to the shadow path.
  if (env.WAYFINDER_LIVE_INJECT !== '1') return undefined;
  const setup = wayfinderRankSetup(task, config, env, cwd);
  if (!setup) return undefined;
  const childEnv: Record<string, string> = { ...env, WAYFINDER_HOME: setup.stateHome, PYTHONDONTWRITEBYTECODE: '1' };
  if (setup.roots) childEnv.WAYFINDER_SKILLS_ROOTS = setup.roots;
  else delete childEnv.WAYFINDER_SKILLS_ROOTS;
  try {
    // Awaited, unlike the shadow path: the prompt cannot be built until the
    // pick lands. spawnSync's timeout is the backstop; the script's own
    // `timeout` command is the first bound. stdio stays disconnected from the
    // live ACP pipe for the same reason as the shadow path.
    const result = spawnSync('bash', ['-c', setup.script], {
      env: childEnv,
      cwd,
      timeout: setup.timeoutMs + 5_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (result.error) return undefined;
  } catch {
    return undefined;
  }
  const row = readWayfinderShadowRow(setup.rowPath);
  if (!row?.pick) return undefined;
  return {
    pick: row.pick,
    pickPath: row.pickPath,
    invocationId: setup.invocationId,
    rowPath: setup.rowPath,
    harness: setup.harness,
    engineDir: setup.engineDir,
    stateHome: setup.stateHome,
    roots: setup.roots,
  };
}

/**
 * The exact program the detached child runs.
 *
 * The prompt event travels in argv via `--event-json` rather than stdin. The hook
 * harnesses read stdin, but a non-hook caller has no stdin to hand over: creating a
 * pipe here would mean owning a file descriptor for a process that is deliberately
 * not waited on, which is how deadlocks get in. argv costs one shell argument and
 * removes the entire class of pipe-lifetime failure.
 */
/**
 * Interpreter for the Wayfinder engine. The engine needs flashrank, which hosts
 * usually install in a dedicated venv rather than the system python3.
 */
export function wayfinderPython(env: Record<string, string | undefined>): string {
  return (env.WAYFINDER_PYTHON ?? '').trim() || 'python3';
}

export function wayfinderRankScript(options: {
  entrypoint: string;
  harness: string;
  stateHome: string;
  roots: string;
  cwd: string;
  timeoutMs: number;
  invocationId: string;
  event: { prompt: string; session_id: string; cwd: string };
  python?: string;
}): string {
  const { entrypoint, harness, stateHome, roots, cwd, timeoutMs, invocationId, event } = options;
  const python = options.python?.trim() && options.python.trim() !== 'python3' ? shellQuote(options.python.trim()) : 'python3';
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    'set -u',
    `export WAYFINDER_HOME=${shellQuote(stateHome)}`,
    ...(roots ? [`export WAYFINDER_SKILLS_ROOTS=${shellQuote(roots)}`] : []),
    `cd ${shellQuote(cwd)} || exit 0`,
    `EVENT=${shellQuote(JSON.stringify({ ...event, invocation_id: invocationId }))}`,
    'if command -v timeout >/dev/null 2>&1; then',
    `  timeout ${seconds} ${python} ${shellQuote(entrypoint)} log --harness ${shellQuote(harness)} --event-json "$EVENT" --invocation-id ${shellQuote(invocationId)}`,
    'else',
    `  ${python} ${shellQuote(entrypoint)} log --harness ${shellQuote(harness)} --event-json "$EVENT" --invocation-id ${shellQuote(invocationId)}`,
    'fi',
    'exit 0',
  ].join('\n');
}

/**
 * Where the engine writes one factory ranking.
 *
 * The engine keeps factory rows out of suggestions.jsonl and into
 * `$WAYFINDER_HOME/invocations/<id>/shadow.jsonl`, one directory per invocation.
 * That is deliberate: a slow, detached, concurrent ranking cannot interleave into
 * a single append-only file, and the caller gets an O(1) path to its own row
 * instead of a full log scan at task completion. The id is a UUID from this
 * process, so it is always a safe path segment; the engine refuses anything else.
 */
export function wayfinderRowPath(stateHome: string, invocationId: string): string {
  return joinPath(joinPath(joinPath(stateHome, 'invocations'), invocationId), 'shadow.jsonl');
}

/** Resolve and create the state directory, or undefined when it cannot be used. */
function wayfinderStateHome(configured: string | undefined, cwd: string): string | undefined {
  const explicit = (configured ?? '').trim();
  const stateHome = explicit || joinPath(cwd, '.wayfinder');
  if (existsSync(stateHome)) return stateHome;
  try {
    mkdirSync(stateHome, { recursive: true, mode: 0o700 });
    return stateHome;
  } catch {
    return undefined;
  }
}

/** Handle for one dispatched shadow ranking, labelled after the task completes. */
export interface WayfinderSuggestion {
  invocationId: string;
  harness: string;
  taskId: string;
  rowPath: string;
  engineDir: string;
  stateHome: string;
  roots: string;
}

/**
 * Read-like tool names, matched on the ACP tool title.
 *
 * The comparison strips separators and anchors at the start, so Read, ReadFile,
 * read_file, notebookRead and View all match while Grep, Write and Bash do not.
 * A file the agent never opened cannot have influenced it, which is exactly the
 * distinction an adopted-versus-ignored label is trying to draw.
 */
function isReadLikeTool(name: string): boolean {
  return /^(read|view|notebookread|cat|type)$/i.test(name.replace(/[^\w]/g, ''));
}

/** One shadow row, reduced to the two fields a label needs. */
export interface WayfinderShadowRow {
  pick?: string;
  pickPath?: string;
  candidates: Array<{ id: string; source: string }>;
}

/**
 * Read this invocation's shadow row.
 *
 * The engine writes one file per invocation under
 * `$WAYFINDER_HOME/invocations/<id>/shadow.jsonl` precisely so that a slow,
 * detached, concurrent ranking cannot interleave into a shared append-only log.
 * Reading that single file is therefore also the only correct way to find the
 * row: scanning suggestions.jsonl would race every other task in flight.
 */
export function readWayfinderShadowRow(rowPath: string): WayfinderShadowRow | undefined {
  let text: string;
  try {
    text = readFileSync(rowPath, 'utf-8');
  } catch {
    return undefined;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: { pick?: unknown; pick_path?: unknown; candidates?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const raw = Array.isArray(row.candidates) ? row.candidates : [];
    return {
      pick: typeof row.pick === 'string' ? row.pick : undefined,
      pickPath: typeof row.pick_path === 'string' ? row.pick_path : undefined,
      candidates: raw.filter(
        (c): c is { id: string; source: string } =>
          !!c
          && typeof (c as { id?: unknown }).id === 'string'
          && typeof (c as { source?: unknown }).source === 'string',
      ),
    };
  }
  return undefined;
}

/**
 * The adopt / not-adopt call, with no I/O in it.
 *
 * Separated from the writer so the one decision that decides whether the log is
 * worth accumulating can be tested directly, and so the rule is stated exactly
 * once: a suggestion counts as adopted only when the agent opened the suggested
 * SKILL.md. Anything looser - a keyword hit, a session that mentioned the skill
 * - would inflate the numbers this log exists to produce.
 */
export function evaluateWayfinderShadow(
  row: WayfinderShadowRow | undefined,
  readPaths: ReadonlySet<string>,
): { pick: string; used: boolean; readSkills: string[] } | undefined {
  if (!row?.pick || !row.pickPath) return undefined;
  const skillPath = row.candidates.find((c) => c.id === row.pick)?.source ?? row.pickPath;
  return {
    pick: row.pick,
    used: readPaths.has(skillPath),
    readSkills: [...readPaths].filter((p) => p.includes('SKILL.md')).slice(0, 20),
  };
}

/**
 * Label one shadow ranking with what the agent actually did.
 *
 * A suggestion counts as adopted when the set of files the agent read contains
 * the suggested SKILL.md. Shadow mode otherwise only knows what it proposed, and
 * a proposal nobody acted on looks identical to a useful one. This is the signal
 * that makes the log reviewable: a skill that is picked but never read is a
 * descriptor to fix, not a ranking bug to chase.
 *
 * The write goes through the engine's own `outcome` command rather than a private
 * writer here, so factory rows and the seven CLI harnesses end up in one log that
 * one report can read. It is fire-and-forget for the same reason the ranking is:
 * a labelling step must not be able to fail a completed task.
 */
export function labelWayfinderSuggestion(
  suggestion: WayfinderSuggestion,
  readPaths: ReadonlySet<string>,
): void {
  const outcome = evaluateWayfinderShadow(readWayfinderShadowRow(suggestion.rowPath), readPaths);
  if (!outcome) return;
  const args = [
    joinPath(suggestion.engineDir, 'engine/run.py'),
    'outcome',
    '--harness', suggestion.harness,
    '--session', suggestion.taskId,
    '--pick', outcome.pick,
    '--used', outcome.used ? '1' : '0',
  ];
  if (outcome.readSkills.length > 0) args.push('--detail', outcome.readSkills.join(','));
  try {
    const child = spawn('python3', args, {
      env: { ...process.env, WAYFINDER_HOME: suggestion.stateHome, PYTHONDONTWRITEBYTECODE: '1' },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => {});
    child.on('exit', () => {});
    child.unref();
  } catch {
    /* fail open: a missing outcome row is recoverable, a broken task is not */
  }
}


function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function clampNumber(
  value: number | undefined,
  envValue: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const raw = value ?? (envValue ? Number(envValue) : Number.NaN);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}
