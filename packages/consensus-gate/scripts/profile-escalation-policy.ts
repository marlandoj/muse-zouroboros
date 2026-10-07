export type ProfileTrigger =
  | "none"
  | "dissent"
  | "split"
  | "low_confidence"
  | "panel_failure"
  | "malformed"
  | "forced_shadow";

export type ConsensusStatus = "passed" | "rejected" | "escalate";

export interface ConsensusSnapshot {
  status?: ConsensusStatus;
  consensus?: {
    unanimous?: boolean;
    confidence?: number;
  };
  executionFailure?: boolean;
}

export interface RoutingPolicyOptions {
  minConfidence: number;
}

export interface RoutingDecision {
  escalate: boolean;
  trigger: ProfileTrigger;
  confidence: number | null;
  minConfidence: number;
}

const CONSENSUS_STATUSES = new Set<ConsensusStatus>(["passed", "rejected", "escalate"]);

export function isValidRoutingPolicyOptions(options: unknown): options is RoutingPolicyOptions {
  if (typeof options !== "object" || options === null) return false;
  const minConfidence = (options as { minConfidence?: unknown }).minConfidence;
  return typeof minConfidence === "number" && Number.isFinite(minConfidence) && minConfidence >= 0 && minConfidence <= 1;
}

export function isConsensusSnapshot(snapshot: unknown): snapshot is ConsensusSnapshot {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return false;

  const candidate = snapshot as {
    status?: unknown;
    consensus?: unknown;
    executionFailure?: unknown;
  };

  if (candidate.executionFailure !== undefined && typeof candidate.executionFailure !== "boolean") return false;
  if (candidate.executionFailure === true) return true;
  if (typeof candidate.status !== "string" || !CONSENSUS_STATUSES.has(candidate.status as ConsensusStatus)) return false;
  if (typeof candidate.consensus !== "object" || candidate.consensus === null || Array.isArray(candidate.consensus)) return false;

  const consensus = candidate.consensus as { unanimous?: unknown; confidence?: unknown };
  return (
    typeof consensus.unanimous === "boolean" &&
    typeof consensus.confidence === "number" &&
    Number.isFinite(consensus.confidence) &&
    consensus.confidence >= 0 &&
    consensus.confidence <= 1
  );
}

function decision(
  trigger: ProfileTrigger,
  confidence: number | null,
  options: RoutingPolicyOptions,
): RoutingDecision {
  return {
    escalate: trigger !== "none",
    trigger,
    confidence,
    minConfidence: options.minConfidence,
  };
}

export function decideProfileEscalation(
  snapshot: ConsensusSnapshot,
  options: RoutingPolicyOptions,
): RoutingDecision {
  if (!isValidRoutingPolicyOptions(options)) {
    throw new RangeError("minConfidence must be a finite number between 0 and 1");
  }

  if (snapshot?.executionFailure === true) {
    return decision("panel_failure", null, options);
  }

  if (!isConsensusSnapshot(snapshot)) {
    return decision("malformed", null, options);
  }

  const confidence = snapshot.consensus!.confidence!;

  if (snapshot.status === "escalate") {
    return decision("split", confidence, options);
  }
  if (snapshot.consensus!.unanimous === false) {
    return decision("dissent", confidence, options);
  }
  if (confidence < options.minConfidence) {
    return decision("low_confidence", confidence, options);
  }
  return decision("none", confidence, options);
}
