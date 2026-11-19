/**
 * Harness-discipline module — long-horizon swarm sanity (roadmap §10).
 *
 *   1. Immutable, hash-guarded feature-list (durable spec outside the context window)
 *   2. Per-session smoke test (fast deterministic harness sanity at run start)
 *
 * Both advisory-first, pure cores with injected probes (mirrors src/verification).
 */

export {
  buildFeatureList,
  createFeatureList,
  loadFeatureList,
  parseFeatureList,
  computeFeatureListHash,
  verifyFeatureListIntegrity,
  reconcileProgress,
  createRealFileProbe,
} from './feature-list.js';
export type {
  Feature,
  FeatureList,
  FeatureListFileProbe,
  IntegrityResult,
  ReconcileReport,
  CreateFeatureListOptions,
} from './feature-list.js';

export {
  runSmokeChecks,
  renderSmokeReport,
  createRealDurableLogProbe,
  persistSmokeReport,
} from './smoke-test.js';
export type {
  SmokeSeverity,
  SmokeCheckId,
  SmokeFinding,
  SmokeReport,
  SmokeInput,
  SmokeProbes,
  DurableLogStatus,
} from './smoke-test.js';
