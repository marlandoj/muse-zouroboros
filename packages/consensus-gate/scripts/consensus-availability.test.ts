import { describe, expect, test } from "bun:test";
import { isUnavailableVerdict, selectConsensusVoters } from "./consensus-availability";

const verdict = (model: string, confidence: number, issues: string[] = []) => ({
  model,
  confidence,
  issues,
  pass: confidence > 0,
});

describe("consensus availability", () => {
  test("classifies transport, timeout, empty, and parse failures as unavailable", () => {
    expect(isUnavailableVerdict(verdict("timeout", 0, ["Call failed: synthetic timed out after 25000ms"]))).toBe(true);
    expect(isUnavailableVerdict(verdict("http", 0, ["API error: 503"]))).toBe(true);
    expect(isUnavailableVerdict(verdict("empty", 0, ["Empty response from vendor"]))).toBe(true);
    expect(isUnavailableVerdict(verdict("parse", 0, ["Unparseable verdict: prose"]))).toBe(true);
  });

  test("keeps a genuine negative review in the voter set", () => {
    expect(isUnavailableVerdict(verdict("reviewer", 0.8, ["state transition skips verification"]))).toBe(false);
  });

  test("excludes unavailable reviewers without weakening the minimum quorum", () => {
    const selection = selectConsensusVoters([
      verdict("a", 0.9),
      verdict("b", 0.8, ["real finding"]),
      verdict("c", 0, ["Call failed: timeout"]),
    ], verdict("arbiter", 1), 2);
    expect(selection.quorumOk).toBe(true);
    expect(selection.voters.map((item) => item.model)).toEqual(["a", "b", "arbiter"]);
    expect(selection.unavailable.map((item) => item.model)).toEqual(["c"]);
  });

  test("fails quorum when fewer than two LLM reviewers respond", () => {
    const selection = selectConsensusVoters([
      verdict("a", 0.9),
      verdict("b", 0, ["API error: 500"]),
      verdict("c", 0, ["Call failed: timeout"]),
    ], verdict("arbiter", 1), 2);
    expect(selection.quorumOk).toBe(false);
  });
});
