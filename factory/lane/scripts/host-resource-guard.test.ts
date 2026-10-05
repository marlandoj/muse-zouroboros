import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireExecutorLease,
  assertMemoryHeadroom,
  cgroupAvailableMemoryMib,
  effectiveAvailableMemoryMib,
  enterFactoryExecutorGuard,
  parseCgroupBytes,
  parseMemAvailableMib,
  parseProcessStartTicks,
  validateHostResourcePolicy,
} from "./host-resource-guard";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "factory-host-guard-"));
  roots.push(path);
  return path;
}

const policy = validateHostResourcePolicy({
  version: 1,
  enabled: true,
  min_available_memory_mib: 16_384,
  executor_memory_limit_mib: 12_288,
  executor_nice: 10,
  executor_cpu_set: "0-7",
  executor_process_limit: 256,
  max_concurrent_executor_trees: 1,
});

describe("factory host resource guard", () => {
  test("parses host memory and chooses the tighter cgroup headroom", () => {
    expect(parseMemAvailableMib("MemTotal: 100 kB\nMemAvailable: 20971520 kB\n")).toBe(20_480);
    expect(effectiveAvailableMemoryMib(20_480, 18_000)).toBe(18_000);
    expect(effectiveAvailableMemoryMib(20_480, null)).toBe(20_480);
    expect(parseCgroupBytes("max\n")).toBeNull();
    expect(parseCgroupBytes("2147483648\n")).toBe(2_147_483_648);
    expect(cgroupAvailableMemoryMib(1_073_741_824, 2_147_483_648)).toBe(1024);
  });

  test("requires the safety policy to remain enabled", () => {
    expect(() => validateHostResourcePolicy({
      ...policy,
      enabled: false,
    })).toThrow("enabled must be true");
  });

  test("binds leases to process identity, not a reusable pid alone", () => {
    const stat = "101 (executor worker) S " + Array.from({ length: 19 }, (_, index) => index === 18 ? "4242" : "0").join(" ");
    expect(parseProcessStartTicks(stat)).toBe("4242");
  });

  test("fails closed below the configured memory floor", () => {
    expect(() => assertMemoryHeadroom(policy, {
      host_available_mib: 15_000,
      cgroup_available_mib: null,
      effective_available_mib: 15_000,
    })).toThrow("blocked executor dispatch");
  });

  test("requires one executor tree and proportionate host headroom beyond its limit", () => {
    expect(() => validateHostResourcePolicy({
      ...policy,
      max_concurrent_executor_trees: 2,
    })).toThrow("exactly 1");
    expect(() => validateHostResourcePolicy({
      ...policy,
      min_available_memory_mib: 1_024,
    })).toThrow("at least half the executor memory limit (6144 MiB)");
  });

  test("accepts an explicitly configured container-sized policy", () => {
    // Container hosts can expose only ~1 GiB of observable headroom even
    // though the executor itself remains capped, so the configured floor is
    // proportionate to the 2048 MiB cap rather than the historical bare-metal
    // executor-limit-plus-4096-MiB requirement.
    expect(validateHostResourcePolicy({
      version: 1,
      enabled: true,
      min_available_memory_mib: 1_024,
      executor_memory_limit_mib: 2_048,
      executor_nice: 10,
      executor_cpu_set: "0-1",
      executor_process_limit: 256,
      max_concurrent_executor_trees: 1,
    })).toEqual({
      version: 1,
      enabled: true,
      min_available_memory_mib: 1_024,
      executor_memory_limit_mib: 2_048,
      executor_nice: 10,
      executor_cpu_set: "0-1",
      executor_process_limit: 256,
      max_concurrent_executor_trees: 1,
    });
    expect(() => validateHostResourcePolicy({
      version: 1,
      enabled: true,
      min_available_memory_mib: 1_023,
      executor_memory_limit_mib: 2_048,
      executor_nice: 10,
      executor_cpu_set: "0-1",
      executor_process_limit: 256,
      max_concurrent_executor_trees: 1,
    })).toThrow("between 1024 and 65536");
  });

  test("enforces a cross-process lease and releases only its own token", () => {
    const leasePath = join(root(), "executor.lease.json");
    const first = acquireExecutorLease({
      path: leasePath,
      pid: 101,
      processStartTicks: "1001",
      isProcessAlive: () => true,
    });
    expect(() => acquireExecutorLease({
      path: leasePath,
      pid: 202,
      processStartTicks: "2002",
      isProcessAlive: () => true,
    })).toThrow("blocked concurrent executor dispatch");
    first.release();
    const second = acquireExecutorLease({
      path: leasePath,
      pid: 202,
      processStartTicks: "2002",
      isProcessAlive: () => true,
    });
    second.release();
  });

  test("reclaims a lease whose owning process is dead", () => {
    const leasePath = join(root(), "executor.lease.json");
    acquireExecutorLease({
      path: leasePath,
      pid: 101,
      processStartTicks: "1001",
      isProcessAlive: () => true,
    });
    const replacement = acquireExecutorLease({
      path: leasePath,
      pid: 202,
      processStartTicks: "2002",
      isProcessAlive: () => false,
    });
    replacement.release();
  });

  test("emits mandatory inherited executor limits after passing preflight", () => {
    const leasePath = join(root(), "executor.lease.json");
    const guard = enterFactoryExecutorGuard({
      leasePath,
      readings: {
        host_available_mib: 64_000,
        cgroup_available_mib: 60_000,
        effective_available_mib: 60_000,
      },
      pid: 101,
      processStartTicks: "1001",
      isProcessAlive: () => true,
    });
    expect(guard.executorEnv).toEqual({
      SWARM_EXEC_RESOURCE_GUARD_REQUIRED: "1",
      SWARM_EXEC_MEMORY_LIMIT_MIB: "2048",
      SWARM_EXEC_NICE: "10",
      SWARM_EXEC_CPU_SET: "0-1",
      SWARM_EXEC_PROCESS_LIMIT: "256",
      SWARM_EXEC_CONTAINMENT_REQUIRED: "1",
      SWARM_EXEC_CONTAINMENT_ROOT: "/home/workspace/.factory-worktrees",
      SWARM_EXEC_CONTAINMENT_UID: "65534",
      SWARM_EXEC_CONTAINMENT_GID: "65534",
    });
    guard.lease.release();
  });
});
