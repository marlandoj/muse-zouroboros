import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  planSteps,
  runMaintenance,
  OBSERVATIONS_CLI,
  MENTAL_MODELS_CLI,
  PROMOTE_EVENT_OBS_CLI,
} from '../../../../scripts-vps/memory-adopted-maintenance';

/** Fake deployed checkout containing just the adopted-concept CLIs. */
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'adopted-maint-'));
  for (const rel of [OBSERVATIONS_CLI, MENTAL_MODELS_CLI, PROMOTE_EVENT_OBS_CLI]) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '// fixture\n');
  }
  return root;
}

test('planSteps consolidates observations before refreshing mental models, deterministic by default', () => {
  const steps = planSteps();
  expect(steps.map((s) => s.name)).toEqual([
    'observations-consolidate',
    'mental-models-refresh-due',
    'event-observations-promote',
  ]);
  expect(steps[0].args).not.toContain('--llm');
  expect(planSteps({ llm: true })[0].args).toContain('--llm');
  expect(steps.map((s) => s.script)).toEqual([OBSERVATIONS_CLI, MENTAL_MODELS_CLI, PROMOTE_EVENT_OBS_CLI]);
  expect(steps[2].args).toEqual([]);
});

test('runMaintenance runs both steps even when the first fails, and reports the failure', async () => {
  const root = fakeRepo();
  try {
    const ran: string[] = [];
    const summary = await runMaintenance({
      repoRoot: root,
      runner: (script, args) => {
        ran.push(`${script} ${args.join(' ')}`);
        return ran.length === 1 ? 1 : 0;
      },
    });
    // The later steps are not starved by the first step's failure.
    expect(ran).toHaveLength(3);
    expect(ran[0]).toContain('consolidate');
    expect(ran[1]).toContain('refresh-due');
    expect(ran[2]).toContain('promote-event-observations');
    expect(summary.failed).toBe(1);
    expect(summary.steps.map((s) => s.status)).toEqual([1, 0, 0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runMaintenance fails fast with an actionable message when the CLIs are not deployed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adopted-maint-empty-'));
  try {
    await expect(runMaintenance({ repoRoot: root, runner: () => 0 })).rejects.toThrow(
      'before enabling this unit',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runMaintenance succeeds when every step exits zero', async () => {
  const root = fakeRepo();
  try {
    const summary = await runMaintenance({ repoRoot: root, runner: () => 0 });
    expect(summary.failed).toBe(0);
    expect(summary.steps).toHaveLength(3);
    expect(summary.steps.every((s) => s.status === 0)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
