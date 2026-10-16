/**
 * Decision factory — Track 2 CI gate.
 *
 * Stage 1: unit tests for the record schema/store and the tier policy engine.
 * Stage 2: the adversarial authority-eval suite must be green.
 * Stage 3: empirical wire tests. A mock ACP adapter issues real
 *          `session/request_permission` requests over stdio, and the tests
 *          assert the verdict the adapter observes AND the records the store
 *          holds. This includes the locked-Q4 verification: a dispatch
 *          through the ExecutorClient → ACPTransport seam (the exact path the
 *          factory's harness-router lazy-imports) traverses
 *          requestPermission() — proven on the wire, not from the call graph.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileDecisionRecordStore,
  MemoryDecisionRecordStore,
  type DecisionRecord,
} from '../decision-record.js';
import {
  DEFAULT_TIER_POLICY,
  DecisionGate,
  classifyBlastRadius,
  escalateTier,
  resolveDecisionOrigin,
  tierFor,
  type TierPolicy,
} from '../approval-tiers.js';
import { runAuthorityEvalSuite } from '../authority-eval.js';
import { ACPTransport } from '../transport/acp-transport.js';
import { ExecutorClient } from '../client/executor-client.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import type { ExecutorRegistryEntry, Task } from '../types.js';

const PERMISSION_ADAPTER = `${import.meta.dir}/fixtures/mock-acp-permission-adapter.ts`;

const acpEntry = {
  id: 'claude-code',
  name: 'Claude Code',
  executor: 'local',
  bridge: 'Skills/zo-swarm-executors/bridges/claude-code-bridge.sh',
  description: 'test',
  expertise: ['code-generation'],
  bestFor: ['test'],
  config: { defaultTimeout: 600, model: null, envVars: {} },
  healthCheck: { command: 'true', expectedPattern: '', description: 'test' },
  transport: 'acp' as const,
  acp: { adapterBin: 'bun' },
} as ExecutorRegistryEntry;

function makeCB() {
  return new CircuitBreaker({ id: 'test', cooldownMs: 0, failureThreshold: 5 });
}

function permissionTransport(store: MemoryDecisionRecordStore, policy?: TierPolicy) {
  return new ACPTransport(acpEntry, makeCB(), {
    adapterBin: 'bun',
    adapterArgs: [PERMISSION_ADAPTER],
    decisions: { store, ...(policy ? { policy } : {}) },
  });
}

function task(prompt: string, persona = 'probe-persona'): Task {
  return { id: `task-${Math.random().toString(36).slice(2)}`, persona, task: prompt, priority: 'low' };
}

/**
 * Hermetic dispatch env: the mock entry declares no ACP model selection, so a
 * SWARM_RESOLVED_MODEL/SWARM_PROVIDER inherited from the outer shell would
 * fail the session before the permission round-trip under test.
 */
function hermeticEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { SWARM_RESOLVED_MODEL: '', SWARM_PROVIDER: '', ...extra };
}

// ─── Stage 1: schema + store ─────────────────────────────────────────────────

describe('decision record store', () => {
  test('file store round-trips records and events through append-only JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decision-records-'));
    try {
      const store = new FileDecisionRecordStore(join(dir, 'decisions.jsonl'));
      const gate = new DecisionGate({ store, actor: 'p1', origin: 'swarm', authority: 'delegate' });
      const approved = gate.decide({ kind: 'tool_call', tool: 'Read', summary: 'read', target: '/a' }, 'read');
      const denied = gate.decide({ kind: 'tool_call', tool: 'Delete', summary: 'rm', target: '/b' }, 'delete');

      const records = store.records();
      expect(records.map(r => r.decision_id).sort()).toEqual([approved.decision_id, denied.decision_id].sort());
      const stored = records.find(r => r.decision_id === approved.decision_id)!;
      expect(stored.schema_version).toBe(1);
      expect(stored.actor).toBe('p1');
      expect(stored.outcome).toBe('approved');
      expect(stored.decided_by).toBe(`policy:${DEFAULT_TIER_POLICY.policy_version}`);
      expect(stored.policy_version).toBe(DEFAULT_TIER_POLICY.policy_version);

      const eventTypes = store.events().map(e => e.type);
      expect(eventTypes).toContain('proposed');
      expect(eventTypes).toContain('tier_assigned');
      expect(eventTypes).toContain('approved');
      expect(eventTypes).toContain('denied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every record carries the accountability fields the contract names', () => {
    const store = new MemoryDecisionRecordStore();
    const gate = new DecisionGate({
      store,
      actor: 'p1',
      origin: 'factory',
      authority: 'delegate',
      traceId: 'trace-1',
      taskId: 'task-1',
    });
    const record = gate.decide({ kind: 'executor_dispatch', tool: 'claude-code', target: '/wt', summary: 'dispatch' });
    expect(record.decision_id).toBeTruthy();
    expect(record.actor).toBe('p1');
    expect(record.tier).toBe('delegate');
    expect(record.blast_radius).toBe('delegated');
    expect(record.proposed_action.tool).toBe('claude-code');
    expect(record.outcome).toBe('approved');
    expect(record.decided_by).toContain('delegated:');
    expect(Date.parse(record.decided_at)).toBeGreaterThan(0);
    expect(Date.parse(record.created_at)).toBeGreaterThan(0);
    expect(record.trace_id).toBe('trace-1');
    expect(record.task_id).toBe('task-1');
    expect(record.origin).toBe('factory');
  });
});

// ─── Stage 1: tier policy engine ─────────────────────────────────────────────

describe('approval tiers', () => {
  test('classification maps kinds to blast radii and unknowns to destructive', () => {
    const read = { kind: 'tool_call' as const, tool: 'Read', summary: 'r' };
    expect(classifyBlastRadius(DEFAULT_TIER_POLICY, read, 'read')).toBe('read_only');
    expect(classifyBlastRadius(DEFAULT_TIER_POLICY, read, 'edit')).toBe('local_write');
    expect(classifyBlastRadius(DEFAULT_TIER_POLICY, read, 'fetch')).toBe('network');
    expect(classifyBlastRadius(DEFAULT_TIER_POLICY, read, 'execute')).toBe('delegated');
    expect(classifyBlastRadius(DEFAULT_TIER_POLICY, read, 'delete')).toBe('destructive');
    expect(classifyBlastRadius(DEFAULT_TIER_POLICY, read, 'no-such-kind')).toBe('destructive');
    expect(classifyBlastRadius(DEFAULT_TIER_POLICY, read)).toBe('destructive');
    expect(classifyBlastRadius(DEFAULT_TIER_POLICY, { kind: 'executor_dispatch', tool: 'codex', summary: 'd' })).toBe('delegated');
  });

  test('tool-title overrides outrank benign kinds', () => {
    const policy: TierPolicy = {
      ...DEFAULT_TIER_POLICY,
      toolClassification: { bash: 'destructive' },
    };
    const verdict = tierFor(policy, { kind: 'tool_call', tool: 'Bash', summary: 'run' }, 'read');
    expect(verdict.blastRadius).toBe('destructive');
    expect(verdict.tier).toBe('human');
  });

  test('escalation is one-way', () => {
    expect(escalateTier('auto', 'delegate')).toBe('delegate');
    expect(escalateTier('delegate', 'human')).toBe('human');
    expect(escalateTier('auto', 'auto')).toBe('auto');
    expect(() => escalateTier('human', 'auto')).toThrow();
    expect(() => escalateTier('delegate', 'auto')).toThrow();
    expect(() => escalateTier('human', 'delegate')).toThrow();
  });

  test('origin resolution recognizes the factory lane by its real guard markers', () => {
    expect(resolveDecisionOrigin({})).toBe('swarm');
    expect(resolveDecisionOrigin({ SWARM_EXEC_CONTAINMENT_REQUIRED: '1' })).toBe('factory');
    expect(resolveDecisionOrigin({ SWARM_EXEC_RESOURCE_GUARD_REQUIRED: '1' })).toBe('factory');
    expect(resolveDecisionOrigin({ SWARM_DECISION_ORIGIN: 'factory' })).toBe('factory');
    expect(resolveDecisionOrigin({ SWARM_DECISION_ORIGIN: 'swarm', SWARM_EXEC_CONTAINMENT_REQUIRED: '1' })).toBe('swarm');
  });
});

// ─── Stage 2: authority eval ─────────────────────────────────────────────────

describe('authority eval suite', () => {
  test('every adversarial probe fails closed (suite is green)', () => {
    const report = runAuthorityEvalSuite();
    const red = report.probes.filter(p => !p.passed);
    expect(red.map(p => `${p.id}: ${p.detail}`)).toEqual([]);
    expect(report.green).toBe(true);
  });
});

// ─── Stage 3: empirical wire traversal ───────────────────────────────────────

describe('ACP wire enforcement (mock adapter issues real permission requests)', () => {
  test('swarm dispatch: benign tool permission traverses the gate, is approved, and records fine-grained with parent linkage', async () => {
    const store = new MemoryDecisionRecordStore();
    const t = permissionTransport(store);
    const result = await t.execute(task('please request read permission'), { timeoutMs: 15_000, env: hermeticEnv() });

    expect(result.success).toBe(true);
    expect(result.output).toContain('PERMISSION:selected:allow-once');

    const records = store.records();
    const dispatch = records.find(r => r.proposed_action.kind === 'executor_dispatch')!;
    expect(dispatch).toBeDefined();
    expect(dispatch.origin).toBe('swarm');
    expect(dispatch.granularity).toBe('coarse');
    expect(dispatch.blast_radius).toBe('delegated');
    expect(dispatch.outcome).toBe('approved');

    const tool = records.find(r => r.proposed_action.kind === 'tool_call')!;
    expect(tool).toBeDefined();
    expect(tool.granularity).toBe('fine');
    expect(tool.outcome).toBe('approved');
    expect(tool.proposed_action.tool).toBe('Read');
    expect(tool.proposed_action.target).toBe('/tmp/file.txt');
    expect(tool.parent_decision_id).toBe(dispatch.decision_id);
    expect(tool.session_id).toBe('mock-session');
  }, 20_000);

  test('destructive tool permission is denied on the wire and the denial is a durable record', async () => {
    const store = new MemoryDecisionRecordStore();
    const t = permissionTransport(store);
    const result = await t.execute(task('please request destructive permission'), { timeoutMs: 15_000, env: hermeticEnv() });

    expect(result.output).toContain('PERMISSION:cancelled');

    const denial = store.records().find(
      r => r.proposed_action.kind === 'tool_call' && r.outcome === 'denied',
    )!;
    expect(denial).toBeDefined();
    expect(denial.tier).toBe('human');
    expect(denial.blast_radius).toBe('destructive');
    expect(denial.decided_by).toBe('fail-closed');
  }, 20_000);

  test('retry after denial stays denied on the wire (denial is terminal)', async () => {
    const store = new MemoryDecisionRecordStore();
    const t = permissionTransport(store);
    const result = await t.execute(task('please request destructive twice'), { timeoutMs: 15_000, env: hermeticEnv() });

    expect(result.output).toContain('PERMISSION:cancelled|cancelled');
    expect(store.events().some(e => e.type === 'retry_after_denial')).toBe(true);
  }, 20_000);

  test('LOCKED Q4 VERIFICATION: a factory-lane dispatch through the ExecutorClient→ACPTransport seam traverses requestPermission(), with a coarse delegated dispatch record', async () => {
    // harness-router.ts (the factory's only real-binary seam) lazy-imports
    // this exact ExecutorClient and runs this exact transport; the adapter
    // below proves the permission round-trip happens on the ACP wire.
    const store = new MemoryDecisionRecordStore();
    const t = permissionTransport(store);
    const client = ExecutorClient._withTransport(acpEntry, t);
    const result = await client.run('please request read permission', {
      persona: 'factory-worker',
      timeoutMs: 15_000,
      env: hermeticEnv({ SWARM_DECISION_ORIGIN: 'factory' }),
    });

    // The adapter only prints this after its session/request_permission
    // request came back answered — the traversal is observed, not inferred.
    expect(result.success).toBe(true);
    expect(result.output).toContain('PERMISSION:selected:allow-once');

    const records = store.records();
    const dispatch = records.find(r => r.proposed_action.kind === 'executor_dispatch')!;
    expect(dispatch).toBeDefined();
    expect(dispatch.origin).toBe('factory');
    expect(dispatch.granularity).toBe('coarse');
    expect(dispatch.tier).toBe('delegate');
    expect(dispatch.blast_radius).toBe('delegated');
    expect(dispatch.actor).toBe('factory-worker');

    // Coarse mode per locked Q4: the approved tool permission logs as a cheap
    // child event on the dispatch record, not a second full record.
    expect(records.filter(r => r.proposed_action.kind === 'tool_call')).toEqual([]);
    const childEvents = store.events().filter(
      e => e.type === 'delegated_child' && e.decision_id === dispatch.decision_id,
    );
    expect(childEvents.length).toBe(1);
    expect(childEvents[0].detail?.tool).toBe('Read');
    expect(childEvents[0].detail?.outcome).toBe('approved');
  }, 20_000);

  test('factory-lane denials still produce durable full records despite coarse granularity', async () => {
    const store = new MemoryDecisionRecordStore();
    const t = permissionTransport(store);
    const result = await t.execute(
      task('please request destructive permission', 'factory-worker'),
      { timeoutMs: 15_000, env: hermeticEnv({ SWARM_DECISION_ORIGIN: 'factory' }) },
    );

    expect(result.output).toContain('PERMISSION:cancelled');
    const denial = store.records().find(
      r => r.proposed_action.kind === 'tool_call' && r.outcome === 'denied',
    )!;
    expect(denial).toBeDefined();
    expect(denial.origin).toBe('factory');
  }, 20_000);

  test('a denied dispatch fails the task before any adapter spawns', async () => {
    const store = new MemoryDecisionRecordStore();
    // A policy that routes delegated actions to the human tier: with no human
    // approver, every dispatch is denied at the gate.
    const policy: TierPolicy = {
      ...DEFAULT_TIER_POLICY,
      tierForBlastRadius: { ...DEFAULT_TIER_POLICY.tierForBlastRadius, delegated: 'human' },
    };
    const t = permissionTransport(store, policy);
    const result = await t.execute(task('please request read permission'), { timeoutMs: 15_000, env: hermeticEnv() });

    expect(result.success).toBe(false);
    expect(result.error).toContain('decision factory denied executor dispatch');
    const dispatch = store.records().find(r => r.proposed_action.kind === 'executor_dispatch')!;
    expect(dispatch.outcome).toBe('denied');
    // No session ever opened: no tool decision of any kind exists.
    expect(store.records().filter(r => r.proposed_action.kind === 'tool_call')).toEqual([]);
    expect(result.output).toBeUndefined();
  }, 20_000);

  test('registry allowlist is enforced at the permission seam', async () => {
    const store = new MemoryDecisionRecordStore();
    const t = new ACPTransport(acpEntry, makeCB(), {
      adapterBin: 'bun',
      adapterArgs: [PERMISSION_ADAPTER],
      allowedTools: ['Grep'],
      decisions: { store },
    });
    const result = await t.execute(task('please request read permission'), { timeoutMs: 15_000, env: hermeticEnv() });

    expect(result.output).toContain('PERMISSION:cancelled');
    const denial = store.records().find(
      (r): r is DecisionRecord => r.proposed_action.kind === 'tool_call' && r.outcome === 'denied',
    )!;
    expect(denial).toBeDefined();
    expect(denial.reason).toContain('allowlist');
  }, 20_000);
});
