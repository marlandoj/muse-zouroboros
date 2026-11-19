import { describe, expect, test } from "bun:test";
import {
  finishCase,
  nativeChildCalls,
  nativeDelegationRequests,
  classifyFailure,
} from "./native-swarm-bench-support";

describe("native benchmark cannot turn partial evidence into a pass", () => {
  test("correct artifacts do not excuse a stuck shutdown", () => {
    expect(
      finishCase(
        { success: true, artifactPass: true },
        { code: null, timedOut: true }
      ).success
    ).toBe(false);
  });
  test("an early receipt does not excuse a later worker crash", () => {
    expect(
      finishCase({ success: true }, { code: 1, timedOut: false }).success
    ).toBe(false);
  });
  test("clean exit does not excuse failed acceptance", () => {
    expect(
      finishCase({ success: false }, { code: 0, timedOut: false }).success
    ).toBe(false);
    expect(finishCase({}, { code: 0, timedOut: false }).success).toBe(false);
  });
  test("complete successful evidence passes", () => {
    expect(
      finishCase({ success: true }, { code: 0, timedOut: false }).success
    ).toBe(true);
  });
  test("parent claims and shell mentions of agents are not delegation", () => {
    expect(
      nativeChildCalls([
        { type: "output", content: "Agent alpha and Agent beta completed" },
        {
          type: "tool_call",
          content: JSON.stringify({
            title: "Bash",
            toolCallId: "shell",
            command: "echo Task",
          }),
        },
        { type: "tool_call", content: "Agent alpha" },
      ])
    ).toEqual([]);
  });
  test("repeated progress for one call does not count as two children", () => {
    const event = {
      type: "tool_call",
      content: JSON.stringify({ title: "Agent", toolCallId: "child-a" }),
    };
    expect(nativeChildCalls([event, event])).toEqual(["child-a"]);
  });
  test("distinct native delegation calls count", () => {
    expect(
      nativeChildCalls(
        ["a", "b"].map((id) => ({
          type: "tool_call",
          content: JSON.stringify({ title: "delegate_task", toolCallId: id }),
        }))
      )
    ).toHaveLength(2);
  });
  test("Hermes batched native delegation counts children without double counting events", () => {
    const event = {
      type: "tool_call",
      content: JSON.stringify({
        title: "delegate_task: 2 tasks: alpha | beta",
        toolCallId: "batch",
      }),
    };
    expect(nativeChildCalls([event, event])).toHaveLength(1);
    expect(nativeDelegationRequests([event, event])).toBe(2);
  });
  test.each([
    ["401 invalid API key", "authentication"],
    ["429 quota exhausted", "quota"],
    ["ACP model foo not advertised", "model-not-found"],
    ["model requires a newer version of Codex", "incompatible-harness"],
    ["idle timed out after 65000ms", "timeout"],
  ])("classifies %s separately", (message, category) =>
    expect(classifyFailure(message)).toBe(category)
  );
});
