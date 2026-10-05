import { execFile, type ExecFileException } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { buildHoldoutSandboxEnv } from "../../../packages/selfheal/src/introspect/holdout-sandbox.ts";
import { canonicalize } from "./run-receipt-contract.ts";
import {
  buildTrajectoryHoldReport,
  computeTrajectoryRequestHash,
  parseTrajectoryReplayObservation,
  parseTrajectoryVerifierReport,
  parseTrajectoryVerifierRequest,
  type TrajectoryReplayObservation,
  type TrajectoryVerifierReport,
  type TrajectoryVerifierRequest,
  trajectorySha256,
} from "./trajectory-verifier-contract.ts";

export interface TrajectoryRuntimeInput {
  request: Omit<TrajectoryVerifierRequest, "replay_tool_url">;
  generatorRoot: string;
  replay(): TrajectoryReplayObservation | Promise<TrajectoryReplayObservation>;
  timeoutMs?: number;
}

const ACTIVE_PORTS = new Set<number>();
const ACTIVE_ROOTS = new Set<string>();
let ACTIVE_WORKERS = 0;

export function activeTrajectoryVerifierPorts(): number[] {
  return [...ACTIVE_PORTS].sort((a, b) => a - b);
}

export function activeTrajectoryVerifierRoots(): string[] {
  return [...ACTIVE_ROOTS].sort();
}

export function activeTrajectoryVerifierWorkers(): number {
  return ACTIVE_WORKERS;
}

function workerEnv(root: string): NodeJS.ProcessEnv {
  const env = buildHoldoutSandboxEnv(process.env);
  delete env.ZO_WORKSPACE;
  delete env.ZOUROBOROS_DATA_DIR;
  delete env.HOLDOUT_SUBCHECKS;
  env.HOME = root;
  env.NO_PROXY = "127.0.0.1";
  env.no_proxy = "127.0.0.1";
  return env;
}

export async function runTrajectoryVerifier(input: TrajectoryRuntimeInput): Promise<TrajectoryVerifierReport> {
  const generatorRoot = resolve(input.generatorRoot);
  if (!isAbsolute(input.generatorRoot) || !existsSync(generatorRoot)) throw new Error("generator root must be an existing absolute path");
  const verifierRoot = mkdtempSync(join(tmpdir(), "sf009-verifier-"));
  if (resolve(verifierRoot) === generatorRoot || verifierRoot.startsWith(`${generatorRoot}/`) || generatorRoot.startsWith(`${verifierRoot}/`)) {
    rmSync(verifierRoot, { recursive: true, force: true });
    throw new Error("generator and verifier roots must be distinct");
  }
  ACTIVE_ROOTS.add(verifierRoot);
  let server: ReturnType<typeof Bun.serve> | null = null;
  let request: TrajectoryVerifierRequest | null = null;
  let workerActive = false;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (incoming) => {
        if (incoming.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
        const body = await incoming.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || Object.keys(body).length !== 1 || body.request_id !== input.request.request_id) {
          return Response.json({ error: "opaque replay request denied" }, { status: 403 });
        }
        try {
          return Response.json(parseTrajectoryReplayObservation(await input.replay()));
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        }
      },
    });
    if (typeof server.port !== "number") throw new Error("trajectory replay broker failed to bind");
    ACTIVE_PORTS.add(server.port);
    const raw = structuredClone(input.request) as TrajectoryRuntimeInput["request"];
    raw.redacted_observations.generator_root_sha256 = trajectorySha256({ role: "generator-root", scenario_id: raw.scenario_id, seed: raw.seed });
    raw.redacted_observations.verifier_root_sha256 = trajectorySha256({ role: "verifier-root", scenario_id: raw.scenario_id, seed: raw.seed });
    request = {
      ...raw,
      replay_tool_url: `http://127.0.0.1:${server.port}/replay`,
    };
    request.redacted_observations.qualitative_evidence.request_sha256 = computeTrajectoryRequestHash(request);
    request = parseTrajectoryVerifierRequest(request);
    const workerPath = resolve(join(import.meta.dir, "trajectory-verifier-worker.ts"));
    ACTIVE_WORKERS++;
    workerActive = true;
    const child = await new Promise<{ error: ExecFileException | null; stdout: string }>((resolveChild) => {
      const process = execFile("bun", [workerPath], {
        cwd: verifierRoot,
        env: workerEnv(verifierRoot) as Record<string, string>,
        encoding: "utf8",
        timeout: input.timeoutMs ?? 5_000,
        maxBuffer: 2 * 1024 * 1024,
        killSignal: "SIGKILL",
      }, (error, stdout) => resolveChild({ error, stdout: stdout ?? "" }));
      process.stdin?.end(canonicalize(request));
    });
    ACTIVE_WORKERS--;
    workerActive = false;
    if (child.error) {
      const timedOut = child.error.killed && child.error.signal === "SIGKILL";
      const reason = timedOut ? "trajectory verifier worker timed out" : "trajectory verifier worker failed";
      return buildTrajectoryHoldReport(request, reason, { environment_secret_free: true });
    }
    return parseTrajectoryVerifierReport(JSON.parse(child.stdout));
  } catch (error) {
    if (!request) throw error;
    return buildTrajectoryHoldReport(request, `trajectory verifier runtime failure: ${String(error)}`, { environment_secret_free: true });
  } finally {
    if (workerActive) ACTIVE_WORKERS--;
    if (server?.port) ACTIVE_PORTS.delete(server.port);
    server?.stop(true);
    ACTIVE_ROOTS.delete(verifierRoot);
    rmSync(verifierRoot, { recursive: true, force: true });
  }
}
