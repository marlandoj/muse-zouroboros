/**
 * Unit & Integration tests for:
 * 1. Salvage Record capture on timeout/stall
 * 2. Inclusion of Salvage Record in same-executor resume context
 * 3. Executor-visible Budget Signal maintenance and milestone updates (50%, 70%, 90%)
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  captureSalvageRecord,
  formatSalvageForResume,
  detectChangedFiles,
  extractTestOutcomes,
  extractProgressNote,
  type SalvageRecord,
} from '../executor/salvage-record.js';

import {
  BudgetSignalMonitor,
  writeBudgetSignal,
  readBudgetSignal,
  BUDGET_FILE_NAME,
  SWARM_BUDGET_FILE_NAME,
  type BudgetSignal,
} from '../executor/budget-signal.js';

import {
  resumePromptBlock,
  tierAttemptTimeout,
  TIER_ATTEMPT_TIMEOUT_S,
} from '../executor/attempt-policy.js';

describe('Salvage Record & Budget Signal', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `swarm-salvage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Salvage Record Capture', () => {
    test('captures changed files, test outcomes, last activity, and progress note on timeout', () => {
      // 1. Setup base tree snapshot
      const baseFile = join(testDir, 'existing.ts');
      writeFileSync(baseFile, 'export const a = 1;');
      const baseTree: Record<string, number> = {
        'existing.ts': Date.now() - 10000,
      };

      // 2. Simulate executor making modifications before timing out
      writeFileSync(baseFile, 'export const a = 2; // modified');
      const addedFile = join(testDir, 'new-feature.ts');
      writeFileSync(addedFile, 'export const b = 2; // added');

      // 3. Executor wrote progress note in workspace
      writeFileSync(
        join(testDir, 'PROGRESS.md'),
        '## Checkpoint\nFinished step 1 and step 2. Step 3 in progress: wiring API route.'
      );

      // 4. Test run outcomes written to test-results.json
      writeFileSync(
        join(testDir, 'test-results.json'),
        JSON.stringify({
          testResults: [
            { name: 'src/feature.test.ts', status: 'passed', numPassingTests: 5, numFailingTests: 0 },
            { name: 'src/integration.test.ts', status: 'failed', numPassingTests: 1, numFailingTests: 1, message: 'timeout on line 42' },
          ],
        })
      );

      const salvage = captureSalvageRecord({
        workspaceDir: testDir,
        taskId: 't_timeout_demo',
        attempt: 1,
        executor: 'claude-code',
        errorType: 'timeout',
        baseTree,
        lastActivity: {
          timestamp: '2026-11-22T02:00:00.000Z',
          kind: 'output',
        },
      });

      expect(salvage.taskId).toBe('t_timeout_demo');
      expect(salvage.attempt).toBe(1);
      expect(salvage.executor).toBe('claude-code');
      expect(salvage.errorType).toBe('timeout');
      expect(salvage.lastActivity.timestamp).toBe('2026-11-22T02:00:00.000Z');
      expect(salvage.lastActivity.kind).toBe('output');

      // Files changed
      expect(salvage.filesChanged.total).toBeGreaterThanOrEqual(2);
      expect(salvage.filesChanged.added).toContain('new-feature.ts');
      expect(salvage.filesChanged.modified).toContain('existing.ts');

      // Progress note
      expect(salvage.progressNote).toContain('Checkpoint');
      expect(salvage.progressNote).toContain('wiring API route');

      // Tests run
      expect(salvage.testsRun.length).toBe(2);
      expect(salvage.testsRun[0].passed).toBe(true);
      expect(salvage.testsRun[1].passed).toBe(false);
      expect(salvage.testsRun[1].outputSummary).toContain('timeout on line 42');
    });

    test('captures stall errorType and extracts note from CHECKPOINT.md or NOTES.md', () => {
      writeFileSync(join(testDir, 'CHECKPOINT.md'), 'Refactored database connector. Next: run migrations.');

      const salvage = captureSalvageRecord({
        workspaceDir: testDir,
        taskId: 't_stall_demo',
        attempt: 2,
        executor: 'gemini',
        errorType: 'stalled',
        lastActivity: {
          timestamp: '2026-11-22T02:30:00.000Z',
          kind: 'workspace',
        },
      });

      expect(salvage.errorType).toBe('stalled');
      expect(salvage.lastActivity.kind).toBe('workspace');
      expect(salvage.progressNote).toContain('Refactored database connector');
    });

    test('returns null progressNote when no progress note exists', () => {
      const salvage = captureSalvageRecord({
        workspaceDir: testDir,
        taskId: 't_plain',
        attempt: 1,
        executor: 'codex',
        errorType: 'timeout',
      });

      expect(salvage.progressNote).toBeNull();
    });
  });

  describe('Resume Context Integration', () => {
    test('formatSalvageForResume produces structured markdown summary', () => {
      const mockSalvage: SalvageRecord = {
        taskId: 't_test',
        attempt: 1,
        executor: 'claude-code',
        errorType: 'timeout',
        filesChanged: {
          added: ['src/new.ts'],
          modified: ['src/old.ts'],
          removed: [],
          total: 2,
        },
        testsRun: [
          { command: 'bun test unit', passed: true },
          { command: 'bun test e2e', passed: false, outputSummary: 'Connection refused' },
        ],
        lastActivity: {
          timestamp: '2026-11-22T03:00:00Z',
          kind: 'transcript',
        },
        progressNote: 'Completed unit tests, debugging e2e connection',
        salvagedAt: '2026-11-22T03:00:01Z',
      };

      const formatted = formatSalvageForResume(mockSalvage);
      expect(formatted).toContain('=== SALVAGE RECORD (from Attempt 1 — timeout) ===');
      expect(formatted).toContain('Last observable activity: 2026-11-22T03:00:00Z (transcript)');
      expect(formatted).toContain('src/new.ts');
      expect(formatted).toContain('src/old.ts');
      expect(formatted).toContain('[PASS] bun test unit');
      expect(formatted).toContain('[FAIL] bun test e2e — Connection refused');
      expect(formatted).toContain('Completed unit tests, debugging e2e connection');
    });

    test('resumePromptBlock includes salvage record inside <resume-context>', () => {
      const mockSalvage: SalvageRecord = {
        taskId: 't_resume',
        attempt: 1,
        executor: 'claude-code',
        errorType: 'timeout',
        filesChanged: {
          added: ['lib/auth.ts'],
          modified: ['server.ts'],
          removed: [],
          total: 2,
        },
        testsRun: [{ command: 'bun test', passed: true }],
        lastActivity: {
          timestamp: '2026-11-22T03:15:00Z',
          kind: 'files',
        },
        progressNote: 'Auth module implemented, need to wire routes',
        salvagedAt: '2026-11-22T03:15:01Z',
      };

      const prompt = resumePromptBlock(
        'claude-code',
        2700,
        1,
        null,
        'RESULT.md',
        mockSalvage,
      );

      expect(prompt).toContain('<resume-context>');
      expect(prompt).toContain('This is a RESUME of attempt 1 on the same executor (claude-code)');
      expect(prompt).toContain('<salvage-record>');
      expect(prompt).toContain('=== SALVAGE RECORD (from Attempt 1 — timeout) ===');
      expect(prompt).toContain('lib/auth.ts');
      expect(prompt).toContain('Auth module implemented, need to wire routes');
      expect(prompt).toContain('</salvage-record>');
      expect(prompt).toContain('</resume-context>');
    });

    test('resumePromptBlock works cleanly without salvage record (backwards compatible)', () => {
      const prompt = resumePromptBlock('claude-code', 2700, 1, null, 'RESULT.md', null);

      expect(prompt).toContain('<resume-context>');
      expect(prompt).toContain('This is a RESUME of attempt 1');
      expect(prompt).not.toContain('<salvage-record>');
      expect(prompt).toContain('</resume-context>');
    });
  });

  describe('Budget Signal & Milestone Monitoring', () => {
    test('writes BUDGET.json and .swarm/budget.json', () => {
      const signal: BudgetSignal = {
        attemptBudgetSeconds: 2700,
        elapsedSeconds: 1350,
        remainingSeconds: 1350,
        tierCeilingSeconds: 2700,
        percentElapsed: 50,
        milestone: '50%',
        updatedAt: new Date().toISOString(),
      };

      writeBudgetSignal(testDir, signal);

      const rootFile = join(testDir, BUDGET_FILE_NAME);
      const swarmFile = join(testDir, '.swarm', SWARM_BUDGET_FILE_NAME);

      expect(existsSync(rootFile)).toBe(true);
      expect(existsSync(swarmFile)).toBe(true);

      const readBack = readBudgetSignal(testDir);
      expect(readBack).not.toBeNull();
      expect(readBack?.attemptBudgetSeconds).toBe(2700);
      expect(readBack?.percentElapsed).toBe(50);
      expect(readBack?.milestone).toBe('50%');
    });

    test('BudgetSignalMonitor writes initial budget and fires milestone updates at 50%, 70%, 90%', () => {
      let virtualTime = 1000000;
      const budgetSeconds = 100; // 100 seconds budget for easy percent math

      const updates: BudgetSignal[] = [];
      const monitor = new BudgetSignalMonitor({
        workspaceDir: testDir,
        attemptBudgetSeconds: budgetSeconds,
        tierCeilingSeconds: 300,
        intervalMs: 0, // Manual ticking for deterministic test
        clock: () => virtualTime,
        onUpdate: (s) => updates.push(s),
      });

      // 1. Start: writes initial budget signal
      const initSignal = monitor.start();
      expect(initSignal.milestone).toBe('init');
      expect(initSignal.percentElapsed).toBe(0);
      expect(initSignal.remainingSeconds).toBe(100);

      // Verify file on disk
      let disk = readBudgetSignal(testDir);
      expect(disk?.milestone).toBe('init');
      expect(disk?.percentElapsed).toBe(0);

      // 2. Advance to 25s (25% - no milestone)
      virtualTime += 25000;
      let tickSignal = monitor.tick();
      expect(tickSignal.percentElapsed).toBe(25);
      expect(tickSignal.milestone).toBe('tick');

      // 3. Advance to 50s (50% milestone)
      virtualTime += 25000;
      tickSignal = monitor.tick();
      expect(tickSignal.percentElapsed).toBe(50);
      expect(tickSignal.milestone).toBe('50%');
      disk = readBudgetSignal(testDir);
      expect(disk?.milestone).toBe('50%');
      expect(disk?.remainingSeconds).toBe(50);

      // 4. Advance to 72s (70% milestone)
      virtualTime += 22000;
      tickSignal = monitor.tick();
      expect(tickSignal.percentElapsed).toBe(72);
      expect(tickSignal.milestone).toBe('70%');
      disk = readBudgetSignal(testDir);
      expect(disk?.milestone).toBe('70%');

      // 5. Advance to 91s (90% milestone)
      virtualTime += 19000;
      tickSignal = monitor.tick();
      expect(tickSignal.percentElapsed).toBe(91);
      expect(tickSignal.milestone).toBe('90%');
      disk = readBudgetSignal(testDir);
      expect(disk?.milestone).toBe('90%');
      expect(disk?.remainingSeconds).toBe(9);

      // Milestones fired set
      expect(monitor.getMilestonesFired()).toEqual([50, 70, 90]);

      // 6. Stop monitor
      monitor.stop();
    });

    test('tierAttemptTimeout resolves complex to 2700s ceiling', () => {
      expect(tierAttemptTimeout('complex')).toBe(2700);
      expect(tierAttemptTimeout('swarm-heavy')).toBe(2700);
      expect(tierAttemptTimeout('moderate')).toBe(300);
      expect(tierAttemptTimeout('simple')).toBe(300);
      expect(tierAttemptTimeout('trivial')).toBe(120);
      expect(tierAttemptTimeout(null)).toBe(300);
    });
  });
});
