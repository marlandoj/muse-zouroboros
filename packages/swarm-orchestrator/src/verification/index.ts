/**
 * Verification module — automated wiring verification and gap audit.
 *
 * Three layers of validation:
 *   1. Wiring verification (import graph + reachability)
 *   2. Gap audit (data prerequisites + cross-boundary state)
 *   3. Preflight checks (integrated into orchestrator run())
 */

export { CAPABILITY_MANIFEST, getCapability, getCapabilityIds } from './capabilities.js';
export type { Capability, CapabilityEdge, DataPrerequisite, CrossBoundaryCheck } from './capabilities.js';

export { verifyWiring, printWiringReport } from './verify-wiring.js';
export type { WiringIssue, WiringReport, Severity } from './verify-wiring.js';

export { runGapAudit, printGapAuditReport } from './gap-audit.js';
export type { Gap, GapAuditReport, GapSeverity, GapCategory } from './gap-audit.js';

export { isBenchOrTestPath, detectEvalParityGaps, detectDuplicateExports } from './gap-checks.js';
export type { CapabilityLike, SourceFileLike } from './gap-checks.js';

export {
  verifyTrace,
  extractClaimedPaths,
  createRealFsProbe,
  persistTraceVerifyReport,
  renderTraceVerifyReport,
} from './trace-verify.js';
export type {
  TraceViolation,
  TraceVerifyReport,
  TraceViolationCategory,
  TraceViolationSeverity,
  FsProbe,
  VerifyTraceOptions,
} from './trace-verify.js';
