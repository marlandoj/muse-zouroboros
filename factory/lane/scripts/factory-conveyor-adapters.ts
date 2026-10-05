import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveFactoryStateOverride } from "./factory-state-root";
import {
  CONVEYOR_PHASES,
  type ConveyorCycleSnapshot,
  type ConveyorPhase,
  ConveyorRunnerError,
  canonicalJson,
  inspectCycle,
  recordPhase,
  runCycleScaffold,
  sha256,
} from "./factory-conveyor-runner";

export const ADAPTER_EFFECTS = ["read_only", "external_read", "state_write", "external_write"] as const;
export const ADAPTER_EXECUTION_POLICIES = ["disabled", "read_only"] as const;
export const ADAPTER_PHASE_BOUNDARIES = ["before_start", "after_start", "after_adapter", "after_terminal"] as const;

export type AdapterEffect = typeof ADAPTER_EFFECTS[number];
export type AdapterExecutionPolicy = typeof ADAPTER_EXECUTION_POLICIES[number];
export type AdapterPhaseBoundary = typeof ADAPTER_PHASE_BOUNDARIES[number];
export type AdapterFailureMode = "fail_closed" | "continue" | "silent_stop";

export interface ConveyorAdapterCommand {
  id: string;
  kind: "bun" | "internal";
  script: string | null;
  args: string[];
  env: Record<string, string>;
  effect: AdapterEffect;
  timeout_ms: number;
  stdout_path: string | null;
  stderr_path: string | null;
  load_runtime_config: boolean;
  required_bindings: string[];
}

export interface ConveyorPhaseAdapter {
  phase: ConveyorPhase;
  failure_mode: AdapterFailureMode;
  commands: ConveyorAdapterCommand[];
}

export interface ConveyorAdapterCatalog {
  schema_version: 1;
  factory_root: string;
  scripts_dir: string;
  runtime_config_script: string;
  state_dir: string;
  artifact_root: string;
  cycle_token: string;
  adapters: ConveyorPhaseAdapter[];
  catalog_hash: string;
}

export interface BuildAdapterCatalogInput {
  factoryRoot: string;
  stateDir: string;
  artifactRoot?: string;
  cycleToken: string;
}

export interface AdapterCommandResult {
  exit_code: number;
  stdout_hash: string | null;
  stderr_hash: string | null;
}

export interface AdapterCommandExecutor {
  run(command: ConveyorAdapterCommand): Promise<AdapterCommandResult>;
}

export interface AdapterCommandRun {
  command_id: string;
  status: "planned" | "blocked" | "succeeded" | "failed";
  effect: AdapterEffect;
  exit_code: number | null;
  stdout_hash: string | null;
  stderr_hash: string | null;
}

export interface AdapterPhaseRun {
  phase: ConveyorPhase;
  event: "succeeded" | "skipped" | "failed";
  reason: string | null;
  commands: AdapterCommandRun[];
  result_hash: string;
}

export interface AdapterBoundaryEvent {
  cycle_id: string;
  phase: ConveyorPhase;
  boundary: AdapterPhaseBoundary;
}

export type AdapterBoundaryHook = (event: AdapterBoundaryEvent) => void | Promise<void>;

function assertAbsolute(path: string, field: string): string {
  if (!isAbsolute(path)) throw new ConveyorRunnerError("adapter_path_invalid", `${field} must be absolute`);
  return resolve(path);
}

function assertToken(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value)) {
    throw new ConveyorRunnerError("adapter_token_invalid", "cycle token must be path-safe");
  }
}

function command(input: Omit<ConveyorAdapterCommand, "kind" | "timeout_ms" | "stdout_path" | "stderr_path" | "load_runtime_config" | "required_bindings"> & {
  timeoutMs?: number;
  stdoutPath?: string;
  stderrPath?: string;
  requiredBindings?: string[];
}): ConveyorAdapterCommand {
  return {
    id: input.id,
    kind: "bun",
    script: input.script,
    args: [...input.args],
    env: { ...input.env },
    effect: input.effect,
    timeout_ms: input.timeoutMs ?? 120_000,
    stdout_path: input.stdoutPath ?? null,
    stderr_path: input.stderrPath ?? null,
    load_runtime_config: true,
    required_bindings: input.requiredBindings ?? [],
  };
}

function internal(id: string, effect: AdapterEffect): ConveyorAdapterCommand {
  return {
    id,
    kind: "internal",
    script: null,
    args: [],
    env: {},
    effect,
    timeout_ms: 30_000,
    stdout_path: null,
    stderr_path: null,
    load_runtime_config: false,
    required_bindings: [],
  };
}

function unsignedCatalog(catalog: Omit<ConveyorAdapterCatalog, "catalog_hash">): unknown {
  return {
    schema_version: catalog.schema_version,
    factory_root: catalog.factory_root,
    scripts_dir: catalog.scripts_dir,
    runtime_config_script: catalog.runtime_config_script,
    state_dir: catalog.state_dir,
    artifact_root: catalog.artifact_root,
    cycle_token: catalog.cycle_token,
    adapters: catalog.adapters,
  };
}

function normalizeContractValue(value: unknown, catalog: ConveyorAdapterCatalog): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeContractValue(entry, catalog));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalizeContractValue(entry, catalog)]),
    );
  }
  if (typeof value !== "string") return value;
  return value
    .replaceAll(catalog.artifact_root, "<artifact_root>")
    .replaceAll(catalog.state_dir, "<state_root>")
    .replaceAll(catalog.factory_root, "<factory_root>")
    .replaceAll(`-${catalog.cycle_token}.`, "-<cycle_token>.");
}

export function conveyorAdapterContractHash(catalog: ConveyorAdapterCatalog): string {
  validateAdapterCatalog(catalog);
  return sha256(canonicalJson({
    schema_version: catalog.schema_version,
    adapters: normalizeContractValue(catalog.adapters, catalog),
  }));
}

export function buildIncumbentAdapterCatalog(input: BuildAdapterCatalogInput): ConveyorAdapterCatalog {
  const factoryRoot = assertAbsolute(input.factoryRoot, "factoryRoot");
  const stateDir = resolveFactoryStateOverride(assertAbsolute(input.stateDir, "stateDir"));
  const artifactRoot = assertAbsolute(input.artifactRoot ?? "/tmp", "artifactRoot");
  assertToken(input.cycleToken);
  const scriptsDir = join(factoryRoot, "Projects", "zouroboros-software-factory", "scripts");
  const runtimeConfigScript = join(scriptsDir, "runtime-config.ts");
  const configDir = join(factoryRoot, "Projects", "zouroboros-software-factory", "config", "serial-promotions");
  const artifact = (name: string, extension: string) => join(artifactRoot, `factory-${name}-${input.cycleToken}.${extension}`);
  const script = (name: string) => join(scriptsDir, name);
  const productionEnv = { FACTORY_STATE_MODE: "production", FACTORY_STATE_DIR: stateDir };

  const adapters: ConveyorPhaseAdapter[] = [
    {
      phase: "preflight",
      failure_mode: "fail_closed",
      commands: [
        command({ id: "runtime-config-check", script: runtimeConfigScript, args: ["check"], env: productionEnv, effect: "read_only" }),
        internal("canonical-repository-identity", "external_read"),
        command({
          id: "conveyor-smoke",
          script: script("conveyor-smoke-test.ts"),
          args: [],
          env: { ...productionEnv, FACTORY_CODING_CASCADE: "off" },
          effect: "state_write",
          timeoutMs: 600_000,
        }),
      ],
    },
    {
      phase: "recovery",
      failure_mode: "fail_closed",
      commands: [
        command({ id: "reap-stale-executions", script: script("reap-stale-execs.ts"), args: [], env: productionEnv, effect: "state_write" }),
        internal("pending-handoff-guard", "read_only"),
      ],
    },
    {
      phase: "capacity_guard",
      failure_mode: "silent_stop",
      commands: [command({ id: "inflight-cap-guard", script: script("inflight-cap.ts"), args: ["guard", "--state-dir", stateDir], env: productionEnv, effect: "read_only" })],
    },
    {
      phase: "serial_promotion",
      failure_mode: "fail_closed",
      commands: [command({
        id: "serial-intake-promoter",
        script: script("serial-intake-promoter.ts"),
        args: ["tick-all", "--config-dir", configDir],
        env: { ...productionEnv, FACTORY_SERIAL_PROMOTION: "enforce" },
        effect: "external_write",
        stdoutPath: artifact("serial", "json"),
        stderrPath: artifact("serial", "err"),
      })],
    },
    {
      phase: "signal_intake",
      failure_mode: "continue",
      commands: [command({
        id: "signal-intake",
        script: script("signal-intake.ts"),
        args: ["tick"],
        env: productionEnv,
        effect: "state_write",
        stdoutPath: artifact("signals", "out"),
        stderrPath: artifact("signals", "err"),
      })],
    },
    {
      phase: "prespec",
      failure_mode: "continue",
      commands: [command({
        id: "bounded-prespec",
        script: script("prespec-runner.ts"),
        args: ["--top", "1", "--json"],
        env: { ...productionEnv, SF_PRESPEC: "1", SF_PRESPEC_TOP_N: "1", SF_PRESPEC_COOLDOWN_HOURS: "72" },
        effect: "state_write",
        stdoutPath: artifact("prespec", "json"),
        stderrPath: artifact("prespec", "err"),
      })],
    },
    {
      phase: "pull",
      failure_mode: "fail_closed",
      commands: [command({
        id: "linear-puller",
        script: script("linear-puller.ts"),
        args: [],
        env: productionEnv,
        effect: "external_read",
        stdoutPath: artifact("queue", "json"),
        stderrPath: artifact("puller", "err"),
      })],
    },
    {
      phase: "contract",
      failure_mode: "silent_stop",
      commands: [command({
        id: "ticket-contract",
        script: script("ticket-contract.ts"),
        args: ["--tickets", artifact("queue", "json")],
        env: productionEnv,
        effect: "external_write",
        stdoutPath: artifact("validated", "json"),
        stderrPath: artifact("validated", "err"),
      })],
    },
    {
      phase: "open_execution_guard",
      failure_mode: "silent_stop",
      commands: [internal("open-execution-guard", "read_only")],
    },
    {
      phase: "dispatch",
      failure_mode: "fail_closed",
      commands: [command({
        id: "dispatcher",
        script: script("dispatcher.ts"),
        args: ["--tickets", artifact("validated", "json")],
        env: productionEnv,
        effect: "state_write",
        stdoutPath: artifact("dispatched", "json"),
        stderrPath: artifact("dispatched", "err"),
      })],
    },
    {
      phase: "execute",
      failure_mode: "fail_closed",
      commands: [command({
        id: "swarm-exec",
        script: script("swarm-exec.ts"),
        args: ["--dispatch", artifact("dispatched", "json")],
        env: { ...productionEnv, FACTORY_CODING_CASCADE: "enforce" },
        effect: "external_write",
        timeoutMs: 3_600_000,
        stdoutPath: artifact("exec", "out"),
        stderrPath: artifact("exec", "err"),
      })],
    },
    {
      phase: "validate",
      failure_mode: "fail_closed",
      commands: [command({ id: "cycle-contract", script: script("cycle-contract.ts"), args: ["--ticket-id", "{{ticket_id}}"], env: productionEnv, effect: "read_only", requiredBindings: ["ticket_id"] })],
    },
    {
      phase: "housekeeping",
      failure_mode: "continue",
      commands: [
        command({ id: "plan-gate-monitor", script: script("plan-gate-evidence-monitor.ts"), args: ["--target", "30", "--stale-hours", "72", "--retention-days", "90"], env: productionEnv, effect: "state_write" }),
        command({ id: "approval-harvest", script: script("approval-ledger.ts"), args: ["harvest"], env: productionEnv, effect: "external_write" }),
        command({ id: "hold-notify", script: script("hold-notify.ts"), args: ["run"], env: productionEnv, effect: "state_write", stdoutPath: artifact("holds", "json") }),
        command({ id: "lever-board", script: script("lever-board.ts"), args: [], env: productionEnv, effect: "read_only" }),
        command({ id: "ship-ready", script: script("ship-ready-runner.ts"), args: ["run-ready", "--min-age-minutes", "0"], env: productionEnv, effect: "external_write", stdoutPath: artifact("shipping", "json"), stderrPath: artifact("shipping", "err"), timeoutMs: 1_800_000 }),
      ],
    },
    {
      phase: "pool_reconcile",
      failure_mode: "continue",
      commands: [command({
        id: "pool-manager-reconcile",
        script: script("pool-manager.ts"),
        args: ["reconcile", "--mode", "act"],
        env: { ...productionEnv, FACTORY_CODING_CASCADE: "enforce" },
        effect: "external_write",
        timeoutMs: 1_500_000,
      })],
    },
    {
      phase: "collect",
      failure_mode: "continue",
      commands: [
        command({ id: "factory-collect", script: script("factory-collect.ts"), args: ["tick"], env: { ...productionEnv, SF004_METRICS: "1" }, effect: "state_write" }),
        command({ id: "factory-slo", script: script("factory-slo.ts"), args: ["tick"], env: { ...productionEnv, SF005_SLO: "1" }, effect: "state_write" }),
        command({ id: "fleet-status", script: script("fleet-status.ts"), args: [], env: { ...productionEnv, SF008_FLEET: "1" }, effect: "external_read" }),
        command({ id: "scenario-status", script: script("scenario-run.ts"), args: ["status"], env: { ...productionEnv, SF009_SCENARIOS: "1" }, effect: "read_only" }),
        command({ id: "survivability-harvest", script: script("survivability-probe.ts"), args: ["harvest"], env: { ...productionEnv, SF012_SURVIVAL: "1" }, effect: "external_write" }),
        command({ id: "decision-signals-harvest", script: script("decision-signals.ts"), args: ["harvest"], env: { ...productionEnv, SF012_SURVIVAL: "1" }, effect: "state_write" }),
      ],
    },
    {
      phase: "cleanup",
      failure_mode: "continue",
      commands: [internal("cleanup-cycle-artifacts", "state_write")],
    },
    {
      phase: "report",
      failure_mode: "continue",
      commands: [internal("lane-utilization-record", "state_write")],
    },
  ];

  const unsigned: Omit<ConveyorAdapterCatalog, "catalog_hash"> = {
    schema_version: 1,
    factory_root: factoryRoot,
    scripts_dir: scriptsDir,
    runtime_config_script: runtimeConfigScript,
    state_dir: stateDir,
    artifact_root: artifactRoot,
    cycle_token: input.cycleToken,
    adapters,
  };
  const catalog = { ...unsigned, catalog_hash: sha256(canonicalJson(unsignedCatalog(unsigned))) };
  validateAdapterCatalog(catalog);
  return catalog;
}

export function validateAdapterCatalog(catalog: ConveyorAdapterCatalog): void {
  if (catalog.schema_version !== 1) throw new ConveyorRunnerError("adapter_schema_incompatible", "unsupported adapter schema");
  if (catalog.catalog_hash !== sha256(canonicalJson(unsignedCatalog(catalog)))) {
    throw new ConveyorRunnerError("adapter_hash_mismatch", "adapter catalog hash mismatch");
  }
  if (!isAbsolute(catalog.runtime_config_script) || catalog.runtime_config_script !== join(catalog.scripts_dir, "runtime-config.ts") || !existsSync(catalog.runtime_config_script)) {
    throw new ConveyorRunnerError("adapter_runtime_config_invalid", "adapter catalog requires the factory runtime-config.ts source");
  }
  if (catalog.adapters.length !== CONVEYOR_PHASES.length) {
    throw new ConveyorRunnerError("adapter_phase_count", "adapter catalog must cover every conveyor phase exactly once");
  }
  const commandIds = new Set<string>();
  for (const [index, adapter] of catalog.adapters.entries()) {
    if (adapter.phase !== CONVEYOR_PHASES[index]) {
      throw new ConveyorRunnerError("adapter_phase_order", `adapter ${adapter.phase} does not match phase ${CONVEYOR_PHASES[index]}`);
    }
    if (adapter.commands.length === 0) throw new ConveyorRunnerError("adapter_empty", `phase ${adapter.phase} has no adapter command`);
    for (const entry of adapter.commands) {
      if (commandIds.has(entry.id)) throw new ConveyorRunnerError("adapter_command_duplicate", `duplicate adapter command ${entry.id}`);
      commandIds.add(entry.id);
      if (!ADAPTER_EFFECTS.includes(entry.effect)) throw new ConveyorRunnerError("adapter_effect_invalid", `invalid effect for ${entry.id}`);
      if (!Number.isSafeInteger(entry.timeout_ms) || entry.timeout_ms <= 0) {
        throw new ConveyorRunnerError("adapter_timeout_invalid", `invalid timeout for ${entry.id}`);
      }
      if (entry.kind === "bun") {
        if (!entry.script || !isAbsolute(entry.script) || !entry.script.startsWith(`${catalog.scripts_dir}/`)) {
          throw new ConveyorRunnerError("adapter_script_invalid", `script for ${entry.id} escapes the factory scripts directory`);
        }
        if (!existsSync(entry.script)) throw new ConveyorRunnerError("adapter_script_missing", `adapter script is missing: ${entry.script}`);
        if (!entry.load_runtime_config) throw new ConveyorRunnerError("adapter_runtime_config_missing", `bun adapter ${entry.id} must load typed runtime configuration`);
      } else if (entry.script !== null) {
        throw new ConveyorRunnerError("adapter_script_invalid", `internal adapter ${entry.id} cannot name a script`);
      } else if (entry.load_runtime_config) {
        throw new ConveyorRunnerError("adapter_runtime_config_invalid", `internal adapter ${entry.id} cannot load runtime configuration directly`);
      }
      for (const binding of entry.required_bindings) {
        if (!/^[a-z][a-z0-9_]*$/.test(binding) || !entry.args.includes(`{{${binding}}}`)) {
          throw new ConveyorRunnerError("adapter_binding_invalid", `invalid or unused binding ${binding} for ${entry.id}`);
        }
      }
      for (const arg of entry.args) {
        const placeholders = [...arg.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]);
        if (placeholders.some((binding) => !entry.required_bindings.includes(binding))) {
          throw new ConveyorRunnerError("adapter_binding_invalid", `undeclared binding in ${entry.id}`);
        }
      }
      for (const value of [entry.stdout_path, entry.stderr_path]) {
        if (value !== null && (!isAbsolute(value) || !value.startsWith(`${catalog.artifact_root}/`))) {
          throw new ConveyorRunnerError("adapter_artifact_invalid", `artifact for ${entry.id} escapes the artifact root`);
        }
      }
    }
  }
}

function canExecute(policy: AdapterExecutionPolicy, command: ConveyorAdapterCommand): boolean {
  if (policy === "disabled") return false;
  if (command.kind === "internal") return false;
  return command.effect === "read_only" || command.effect === "external_read";
}

function materializeCommand(command: ConveyorAdapterCommand, bindings: Record<string, string>): ConveyorAdapterCommand {
  const resolved: Record<string, string> = {};
  for (const binding of command.required_bindings) {
    const value = bindings[binding];
    if (!value) {
      throw new ConveyorRunnerError("adapter_binding_missing", `safe binding ${binding} is required for ${command.id}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
      throw new ConveyorRunnerError("adapter_binding_unsafe", `binding ${binding} is not a path-safe argument token for ${command.id}`);
    }
    resolved[binding] = value;
  }
  return {
    ...command,
    args: command.args.map((arg) => command.required_bindings.reduce(
      (value, binding) => value.replaceAll(`{{${binding}}}`, resolved[binding]),
      arg,
    )),
  };
}

export async function executeAdapterPhase(input: {
  adapter: ConveyorPhaseAdapter;
  policy?: AdapterExecutionPolicy;
  executor?: AdapterCommandExecutor;
  bindings?: Record<string, string>;
}): Promise<AdapterPhaseRun> {
  const policy = input.policy ?? "disabled";
  if (!ADAPTER_EXECUTION_POLICIES.includes(policy)) {
    throw new ConveyorRunnerError("adapter_policy_invalid", `unsupported adapter policy ${String(policy)}`);
  }
  const runs: AdapterCommandRun[] = [];
  let failed = false;
  let commandFailed = false;
  let executed = 0;
  for (const entry of input.adapter.commands) {
    if (!canExecute(policy, entry)) {
      runs.push({ command_id: entry.id, status: policy === "disabled" ? "planned" : "blocked", effect: entry.effect, exit_code: null, stdout_hash: null, stderr_hash: null });
      continue;
    }
    if (!input.executor) throw new ConveyorRunnerError("adapter_executor_required", "read_only policy requires an injected executor");
    const result = await input.executor.run(materializeCommand(entry, input.bindings ?? {}));
    executed += 1;
    const status = result.exit_code === 0 ? "succeeded" : "failed";
    runs.push({ command_id: entry.id, status, effect: entry.effect, exit_code: result.exit_code, stdout_hash: result.stdout_hash, stderr_hash: result.stderr_hash });
    if (result.exit_code !== 0) {
      commandFailed = true;
      if (input.adapter.failure_mode === "fail_closed") {
        failed = true;
        break;
      }
    }
  }
  const event: AdapterPhaseRun["event"] = failed
    ? "failed"
    : input.adapter.failure_mode === "silent_stop" && commandFailed
      ? "skipped"
      : executed === 0 || runs.some((run) => run.status === "blocked")
        ? "skipped"
        : "succeeded";
  const reason = failed
    ? "read-only adapter command failed"
    : input.adapter.failure_mode === "silent_stop" && commandFailed
      ? "read-only adapter requested a silent stop"
      : input.adapter.failure_mode === "continue" && commandFailed
        ? "non-fatal read-only adapter command failed"
    : event === "skipped"
      ? policy === "disabled" ? "adapter execution disabled" : "mutation-capable or internal commands blocked"
      : null;
  const unsigned = { phase: input.adapter.phase, event, reason, commands: runs };
  return { ...unsigned, result_hash: sha256(canonicalJson(unsigned)) };
}

export async function runAdapterCycle(input: {
  mode: "off" | "shadow";
  cycleId?: string;
  idempotencyKey?: string;
  runnerStateDir?: string;
  catalog?: ConveyorAdapterCatalog;
  policy?: AdapterExecutionPolicy;
  executor?: AdapterCommandExecutor;
  bindings?: Record<string, string>;
  boundaryHook?: AdapterBoundaryHook;
}): Promise<ConveyorCycleSnapshot | null> {
  if (input.mode === "shadow") {
    if (!input.catalog || !input.cycleId) throw new ConveyorRunnerError("adapter_catalog_required", "shadow adapter cycles require a catalog and cycle id");
    validateAdapterCatalog(input.catalog);
  }
  const scaffold = runCycleScaffold({
    mode: input.mode,
    cycleId: input.cycleId,
    idempotencyKey: input.idempotencyKey,
    stateDir: input.runnerStateDir,
  });
  if (scaffold.mode === "off") return null;
  if (!input.catalog || !input.cycleId) throw new ConveyorRunnerError("adapter_catalog_required", "shadow adapter cycles require a catalog and cycle id");
  let state = scaffold.snapshot;
  if (!state) throw new ConveyorRunnerError("cycle_missing", "shadow cycle was not created");
  while (state.status === "ready" || state.status === "running") {
    const phase = state.open_phase ?? state.next_phase;
    if (!phase) break;
    const adapter = input.catalog.adapters[CONVEYOR_PHASES.indexOf(phase)];
    const inputHash = sha256(canonicalJson(adapter));
    await input.boundaryHook?.({ cycle_id: input.cycleId, phase, boundary: "before_start" });
    recordPhase({
      cycleId: input.cycleId,
      phase,
      event: "started",
      stateDir: input.runnerStateDir,
      transitionKey: `${input.cycleId}:${phase}:started:adapter-v1`,
      inputHash,
    });
    await input.boundaryHook?.({ cycle_id: input.cycleId, phase, boundary: "after_start" });
    const result = await executeAdapterPhase({ adapter, policy: input.policy, executor: input.executor, bindings: input.bindings });
    await input.boundaryHook?.({ cycle_id: input.cycleId, phase, boundary: "after_adapter" });
    recordPhase({
      cycleId: input.cycleId,
      phase,
      event: result.event,
      stateDir: input.runnerStateDir,
      transitionKey: `${input.cycleId}:${phase}:${result.event}:adapter-v1`,
      outputHash: result.result_hash,
      reason: result.reason,
      error: result.event === "failed" ? result.reason : null,
    });
    await input.boundaryHook?.({ cycle_id: input.cycleId, phase, boundary: "after_terminal" });
    state = inspectCycle(input.cycleId, input.runnerStateDir);
  }
  return state;
}
