import { describe, test, expect } from "bun:test";
import {
  normalizeModelId,
  sameModel,
  excludeAuthor,
  panelGuard,
  cgFlagOn,
  cgNum,
  arbiterHardFail,
  hasQualifyingDissent,
  applyTrustAndRecall,
  type VerdictLike,
} from "./reviewer-independence";
import { ARBITER_MODEL_ID } from "./diversity-arbiter";

describe("normalizeModelId", () => {
  const cases: Array<{ name: string; input: string; want: string }> = [
    { name: "empty", input: "", want: "" },
    { name: "strips hf: scheme", input: "hf:zai-org/GLM-5.2", want: "zai-org/glm-5.2" },
    { name: "strips xai: scheme", input: "xai:grok-3-mini", want: "grok-3-mini" },
    { name: "strips kimi: scheme", input: "kimi:kimi-k3", want: "kimi-k3" },
    { name: "lowercases bare id", input: "GLM-5.2", want: "glm-5.2" },
    { name: "leaves unknown scheme intact", input: "weird:foo/bar", want: "weird:foo/bar" },
    { name: "trims surrounding space", input: "  hf:org/Model  ", want: "org/model" },
  ];
  for (const c of cases) {
    test(c.name, () => expect(normalizeModelId(c.input)).toBe(c.want));
  }
});

describe("sameModel", () => {
  const cases: Array<{ name: string; a: string; b: string; want: boolean }> = [
    { name: "identical", a: "hf:zai-org/GLM-5.2", b: "hf:zai-org/GLM-5.2", want: true },
    { name: "scheme remap (hf vs openrouter)", a: "hf:zai-org/GLM-5.2", b: "openrouter:zai-org/glm-5.2", want: true },
    { name: "bare basename vs full path", a: "GLM-5.2", b: "hf:zai-org/GLM-5.2", want: true },
    { name: "case-insensitive", a: "hf:MoonshotAI/Kimi-K2.6", b: "hf:moonshotai/kimi-k2.6", want: true },
    { name: "different models", a: "hf:zai-org/GLM-5.2", b: "hf:moonshotai/Kimi-K2.6", want: false },
    { name: "empty author never matches", a: "", b: "hf:zai-org/GLM-5.2", want: false },
  ];
  for (const c of cases) {
    test(c.name, () => expect(sameModel(c.a, c.b)).toBe(c.want));
  }
});

describe("excludeAuthor", () => {
  const panel = ["hf:zai-org/GLM-5.2", "hf:moonshotai/Kimi-K2.6", "xai:grok-3-mini"];
  const cases: Array<{ name: string; panel: string[]; author?: string; want: string[] }> = [
    { name: "author absent → unchanged", panel, author: undefined, want: panel },
    { name: "author present (exact) removed", panel, author: "hf:zai-org/GLM-5.2", want: ["hf:moonshotai/Kimi-K2.6", "xai:grok-3-mini"] },
    { name: "author present (alias) removed", panel, author: "GLM-5.2", want: ["hf:moonshotai/Kimi-K2.6", "xai:grok-3-mini"] },
    { name: "author present (scheme remap) removed", panel, author: "openrouter:moonshotai/kimi-k2.6", want: ["hf:zai-org/GLM-5.2", "xai:grok-3-mini"] },
    { name: "author not on panel → unchanged", panel, author: "hf:deepseek/DeepSeek-V4", want: panel },
    { name: "empty panel → empty", panel: [], author: "hf:zai-org/GLM-5.2", want: [] },
  ];
  for (const c of cases) {
    test(c.name, () => expect(excludeAuthor(c.panel, c.author)).toEqual(c.want));
  }

  test("does not mutate input panel", () => {
    const p = [...panel];
    excludeAuthor(p, "GLM-5.2");
    expect(p).toEqual(panel);
  });
});

describe("panelGuard", () => {
  const cases: Array<{ name: string; panel: string[]; min: number; ok: boolean }> = [
    { name: "above min", panel: ["a", "b", "c"], min: 2, ok: true },
    { name: "exactly min", panel: ["a", "b"], min: 2, ok: true },
    { name: "below min", panel: ["a"], min: 2, ok: false },
    { name: "empty below min", panel: [], min: 2, ok: false },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = panelGuard(c.panel, c.min);
      expect(r.ok).toBe(c.ok);
      if (!c.ok) expect(r.reason).toBe("author-exclusion-undersized-panel");
    });
  }
});

describe("cgFlagOn / cgNum", () => {
  test("flag default ON when unset", () => {
    delete process.env.__CG_TEST_FLAG;
    expect(cgFlagOn("__CG_TEST_FLAG", true)).toBe(true);
    expect(cgFlagOn("__CG_TEST_FLAG", false)).toBe(false);
  });
  const offVals = ["0", "false", "off", "no", "FALSE", "Off"];
  for (const v of offVals) {
    test(`flag '${v}' → off`, () => {
      process.env.__CG_TEST_FLAG = v;
      expect(cgFlagOn("__CG_TEST_FLAG", true)).toBe(false);
    });
  }
  test("flag any other value → on", () => {
    process.env.__CG_TEST_FLAG = "1";
    expect(cgFlagOn("__CG_TEST_FLAG", false)).toBe(true);
    delete process.env.__CG_TEST_FLAG;
  });
  test("cgNum parses / falls back", () => {
    delete process.env.__CG_TEST_NUM;
    expect(cgNum("__CG_TEST_NUM", 0.7)).toBe(0.7);
    process.env.__CG_TEST_NUM = "0.85";
    expect(cgNum("__CG_TEST_NUM", 0.7)).toBe(0.85);
    process.env.__CG_TEST_NUM = "not-a-number";
    expect(cgNum("__CG_TEST_NUM", 0.7)).toBe(0.7);
    delete process.env.__CG_TEST_NUM;
  });
});

const llmPass = (model: string, confidence = 0.9): VerdictLike => ({ model, pass: true, confidence });
const llmFail = (
  model: string,
  confidence: number,
  severity: "high" | "medium" | "low",
): VerdictLike => ({ model, pass: false, confidence, dissent_claims: [{ claim: "issue", severity }] });
const arbiterFail = (severity: "high" | "medium" | "low"): VerdictLike => ({
  model: ARBITER_MODEL_ID,
  pass: false,
  confidence: severity === "high" ? 0.85 : 0.95,
  dissent_claims: [{ claim: "arb", severity }],
});

describe("arbiterHardFail", () => {
  test("arbiter fail with high-sev claim → true", () => {
    expect(arbiterHardFail([llmPass("A"), arbiterFail("high")])).toBe(true);
  });
  test("arbiter fail with only medium claim → false", () => {
    expect(arbiterHardFail([llmPass("A"), arbiterFail("medium")])).toBe(false);
  });
  test("arbiter pass → false", () => {
    expect(arbiterHardFail([llmPass("A"), { model: ARBITER_MODEL_ID, pass: true, confidence: 1.0 }])).toBe(false);
  });
  test("high-sev LLM fail is NOT an arbiter hard fail", () => {
    expect(arbiterHardFail([llmFail("A", 0.9, "high")])).toBe(false);
  });
});

describe("hasQualifyingDissent", () => {
  test("high-conf high-sev LLM dissent → true", () => {
    expect(hasQualifyingDissent([llmPass("A"), llmFail("B", 0.8, "high")], 0.7)).toBe(true);
  });
  test("low-conf high-sev dissent → false (below conf floor)", () => {
    expect(hasQualifyingDissent([llmPass("A"), llmFail("B", 0.5, "high")], 0.7)).toBe(false);
  });
  test("high-conf low-sev nit → false", () => {
    expect(hasQualifyingDissent([llmPass("A"), llmFail("B", 0.95, "low")], 0.7)).toBe(false);
  });
  test("arbiter high-sev fail does NOT count as fuzzy dissent", () => {
    expect(hasQualifyingDissent([llmPass("A"), arbiterFail("high")], 0.7)).toBe(false);
  });
});

describe("applyTrustAndRecall precedence", () => {
  const both = { deterministicFirst: true, recallBias: true, recallConf: 0.7 };

  test("deterministic hard fail rejects even when LLMs all pass", () => {
    const out = applyTrustAndRecall(
      [llmPass("A"), llmPass("B"), arbiterFail("high")],
      { pass: true, status: "passed" },
      both,
    );
    expect(out.status).toBe("rejected");
    expect(out.pass).toBe(false);
    expect(out.reason).toBe("deterministic-first-hard-fail");
  });

  test("deterministic block takes precedence over recall escalate", () => {
    const out = applyTrustAndRecall(
      [llmPass("A"), llmFail("B", 0.9, "high"), arbiterFail("high")],
      { pass: true, status: "passed" },
      both,
    );
    expect(out.status).toBe("rejected");
  });

  test("recall escalate when a passed merge hides a high-conf high-sev dissent", () => {
    const out = applyTrustAndRecall(
      [llmPass("A"), llmPass("B"), llmFail("C", 0.8, "high")],
      { pass: true, status: "passed" },
      both,
    );
    expect(out.status).toBe("escalate");
    expect(out.pass).toBe(null);
    expect(out.reason).toBe("recall-bias-high-sev-dissent");
  });

  test("flags OFF → base outcome unchanged", () => {
    const out = applyTrustAndRecall(
      [llmPass("A"), llmPass("B"), arbiterFail("high")],
      { pass: true, status: "passed" },
      { deterministicFirst: false, recallBias: false, recallConf: 0.7 },
    );
    expect(out.status).toBe("passed");
    expect(out.pass).toBe(true);
    expect(out.reason).toBeUndefined();
  });

  test("recall does not touch a non-passed base (rejected stays rejected)", () => {
    const out = applyTrustAndRecall(
      [llmFail("A", 0.9, "high"), llmFail("B", 0.9, "high")],
      { pass: false, status: "rejected" },
      both,
    );
    expect(out.status).toBe("rejected");
  });

  test("low-conf nit dissent does not flip a pass", () => {
    const out = applyTrustAndRecall(
      [llmPass("A"), llmPass("B"), llmFail("C", 0.4, "low")],
      { pass: true, status: "passed" },
      both,
    );
    expect(out.status).toBe("passed");
  });
});
