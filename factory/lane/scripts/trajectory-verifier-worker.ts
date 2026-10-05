#!/usr/bin/env bun
import { canonicalize } from "./run-receipt-contract.ts";
import {
  buildTrajectoryReport,
  parseTrajectoryReplayObservation,
  parseTrajectoryVerifierRequest,
} from "./trajectory-verifier-contract.ts";

const SECRET_ENV = /(^|_)(SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL)(_|$)/i;

export function workerEnvironmentIsSecretFree(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).every((name) => !SECRET_ENV.test(name));
}

export async function executeTrajectoryWorker(input: unknown): Promise<string> {
  const request = parseTrajectoryVerifierRequest(input);
  const response = await fetch(request.replay_tool_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: request.request_id }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`replay tool returned HTTP ${response.status}`);
  const replay = parseTrajectoryReplayObservation(await response.json());
  return canonicalize(buildTrajectoryReport(request, replay, workerEnvironmentIsSecretFree(process.env)));
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text()) as unknown;
    console.log(await executeTrajectoryWorker(input));
  } catch (error) {
    console.error(String(error));
    process.exit(1);
  }
}
