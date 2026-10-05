import {
  CODER_HARNESS_CHAIN,
  classifyHarnessFailureDetail,
  defaultHealthProbe,
  runHarness,
  type HarnessRunResult,
  type HealthProbe,
} from "./harness-router";
import { factoryClaimStorageKeyV2 } from "./factory-claim-identity";
import type { FactoryExecutionSubject } from "./factory-execution-subject";

export type ExecutorLifecycleKind =
  | "exec.start"
  | "probe.ok"
  | "probe.unhealthy"
  | "executor.start"
  | "executor.ok"
  | "executor.fail"
  | "executor.throw"
  | "exec.implementation_complete"
  | "exec.held"
  | "exec.failed";

export interface ExecutorLifecycleEvent {
  kind: ExecutorLifecycleKind;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface ExecutorChainResult {
  success: boolean;
  output: string;
  executorId: string | null;
  durationMs: number;
  trail: string[];
  error: string | null;
  modelUsed?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  modelProvenance?: HarnessRunResult["modelProvenance"];
  /** Invocation-local evidence only; the caller must durably reserve/reconcile
   * the operation before invoking this runner. It is not a dispatch permit. */
  launch?: {
    policy: "single_launch";
    count: 0 | 1;
    effect: "not_started" | "completed" | "uncertain";
  };
  factorySubject?: Readonly<FactoryExecutionSubject>;
}

export interface ExecutorChainOptions {
  prompt: string;
  workdir: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  env?: Record<string, string>;
  chain?: ReadonlyArray<string>;
  healthProbe?: HealthProbe;
  harnessRun?: typeof runHarness;
  onEvent?: (event: ExecutorLifecycleEvent) => void;
  onOutput?: (executorId: string, text: string) => void;
  /** Preserve historical fallback by default. Once a single-launch call starts,
   * failure cannot prove it made no effect, so another harness must not run. */
  launchPolicy?: "fallback" | "single_launch";
  /** Structural lineage only. Independent current claim/dispatch authority and
   * durable recovery remain the responsibility of the installed caller. */
  factorySubject?: Readonly<FactoryExecutionSubject>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeFailureMessage(error: unknown): string {
  try { const value = message(error); return typeof value === "string" ? value : "unrenderable executor failure"; }
  catch { return "unrenderable executor failure"; }
}

function snapshotSubject(input: Readonly<FactoryExecutionSubject> | undefined): Readonly<FactoryExecutionSubject> | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("FACTORY_EXECUTOR_SUBJECT");
  const subject = { ...input };
  const keys = ["schema", "provider", "factory_work_id", "claim_key", "claim_generation",
    "claim_owner", "reader_proof_sha256", "execution_id"];
  if (Object.keys(subject).length !== keys.length || keys.some(key => !Object.hasOwn(subject, key))
    || subject.schema !== "factory-execution-subject/v1" || subject.provider !== "hermes"
    || typeof subject.factory_work_id !== "string" || !/^fw_[a-f0-9]{64}$/.test(subject.factory_work_id)
    || subject.claim_key !== factoryClaimStorageKeyV2({ schema: "factory-claim-subject/v2", provider: "hermes", work_id: subject.factory_work_id })
    || !Number.isSafeInteger(subject.claim_generation) || subject.claim_generation < 1
    || typeof subject.claim_owner !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(subject.claim_owner)
    || typeof subject.reader_proof_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(subject.reader_proof_sha256)
    || typeof subject.execution_id !== "string" || !/^exec-[A-Za-z0-9_.:-]{1,120}$/.test(subject.execution_id)) {
    throw new Error("FACTORY_EXECUTOR_SUBJECT");
  }
  return Object.freeze(subject);
}

export async function runExecutorChain(options: ExecutorChainOptions): Promise<ExecutorChainResult> {
  const policy = options.launchPolicy ?? "fallback";
  if (policy !== "fallback" && policy !== "single_launch") throw new Error("FACTORY_EXECUTOR_LAUNCH_POLICY");
  const subject = snapshotSubject(options.factorySubject);
  if (subject && policy !== "single_launch") throw new Error("FACTORY_EXECUTOR_SUBJECT_REQUIRES_SINGLE_LAUNCH");
  const chain = [...(options.chain ?? CODER_HARNESS_CHAIN)];
  if (policy === "single_launch" && (chain.length > 32 || chain.some(id =>
    typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(id)))) throw new Error("FACTORY_EXECUTOR_CHAIN");
  const prompt = options.prompt, workdir = options.workdir, timeoutMs = options.timeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs, env = options.env ? { ...options.env } : undefined;
  const onOutput = options.onOutput;
  const probe = options.healthProbe ?? defaultHealthProbe();
  const dispatch = options.harnessRun ?? runHarness;
  const sink = options.onEvent ?? (() => {});
  const trail: string[] = [];
  let durationMs = 0;
  let launches: 0 | 1 = 0;
  let observerFailed = false;
  const emit = (event: ExecutorLifecycleEvent): void => {
    if (observerFailed) return;
    try { sink(subject ? { ...event, data: { ...event.data, factory_subject: subject } } : event); }
    catch (error) {
      if (policy !== "single_launch" || launches === 0) throw error;
      // After dispatch, failure to record an observation cannot erase the
      // effect's uncertainty or let a caller mistake this for preflight failure.
      observerFailed = true;
    }
  };
  const evidence = (result: ExecutorChainResult, effect: "not_started" | "completed" | "uncertain"): ExecutorChainResult => ({
    ...result,
    ...(policy === "single_launch" ? { launch: { policy: "single_launch" as const, count: launches, effect } } : {}),
    ...(subject ? { factorySubject: subject } : {}),
  });
  const held = (executorId: string): ExecutorChainResult => {
    const error = "FACTORY_EXECUTOR_EFFECT_UNCERTAIN";
    emit({ kind: "exec.held", detail: error, data: { executor: executorId, retry_eligible: false } });
    return evidence({ success: false, output: "", executorId, durationMs, trail, error }, "uncertain");
  };

  emit({
    kind: "exec.start",
    data: {
      chain: [...chain],
      timeout_ms: timeoutMs,
      idle_timeout_ms: idleTimeoutMs ?? null,
    },
  });

  for (const executorId of chain) {
    let health: { healthy: boolean; message: string };
    try {
      health = await probe(executorId);
    } catch (error) {
      health = { healthy: false, message: `probe threw: ${message(error)}` };
    }

    if (!health.healthy) {
      trail.push(`executor:${executorId}=unhealthy`);
      emit({ kind: "probe.unhealthy", detail: health.message, data: { executor: executorId } });
      continue;
    }

    emit({ kind: "probe.ok", data: { executor: executorId } });
    emit({
      kind: "executor.start",
      data: {
        executor: executorId,
        timeout_ms: timeoutMs,
        idle_timeout_ms: idleTimeoutMs ?? null,
      },
    });
    try {
      launches = 1;
      const supplied = await dispatch(executorId, prompt, {
        workdir,
        timeoutMs,
        idleTimeoutMs,
        env: env ? { ...env } : undefined,
        onOutput: (text) => onOutput?.(executorId, text),
      });
      // Snapshot before observer callbacks can change a retained harness object.
      const result: HarnessRunResult = policy === "single_launch"
        ? structuredClone(supplied) : supplied;
      if (policy === "single_launch" && (!result || typeof result.success !== "boolean"
        || result.executorId !== executorId || typeof result.output !== "string"
        || typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs)
        || result.durationMs < 0)) throw new Error("FACTORY_EXECUTOR_RESULT");
      durationMs += result.durationMs;
      const seconds = Math.round(result.durationMs / 1000);
      if (result.success) {
        trail.push(`executor:${executorId}=ok(${seconds}s)`);
        emit({ kind: "executor.ok", data: { executor: executorId, seconds } });
        emit({
          kind: "exec.implementation_complete",
          detail: result.output.slice(0, 200),
          data: { executor: executorId },
        });
        if (observerFailed) return held(executorId);
        return evidence({
          success: true,
          output: result.output,
          executorId,
          durationMs,
          trail,
          error: null,
          modelUsed: result.modelUsed,
          tokensUsed: result.tokensUsed,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          modelProvenance: result.modelProvenance,
        }, "completed");
      }

      const detail = (result.failureDetail ?? result.output).trim().replace(/\s+/g, " ").slice(0, 200) || "unsuccessful result";
      const failureKind = result.failureKind ?? "execution";
      trail.push(`executor:${executorId}=fail(${seconds}s):${failureKind}:${detail}`);
      emit({ kind: "executor.fail", detail, data: { executor: executorId, seconds, failure_kind: failureKind } });
    } catch (error) {
      const detail = (policy === "single_launch" ? safeFailureMessage(error) : message(error)).slice(0, 200);
      const failureKind = classifyHarnessFailureDetail(detail);
      trail.push(`executor:${executorId}=throw:${failureKind}:${detail}`);
      emit({ kind: "executor.throw", detail, data: { executor: executorId, failure_kind: failureKind } });
    }
    if (policy === "single_launch") return held(executorId);
  }

  const error = `executor chain exhausted (${trail.join(" -> ")})`;
  emit({ kind: "exec.failed", detail: error, data: { trail: [...trail] } });
  return evidence({ success: false, output: "", executorId: null, durationMs, trail, error }, "not_started");
}
