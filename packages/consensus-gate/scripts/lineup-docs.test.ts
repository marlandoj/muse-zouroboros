import { describe, expect, test } from "bun:test";
import { renderMarkdown, type LineupManifest } from "./lineup-docs";

const manifest: LineupManifest = {
  schemaVersion: 2,
  generatedAt: "2026-07-13T00:00:00.000Z",
  configHash: "abc123",
  moa: {
    fallback: {
      proposers: [{ id: "fallback/a", name: "Fallback A", family: "fallback", provider: "openrouter", role: "proposer" }],
      aggregator: { id: "fallback/judge", name: "Fallback Judge", family: "judge", provider: "openrouter", role: "aggregator" },
    },
    effective: {
      source: "dynamic",
      proposers: [{ id: "hf:org/A", name: "A", family: "a", provider: "synthetic", role: "proposer" }],
      aggregator: { id: "oc:judge", name: "Judge", family: "judge", provider: "opencode", role: "aggregator" },
    },
    profiles: [{
      profile: "flagship",
      roleProfile: "deep-reasoning",
      capabilityTier: "frontier",
      weightPolicy: "any",
      valid: true,
      persistedAt: "2026-07-13T00:00:00.000Z",
      proposers: [{ id: "hf:org/A", name: "A", family: "a", provider: "synthetic", role: "proposer" }],
      aggregator: { id: "oc:judge", name: "Judge", family: "judge", provider: "opencode", role: "aggregator" },
    }],
  },
  consensus: {
    source: "legacy",
    models: [{ id: "xai:grok", name: "Grok", family: "grok", provider: "xai", role: "reviewer" }],
  },
  health: {
    "oc:judge": { ok: false, provider: "opencode", observedAt: "2026-07-13T00:00:00.000Z", latencyMs: 10, error: "HTTP 400" },
  },
};

describe("renderMarkdown", () => {
  test("renders runtime source, exact seats, and health without hand-maintained model names", () => {
    const output = renderMarkdown(manifest);
    expect(output).toContain("Resolution source: **dynamic**");
    expect(output).toContain("`hf:org/A`");
    expect(output).toContain("degraded (HTTP 400)");
    expect(output).toContain("`CONSENSUS_MODELS`");
    expect(output).toContain("role **deep-reasoning**; capability **frontier**; weights **any**");
  });
});
