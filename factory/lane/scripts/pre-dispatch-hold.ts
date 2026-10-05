import { createHash } from "node:crypto";

export interface PreDispatchHoldExecution {
  execution_id: string;
  identifier: string;
  result_summary?: string | null;
}

export interface PreDispatchHoldRecord {
  execution_id: string;
  tier: string;
  held_at: string;
  notified: "none";
  released_by: null;
  released_at: null;
  reason: "promotion_context";
  failure_fingerprint: string;
}

export interface PreDispatchHoldPersistence {
  mode: "execution" | "hold_record";
  executionSaveError?: string;
}

export function persistPreDispatchHold<T extends PreDispatchHoldExecution>(
  exec: T,
  reason: string,
  deps: {
    now: () => string;
    saveExecution: (execution: T) => void;
    saveHold: (hold: PreDispatchHoldRecord) => void;
  },
): PreDispatchHoldPersistence {
  exec.result_summary = `${exec.result_summary ?? "verified execution"}; SF010 HOLD: ${reason}`;
  try {
    deps.saveExecution(exec);
    return { mode: "execution" };
  } catch (error) {
    const executionSaveError = error instanceof Error ? error.message : String(error);
    deps.saveHold({
      execution_id: exec.execution_id,
      tier: "high",
      held_at: deps.now(),
      notified: "none",
      released_by: null,
      released_at: null,
      reason: "promotion_context",
      failure_fingerprint: createHash("sha256").update(`${reason}\n${executionSaveError}`).digest("hex"),
    });
    return { mode: "hold_record", executionSaveError };
  }
}
