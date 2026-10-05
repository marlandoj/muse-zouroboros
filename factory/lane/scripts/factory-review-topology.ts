export const FACTORY_DIRECT_REVIEW_MODELS = [
  "byok:d879829b-6d2c-44f6-a60e-0c1e31149b9e",
  "kimi:kimi-k3",
  "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f",
] as const;

export const FACTORY_DIRECT_MIN_REVIEWERS = "2";

export function factoryReviewEnvironment(
  env: Record<string, string | undefined> = process.env,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...env,
    CONSENSUS_MODELS: env.CONSENSUS_MODELS ?? FACTORY_DIRECT_REVIEW_MODELS.join(","),
    CONSENSUS_MIN_REVIEWERS: env.CONSENSUS_MIN_REVIEWERS ?? FACTORY_DIRECT_MIN_REVIEWERS,
    ...overrides,
  };
}

export function factoryGateEnvironment(
  traceId: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return factoryReviewEnvironment(env, { ZO_TRACE_ID: traceId });
}
