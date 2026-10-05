import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  hashPlanArtifact,
  signApprovalReceipt,
  type ApprovalReceipt,
  type PlanArtifact,
} from 'zouroboros-workflow/plan-gate';
import {
  evaluateSwarmPlanGatePreflight,
  normalizePlanArtifactInput,
  runSwarmPlanGatePreflight,
} from '../plan-gate-preflight.js';

const keys = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const constitutionGateFixture = resolve(import.meta.dir, 'fixtures/constitution-gate.ts');
const originalConstitutionGate = process.env.ZOUROBOROS_CONSTITUTION_GATE;

beforeEach(() => {
  process.env.ZOUROBOROS_CONSTITUTION_GATE = constitutionGateFixture;
});

afterEach(() => {
  if (originalConstitutionGate === undefined) delete process.env.ZOUROBOROS_CONSTITUTION_GATE;
  else process.env.ZOUROBOROS_CONSTITUTION_GATE = originalConstitutionGate;
});

function plan(): PlanArtifact {
  return {
    id: 'swarm-plan',
    title: 'Plan-gated swarm execution',
    risk: 'high',
    revision: 2,
    tasks: [{ id: 'TASK-1', title: 'Run the task', depends_on: [] }],
    acceptance_criteria: ['The task completes after approval.'],
    exit_conditions: [{ name: 'verified', criteria: 'Focused tests pass.' }],
    rollback: 'Disable the feature flag.',
  };
}

function signedReceipt(artifact: PlanArtifact = plan()): ApprovalReceipt {
  return signApprovalReceipt({
    receipt_type: 'approval',
    artifact_sha256: hashPlanArtifact(artifact),
    gate_run_ids: ['gate-1'],
    decision: 'accepted',
    actor: { id: 'operator', source: 'test', authorization: 'project-owner' },
    timestamp: '2026-07-17T20:00:00.000Z',
    expiry: '2099-07-18T20:00:00.000Z',
    signed: false,
    enforcement_eligible: false,
    revision: artifact.revision ?? 1,
  }, { keyId: 'test-key', privateKey: keys.privateKey });
}

describe('shared swarm plan-gate preflight', () => {
  test('is inert when disabled and holds missing mandatory plans', () => {
    expect(evaluateSwarmPlanGatePreflight({ mode: 'disabled', audit: false }).action)
      .toBe('proceed');
    const enforced = evaluateSwarmPlanGatePreflight({ mode: 'enforce', audit: false });
    expect(enforced.action).toBe('hold');
    expect(enforced.reason).toBe('plan_artifact_missing');
  });

  test('reports would-hold in shadow without changing execution', () => {
    const result = runSwarmPlanGatePreflight({
      mode: 'shadow', artifact: plan(), audit: false,
    });
    expect(result.action).toBe('proceed');
    expect(result.wouldHold).toBe(true);
    expect(result.reason).toBe('shadow_or_advisory_would_hold');
  });

  test('propagates SWARM policy context for low-risk artifacts', () => {
    const artifact = { ...plan(), risk: 'low' as const };
    const withoutContext = evaluateSwarmPlanGatePreflight({
      mode: 'shadow', artifact, audit: false,
    });
    const withContext = evaluateSwarmPlanGatePreflight({
      mode: 'shadow', artifact, policyContext: { execution_mode: 'SWARM' }, audit: false,
    });

    expect(withoutContext.required).toBe(false);
    expect(withContext.required).toBe(true);
    expect(withContext.result?.policy.triggered_by).toContain('execution_mode_swarm');
  });

  test('enforcement accepts only a valid artifact-bound trusted receipt', () => {
    const artifact = plan();
    const receipt = signedReceipt(artifact);
    const valid = runSwarmPlanGatePreflight({
      mode: 'enforce', artifact, receipt,
      trustedKeys: { 'test-key': keys.publicKey }, audit: false,
    });
    expect(valid.action).toBe('proceed');

    const stale = runSwarmPlanGatePreflight({
      mode: 'enforce', artifact: { ...artifact, revision: 3 }, receipt,
      trustedKeys: { 'test-key': keys.publicKey }, audit: false,
    });
    expect(stale.action).toBe('hold');
    expect(stale.reason).toBe('artifact_hash_mismatch');

    const untrusted = runSwarmPlanGatePreflight({
      mode: 'enforce', artifact, receipt, trustedKeys: {}, audit: false,
    });
    expect(untrusted.action).toBe('hold');
    expect(untrusted.reason).toBe('trusted_key_missing');
  });

  test('enforcement holds constitution violations and evaluator outages', () => {
    const weightPlan = {
      ...plan(),
      title: 'Fine-tune model weights from swarm output',
    };
    const weightDecision = runSwarmPlanGatePreflight({
      mode: 'enforce',
      artifact: weightPlan,
      receipt: signedReceipt(weightPlan),
      trustedKeys: { 'test-key': keys.publicKey },
      audit: false,
    });
    expect(weightDecision.action).toBe('hold');
    expect(weightDecision.reason).toBe('constitution_blocked');
    expect(weightDecision.constitution?.violations.some(item => item.code === 'I-FROZEN-WEIGHTS')).toBe(true);

    const prior = process.env.ZOUROBOROS_CONSTITUTION_GATE;
    process.env.ZOUROBOROS_CONSTITUTION_GATE = '/missing/constitution-gate.ts';
    try {
      const artifact = plan();
      const unavailable = runSwarmPlanGatePreflight({
        mode: 'enforce',
        artifact,
        receipt: signedReceipt(artifact),
        trustedKeys: { 'test-key': keys.publicKey },
        audit: false,
      });
      expect(unavailable.action).toBe('hold');
      expect(unavailable.constitution?.violations[0]?.code).toBe('IX-GATE-UNAVAILABLE');
    } finally {
      if (prior === undefined) delete process.env.ZOUROBOROS_CONSTITUTION_GATE;
      else process.env.ZOUROBOROS_CONSTITUTION_GATE = prior;
    }
  });

  test('both runtimes invoke the same preflight before executor routing', () => {
    const packageRuntime = readFileSync(resolve(import.meta.dir, '../orchestrator.ts'), 'utf8');
    const operationalRuntime = readFileSync(
      resolve(import.meta.dir, '../../scripts/orchestrate-v5.ts'),
      'utf8',
    );
    expect(packageRuntime.indexOf('runSwarmPlanGatePreflight(this.config.planGate)'))
      .toBeGreaterThan(-1);
    expect(packageRuntime.indexOf('runSwarmPlanGatePreflight(this.config.planGate)'))
      .toBeLessThan(packageRuntime.indexOf('this.resolveExecutor(task)'));
    expect(operationalRuntime.indexOf('runSwarmPlanGatePreflight(this.config.planGate)'))
      .toBeGreaterThan(-1);
    expect(operationalRuntime.indexOf('runSwarmPlanGatePreflight(this.config.planGate)'))
      .toBeLessThan(operationalRuntime.indexOf('this.callLocalAgent('));
  });

  test('normalizes legacy task aliases without dropping factory seed contracts', () => {
    const commit = 'c490c7a600eea2d66db689aeb33e2192fdfc67e3';
    const artifact = normalizePlanArtifactInput({
      project_id: 'ZOU-1077',
      project_name: 'Pinned factory seed',
      target_repo: 'marlandoj/zouroboros',
      repositories: [{ repository: 'marlandoj/zouroboros', ref: 'main', commit_sha: commit }],
      build_plumbing_allowance: { max_changed_lines: 20, path_patterns: ['**/*.d.ts'] },
      tasks: [{ id: 'T1', name: 'Implement', files: ['src/index.ts'], deps: [] }],
      acceptance: ['The implementation is verified by focused tests.'],
      exit_conditions: ['Focused tests pass.'],
      rollback: 'Revert the implementation commit.',
    });

    expect(artifact.id).toBe('ZOU-1077');
    expect(artifact.tasks[0]?.title).toBe('Implement');
    expect(artifact.tasks[0]?.paths).toEqual(['src/index.ts']);
    expect(artifact.repositories?.[0]?.commit_sha).toBe(commit);
    expect(artifact.build_plumbing_allowance?.max_changed_lines).toBe(20);
  });
});
