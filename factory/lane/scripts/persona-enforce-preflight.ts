#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  createZoMcpListPersonasCaller,
  resolvePersonas,
} from "./persona-directory";
import {
  invokeZoPersona,
  type PersonaCallRequest,
  type PersonaCallResult,
} from "./persona-orchestrator";
import {
  resolveModelVendor,
  selectIndependentReviewerModel,
  type SpecialistReviewerPolicy,
} from "../../../packages/zo-swarm-orchestrator/src/persona/specialist-consult";

interface PreflightOptions {
  personaName: string;
  implementerModelName: string;
  implementerVendor?: string;
  reviewerPolicy?: SpecialistReviewerPolicy;
  timeoutMs: number;
}

interface PreflightDeps {
  listPersonas?: () => Promise<unknown>;
  invokePersona?: (request: PersonaCallRequest) => Promise<PersonaCallResult>;
}

export async function runPersonaEnforcePreflight(
  options: PreflightOptions,
  deps: PreflightDeps = {},
) {
  const selected = selectIndependentReviewerModel({
    implementerModelName: options.implementerModelName,
    implementerVendor: options.implementerVendor,
    policy: options.reviewerPolicy,
  });
  const resolution = await resolvePersonas({
    mode: "enforce",
    roles: [{
      role_id: "factory-adviser-auth-preflight",
      selector: options.personaName,
      required: true,
      required_scopes: ["files:read"],
    }],
    listPersonas: deps.listPersonas ?? createZoMcpListPersonasCaller(),
    timeoutMs: options.timeoutMs,
  });
  if (!resolution.ok || resolution.resolved.length !== 1) {
    throw new Error(resolution.failures.map((failure) => failure.message).join("; ") || "persona resolution failed");
  }
  const persona = resolution.resolved[0];
  const result = await (deps.invokePersona ?? invokeZoPersona)({
    input: [
      "This is a read-only software-factory adviser authentication preflight.",
      "Do not use tools, mutate files, or perform external actions.",
      "Reply with exactly AUTH_OK.",
    ].join("\n"),
    model_name: selected.modelName,
    persona_id: persona.persona_id,
    timeout_ms: options.timeoutMs,
  });
  if (result.output.trim() !== "AUTH_OK") {
    throw new Error("persona adviser preflight did not return exact AUTH_OK acknowledgement");
  }
  const resolvedReviewerVendor = resolveModelVendor(
    result.model_name,
    result.model_name === selected.modelName ? selected.vendor : undefined,
  );
  if (!resolvedReviewerVendor) throw new Error(`resolved reviewer vendor is unknown for ${result.model_name}`);
  if (result.model_name === selected.implementerModelName) throw new Error("resolved reviewer model matches implementer model");
  if (resolvedReviewerVendor === selected.implementerVendor) throw new Error("resolved reviewer vendor matches implementer vendor");
  return {
    ok: true,
    persona_name: persona.name,
    persona_id: persona.persona_id,
    directory_snapshot_hash: resolution.snapshot?.snapshot_hash ?? null,
    implementer_model_name: selected.implementerModelName,
    implementer_vendor: selected.implementerVendor,
    requested_reviewer_model_name: selected.modelName,
    requested_reviewer_vendor: selected.vendor,
    resolved_reviewer_model_name: result.model_name,
    resolved_reviewer_vendor: resolvedReviewerVendor,
    distinct_model: result.model_name !== selected.implementerModelName,
    vendor_diverse: resolvedReviewerVendor !== selected.implementerVendor,
    output_sha256: createHash("sha256").update(result.output).digest("hex"),
    cost_usd: result.cost_usd,
  };
}

function parseArgs(args: string[]): PreflightOptions {
  let personaName = "Mobile App Builder";
  let implementerModelName = "";
  let implementerVendor: string | undefined;
  let timeoutMs = 120_000;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--help" || flag === "-h") {
      console.log("Usage: bun persona-enforce-preflight.ts --implementer-model <id> [--implementer-vendor <vendor>] [--persona <name>] [--timeout-ms <ms>]");
      process.exit(0);
    }
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    index++;
    if (flag === "--persona") personaName = value;
    else if (flag === "--implementer-model") implementerModelName = value;
    else if (flag === "--implementer-vendor") implementerVendor = value;
    else if (flag === "--timeout-ms") timeoutMs = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!implementerModelName) throw new Error("--implementer-model is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new Error("--timeout-ms must be an integer from 1000 to 900000");
  }
  return { personaName, implementerModelName, implementerVendor, timeoutMs };
}

if (import.meta.main) {
  runPersonaEnforcePreflight(parseArgs(Bun.argv.slice(2))).then(
    (result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
