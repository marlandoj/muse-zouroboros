import { describe, expect, test } from "bun:test";
import {
  resolveHetznerExecutionRoute,
  validateHetznerExecutorConfig,
  type HetznerExecutorConfig,
} from "./hetzner-executor-policy";

const CONFIG: HetznerExecutorConfig = validateHetznerExecutorConfig({
  version: 1,
  enabled: true,
  provider: "hetzner",
  location: "hel1",
  image: "ubuntu-24.04",
  default_profile: "medium",
  max_profile: "large",
  max_in_flight: 1,
  profiles: {
    small: { server_type: "cpx32", vcpus: 4, memory_gib: 8, cpu: "shared", ttl_minutes: 45, max_cost_usd: 0.1 },
    medium: { server_type: "ccx23", vcpus: 4, memory_gib: 16, cpu: "dedicated", ttl_minutes: 60, max_cost_usd: 0.25 },
    large: { server_type: "ccx33", vcpus: 8, memory_gib: 32, cpu: "dedicated", ttl_minutes: 90, max_cost_usd: 0.5 },
  },
  kill_switch: "SF_HETZNER_EXECUTOR=0",
});

function route(description: string, env: Record<string, string | undefined> = {}) {
  return resolveHetznerExecutionRoute({ title: "Factory task", description }, env, CONFIG);
}

describe("Hetzner natural-language routing", () => {
  test("treats explicit use language as binding", () => {
    const decision = route("Hetzner is to be used for this execution.");
    expect(decision.requested).toBe(true);
    expect(decision.binding).toBe(true);
    expect(decision.supported).toBe(true);
    expect(decision.profile_name).toBe("medium");
  });

  test("supports a structured execution target", () => {
    expect(route("execution_target: hetzner-ephemeral").requested).toBe(true);
  });

  test("does not route incidental mentions", () => {
    expect(route("Document how Hetzner differs from AWS.").requested).toBe(false);
  });

  test("negation takes precedence", () => {
    const decision = route("Discuss Hetzner, but do not use Hetzner for this build.");
    expect(decision.requested).toBe(false);
    expect(decision.reason).toContain("negation");
  });

  test("promotes browser and WebGPU work to large", () => {
    const decision = route("Use Hetzner for this WebGPU browser and Playwright build.");
    expect(decision.profile_name).toBe("large");
    expect(decision.profile?.server_type).toBe("ccx33");
  });

  test("uses small for explicitly narrow work", () => {
    expect(route("Use Hetzner for this docs-only patch.").profile_name).toBe("small");
  });

  test("accepts allowlisted profile and server type overrides", () => {
    expect(route("Use Hetzner. hetzner_profile: small").profile_name).toBe("small");
    expect(route("Use Hetzner. hetzner_size: ccx33").profile_name).toBe("large");
  });

  test("rejects arbitrary server types", () => {
    const decision = route("Use Hetzner. hetzner_size: ccx63");
    expect(decision.requested).toBe(true);
    expect(decision.supported).toBe(false);
    expect(decision.reason).toContain("allowlist");
  });

  test("fails closed for GPU requests", () => {
    const decision = route("Use Hetzner with an NVIDIA GPU for CUDA tests.");
    expect(decision.requested).toBe(true);
    expect(decision.supported).toBe(false);
    expect(decision.reason).toContain("CPU-only");
  });

  test("kill switch disables requested execution without removing intent", () => {
    const decision = route("Use Hetzner for the build.", { SF_HETZNER_EXECUTOR: "0" });
    expect(decision.requested).toBe(true);
    expect(decision.supported).toBe(false);
    expect(decision.reason).toContain("kill switch");
  });
});

describe("Hetzner sizing configuration", () => {
  test("requires exactly one global in-flight worker", () => {
    expect(() => validateHetznerExecutorConfig({ ...CONFIG, max_in_flight: 2 })).toThrow("exactly 1");
  });

  test("rejects an oversized TTL", () => {
    expect(() => validateHetznerExecutorConfig({
      ...CONFIG,
      profiles: { ...CONFIG.profiles, large: { ...CONFIG.profiles.large, ttl_minutes: 121 } },
    })).toThrow("no greater than 120");
  });
});
