import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildPortableHarnessInventory } from "../../../packages/swarm/src/executor/portability.ts";
import { buildSyntheticHarnessPortabilityQualification } from "./harness-portability-comparison-cohort.ts";
import {
  buildCompatibilityMatrix,
  finalizeObservation,
  finalizeProtocol,
  parseCapabilityConformanceCell,
  parseCompatibilityMatrix,
  parseHarnessPortabilityObservation,
  parseHarnessPortabilityPair,
  parseHarnessPortabilityProtocol,
  parseHarnessPortabilitySummary,
} from "./harness-portability-comparison-contract.ts";
import { evaluateHarnessPortabilityComparison } from "./harness-portability-comparison-runner.ts";

const fixture = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");
const inventory = buildPortableHarnessInventory();

describe("harness portability comparison contract", () => {
  test("accepts strict protocol, comparison, pair, observation, capability, budget, interval, matrix, and summary inputs", () => {
    const qualification = buildSyntheticHarnessPortabilityQualification(fixture);
    const protocol = parseHarnessPortabilityProtocol(qualification.protocol, inventory);
    const pair = parseHarnessPortabilityPair(qualification.pairs[0], protocol);
    const observation = parseHarnessPortabilityObservation(qualification.observations[0], pair, protocol, inventory);
    const cell = parseCapabilityConformanceCell(qualification.capability_cells[0], pair);
    const matrix = parseCompatibilityMatrix(buildCompatibilityMatrix(inventory), inventory);
    const summary = evaluateHarnessPortabilityComparison(qualification.protocol, qualification.pairs, qualification.observations, qualification.capability_cells, inventory);
    expect(parseHarnessPortabilitySummary(summary, protocol, inventory)).toEqual(summary);
    expect(protocol.comparisons).toHaveLength(3);
    expect(protocol.task_contracts).toHaveLength(10);
    expect(pair.comparison_id).toBe(observation.comparison_id);
    expect(cell.denominator_included).toBe(true);
    expect(matrix.entries.map((entry) => entry.harness_id)).toEqual(["claude-code", "codex", "gemini", "hermes", "kimi", "opencode", "pi"]);
  });

  test("rejects unknown fields, duplicates, hash drift, contract drift, and unscoped pair identity", () => {
    const qualification = buildSyntheticHarnessPortabilityQualification(fixture);
    expect(() => parseHarnessPortabilityProtocol({ ...qualification.protocol, surprise: true }, inventory)).toThrow("unknown fields");
    expect(() => parseHarnessPortabilityProtocol({ ...qualification.protocol, task_contracts: [...qualification.protocol.task_contracts, qualification.protocol.task_contracts[0]] }, inventory)).toThrow();
    expect(() => parseHarnessPortabilityProtocol({ ...qualification.protocol, protocol_sha256: "f".repeat(64) }, inventory)).toThrow("protocol hash drift");
    const protocol = parseHarnessPortabilityProtocol(qualification.protocol, inventory);
    expect(() => parseHarnessPortabilityPair({ ...qualification.pairs[0], pair_id: "pair-not-comparison-scoped" }, protocol)).toThrow("comparison-scoped");
    expect(() => parseHarnessPortabilityPair({ ...qualification.pairs[0], input_contract_sha256: "f".repeat(64) }, protocol)).toThrow();
    const summary = evaluateHarnessPortabilityComparison(qualification.protocol, qualification.pairs, qualification.observations, qualification.capability_cells, inventory);
    expect(() => parseHarnessPortabilitySummary({ ...summary, surprise: true }, protocol, inventory)).toThrow("unknown fields");
    expect(() => parseHarnessPortabilitySummary({ ...summary, summary_sha256: "f".repeat(64) }, protocol, inventory)).toThrow("summary hash drift");
  });

  test("rejects raw or secret data recursively and enforces production adapter plus proof boundaries", () => {
    const qualification = buildSyntheticHarnessPortabilityQualification(fixture);
    const protocol = parseHarnessPortabilityProtocol(qualification.protocol, inventory);
    const pair = parseHarnessPortabilityPair(qualification.pairs[0], protocol);
    expect(() => parseHarnessPortabilityProtocol({ ...qualification.protocol, task_contracts: qualification.protocol.task_contracts.map((task, index) => index === 0 ? { ...task, raw_prompt: "plaintext" } : task) }, inventory)).toThrow("forbidden field");
    expect(() => parseHarnessPortabilityProtocol({ ...qualification.protocol, protocol_id: "sk_live_1234567890" }, inventory)).toThrow("secret-shaped");
    const { observation_sha256: _ignored, ...observationBody } = qualification.observations[0];
    const drifted = finalizeObservation({ ...observationBody, adapter_sha256: "f".repeat(64) });
    expect(() => parseHarnessPortabilityObservation(drifted, pair, protocol, inventory)).toThrow("adapter hash drift");
    const collapsed = finalizeObservation({
      ...observationBody,
      verifier_identity: qualification.observations[0].generator_identity,
    });
    expect(() => parseHarnessPortabilityObservation(collapsed, pair, protocol, inventory)).toThrow("identities must differ");
    const { protocol_sha256: _protocolHash, ...protocolBody } = qualification.protocol;
    const receiptDrift = finalizeProtocol({
      ...protocolBody,
      task_contracts: protocolBody.task_contracts.map((task, index) => index === 0
        ? { ...task, receipt_contract_sha256: "f".repeat(64) }
        : task),
    });
    expect(() => parseHarnessPortabilityProtocol(receiptDrift, inventory)).toThrow("receipt contract drifts from the incumbent");
  });
});
