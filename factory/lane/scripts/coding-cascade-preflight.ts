#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { CODING_CASCADE_MODELS } from "./coding-cascade";

const outputPath = process.argv[2];
if (!outputPath) {
  console.error("Usage: coding-cascade-preflight.ts <output.json>");
  process.exit(2);
}
// Zouroboros System (de-Zo): this preflight probes the legacy Zo transport.
// Zo Computer no longer exists, so it is a no-op unless the operator explicitly
// re-enables the legacy fallback with SF_EXEC_ZO_ASK_FALLBACK=1.
if (process.env.SF_EXEC_ZO_ASK_FALLBACK !== "1") {
  writeFileSync(outputPath, `${JSON.stringify({ zo_ask: "disabled", reason: "SF_EXEC_ZO_ASK_FALLBACK≠1 — Zouroboros System is harness-only" }, null, 2)}\n`);
  console.log("coding-cascade preflight skipped: Zo /zo/ask transport disabled (harness-only)");
  process.exit(0);
}
const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
if (!token) throw new Error("ZO_CLIENT_IDENTITY_TOKEN is not configured");

const results = await Promise.all(CODING_CASCADE_MODELS.map(async (model) => {
  const started = Date.now();
  try {
    const response = await fetch("https://api.zo.computer/zo/ask", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "Transport preflight only. Do not use tools. Reply with exactly OK.",
        model_name: model.id,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const body = await response.text();
    let contentPresent = body.trim().length > 0;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const output = parsed.output;
      contentPresent = typeof output === "string" ? output.trim().length > 0 : output !== null && output !== undefined;
    } catch {
      // A non-JSON body is still transport evidence when the endpoint returns 2xx.
    }
    return {
      requested_model: model.id,
      label: model.label,
      ok: response.ok && contentPresent,
      http_status: response.status,
      content_present: contentPresent,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      requested_model: model.id,
      label: model.label,
      ok: false,
      http_status: null,
      content_present: false,
      latency_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}));

const artifact = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  endpoint: "https://api.zo.computer/zo/ask",
  ok: results.every((result) => result.ok),
  results,
};
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ ok: artifact.ok, results }));
if (!artifact.ok) process.exitCode = 1;
