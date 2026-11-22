/**
 * Salvage Record — structured partial-progress tracking for timed out or stalled attempts.
 *
 * When an attempt ends in timeout or stall, captures:
 * 1. files changed versus the attempt's base
 * 2. tests run and their outcomes
 * 3. last activity timestamp and kind
 * 4. the executor's own progress note if one exists in the workspace
 *
 * Included in the resume context when a campaign resumes so the next attempt
 * continues from the checkpoint instead of cold-restarting.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface TestRunOutcome {
  testFile?: string;
  command?: string;
  passed: boolean;
  numTests?: number;
  passedCount?: number;
  failedCount?: number;
  outputSummary?: string;
}

export interface ChangedFilesSummary {
  added: string[];
  modified: string[];
  removed: string[];
  total: number;
}

export interface SalvageRecord {
  taskId: string;
  attempt: number;
  executor: string;
  errorType: 'timeout' | 'stalled';
  /** Files changed versus the attempt's base */
  filesChanged: ChangedFilesSummary;
  /** Tests run and their outcomes */
  testsRun: TestRunOutcome[];
  /** Last activity timestamp and kind */
  lastActivity: {
    timestamp: string;
    kind: string;
  };
  /** The executor's own progress note if one exists in the workspace */
  progressNote: string | null;
  /** ISO timestamp when the salvage record was created */
  salvagedAt: string;
}

export interface CaptureSalvageOptions {
  workspaceDir: string;
  taskId: string;
  attempt: number;
  executor: string;
  errorType: 'timeout' | 'stalled';
  baseTree?: Record<string, number> | null; // relPath -> mtimeMs
  lastActivity?: {
    timestamp?: string;
    kind?: string;
  };
  testsRun?: TestRunOutcome[];
  progressNote?: string | null;
}

/** Known progress note filenames in order of preference */
const PROGRESS_NOTE_FILENAMES = [
  'PROGRESS.md',
  'CHECKPOINT.md',
  'NOTES.md',
  'NOTE.md',
  'TODO.md',
  'RESULT.md',
];

/**
 * Scan workspace for executor progress notes (e.g. PROGRESS.md, CHECKPOINT.md).
 */
export function extractProgressNote(workspaceDir: string, maxChars = 4000): string | null {
  for (const filename of PROGRESS_NOTE_FILENAMES) {
    const fullPath = join(workspaceDir, filename);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8').trim();
        if (content.length > 0) {
          // If it's RESULT.md, only treat as progress note if it doesn't declare STATUS: DONE
          if (filename === 'RESULT.md' && content.includes('STATUS: DONE')) {
            // Already finished or complete result, not a partial progress note
            continue;
          }
          return content.length > maxChars ? content.slice(0, maxChars) + '\n...(truncated)' : content;
        }
      } catch {
        // Continue searching
      }
    }
  }
  return null;
}

/**
 * Take a shallow/nested mtime snapshot of a workspace directory.
 */
export function snapshotWorkspaceTree(dir: string, maxDepth = 4, currentDepth = 0): Record<string, number> {
  const result: Record<string, number> = {};
  if (!existsSync(dir) || currentDepth > maxDepth) return result;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.gemini' || ent.name === '.claude') {
        continue;
      }
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        const sub = snapshotWorkspaceTree(full, maxDepth, currentDepth + 1);
        for (const [k, v] of Object.entries(sub)) {
          result[`${ent.name}/${k}`] = v;
        }
      } else if (ent.isFile()) {
        try {
          result[ent.name] = statSync(full).mtimeMs;
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore read errors
  }
  return result;
}

/**
 * Detect changed files versus base snapshot or git status.
 */
export function detectChangedFiles(workspaceDir: string, baseTree?: Record<string, number> | null): ChangedFilesSummary {
  const added: Set<string> = new Set();
  const modified: Set<string> = new Set();
  const removed: Set<string> = new Set();

  // Method 1: Git status if workspace is a git repo
  try {
    const gitRes = spawnSync('git', ['status', '--porcelain', '-uall'], {
      cwd: workspaceDir,
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (gitRes.status === 0 && gitRes.stdout) {
      for (const line of gitRes.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const code = line.slice(0, 2);
        const file = line.slice(3).trim();
        if (!file || file.startsWith('.git/')) continue;

        if (code.includes('?') || code.includes('A')) {
          added.add(file);
        } else if (code.includes('D')) {
          removed.add(file);
        } else if (code.includes('M')) {
          modified.add(file);
        }
      }
    }
  } catch {
    // Git not available or not a git repository
  }

  // Method 2: Compare with baseTree if provided
  if (baseTree && Object.keys(baseTree).length > 0) {
    const currentTree = snapshotWorkspaceTree(workspaceDir);
    for (const [path, mtime] of Object.entries(currentTree)) {
      if (!(path in baseTree)) {
        added.add(path);
      } else if (mtime > baseTree[path]) {
        if (!added.has(path)) {
          modified.add(path);
        }
      }
    }
    for (const path of Object.keys(baseTree)) {
      if (!(path in currentTree)) {
        removed.add(path);
      }
    }
  }

  const addedList = Array.from(added).sort();
  const modifiedList = Array.from(modified).sort();
  const removedList = Array.from(removed).sort();

  return {
    added: addedList,
    modified: modifiedList,
    removed: removedList,
    total: addedList.length + modifiedList.length + removedList.length,
  };
}

/**
 * Extract test runs and outcomes from test result files or workspace logs.
 */
export function extractTestOutcomes(workspaceDir: string): TestRunOutcome[] {
  const outcomes: TestRunOutcome[] = [];

  // Check for test-results.json
  const jsonPath = join(workspaceDir, 'test-results.json');
  if (existsSync(jsonPath)) {
    try {
      const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      if (Array.isArray(data.testResults)) {
        for (const tr of data.testResults) {
          outcomes.push({
            testFile: tr.name,
            passed: tr.status === 'passed',
            passedCount: tr.numPassingTests,
            failedCount: tr.numFailingTests,
            outputSummary: tr.message,
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  // Check for run.log test lines if present
  const runLogPath = join(workspaceDir, 'run.log');
  if (existsSync(runLogPath)) {
    try {
      const content = readFileSync(runLogPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.includes('(pass)') || line.includes('PASS')) {
          outcomes.push({
            command: line.trim().slice(0, 100),
            passed: true,
          });
        } else if (line.includes('(fail)') || line.includes('FAIL')) {
          outcomes.push({
            command: line.trim().slice(0, 100),
            passed: false,
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  return outcomes;
}

/**
 * Capture a structured partial-progress Salvage Record when an attempt ends in timeout or stall.
 */
export function captureSalvageRecord(options: CaptureSalvageOptions): SalvageRecord {
  const filesChanged = detectChangedFiles(options.workspaceDir, options.baseTree);
  const testsRun = options.testsRun && options.testsRun.length > 0
    ? options.testsRun
    : extractTestOutcomes(options.workspaceDir);
  const progressNote = options.progressNote !== undefined
    ? options.progressNote
    : extractProgressNote(options.workspaceDir);

  const lastActivity = {
    timestamp: options.lastActivity?.timestamp || new Date().toISOString(),
    kind: options.lastActivity?.kind || (options.errorType === 'timeout' ? 'timeout_ceiling' : 'stall_detected'),
  };

  return {
    taskId: options.taskId,
    attempt: options.attempt,
    executor: options.executor,
    errorType: options.errorType,
    filesChanged,
    testsRun,
    lastActivity,
    progressNote,
    salvagedAt: new Date().toISOString(),
  };
}

/**
 * Formats a SalvageRecord into markdown text for inclusion in a resume prompt.
 */
export function formatSalvageForResume(salvage: SalvageRecord): string {
  const lines: string[] = [
    `=== SALVAGE RECORD (from Attempt ${salvage.attempt} — ${salvage.errorType}) ===`,
    `Last observable activity: ${salvage.lastActivity.timestamp} (${salvage.lastActivity.kind})`,
  ];

  const { added, modified, removed, total } = salvage.filesChanged;
  if (total > 0) {
    lines.push(`Workspace changes made before attempt stopped (${total} files):`);
    if (added.length > 0) {
      lines.push(`  - Added (${added.length}): ${added.slice(0, 15).join(', ')}${added.length > 15 ? ` ... (+${added.length - 15} more)` : ''}`);
    }
    if (modified.length > 0) {
      lines.push(`  - Modified (${modified.length}): ${modified.slice(0, 15).join(', ')}${modified.length > 15 ? ` ... (+${modified.length - 15} more)` : ''}`);
    }
    if (removed.length > 0) {
      lines.push(`  - Removed (${removed.length}): ${removed.slice(0, 15).join(', ')}${removed.length > 15 ? ` ... (+${removed.length - 15} more)` : ''}`);
    }
  } else {
    lines.push('Workspace changes: none recorded against base');
  }

  if (salvage.testsRun.length > 0) {
    lines.push(`Tests executed in previous attempt (${salvage.testsRun.length}):`);
    for (const t of salvage.testsRun.slice(0, 10)) {
      const status = t.passed ? 'PASS' : 'FAIL';
      lines.push(`  [${status}] ${t.command || t.testFile || 'test'}${t.outputSummary ? ` — ${t.outputSummary}` : ''}`);
    }
    if (salvage.testsRun.length > 10) {
      lines.push(`  ... (+${salvage.testsRun.length - 10} more tests)`);
    }
  }

  if (salvage.progressNote) {
    lines.push('Executor progress note found in workspace:');
    lines.push('---');
    lines.push(salvage.progressNote);
    lines.push('---');
  }

  return lines.join('\n');
}
