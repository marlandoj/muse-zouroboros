import { describe, expect, test } from "bun:test";
import {
  FACTORY_DIRECT_MIN_REVIEWERS,
  FACTORY_DIRECT_REVIEW_MODELS,
  factoryGateEnvironment,
  factoryReviewEnvironment,
} from "./factory-review-topology";

describe("factory review topology", () => {
  test("defaults to three direct seats with a two-responsive-seat quorum", () => {
    const env = factoryReviewEnvironment({});

    expect(env.CONSENSUS_MODELS).toBe(FACTORY_DIRECT_REVIEW_MODELS.join(","));
    expect(env.CONSENSUS_MIN_REVIEWERS).toBe(FACTORY_DIRECT_MIN_REVIEWERS);
    expect(env.CONSENSUS_MODELS?.split(",")).toHaveLength(3);
    expect(env.CONSENSUS_MODELS).not.toContain("hf:");
    expect(env.LINEUP_PIN_AGGREGATOR).toBeUndefined();
    expect(env.LINEUP_ROLE_CHAINS).toBeUndefined();
  });

  test("preserves an explicit factory override", () => {
    const env = factoryReviewEnvironment({
      CONSENSUS_MODELS: "kimi:kimi-k3,byok:custom",
      CONSENSUS_MIN_REVIEWERS: "1",
    });

    expect(env.CONSENSUS_MODELS).toBe("kimi:kimi-k3,byok:custom");
    expect(env.CONSENSUS_MIN_REVIEWERS).toBe("1");
  });

  test("passes ticket-scoped Model Policy pins through without adding an aggregator", () => {
    const env = factoryReviewEnvironment(
      { UNRELATED: "keep" },
      { LINEUP_PIN_PROPOSERS: "oc:a,hf:b,or:c" },
    );

    expect(env.CONSENSUS_MODELS).toBe(FACTORY_DIRECT_REVIEW_MODELS.join(","));
    expect(env.LINEUP_PIN_PROPOSERS).toBe("oc:a,hf:b,or:c");
    expect(env.LINEUP_PIN_AGGREGATOR).toBeUndefined();
    expect(env.UNRELATED).toBe("keep");
  });

  test("binds the factory trace to the gate subprocess", () => {
    const env = factoryGateEnvironment("factory:exec-1071", {});

    expect(env.ZO_TRACE_ID).toBe("factory:exec-1071");
    expect(env.CONSENSUS_MODELS).toBe(FACTORY_DIRECT_REVIEW_MODELS.join(","));
  });
});
