import { describe, expect, test } from "bun:test";
import { retryableExecutionContractError } from "./execution-contract-error";

describe("retryable execution contract errors", () => {
  test("marks direct-campaign validation configuration failures retryable", () => {
    expect(retryableExecutionContractError(
      "coding cascade enforce requires FACTORY_CODING_CASCADE_VALIDATION_COMMANDS for direct campaigns",
    )).toBe(true);
    expect(retryableExecutionContractError(
      "FACTORY_CODING_CASCADE_VALIDATION_COMMANDS is invalid JSON: Unexpected token",
    )).toBe(true);
    expect(retryableExecutionContractError(
      "coding cascade validation commands are missing: FACTORY_CODING_CASCADE_VALIDATION_COMMANDS",
    )).toBe(true);
    expect(retryableExecutionContractError(
      "validation command[0] timeout_ms must be a positive integer: FACTORY_CODING_CASCADE_VALIDATION_COMMANDS",
    )).toBe(true);
  });

  test("preserves retryability for repairable seed contracts", () => {
    expect(retryableExecutionContractError("seed not found: seed-zou-1397.yaml")).toBe(true);
    expect(retryableExecutionContractError(
      "validation command[0] requires label, command, and string[] args: seed-zou-1397.yaml",
    )).toBe(true);
  });

  test("keeps authorization and executor failures terminal", () => {
    expect(retryableExecutionContractError("coding cascade enforce requires an explicit target repository")).toBe(false);
    expect(retryableExecutionContractError("governance authorization denied")).toBe(false);
    expect(retryableExecutionContractError("executor chain exhausted")).toBe(false);
  });
});
