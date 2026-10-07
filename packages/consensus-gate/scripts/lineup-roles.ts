import {
  providerForModelId,
  resolveModelIdentity,
  sameCanonicalModel,
  type ModelProvider,
} from "./model-identity";

export interface LineupRole {
  primary: string;
  fallbacks: string[];
}

export type LineupRoleInput = string | LineupRole;

export interface LineupRoleConfig {
  proposers: LineupRoleInput[];
  aggregator: LineupRoleInput;
}

export interface ChainAttempt {
  requestedId: string;
  resolvedId: string;
  provider: ModelProvider;
  ok: boolean;
  error?: string;
}

export interface RoleExecution<T> {
  role: LineupRole;
  value: T;
  attempts: ChainAttempt[];
  servingProvider: ModelProvider;
  servingModel: string;
}

export function isRetryableVerdictLike(value: { confidence: number; issues: string[] }): boolean {
  if (value.confidence !== 0) return false;
  return value.issues.some((issue) =>
    issue === "Empty response from vendor" ||
    issue.startsWith("API error:") ||
    issue.startsWith("Call failed:") ||
    issue.startsWith("Unparseable verdict")
  );
}

export function normalizeLineupRole(input: LineupRoleInput): LineupRole {
  if (typeof input === "string") {
    const primary = input.trim();
    if (!primary) throw new Error("lineup role primary must not be empty");
    return { primary, fallbacks: [] };
  }
  if (!input || typeof input !== "object" || typeof input.primary !== "string" || !Array.isArray(input.fallbacks)) {
    throw new Error("lineup role must be a model id or { primary, fallbacks }");
  }
  const primary = input.primary.trim();
  const fallbacks = input.fallbacks.map((id) => {
    if (typeof id !== "string" || !id.trim()) throw new Error("lineup role fallback ids must be non-empty strings");
    return id.trim();
  });
  if (!primary) throw new Error("lineup role primary must not be empty");
  return { primary, fallbacks };
}

export function resolveLineupRole(input: LineupRoleInput): LineupRole {
  const role = normalizeLineupRole(input);
  const resolve = (id: string) => {
    const identity = resolveModelIdentity(id);
    if (id.startsWith("byok:") && identity.resolvedId === id && !/^byok:[0-9a-f-]{36}$/i.test(id)) {
      throw new Error(`unknown BYOK alias: ${id}`);
    }
    return identity.resolvedId;
  };
  return { primary: resolve(role.primary), fallbacks: role.fallbacks.map(resolve) };
}

export function validateLineupRole(input: LineupRoleInput): string[] {
  let role: LineupRole;
  try {
    role = resolveLineupRole(input);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const ids = [role.primary, ...role.fallbacks];
  const errors: string[] = [];
  if (new Set(ids).size !== ids.length) errors.push("role chain contains duplicate resolved ids");
  const providers = ids.map(providerForModelId);
  if (role.fallbacks.length && providers[0] === providers[1]) {
    errors.push("first fallback must use a different provider route from the primary");
  }
  if (new Set(providers).size !== providers.length) errors.push("role chain contains duplicate provider routes");
  for (const fallback of role.fallbacks) {
    if (!sameCanonicalModel(role.primary, fallback)) {
      errors.push(`fallback ${fallback} does not preserve canonical model identity`);
    }
  }
  return errors;
}

export function parseLineupRoleConfig(raw: string): LineupRoleConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`LINEUP_ROLE_CHAINS must be valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("LINEUP_ROLE_CHAINS must be an object");
  const config = parsed as Partial<LineupRoleConfig>;
  if (!Array.isArray(config.proposers) || config.proposers.length === 0 || config.aggregator === undefined) {
    throw new Error("LINEUP_ROLE_CHAINS requires non-empty proposers and an aggregator");
  }
  const proposers = config.proposers.map(normalizeLineupRole);
  const aggregator = normalizeLineupRole(config.aggregator);
  const errors = [...proposers, aggregator].flatMap(validateLineupRole);
  if (errors.length) throw new Error(`invalid LINEUP_ROLE_CHAINS: ${errors.join("; ")}`);
  return { proposers, aggregator };
}

export function roleConfigFromEnv(
  env: Record<string, string | undefined>,
  defaultProposers: string[],
  defaultAggregator: string,
): LineupRoleConfig {
  if (env.LINEUP_ROLE_CHAINS) return parseLineupRoleConfig(env.LINEUP_ROLE_CHAINS);
  const pinned = (env.LINEUP_PIN_PROPOSERS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return {
    proposers: (pinned.length ? pinned : defaultProposers).map(normalizeLineupRole),
    aggregator: normalizeLineupRole((env.LINEUP_PIN_AGGREGATOR ?? "").trim() || defaultAggregator),
  };
}

export async function executeLineupRole<T>(
  input: LineupRoleInput,
  call: (resolvedId: string) => Promise<T>,
  failed: (value: T) => boolean,
  errorOf: (value: T) => string | undefined,
): Promise<RoleExecution<T>> {
  const errors = validateLineupRole(input);
  if (errors.length) throw new Error(errors.join("; "));
  const requested = normalizeLineupRole(input);
  const resolved = resolveLineupRole(requested);
  const requestedIds = [requested.primary, ...requested.fallbacks];
  const resolvedIds = [resolved.primary, ...resolved.fallbacks];
  const attempts: ChainAttempt[] = [];
  let lastValue!: T;
  for (let index = 0; index < resolvedIds.length; index++) {
    const resolvedId = resolvedIds[index];
    lastValue = await call(resolvedId);
    const isFailure = failed(lastValue);
    attempts.push({
      requestedId: requestedIds[index],
      resolvedId,
      provider: providerForModelId(resolvedId),
      ok: !isFailure,
      error: isFailure ? errorOf(lastValue) : undefined,
    });
    if (!isFailure) {
      return {
        role: requested,
        value: lastValue,
        attempts,
        servingProvider: providerForModelId(resolvedId),
        servingModel: resolvedId,
      };
    }
  }
  const last = attempts[attempts.length - 1];
  return {
    role: requested,
    value: lastValue,
    attempts,
    servingProvider: last.provider,
    servingModel: last.resolvedId,
  };
}
