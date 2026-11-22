/**
 * Per-attempt timeout and resume policy.
 *
 * Provides:
 * 1. Tier-default attempt timeouts (complex -> 2700s)
 * 2. Timeout resolution per task/tier
 * 3. resumePromptBlock with Salvage Record inclusion for same-executor resumes
 */

import type { SalvageRecord } from './salvage-record.js';
import { formatSalvageForResume } from './salvage-record.js';

export const TIER_ATTEMPT_TIMEOUT_S: Readonly<Record<string, number>> = Object.freeze({
  trivial: 120,
  'swarm-light': 120,
  simple: 300,
  moderate: 300,
  'swarm-mid': 300,
  complex: 2700,
  'swarm-heavy': 2700,
});

export const DEFAULT_ATTEMPT_TIMEOUT_S = 300;

export function tierAttemptTimeout(tier: string | undefined | null): number {
  if (!tier) return DEFAULT_ATTEMPT_TIMEOUT_S;
  return TIER_ATTEMPT_TIMEOUT_S[tier] ?? DEFAULT_ATTEMPT_TIMEOUT_S;
}

export function resumePromptBlock(
  executorId: string,
  timeoutSeconds: number,
  attemptNo: number,
  stall?: { silentS: number; windowS: number } | null,
  resultFile?: string | null,
  salvage?: SalvageRecord | null,
): string {
  const why = stall
    ? `That attempt was stopped after ${Math.round(stall.silentS)}s with no observable activity (stall detection, window ${stall.windowS}s) before it finished; its work in the task workspace is still there. If a command hung, do not re-run it the same way.`
    : `That attempt was stopped at the per-attempt timeout (${timeoutSeconds}s) before it finished; its work in the task workspace is still there.`;

  const salvageSection = salvage ? `\n\n<salvage-record>\n${formatSalvageForResume(salvage)}\n</salvage-record>` : '';

  return `<resume-context>
This is a RESUME of attempt ${attemptNo} on the same executor (${executorId}). ${why}
Do not start over. First inspect the workspace (git status / git diff / git log, files you would have created${resultFile ? `, ${resultFile} if present` : ''}) to see what the stopped attempt already did, then continue from where it stopped and finish the task.${salvageSection}
If the task cannot be finished within the per-attempt limit, do not work around the limit (no detached or background processes) and do not write status files: end your reply with STATUS: BLOCKED and the reason.
</resume-context>

`;
}
