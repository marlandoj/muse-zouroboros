import { factoryProfileEnv, factoryWorktreesRoot } from "../../../packages/swarm/src/transport/factory-path-profile";
import { readManagedFactoryBoundary } from "../../../packages/swarm/src/transport/factory-systemd-containment";
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface HostResourcePolicy {
  version: 1;
  enabled: true;
  min_available_memory_mib: number;
  executor_memory_limit_mib: number;
  executor_nice: number;
  executor_cpu_set: string;
  executor_process_limit: number;
  max_concurrent_executor_trees: 1;
}

export interface HostMemoryReadings {
  host_available_mib: number;
  cgroup_available_mib: number | null;
  effective_available_mib: number;
}

export interface ExecutorLease {
  path: string | null;
  release(): void;
}

export interface FactoryExecutorGuard {
  policy: HostResourcePolicy;
  memory: HostMemoryReadings | null;
  executorEnv: Record<string, string>;
  lease: ExecutorLease;
}

interface LeaseRecord {
  version: 1;
  token: string;
  pid: number;
  acquired_at: string;
  process_start_ticks: string;
}

const FACTORY_ROOT = join(import.meta.dir, "..");
const DEFAULT_POLICY_PATH = join(FACTORY_ROOT, "config", "host-resource-policy.json");
const DEFAULT_LEASE_PATH = factoryStatePath("host-resource-executor.lease.json");
const MIB = 1024 * 1024;
const DEFAULT_POLICY: HostResourcePolicy = {
  version: 1,
  enabled: true,
  min_available_memory_mib: 16_384,
  executor_memory_limit_mib: 12_288,
  executor_nice: 10,
  executor_cpu_set: "0-7",
  executor_process_limit: 256,
  max_concurrent_executor_trees: 1,
};

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

export function validateHostResourcePolicy(input: unknown): HostResourcePolicy {
  if (!input || typeof input !== "object") throw new Error("host resource policy must be an object");
  const value = input as Partial<HostResourcePolicy>;
  if (value.version !== 1) throw new Error("host resource policy version must be 1");
  if (value.enabled !== true) throw new Error("host resource policy enabled must be true");
  if (value.max_concurrent_executor_trees !== 1) {
    throw new Error("max_concurrent_executor_trees must be exactly 1");
  }
  const minAvailable = boundedInteger(value.min_available_memory_mib, "min_available_memory_mib", 1_024, 65_536);
  const memoryLimit = boundedInteger(value.executor_memory_limit_mib, "executor_memory_limit_mib", 2_048, 65_536);
  // Explicitly configured policies may target container-sized hosts whose
  // observable headroom is much smaller than a bare-metal executor host.
  // Keep the floor positive and require headroom proportionate to the cap
  // instead of the historical fixed executor-limit-plus-4096-MiB rule.
  const requiredHeadroom = Math.ceil(memoryLimit / 2);
  if (minAvailable < requiredHeadroom) {
    throw new Error(
      `min_available_memory_mib must preserve at least half the executor memory limit (${requiredHeadroom} MiB)`,
    );
  }
  if (typeof value.executor_cpu_set !== "string" || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value.executor_cpu_set)) {
    throw new Error("executor_cpu_set must be a comma-separated CPU or CPU-range list");
  }
  return {
    version: 1,
    enabled: value.enabled,
    min_available_memory_mib: minAvailable,
    executor_memory_limit_mib: memoryLimit,
    executor_nice: boundedInteger(value.executor_nice, "executor_nice", 0, 19),
    executor_cpu_set: value.executor_cpu_set,
    executor_process_limit: boundedInteger(value.executor_process_limit, "executor_process_limit", 16, 512),
    max_concurrent_executor_trees: 1,
  };
}

export function loadHostResourcePolicy(path = DEFAULT_POLICY_PATH): HostResourcePolicy {
  if (!existsSync(path)) {
    if (path !== DEFAULT_POLICY_PATH) throw new Error(`host resource policy not found: ${path}`);
    return { ...DEFAULT_POLICY };
  }
  try {
    return validateHostResourcePolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`invalid host resource policy ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseMemAvailableMib(content: string): number {
  const match = content.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!match) throw new Error("MemAvailable is unavailable in /proc/meminfo");
  return Math.floor(Number(match[1]) / 1024);
}

export function parseCgroupBytes(content: string): number | null {
  const raw = content.trim();
  if (raw === "max") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid cgroup memory value: ${raw}`);
  return value;
}

function readCgroupBytes(path: string): number | null {
  if (!existsSync(path)) return null;
  return parseCgroupBytes(readFileSync(path, "utf8"));
}

export function cgroupAvailableMemoryMib(usageBytes: number | null, limitBytes: number | null): number | null {
  if (usageBytes === null || limitBytes === null || limitBytes >= Number.MAX_SAFE_INTEGER) return null;
  return Math.max(0, Math.floor((limitBytes - usageBytes) / MIB));
}

export function effectiveAvailableMemoryMib(hostAvailableMib: number, cgroupAvailableMib: number | null): number {
  return Math.floor(cgroupAvailableMib === null
    ? hostAvailableMib
    : Math.min(hostAvailableMib, cgroupAvailableMib));
}

export function readHostMemoryHeadroom(): HostMemoryReadings {
  const hostAvailableMib = parseMemAvailableMib(readFileSync("/proc/meminfo", "utf8"));
  const cgroupV2Usage = readCgroupBytes("/sys/fs/cgroup/memory.current");
  const cgroupV2Limit = readCgroupBytes("/sys/fs/cgroup/memory.max");
  const cgroupV1Usage = readCgroupBytes("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  const cgroupV1Limit = readCgroupBytes("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const cgroupAvailableMib = cgroupAvailableMemoryMib(cgroupV2Usage, cgroupV2Limit)
    ?? cgroupAvailableMemoryMib(cgroupV1Usage, cgroupV1Limit);
  return {
    host_available_mib: hostAvailableMib,
    cgroup_available_mib: cgroupAvailableMib,
    effective_available_mib: effectiveAvailableMemoryMib(hostAvailableMib, cgroupAvailableMib),
  };
}

export function assertMemoryHeadroom(policy: HostResourcePolicy, readings: HostMemoryReadings): void {
  if (readings.effective_available_mib < policy.min_available_memory_mib) {
    throw new Error(
      `factory host resource gate blocked executor dispatch: ${readings.effective_available_mib} MiB available; `
      + `${policy.min_available_memory_mib} MiB required`,
    );
  }
}

const HEADROOM_POLL_INTERVAL_MS = 2_000;
const HEADROOM_POLL_TIMEOUT_MS = 120_000;

/**
 * Poll host memory headroom until it clears the policy floor or a timeout
 * expires. On shared-memory containers (no delegated cgroup controllers)
 * MemAvailable swings with other tenants, so a single sample can block a
 * dispatch that would have been fine seconds later. Bounded: gives up
 * after the timeout and throws the same gate error. Never lowers the floor
 * and never bypasses the check — it only waits for a real reading that
 * passes it.
 */
export async function waitForMemoryHeadroom(options: {
  policy: HostResourcePolicy;
  readReadings?: () => HostMemoryReadings;
  timeoutMs?: number;
  intervalMs?: number;
  logger?: Pick<Console, 'warn'>;
} = {}): Promise<HostMemoryReadings> {
  const { policy } = options;
  const read = options.readReadings ?? readHostMemoryHeadroom;
  const timeoutMs = options.timeoutMs ?? HEADROOM_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? HEADROOM_POLL_INTERVAL_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let attempts = 0;
  for (;;) {
    const readings = read();
    attempts += 1;
    if (readings.effective_available_mib >= policy.min_available_memory_mib) {
      if (attempts > 1) {
        (options.logger ?? console).warn(
          `[host-resource-guard] memory headroom recovered after ${attempts} samples: `
          + `${readings.effective_available_mib} MiB available (floor ${policy.min_available_memory_mib} MiB)`,
        );
      }
      return readings;
    }
    if (Date.now() + intervalMs > deadline) {
      throw new Error(
        `factory host resource gate blocked executor dispatch: ${readings.effective_available_mib} MiB available; `
        + `${policy.min_available_memory_mib} MiB required (waited ${timeoutMs}ms, ${attempts} samples)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function parseProcessStartTicks(content: string): string {
  const commandEnd = content.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("invalid /proc stat: missing command terminator");
  const fields = content.slice(commandEnd + 1).trim().split(/\s+/);
  const startTicks = fields[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) throw new Error("invalid /proc stat: missing process start time");
  return startTicks;
}

function readProcessStartTicks(pid: number): string | null {
  try {
    return parseProcessStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

function processIdentityAlive(pid: number, expectedStartTicks: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return readProcessStartTicks(pid) === expectedStartTicks;
}

function loadLease(path: string): LeaseRecord {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseRecord>;
  if (
    value.version !== 1
    || typeof value.token !== "string"
    || !Number.isInteger(value.pid)
    || typeof value.acquired_at !== "string"
    || !Number.isFinite(Date.parse(value.acquired_at))
    || typeof value.process_start_ticks !== "string"
    || !/^\d+$/.test(value.process_start_ticks)
  ) {
    throw new Error(`invalid executor lease: ${path}`);
  }
  return value as LeaseRecord;
}

export function acquireExecutorLease(options: {
  path?: string;
  now?: Date;
  pid?: number;
  processStartTicks?: string;
  isProcessAlive?: (pid: number, processStartTicks: string) => boolean;
} = {}): ExecutorLease {
  const path = options.path ?? DEFAULT_LEASE_PATH;
  const now = options.now ?? new Date();
  const pid = options.pid ?? process.pid;
  const processStartTicks = options.processStartTicks ?? readProcessStartTicks(pid);
  if (!processStartTicks) throw new Error(`cannot determine process identity for executor lease pid ${pid}`);
  const isAlive = options.isProcessAlive ?? processIdentityAlive;
  const token = randomUUID();
  const record: LeaseRecord = {
    version: 1,
    token,
    pid,
    acquired_at: now.toISOString(),
    process_start_ticks: processStartTicks,
  };
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return {
        path,
        release() {
          if (!existsSync(path)) return;
          const current = loadLease(path);
          if (current.token === token) unlinkSync(path);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = loadLease(path);
      if (!isAlive(current.pid, current.process_start_ticks)) {
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      throw new Error(
        `factory host resource gate blocked concurrent executor dispatch: pid ${current.pid} `
        + `holds ${path} since ${current.acquired_at}`,
      );
    }
  }
  throw new Error(`factory host resource gate could not acquire executor lease: ${path}`);
}

export function enterFactoryExecutorGuard(options: {
  policyPath?: string;
  leasePath?: string;
  readings?: HostMemoryReadings;
  now?: Date;
  pid?: number;
  processStartTicks?: string;
  isProcessAlive?: (pid: number, processStartTicks: string) => boolean;
} = {}): FactoryExecutorGuard {
  const managed = readManagedFactoryBoundary();
  if (managed && Object.keys(options).length) throw new Error("managed Factory guard forbids caller policy/observation overrides");
  const profileEnv = managed ? { HOME: managed.policy.home, CODEX_HOME: join(managed.policy.home, ".codex") } : factoryProfileEnv();
  const containmentRoot = managed?.policy.workdir ?? factoryWorktreesRoot();
  const policy = loadHostResourcePolicy(options.policyPath);
  if (managed && JSON.stringify(policy) !== JSON.stringify(DEFAULT_POLICY)) {
    throw new Error("managed Factory unit requires the exact enrolled host resource policy");
  }
  const memory = options.readings ?? readHostMemoryHeadroom();
  assertMemoryHeadroom(policy, memory);
  const lease = acquireExecutorLease({
    path: options.leasePath,
    now: options.now,
    pid: options.pid,
    processStartTicks: options.processStartTicks,
    isProcessAlive: options.isProcessAlive,
  });
  return {
    policy,
    memory,
    executorEnv: {
      ...profileEnv,
      SWARM_EXEC_RESOURCE_GUARD_REQUIRED: "1",
      SWARM_EXEC_MEMORY_LIMIT_MIB: String(policy.executor_memory_limit_mib),
      SWARM_EXEC_NICE: String(policy.executor_nice),
      SWARM_EXEC_CPU_SET: policy.executor_cpu_set,
      SWARM_EXEC_PROCESS_LIMIT: String(policy.executor_process_limit),
      SWARM_EXEC_CONTAINMENT_REQUIRED: "1",
      SWARM_EXEC_CONTAINMENT_ROOT: containmentRoot,
      SWARM_EXEC_CONTAINMENT_UID: String(managed?.policy.worker_uid ?? 65534),
      SWARM_EXEC_CONTAINMENT_GID: String(managed?.policy.worker_gid ?? 65534),
    },
    lease,
  };
}
