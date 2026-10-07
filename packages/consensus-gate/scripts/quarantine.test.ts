import { describe, expect, test } from "bun:test";
import {
  candidateRouteId,
  DEFAULT_CONSENSUS_MODELS,
  distinctDailyShadowLog,
} from "./quarantine";

test("default consensus panel uses currently funded providers", () => {
  expect(DEFAULT_CONSENSUS_MODELS).toEqual([
    "hf:zai-org/GLM-5.2",
    "kimi:kimi-k3",
    "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
  ]);
});

describe("shadow promotion evidence", () => {
  test("normalizes legacy OpenRouter candidate ids into direct routes", () => {
    expect(candidateRouteId({ id: "anthropic/claude-fable-5", provider: "openrouter" })).toBe(
      "or:anthropic/claude-fable-5",
    );
    expect(candidateRouteId({ id: "oc:claude-fable-5", provider: "opencode" })).toBe("oc:claude-fable-5");
  });

  test("counts at most one independent observation per UTC day", () => {
    const log = [
      { model: "candidate", date: "2026-07-10T01:00:00.000Z", effective_weight: 0.7 },
      { model: "candidate", date: "2026-07-10T12:00:00.000Z", effective_weight: 0.8 },
      { model: "candidate", date: "2026-07-11T01:00:00.000Z", effective_weight: 0.9 },
      { model: "other", date: "2026-07-11T01:00:00.000Z", effective_weight: 1 },
    ];
    expect(distinctDailyShadowLog(log, "candidate")).toEqual([
      { model: "candidate", date: "2026-07-10T12:00:00.000Z", effective_weight: 0.8 },
      { model: "candidate", date: "2026-07-11T01:00:00.000Z", effective_weight: 0.9 },
    ]);
  });
});
