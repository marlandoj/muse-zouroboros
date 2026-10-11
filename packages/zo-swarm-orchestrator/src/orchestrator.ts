/**
 * Main Swarm Orchestrator
 *
 * Coordinates task execution with circuit breakers, routing, and DAG execution.
 * Transport-agnostic: all executor communication goes through ExecutorTransport.
 *
 * Phase 1 extensions: Executor Selector, Budget Governor, Role Registry integration.
 * Phase 2 extensions: RAG Enrichment, Hierarchical Delegation wiring.
 * Phase 3 extensions: Pipeline enforcement gates (seed validation, post-flight eval, gap audit).
 */

import type { Task, TaskResult, SwarmConfig, ExecutorCapability, PipelineGateConfig } from './types.js';
import { CircuitBreakerRegistry } from './circuit/breaker.js';
import { RoutingEngine } from './routing/engine.js';
import { RoutingSignals } from './routing/signals.js';
import { loadRegistry, getAutoRoutableExecutors, getLocalExecutors } from './registry/loader.js';
import { DAGExecutor, ExecutionContext } from './dag/executor.js';
import { createTransport } from './transport/factory.js';
import type { ExecutorTransport } from './transport/types.js';
import { selectExecutor, inferComplexity, type BudgetSnapshot, type HealthSnapshot } from './selector/executor-selector.js';
import { resolveModelForExecutor } from './routing/model-router.js';
import { BudgetGovernor, type BudgetConfig } from './budget/governor.js';
import { RoleRegistry } from './roles/registry.js';
import { prefetchRAGForTasks } from './rag/index.js';
import { enrichTasksWithDomainContext } from './rag/domain-context.js';
import {
  evaluateDelegation,
  renderHierarchicalPolicyBlock,
  stripDelegationReport,
} from './hierarchical.js';
import { runGapAudit, type GapAuditReport } from './verification/gap-audit.js';
import {
  verifyTrace,
  createRealFsProbe,
  renderTraceVerifyReport,
  persistTraceVerifyReport,
  type TraceVerifyReport,
} from './verification/trace-verify.js';
import {
  runSmokeChecks,
  renderSmokeReport,
  persistSmokeReport,
  createRealDurableLogProbe,
  loadFeatureList,
  reconcileProgress,
  createRealFileProbe,
  type FeatureList,
} from './harness/index.js';
import {
  validateToolFit,
  storeValidation,
  deriveDefaultInputs,
} from 'zouroboros-selfheal';
import { runSwarmPlanGatePreflight } from './plan-gate-preflight.js';
import { createComputeDispatcher } from './compute/dispatcher.js';
import type { ProviderAdapter } from 'zouroboros-core';
import { resolvePortableHarness, type ResolvedPortableHarness } from './executor/portability.js';
import {
  consultSpecialists,
  renderSpecialistOutputs,
  resolveSpecialistConsultMode,
  type SpecialistConsultEvidence,
  type SpecialistConsultPhase,
} from './persona/specialist-consult.js';

const DEFAULT_PIPELINE_GATES: PipelineGateConfig = {
  seedValidation: true,
  postFlightEval: true,
  gapAuditLoop: true,
  blockOnSeedFailure: true,
};

const DEFAULT_CONFIG: SwarmConfig = {
  localConcurrency: 8,
  timeoutSeconds: 600,
  maxRetries: 3,
  enableMemory: true,
  dagMode: 'streaming',
  notifyOnComplete: 'none',
  routingStrategy: 'balanced',
  useSixSignalRouting: true,
  stagnationEnabled: true,
};

export class SwarmOrchestrator {
  private config: SwarmConfig;
  private circuitBreakers: CircuitBreakerRegistry;
  private routingSignals: RoutingSignals;
  private routingEngine: RoutingEngine;
  private transports: Map<string, ExecutorTransport>;
  private capabilities: ExecutorCapability[];
  private budgetGovernor: BudgetGovernor;
  private roleRegistry: RoleRegistry;
  private registryEntries: ReturnType<typeof getLocalExecutors>;
  private computeAdapters = new Map<string, ProviderAdapter>();
  private portableHarness?: ResolvedPortableHarness;

  private async consultTaskSpecialists(
    task: Task,
    phase: SpecialistConsultPhase,
    implementationOutput?: string,
    implementerModelName?: string,
  ) {
    const mode = resolveSpecialistConsultMode(task.specialistMode ?? this.config.specialistConsult?.mode);
    return consultSpecialists({
      mode,
      phase,
      taskId: task.id,
      task: task.task,
      implementationOutput,
      assignments: task.specialists ?? [],
      modelName: this.config.specialistConsult?.modelName ?? task.model,
      implementerModelName,
      reviewerPolicy: this.config.specialistConsult?.reviewerModels ? {
        candidates: this.config.specialistConsult.reviewerModels,
        requireDistinctModel: this.config.specialistConsult.requireDistinctReviewerModel,
        requireVendorDiversity: this.config.specialistConsult.requireReviewerVendorDiversity,
      } : undefined,
      timeoutMs: this.config.specialistConsult?.timeoutMs,
    });
  }

  constructor(config: Partial<SwarmConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.circuitBreakers = new CircuitBreakerRegistry();
    this.transports = new Map();
    this.capabilities = [];
    this.registryEntries = [];
    this.budgetGovernor = new BudgetGovernor(this.config.dbPath);
    this.roleRegistry = new RoleRegistry(this.config.dbPath);
    this.portableHarness = process.env.SWARM_HARNESS
      ? resolvePortableHarness({ explicitHarness: process.env.SWARM_HARNESS })
      : undefined;

    this.initializeTransports();

    this.routingSignals = new RoutingSignals(this.config.dbPath);
    this.routingEngine = new RoutingEngine({
      strategy: this.config.routingStrategy,
      useSixSignal: this.config.useSixSignalRouting,
      circuitBreakers: this.circuitBreakers,
      executorCapabilities: this.capabilities,
      signals: this.routingSignals,
    });
  }

  getPortableHarness(): ResolvedPortableHarness | undefined {
    return this.portableHarness;
  }

  private initializeTransports(): void {
    const registry = loadRegistry();
    const localExecutors = getLocalExecutors(registry);
    const autoRoutableExecutors = getAutoRoutableExecutors(registry);
    this.registryEntries = autoRoutableExecutors;

    for (const entry of localExecutors) {
      const cb = this.circuitBreakers.get(entry.id);
      const transport = createTransport(entry, cb);
      this.transports.set(entry.id, transport);

      if (autoRoutableExecutors.includes(entry)) {
        this.capabilities.push({
          id: entry.id,
          name: entry.name,
          expertise: entry.expertise,
          bestFor: entry.bestFor,
          isLocal: true,
        });
      }
    }
  }

  private resolveExecutor(task: Task): { executorId: string; model?: string; fallbacks: string[] } {
    const health: HealthSnapshot = {};
    const cbStatus = this.circuitBreakers.getStatus();
    for (const [id, state] of Object.entries(cbStatus)) {
      health[id] = { state: state.state, failures: state.failures };
    }

    let budget: BudgetSnapshot | null = null;
    try {
      const budgetState = this.budgetGovernor.getState('current');
      if (budgetState.totalBudgetUSD > 0) {
        budget = {
          totalSpentUSD: budgetState.totalSpentUSD,
          totalBudgetUSD: budgetState.totalBudgetUSD,
          perExecutor: budgetState.perExecutor,
        };
      }
    } catch {}

    let roleResolution = null;
    if (task.role) {
      roleResolution = this.roleRegistry.resolve(task.role);
    }

    const selection = selectExecutor(task, budget, health, this.registryEntries, roleResolution, this.routingEngine);
    return {
      executorId: selection.executorId,
      model: this.resolveModelFor(task, selection.executorId, selection.model) ?? selection.model,
      fallbacks: selection.fallbacks,
    };
  }

  private resolveModelFor(task: Task, executorId: string, roleModel?: string): string | undefined {
    const entry = this.registryEntries.find(candidate => candidate.id === executorId);
    const effectiveRoleModel = roleModel
      ?? (task.role ? this.roleRegistry.resolve(task.role)?.model : undefined);
    return resolveModelForExecutor(
      task,
      executorId,
      inferComplexity(task),
      entry,
      effectiveRoleModel,
    )?.model;
  }

  initBudget(config: Omit<BudgetConfig, 'swarmId'> & { swarmId?: string }): void {
    this.budgetGovernor.initSwarm({ swarmId: config.swarmId ?? 'current', ...config });
  }

  getBudgetState(swarmId: string = 'current'): ReturnType<BudgetGovernor['getState']> {
    return this.budgetGovernor.getState(swarmId);
  }

  getBudgetGovernor(): BudgetGovernor {
    return this.budgetGovernor;
  }

  registerComputeAdapter(adapter: ProviderAdapter): void {
    this.computeAdapters.set(adapter.provider, adapter);
  }

  getRoleRegistry(): RoleRegistry {
    return this.roleRegistry;
  }

  getRoutingEngine(): RoutingEngine {
    return this.routingEngine;
  }

  /**
   * Preflight data checks — lightweight runtime validation before dispatch.
   * Returns warnings (non-blocking) and errors (blocking if strict mode).
   */
  preflightDataChecks(): { warnings: string[]; errors: string[] } {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Check 1: At least one transport registered
    if (this.transports.size === 0) {
      errors.push('No executor transports registered — tasks cannot be dispatched');
    }

    // Check 2: RoleRegistry populated (warn if empty, tasks with role: will fallback)
    try {
      const roleCount = this.roleRegistry.count();
      if (roleCount === 0) {
        warnings.push('RoleRegistry is empty — role-based routing will fall through to tag heuristics. Run persona seeder to populate.');
      }
    } catch {
      warnings.push('Could not query RoleRegistry — role-based routing unavailable');
    }

    // Check 3: Circuit breakers not all OPEN
    const cbStatus = this.circuitBreakers.getStatus();
    const allOpen = Object.values(cbStatus).every(s => s.state === 'OPEN');
    if (Object.keys(cbStatus).length > 0 && allOpen) {
      errors.push('All circuit breakers are OPEN — no healthy executors available');
    }

    return { warnings, errors };
  }

  private getPipelineGates(): PipelineGateConfig {
    return { ...DEFAULT_PIPELINE_GATES, ...this.config.pipelineGates };
  }

  /**
   * Seed Validation Gate — runs gap audit before execution.
   * Returns critical gaps found. Blocks execution if blockOnSeedFailure is true.
   */
  seedValidationGate(): { passed: boolean; report: GapAuditReport; criticalGaps: string[] } {
    console.log('\n  [SEED GATE] Running pre-execution seed validation...');
    const report = runGapAudit();
    const criticalGaps = report.gaps
      .filter(g => g.severity === 'critical')
      .map(g => `[${g.capabilityId}] ${g.message}`);

    if (criticalGaps.length > 0) {
      console.error(`  [SEED GATE] ❌ ${criticalGaps.length} critical gap(s) found:`);
      for (const gap of criticalGaps) {
        console.error(`    • ${gap}`);
      }
    } else {
      console.log(`  [SEED GATE] ✅ Passed (${report.summary.totalCapabilities} capabilities verified, ${report.gaps.length} non-critical warnings)`);
    }

    return { passed: report.passed, report, criticalGaps };
  }

  /**
   * Post-flight evaluation — analyzes execution results for quality signals.
   * Returns a structured report of successes, failures, and fallback usage.
   */
  postFlightEval(results: TaskResult[]): {
    passed: boolean;
    successRate: number;
    fallbacksUsed: number;
    failedTasks: string[];
    report: string;
    traceVerify?: TraceVerifyReport;
  } {
    console.log('\n  [POST-FLIGHT] Running post-flight evaluation...');

    // ── Trace-verify (declared-success vs on-disk ground truth) ──
    // SWARM_TRACE_VERIFY: report pass, default ON, non-blocking.
    // SWARM_TRACE_VERIFY_ENFORCE: default OFF — a critical trace violation flips
    // that task's counted success → false in the tally (enforce_target = A).
    // Both flags off ⇒ this block is inert and the tally is byte-identical.
    const traceVerifyOn =
      process.env.SWARM_TRACE_VERIFY !== '0' &&
      process.env.SWARM_TRACE_VERIFY !== 'false';
    const enforceOn =
      process.env.SWARM_TRACE_VERIFY_ENFORCE === '1' ||
      process.env.SWARM_TRACE_VERIFY_ENFORCE === 'true';
    let traceVerify: TraceVerifyReport | undefined;
    const enforcedFailIds = new Set<string>();
    if (traceVerifyOn) {
      traceVerify = verifyTrace(results, createRealFsProbe());
      if (enforceOn) {
        for (const v of traceVerify.violations) {
          if (v.severity === 'critical') enforcedFailIds.add(v.taskId);
        }
      }
    }
    // Enforced verification must reach API/CLI callers, not only the tally.
    // Advisory mode deliberately preserves the original result.
    for (const result of results) {
      if (result.success && enforcedFailIds.has(result.task.id)) {
        result.success = false;
        const violations = traceVerify?.violations.filter(v => v.taskId === result.task.id && v.severity === 'critical') ?? [];
        result.error = `Post-flight verification failed: ${violations.map(v => v.message).join('; ')}`;
      }
    }
    const isSuccess = (r: TaskResult): boolean => r.success;

    const successCount = results.filter(isSuccess).length;
    const failCount = results.length - successCount;
    const successRate = results.length > 0 ? successCount / results.length : 0;
    const fallbacksUsed = results.filter(r => (r.fallbacksAttempted ?? 0) > 0).length;
    const failedTasks = results.filter(r => !isSuccess(r)).map(r => r.task.id);
    const genuineFailed = results.filter(r => !r.success);

    const lines: string[] = [
      `Post-Flight Evaluation Report`,
      `  Total tasks: ${results.length}`,
      `  Successes: ${successCount} (${(successRate * 100).toFixed(1)}%)`,
      `  Failures: ${failCount}`,
      `  Tasks using fallback executors: ${fallbacksUsed}`,
    ];

    if (genuineFailed.length > 0) {
      lines.push(`  Failed tasks:`);
      for (const result of genuineFailed) {
        const fb = result.fallbacksAttempted ? ` (${result.fallbacksAttempted} fallbacks tried)` : '';
        lines.push(`    • ${result.task.id}: ${result.error?.slice(0, 150)}${fb}`);
      }
    }

    for (const result of results.filter(r => (r.fallbacksAttempted ?? 0) > 0 && r.success)) {
      lines.push(`  [RECOVERY] Task "${result.task.id}" succeeded via fallback executor "${result.effectiveExecutor}" after ${result.fallbacksAttempted} fallback(s)`);
    }

    // ── Trace-verify report section (only when enabled — keeps flag-off byte-identical) ──
    if (traceVerifyOn && traceVerify) {
      const s = traceVerify.summary;
      lines.push(
        `  [TRACE-VERIFY] ${traceVerify.checkedResults}/${traceVerify.totalResults} declared-success checked — ` +
          `${s.critical} critical, ${s.warning} warning, ${s.info} info`,
      );
      if (enforceOn && enforcedFailIds.size > 0) {
        lines.push(
          `  [TRACE-VERIFY] ENFORCE: ${enforcedFailIds.size} task(s) flipped success→fail on critical trace violations: ${[...enforcedFailIds].join(', ')}`,
        );
      }
    }

    // ── Feature-list reconciliation (roadmap §10; advisory — never changes tally) ──
    // Fires only when SWARM_FEATURE_LIST points at a loadable spec. Maps declared
    // features → landed vs missing against the actual results. Report-only.
    let reconcile: ReturnType<typeof reconcileProgress> | undefined;
    const flPath = process.env.SWARM_FEATURE_LIST;
    if (flPath) {
      try {
        const featureList = loadFeatureList(flPath, createRealFileProbe());
        reconcile = reconcileProgress(featureList, results);
        lines.push(
          `  [FEATURE-LIST] "${reconcile.campaign}": ${reconcile.landed.length}/${reconcile.total} landed` +
            (reconcile.missing.length > 0 ? ` — missing: ${reconcile.missing.join(', ')}` : ' — all delivered'),
        );
      } catch (err) {
        lines.push(`  [FEATURE-LIST] reconcile skipped — spec at ${flPath} unreadable: ${err}`);
      }
    }

    const report = lines.join('\n');
    const passed = successRate >= 0.5; // At least 50% success rate to consider the run viable

    if (passed) {
      console.log(`  [POST-FLIGHT] ✅ Passed — ${(successRate * 100).toFixed(1)}% success rate`);
    } else {
      console.error(`  [POST-FLIGHT] ❌ Failed — ${(successRate * 100).toFixed(1)}% success rate (threshold: 50%)`);
    }

    // ── Trace-verify console render + artifact persist (advisory; enforce flips tally only) ──
    if (traceVerifyOn && traceVerify) {
      const s = traceVerify.summary;
      const icon = s.critical > 0 ? '❌' : s.warning > 0 ? '⚠' : '✅';
      console.log(
        `  [TRACE-VERIFY] ${icon} ${traceVerify.checkedResults}/${traceVerify.totalResults} declared-success checked — ` +
          `${s.critical} critical, ${s.warning} warning, ${s.info} info${enforceOn ? ' (ENFORCE on)' : ' (advisory)'}`,
      );
      if (traceVerify.violations.length > 0) {
        console.log(renderTraceVerifyReport(traceVerify));
      }
      try {
        const path = persistTraceVerifyReport(traceVerify);
        console.log(`  [TRACE-VERIFY] report written to ${path}`);
      } catch (err) {
        console.log(`  [TRACE-VERIFY] artifact persist failed (non-blocking): ${err}`);
      }
    }

    // ── Feature-list reconcile console render (advisory) ──
    if (reconcile) {
      const icon = reconcile.passed ? '✅' : '⚠';
      console.log(
        `  [FEATURE-LIST] ${icon} "${reconcile.campaign}": ${reconcile.landed.length}/${reconcile.total} landed` +
          (reconcile.missing.length > 0 ? `, missing: ${reconcile.missing.join(', ')}` : ''),
      );
    }

    return { passed, successRate, fallbacksUsed, failedTasks, report, traceVerify };
  }

  /**
   * Post-execution gap audit loop — runs the 4-question gap audit after execution.
   * Logs findings but does not block (informational for the caller).
   */
  postExecutionGapAudit(): GapAuditReport {
    console.log('\n  [GAP AUDIT] Running post-execution gap audit loop...');
    const report = runGapAudit();

    const criticals = report.gaps.filter(g => g.severity === 'critical');
    const warnings = report.gaps.filter(g => g.severity === 'warning');

    if (criticals.length === 0 && warnings.length === 0) {
      console.log(`  [GAP AUDIT] ✅ All 3 checks passed — no gaps found`);
    } else {
      if (criticals.length > 0) {
        console.error(`  [GAP AUDIT] ❌ ${criticals.length} critical gap(s):`);
        for (const g of criticals) {
          console.error(`    • [${g.category}] ${g.message}`);
          console.error(`      → ${g.remediation}`);
        }
      }
      if (warnings.length > 0) {
        console.log(`  [GAP AUDIT] ⚠ ${warnings.length} warning(s):`);
        for (const g of warnings) {
          console.log(`    • [${g.category}] ${g.message}`);
        }
      }
    }

    return report;
  }

  async run(tasks: Task[]): Promise<TaskResult[]> {
    const gates = this.getPipelineGates();
    // Model attribution: every task in this run shares one run id so the
    // ledger can answer "which model executed which task".
    const runId = `swarm_${Date.now()}`;
    console.log(`Starting swarm execution with ${tasks.length} tasks`);
    console.log(`Run id: ${runId}`);
    console.log(`Mode: ${this.config.dagMode}, Concurrency: ${this.config.localConcurrency}`);
    console.log(`Pipeline gates: seed=${gates.seedValidation}, postFlight=${gates.postFlightEval}, gapAudit=${gates.gapAuditLoop}`);

    // Pre-flight 0: Data checks
    const { warnings, errors } = this.preflightDataChecks();
    for (const w of warnings) console.log(`  [PREFLIGHT WARN] ${w}`);
    for (const e of errors) console.error(`  [PREFLIGHT ERROR] ${e}`);
    if (errors.length > 0) {
      console.error('  Pre-flight errors detected — aborting swarm execution');
      return tasks.map(task => ({
        task,
        success: false,
        error: `Pre-flight failed: ${errors.join('; ')}`,
        durationMs: 0,
        retries: 0,
      }));
    }

    const planGate = runSwarmPlanGatePreflight(this.config.planGate);
    console.log(`  [PLAN GATE:${planGate.mode}] ${planGate.action.toUpperCase()} - ${planGate.reason}`);
    if (planGate.auditError) console.log(`  [PLAN GATE WARN] audit failed: ${planGate.auditError}`);
    if (planGate.action === 'hold') {
      return tasks.map(task => ({
        task,
        success: false,
        error: `Plan gate held execution: ${planGate.reason}`,
        durationMs: 0,
        retries: 0,
      }));
    }

    // Pre-flight 0.25: Per-session harness smoke test (roadmap §10).
    // SWARM_HARNESS_SMOKE: advisory, default ON — reports, never blocks.
    // SWARM_HARNESS_SMOKE_ENFORCE: default OFF — a CRITICAL smoke finding aborts
    // before execution (same shape as blockOnSeedFailure). Both off ⇒ this block
    // is inert and run() is byte-identical.
    const smokeOn =
      process.env.SWARM_HARNESS_SMOKE !== '0' && process.env.SWARM_HARNESS_SMOKE !== 'false';
    if (smokeOn) {
      let featureList: FeatureList | null = null;
      const flPath = process.env.SWARM_FEATURE_LIST;
      if (flPath) {
        try {
          featureList = loadFeatureList(flPath, createRealFileProbe());
        } catch (err) {
          console.log(`  [SMOKE] ⚠ feature-list at ${flPath} failed to load: ${err}`);
        }
      }
      const smoke = runSmokeChecks(
        {
          featureList,
          transportCount: this.transports.size,
          flags: {
            SWARM_HARNESS_SMOKE: process.env.SWARM_HARNESS_SMOKE,
            SWARM_HARNESS_SMOKE_ENFORCE: process.env.SWARM_HARNESS_SMOKE_ENFORCE,
            SWARM_TRACE_VERIFY: process.env.SWARM_TRACE_VERIFY,
            SWARM_TRACE_VERIFY_ENFORCE: process.env.SWARM_TRACE_VERIFY_ENFORCE,
          },
        },
        createRealDurableLogProbe(this.config.dbPath),
      );
      const enforceSmoke =
        process.env.SWARM_HARNESS_SMOKE_ENFORCE === '1' ||
        process.env.SWARM_HARNESS_SMOKE_ENFORCE === 'true';
      const icon = smoke.summary.critical > 0 ? '❌' : smoke.summary.warning > 0 ? '⚠' : '✅';
      console.log(
        `  [SMOKE] ${icon} ${smoke.summary.critical} critical, ${smoke.summary.warning} warning, ${smoke.summary.info} info${enforceSmoke ? ' (ENFORCE on)' : ' (advisory)'}`,
      );
      if (smoke.summary.critical > 0 || smoke.summary.warning > 0) {
        console.log(renderSmokeReport(smoke));
      }
      try {
        persistSmokeReport(smoke);
      } catch {
        // non-blocking
      }
      if (enforceSmoke && !smoke.passed) {
        const crits = smoke.findings
          .filter(f => f.severity === 'critical')
          .map(f => f.message)
          .join('; ');
        console.error('  [SMOKE] ENFORCE: critical harness smoke failure — aborting before execution');
        return tasks.map(task => ({
          task,
          success: false,
          error: `Harness smoke failed: ${crits}`,
          durationMs: 0,
          retries: 0,
        }));
      }
    }

    // Pre-flight 0.5: Seed Validation Gate (mandatory by default)
    if (gates.seedValidation) {
      const seedResult = this.seedValidationGate();
      if (!seedResult.passed && gates.blockOnSeedFailure) {
        console.error('  [SEED GATE] Blocking execution — critical gaps must be resolved first');
        return tasks.map(task => ({
          task,
          success: false,
          error: `Seed validation failed: ${seedResult.criticalGaps.join('; ')}`,
          durationMs: 0,
          retries: 0,
        }));
      }
    } else {
      console.log('  [SEED GATE] ⚠ SKIPPED (pipelineGates.seedValidation = false)');
    }

    // Pre-flight 1: Resolve executors for all tasks via Executor Selector
    for (const task of tasks) {
      if (task.compute) continue;
      const resolved = this.resolveExecutor(task);
      task.executor = resolved.executorId;
      if (!task.fallbackExecutors?.length) task.fallbackExecutors = resolved.fallbacks;
    }

    // Pre-flight 1.5: Schema-fit pre-check (M10 W3 t7 — GRETEL-pattern proxy)
    // For each role-bound task, derive default inputs if absent and check
    // them against role.inputs schema. Warn-mode by default — never blocks.
    let validationsPass = 0, validationsWarn = 0, validationsSkipped = 0;
    for (const task of tasks) {
      if (!task.role) { validationsSkipped++; continue; }
      const role = this.roleRegistry.get(task.role);
      if (!role || !role.inputs || Object.keys(role.inputs).length === 0) {
        validationsSkipped++;
        continue;
      }
      if (!task.inputs) {
        task.inputs = deriveDefaultInputs(task.task, {
          ragContext: task.ragContext,
          tags: task.memoryMetadata?.tags,
        });
      }
      const result = validateToolFit(
        task.executor || 'unknown',
        task.inputs,
        role.inputs as Record<string, unknown>,
      );
      try {
        storeValidation({
          toolName: task.executor || 'unknown',
          roleId: role.id,
          taskId: task.id,
          outcome: result.outcome,
          score: result.score,
          missingKeys: result.missingKeys,
          typeMismatches: result.typeMismatches,
          persona: task.persona,
        });
      } catch {}
      if (result.outcome === 'pass') validationsPass++;
      else {
        validationsWarn++;
        console.log(`  [SCHEMA-FIT WARN] ${task.id} (role=${role.id}): ${result.message}`);
      }
    }
    if (validationsPass + validationsWarn > 0) {
      console.log(`  [SCHEMA-FIT] ${validationsPass} pass, ${validationsWarn} warn, ${validationsSkipped} skipped (no role/schema)`);
    }

    // Pre-flight 2: RAG enrichment (inject memory context into prompts)
    if (this.config.ragEnrichment?.enabled !== false && this.config.enableMemory) {
      try {
        const ragOptions = {
          topK: this.config.ragEnrichment?.topK,
          minScore: this.config.ragEnrichment?.minScore,
          collections: this.config.ragEnrichment?.collections,
        };
        const ragMap = await prefetchRAGForTasks(tasks, ragOptions);
        let enrichedCount = 0;
        for (const task of tasks) {
          const ctx = ragMap.get(task.id);
          if (ctx) {
            task.ragContext = ctx;
            task.task = ctx + '\n\n' + task.task;
            enrichedCount++;
          }
        }
        if (enrichedCount > 0) {
          console.log(`  [RAG] Enriched ${enrichedCount}/${tasks.length} tasks with memory context`);
        }
      } catch (err) {
        console.log(`  [RAG] Pre-flight enrichment failed (non-blocking): ${err}`);
      }
    }

    // Pre-flight 2.5: Domain context injection (operational context from memory system)
    if (this.config.enableMemory) {
      try {
        const { enrichedCount, domain } = enrichTasksWithDomainContext(tasks);
        if (enrichedCount > 0) {
          console.log(`  [DOMAIN CTX] Injected ${domain} context into ${enrichedCount}/${tasks.length} tasks`);
        }
      } catch (err) {
        console.log(`  [DOMAIN CTX] Domain context injection failed (non-blocking): ${err}`);
      }
    }

    const specialistEvidence = new Map<string, SpecialistConsultEvidence[]>();
    const specialistCosts = new Map<string, number>();
    for (const task of tasks) {
      if (!task.specialists?.some((assignment) => assignment.phases.includes('advise'))) continue;
      const advice = await this.consultTaskSpecialists(task, 'advise');
      specialistEvidence.set(task.id, [...advice.evidence]);
      specialistCosts.set(task.id, advice.totalCostUsd);
      if (!advice.ok) {
        return tasks.map(candidate => ({
          task: candidate,
          success: false,
          error: candidate.id === task.id
            ? `Required specialist advice failed: ${advice.blockedReason}`
            : `Swarm held because required specialist advice failed for ${task.id}`,
          durationMs: 0,
          retries: 0,
          specialistEvidence: specialistEvidence.get(candidate.id),
          specialistCostUsd: specialistCosts.get(candidate.id),
        }));
      }
      const rendered = renderSpecialistOutputs(advice);
      if (advice.mode === 'enforce' && rendered) {
        task.task = `## Specialist Advice\n${rendered}\n\n## Primary Task\n${task.task}`;
      }
    }

    // Pre-flight 3: Hierarchical delegation policy injection
    if (this.config.hierarchicalDelegation?.enabled) {
      for (const task of tasks) {
        const executorId = task.executor || 'claude-code';
        const decision = evaluateDelegation(task, executorId, {
          hierarchicalDelegation: this.config.hierarchicalDelegation,
        });
        const policyBlock = renderHierarchicalPolicyBlock(task, executorId, decision);
        if (policyBlock) {
          task.task = policyBlock + task.task;
        }
      }
    }

    const budgetGov = this.budgetGovernor;

    const context: ExecutionContext = {
      config: this.config,
      getExecutor: (id: string) => {
        try {
          const state = budgetGov.getState('current');
          if (state.capReached && state.hardCapAction === 'downgrade') {
            const target = budgetGov.getDowngradeTarget(id);
            const transport = this.transports.get(target.executorId);
            if (transport) return transport;
          }
        } catch {}
        return this.transports.get(id);
      },
      resolveModel: (task: Task, executorId: string) => this.resolveModelFor(task, executorId),
      computeDispatcher: createComputeDispatcher({
        policy: this.config.computeRouting,
        adapters: this.computeAdapters,
      }),
    };

    const dag = new DAGExecutor(tasks, context);
    const results = await dag.execute(this.config.dagMode);

    for (const result of results) {
      const evidence = specialistEvidence.get(result.task.id) ?? [];
      let cost = specialistCosts.get(result.task.id) ?? 0;
      if (result.success && result.task.specialists?.some((assignment) => assignment.phases.includes('review'))) {
        const review = await this.consultTaskSpecialists(
          result.task,
          'review',
          result.output ?? '',
          result.modelUsed ?? result.task.model,
        );
        evidence.push(...review.evidence);
        cost += review.totalCostUsd;
        if (!review.ok) {
          result.success = false;
          result.error = `Required specialist review failed: ${review.blockedReason}`;
        }
      }
      if (evidence.length > 0) result.specialistEvidence = evidence;
      if (cost > 0) result.specialistCostUsd = cost;
    }

    // Post-flight 1: Strip hierarchical delegation reports from results
    if (this.config.hierarchicalDelegation?.enabled) {
      for (const result of results) {
        if (result.output) {
          const parsed = stripDelegationReport(result.output);
          result.output = parsed.cleanOutput;
          result.childRecords = parsed.childRecords;
          result.artifacts = [...(result.artifacts || []), ...parsed.artifacts];
          result.delegated = parsed.delegated;
        }
      }
    }

    // Post-flight 2: Record budget usage + model attribution from results.
    // Attribution rows are written for EVERY task (even with zero reported
    // tokens) so the ledger always shows which model executed which task.
    for (const result of results) {
      const executor = result.effectiveExecutor ?? result.task.executor ?? 'claude-code';
      const model = result.modelUsed
        ?? this.resolveModelFor(result.task, executor)
        ?? result.task.model
        ?? 'sonnet';
      const bridgeReported = result.inputTokens != null && result.outputTokens != null;
      const tokens = result.tokensUsed ?? 0;
      const inputTokens = bridgeReported ? result.inputTokens! : Math.round(tokens * 0.7);
      const outputTokens = bridgeReported ? result.outputTokens! : Math.round(tokens * 0.3);
      budgetGov.recordUsage('current', executor, model, inputTokens, outputTokens, {
        runId,
        label: result.task.id,
        estimated: !bridgeReported,
      });
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    console.log(`\nSwarm execution complete:`);
    console.log(`  Success: ${successCount}/${tasks.length}`);
    console.log(`  Failed: ${failCount}/${tasks.length}`);

    const feedbackFailures = new Set(results.filter(result => !result.success).map(result => result.task.id));

    // Post-flight 3: Post-flight evaluation (mandatory by default)
    if (gates.postFlightEval) {
      const evalResult = this.postFlightEval(results);
      for (const id of evalResult.failedTasks) feedbackFailures.add(id);
      if (!evalResult.passed) {
        console.error(`  [POST-FLIGHT] Swarm run has low success rate (${(evalResult.successRate * 100).toFixed(1)}%)`);
      }
    } else {
      console.log('  [POST-FLIGHT] ⚠ SKIPPED (pipelineGates.postFlightEval = false)');
    }

    // Post-flight 4: Gap audit loop (mandatory by default)
    if (gates.gapAuditLoop) {
      this.postExecutionGapAudit();
    } else {
      console.log('  [GAP AUDIT] ⚠ SKIPPED (pipelineGates.gapAuditLoop = false)');
    }

    for (const result of results) {
      const executor = result.effectiveExecutor ?? result.task.executor;
      if (executor && !result.task.compute) {
        this.routingSignals.record(executor, result.task, !feedbackFailures.has(result.task.id));
      }
    }
    return results;
  }

  getCircuitBreakerStatus(): Record<string, { state: string; failures: number }> {
    const status = this.circuitBreakers.getStatus();
    const simplified: Record<string, { state: string; failures: number }> = {};

    for (const [id, state] of Object.entries(status)) {
      simplified[id] = {
        state: state.state,
        failures: state.failures,
      };
    }

    return simplified;
  }

  resetCircuitBreakers(): void {
    this.circuitBreakers.resetAll();
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.transports.values()].map(t => t.shutdown()));
  }
}
