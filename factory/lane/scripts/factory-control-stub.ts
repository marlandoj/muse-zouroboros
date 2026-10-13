/**
 * factory-control-stub.ts — Local stand-in for capability-runtime's
 * factory control gate.
 *
 * The upstream `runFactoryControlGate` (packages/capability-runtime) is not
 * vendored in this distribution. This stub replicates its default behavior:
 *
 * - When ZCR_FACTORY_CONTROL_CONFIG is UNSET, upstream bypasses the gate and
 *   permits the continuation. This stub does the same.
 * - When ZCR_FACTORY_CONTROL_CONFIG IS SET, upstream would evaluate a real
 *   capability gate we cannot replicate here — so this stub FAILS CLOSED
 *   instead of silently permitting past an unevaluated gate.
 *
 * Never silently pass a configured gate. If the full gate is needed, vendor
 * packages/capability-runtime and repoint dispatcher.ts at it.
 */

export type FactoryControlMode = "off" | "shadow" | "canary" | "enforce";
export type FactoryControlDecision = "permit" | "hold";
export type FactoryControlHostEffect = "performed" | "not_performed";

export interface FactoryControlOutcome<T> {
  readonly mode: FactoryControlMode;
  readonly decision: FactoryControlDecision;
  readonly enforced: boolean;
  readonly reason_codes: readonly string[];
  readonly action_id: string | null;
  readonly action_state: string | null;
  readonly dispatch_boundary: string | null;
  readonly host_effect: FactoryControlHostEffect;
  readonly value?: T;
}

export interface FactoryControlInput<T> {
  readonly ticket_identifier: string;
  readonly dispatch_result: T;
}

export async function runFactoryControlGate<T>(
  input: FactoryControlInput<T>,
  continuation: () => Promise<T> | T,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FactoryControlOutcome<T>> {
  const configPath = env.ZCR_FACTORY_CONTROL_CONFIG;
  if (configPath !== undefined && configPath.length > 0) {
    throw new Error(
      "factory control gate is configured (ZCR_FACTORY_CONTROL_CONFIG is set) but " +
        "capability-runtime is not vendored in this distribution — refusing to " +
        "dispatch past an unevaluated gate",
    );
  }
  const value = await continuation();
  return {
    mode: "off",
    decision: "permit",
    enforced: false,
    reason_codes: [],
    action_id: null,
    action_state: null,
    dispatch_boundary: null,
    host_effect: "performed",
    value,
  };
}
