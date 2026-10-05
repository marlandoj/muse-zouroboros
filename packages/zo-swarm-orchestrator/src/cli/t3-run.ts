/**
 * t3-run — ZouroBench T3 single-task bench harness.
 *
 * Runs ONE T3 envelope through the swarm orchestrator and emits a
 * T2 Trajectory-schema JSON object on stdout. Optionally invokes the
 * consensus-gate as a POST-swarm validation step (bench-side measurement —
 * not wired into the production orchestrator).
 *
 * Invocation contract (called by hal-adapter/src/runners/zouroboros-swarm-bridge.ts):
 *
 *   bun .../cli/index.ts t3-run \
 *     --task <envelope.yaml|.json>
 *     --seed N
 *     --consensus-gate on|off
 *     --model M
 *     [--executor E]              # default 'claude-code', explicit pins selector
 *     [--max-usd X]               # spend cap; defaults to ZOUROBOROS_T3_MAX_USD or 10
 *     [--json]                    # currently a no-op (default is JSON; reserved for future banner mode)
 *
 * Output: one JSON object matching T2 Trajectory schema on stdout. Exits 0 on
 * harness success regardless of whether the bench task itself passed — the
 * trajectory's `terminate_reason` carries the outcome.
 *
 * Spend cap behavior: hard fail (exit 1, no stdout JSON) if the projected cost
 * would exceed the cap. The cap is per-invocation, not cumulative.
 *
 * Why a bench harness vs. wiring consensus-gate into SwarmOrchestrator:
 *   The §4 add in zourobench-2026/SYNTHESIS.md is *measurement*, not deployment.
 *   The swarm orchestrator currently has no consensus-gate caller (only memory.ts
 *   evolveProcedure does). Bench-side invocation is honest, scoped, and reversible.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { getWorkspaceRoot } from 'zouroboros-core';
import { SwarmOrchestrator } from '../orchestrator.js';
import type { Task, TaskResult, SwarmConfig } from '../types.js';

/* -------------------------------------------------------------------------- */
/*  T3 envelope (subset)                                                      */
/* -------------------------------------------------------------------------- */

interface T3Envelope {
  id: string;
  domain: string;
  difficulty: string;
  problem: {
    statement: string;
    initial_state: {
      workspace_path: string;
      tools_available: string[];
    };
  };
  budgets: {
    max_turns: number;
    max_input_tokens: number;
    max_output_tokens: number;
    wall_clock_s: number;
  };
  contamination: {
    uuid: string;
  };
}

/* -------------------------------------------------------------------------- */
/*  T2 Trajectory shape (output)                                              */
/* -------------------------------------------------------------------------- */

type TerminateReason =
  | 'success'
  | 'agent_quit'
  | 'budget_exhausted_turns'
  | 'budget_exhausted_tokens'
  | 'budget_exhausted_wall'
  | 'hard_error';

interface Turn {
  turn: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  wall_ms: number;
}

interface Trajectory {
  run_id: string;
  task_id: string;
  runner_id: string;
  model: string;
  seed: number;
  started_at: string;
  finished_at: string;
  turns: Turn[];
  terminate_reason: TerminateReason;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  total_wall_ms: number;
  judge_notes?: string;
}

/* -------------------------------------------------------------------------- */
/*  Cost rates (per 1M tokens)                                                */
/* -------------------------------------------------------------------------- */

const COST_PER_1M: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  default: { input: 3, output: 15 },
};

function costFor(model: string, inTok: number, outTok: number): number {
  const rate = COST_PER_1M[model] ?? COST_PER_1M.default;
  return (inTok * rate.input + outTok * rate.output) / 1_000_000;
}

/* -------------------------------------------------------------------------- */
/*  Envelope loader (YAML or JSON, by extension)                              */
/* -------------------------------------------------------------------------- */

function loadEnvelope(p: string): T3Envelope {
  if (!existsSync(p)) {
    throw new Error(`Envelope not found: ${p}`);
  }
  const raw = readFileSync(p, 'utf-8');
  const ext = path.extname(p).toLowerCase();
  if (ext === '.json') return JSON.parse(raw) as T3Envelope;
  if (ext === '.yaml' || ext === '.yml') return yaml.parse(raw) as T3Envelope;
  throw new Error(`Unsupported envelope extension: ${ext} (expected .yaml/.yml/.json)`);
}

/* -------------------------------------------------------------------------- */
/*  Synthesizer: TaskResult → T2 Trajectory                                   */
/*                                                                            */
/*  The T2 scorer (zourobench-2026/hal-adapter/src/scorer/t2-score.ts) reads: */
/*    - trajectory.terminate_reason                                           */
/*    - trajectory.turns[].role === 'assistant' content for watermark check   */
/*    - envelope.acceptance.partial_credit.substeps[] (drives per-substep)    */
/*  It does NOT inspect intermediate substep progress. A minimal 2-turn       */
/*  trajectory (user prompt + assistant final output) is the honest mapping   */
/*  of the swarm's task-level result.                                         */
/* -------------------------------------------------------------------------- */

export type { T3Envelope, Trajectory, Turn, TerminateReason };

export function synthesizeTrajectory(args: {
  envelope: T3Envelope;
  seed: number;
  consensus_gate: 'on' | 'off';
  result: TaskResult;
  model: string;
  startedAt: string;
  finishedAt: string;
}): Trajectory {
  const { envelope, seed, consensus_gate, result, model, startedAt, finishedAt } = args;

  // Token accounting.
  //   Preferred path: bridge reports inputTokens/outputTokens separately (claude-code-bridge.sh
  //   parses the CLI's --output-format json). We use those directly.
  //   Fallback path: only `tokensUsed` is present — split 70/30 in/out (matching the historical
  //   orchestrator.ts:477-479 convention).
  let tokensIn: number;
  let tokensOut: number;
  if (
    (result.inputTokens !== undefined && result.inputTokens > 0) ||
    (result.outputTokens !== undefined && result.outputTokens > 0)
  ) {
    tokensIn = result.inputTokens ?? 0;
    tokensOut = result.outputTokens ?? 0;
  } else {
    const tokensUsed = result.tokensUsed ?? 0;
    tokensIn = Math.round(tokensUsed * 0.7);
    tokensOut = Math.round(tokensUsed * 0.3);
  }
  const usedModel = result.modelUsed ?? model;
  // Prefer the executor-reported cost when present (claude CLI emits a real
  // total_cost_usd that accounts for cache reads, mid-run model switches, etc.).
  // Fall back to our static per-1M rate table when the bridge can't report cost.
  const totalCost =
    result.costUsd !== undefined && result.costUsd > 0
      ? result.costUsd
      : costFor(usedModel, tokensIn, tokensOut);

  let terminate_reason: TerminateReason;
  if (result.success) {
    terminate_reason = 'success';
  } else if (result.error && /timeout|timed out/i.test(result.error)) {
    terminate_reason = 'budget_exhausted_wall';
  } else if (result.error && /token|context.{0,8}length/i.test(result.error)) {
    terminate_reason = 'budget_exhausted_tokens';
  } else if (result.error) {
    terminate_reason = 'hard_error';
  } else {
    terminate_reason = 'agent_quit';
  }

  const turns: Turn[] = [
    {
      turn: 0,
      role: 'user',
      content: envelope.problem.statement,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      wall_ms: 0,
    },
    {
      turn: 1,
      role: 'assistant',
      content: result.output ?? result.error ?? '',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: totalCost,
      wall_ms: result.durationMs,
    },
  ];

  return {
    run_id: `t3-run-${randomUUID()}`,
    task_id: envelope.id,
    runner_id: `zouroboros-swarm:${result.effectiveExecutor ?? result.task.executor ?? 'unknown'}(${consensus_gate})`,
    model: usedModel,
    seed,
    started_at: startedAt,
    finished_at: finishedAt,
    turns,
    terminate_reason,
    total_input_tokens: tokensIn,
    total_output_tokens: tokensOut,
    total_cost_usd: totalCost,
    total_wall_ms: result.durationMs,
  };
}

/* -------------------------------------------------------------------------- */
/*  Consensus-gate post-swarm invocation                                      */
/* -------------------------------------------------------------------------- */

// Bench-only post-swarm validation hook. Overridable so tests can point at a
// missing path (forcing the fast 'skipped' branch — no real LLM calls) and so
// operators can relocate the gate script outside the default Skills/ layout.
const CONSENSUS_GATE_PATH =
  process.env.ZOUROBOROS_CONSENSUS_GATE_PATH || path.join(getWorkspaceRoot(), 'Skills/consensus-gate/scripts/consensus-gate.ts');

interface ConsensusGateResult {
  status: 'passed' | 'rejected' | 'split' | 'skipped' | 'gate_error';
  notes: string;
  cost_proxy_usd: number; // gate uses credited key; 0 unless we account otherwise
}

function runConsensusGate(envelope: T3Envelope, trajectory: Trajectory, authorModel?: string): ConsensusGateResult {
  if (!existsSync(CONSENSUS_GATE_PATH)) {
    return { status: 'skipped', notes: 'consensus-gate script missing', cost_proxy_usd: 0 };
  }
  if (trajectory.turns.length === 0) {
    return { status: 'skipped', notes: 'no trajectory turns to validate', cost_proxy_usd: 0 };
  }
  const assistantOutput = trajectory.turns.find(t => t.role === 'assistant')?.content ?? '';
  if (!assistantOutput.trim()) {
    return { status: 'skipped', notes: 'empty swarm output', cost_proxy_usd: 0 };
  }

  const label = `t3-${envelope.id}-s${trajectory.seed}`;
  // Reviewer independence (P0-2): the executor model authored this output, so
  // exclude it from its own review panel. A no-op when the executor isn't on
  // the consensus panel (the common Claude-executor case).
  const gateArgs = [
    CONSENSUS_GATE_PATH,
    'validate',
    '--code', assistantOutput,
    '--criteria', 'correctness,consistency,security',
    '--label', label,
  ];
  if (authorModel) gateArgs.push('--author', authorModel);
  const res = spawnSync(
    'bun',
    gateArgs,
    {
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env },
    },
  );
  if (res.status !== 0 || res.error) {
    return {
      status: 'gate_error',
      notes: `gate exit=${res.status} err=${res.error?.message ?? ''} stderr_tail=${(res.stderr ?? '').slice(-200)}`,
      cost_proxy_usd: 0,
    };
  }

  // The validate command emits human-readable text (📊 Results, 📋 Consensus,
  // ID: cg-…). Parse the Consensus line + the ID. The full structured result
  // is persisted to ~/.zouroboros/consensus-gate.json; we can pick it up from
  // there if richer metrics are needed downstream.
  const stdout = res.stdout ?? '';
  const consensusMatch = stdout.match(/Consensus:\s*(PASSED|REJECTED|SPLIT)/i);
  const idMatch = stdout.match(/ID:\s*(cg-\S+)/);

  if (!consensusMatch) {
    return {
      status: 'gate_error',
      notes: `gate output missing Consensus line; stdout_tail=${stdout.slice(-200)}`,
      cost_proxy_usd: 0,
    };
  }
  const verdict = consensusMatch[1].toLowerCase() as 'passed' | 'rejected' | 'split';
  const cgId = idMatch?.[1] ?? 'unknown';
  return {
    status: verdict,
    notes: `gate ${verdict}; id=${cgId}`,
    cost_proxy_usd: 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  CLI surface                                                               */
/* -------------------------------------------------------------------------- */

interface T3RunArgs {
  task: string;
  seed: number;
  consensus_gate: 'on' | 'off';
  model: string;
  executor: string;
  max_usd: number;
  /** D4: force bridge or acp transport regardless of executor registry entry. */
  force_transport?: 'bridge' | 'acp';
}

function parseT3RunArgs(argv: string[]): T3RunArgs {
  const args: Partial<T3RunArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--task': args.task = next(); break;
      case '--seed': args.seed = parseInt(next(), 10); break;
      case '--consensus-gate': {
        const v = next();
        if (v !== 'on' && v !== 'off') throw new Error(`--consensus-gate must be on|off, got: ${v}`);
        args.consensus_gate = v;
        break;
      }
      case '--model': args.model = next(); break;
      case '--executor': args.executor = next(); break;
      case '--max-usd': args.max_usd = parseFloat(next()); break;
      case '--json': /* default; reserved */ break;
      case '--force-transport': {
        const v = next();
        if (v !== 'bridge' && v !== 'acp') throw new Error(`--force-transport must be bridge|acp, got: ${v}`);
        args.force_transport = v;
        break;
      }
      default:
        throw new Error(`Unknown t3-run flag: ${a}`);
    }
  }
  if (!args.task) throw new Error('--task <envelope.yaml|.json> is required');
  if (args.seed === undefined || Number.isNaN(args.seed)) throw new Error('--seed N is required');
  if (!args.consensus_gate) throw new Error('--consensus-gate on|off is required');
  if (!args.model) throw new Error('--model M is required');
  if (!args.executor) args.executor = 'claude-code';
  if (args.max_usd === undefined || Number.isNaN(args.max_usd)) {
    args.max_usd = parseFloat(process.env.ZOUROBOROS_T3_MAX_USD ?? '10');
  }
  return args as T3RunArgs;
}

export async function runT3Subcommand(argv: string[]): Promise<number> {
  const args = parseT3RunArgs(argv);
  const envelope = loadEnvelope(args.task);

  // Spend cap projection: worst-case per-turn × max_turns at the chosen model.
  const projected = costFor(
    args.model,
    envelope.budgets.max_input_tokens,
    envelope.budgets.max_output_tokens,
  );
  if (projected > args.max_usd) {
    process.stderr.write(
      `[t3-run] ABORT: projected cost $${projected.toFixed(2)} exceeds --max-usd $${args.max_usd.toFixed(2)} ` +
      `for ${envelope.id} on ${args.model}\n`,
    );
    return 1;
  }

  const task: Task = {
    id: envelope.id,
    persona: 'zourobench-t3',
    task: envelope.problem.statement,
    priority: 'medium',
    executor: args.executor,
    model: args.model,
    timeoutSeconds: envelope.budgets.wall_clock_s,
    memoryStrategy: 'none',
    outputToMemory: false,
    memoryMetadata: { tags: [envelope.domain, envelope.difficulty, 't3-bench'] },
  };

  const config: Partial<SwarmConfig> = {
    localConcurrency: 1,
    timeoutSeconds: envelope.budgets.wall_clock_s,
    notifyOnComplete: 'none',
    routingStrategy: 'fast',
    useSixSignalRouting: false,
    stagnationEnabled: false,
    enableMemory: false,
    ragEnrichment: { enabled: false },
    pipelineGates: {
      seedValidation: false,
      postFlightEval: false,
      gapAuditLoop: false,
      blockOnSeedFailure: false,
    },
    // Bench harness runs as an ephemeral, single-task process — point the
    // swarm SQLite at a writable per-invocation temp file instead of the
    // shared default (/home/workspace/.swarm/swarm.db). The default dir is
    // unwritable for the non-root CI runner, so the orchestrator constructor
    // would otherwise throw EACCES before any task runs.
    dbPath: path.join(tmpdir(), 'zouroboros-t3', `swarm-${process.pid}-${randomUUID().slice(0, 8)}.db`),
  };

  // D4: propagate --force-transport into the env so factory.ts's per-call
  // SWARM_FORCE_TRANSPORT read overrides the executor registry transport field.
  // Set before orchestrator construction; the factory reads the env at dispatch
  // time (inside orchestrator.run), so set-before-construct is sufficient.
  // Bench-only: cleared after the run to avoid leaking into any subsequent calls
  // within the same process (defensive — t3-run is single-task, but be explicit).
  const prevForceTransport = process.env.SWARM_FORCE_TRANSPORT;
  if (args.force_transport) {
    process.env.SWARM_FORCE_TRANSPORT = args.force_transport;
  }

  const startedAt = new Date().toISOString();
  // The orchestrator emits operational logs via console.log/error. The CLI's
  // contract with the bridge is "stdout is a single Trajectory JSON object" —
  // redirect orchestrator chatter to stderr so stdout stays clean. Install the
  // overrides BEFORE construction so even constructor-time logging is captured.
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n');
  console.info = console.log;
  console.warn = console.log;
  console.error = console.log;

  // Construct inside the try so a constructor-time failure (e.g. an unwritable
  // SQLite path) still synthesizes a valid trajectory and exits 0 per the
  // harness contract, rather than throwing uncaught → exit 1.
  let orchestrator: SwarmOrchestrator | undefined;
  let results: TaskResult[];
  try {
    orchestrator = new SwarmOrchestrator(config);
    results = await orchestrator.run([task]);
  } catch (err) {
    process.stderr.write(`[t3-run] orchestrator threw: ${(err as Error).message}\n`);
    const finishedAt = new Date().toISOString();
    const trajectory: Trajectory = synthesizeTrajectory({
      envelope,
      seed: args.seed,
      consensus_gate: args.consensus_gate,
      result: {
        task,
        success: false,
        error: (err as Error).message,
        durationMs: 0,
        retries: 0,
      },
      model: args.model,
      startedAt,
      finishedAt,
    });
    trajectory.judge_notes = 'orchestrator threw before producing TaskResult';
    process.stdout.write(JSON.stringify(trajectory));
    return 0;
  } finally {
    await orchestrator?.shutdown().catch(() => {});
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
    // Restore SWARM_FORCE_TRANSPORT to pre-invocation state (D4 cleanup).
    if (args.force_transport) {
      if (prevForceTransport === undefined) {
        delete process.env.SWARM_FORCE_TRANSPORT;
      } else {
        process.env.SWARM_FORCE_TRANSPORT = prevForceTransport;
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const result = results[0];
  const trajectory = synthesizeTrajectory({
    envelope,
    seed: args.seed,
    consensus_gate: args.consensus_gate,
    result,
    model: args.model,
    startedAt,
    finishedAt,
  });

  // Consensus-gate is a post-swarm measurement step. Off path: no-op, no cost.
  if (args.consensus_gate === 'on') {
    const gate = runConsensusGate(envelope, trajectory, args.model);
    trajectory.judge_notes = `consensus-gate=${gate.status}; ${gate.notes}`;
    if (gate.status === 'rejected') {
      // A rejected verdict on a previously-successful run flips it to a quit —
      // the gate caught content the validators consider unsafe to merge.
      if (trajectory.terminate_reason === 'success') {
        trajectory.terminate_reason = 'agent_quit';
      }
    }
  }

  process.stdout.write(JSON.stringify(trajectory));
  return 0;
}
