#!/usr/bin/env bun

import { parseArgs } from "node:util";
import {
  createProductionGitHubEdgeAdapter,
  createProductionWorkspaceEdgeAdapter,
  type ReadCommandRunner,
} from "./run-edge-proof-adapters";
import {
  harvestEdgeProofs,
  receiptShadowConfig,
  receiptShadowMode,
  shadowAuthority,
  type HarvestEdgeProofsResult,
} from "./run-receipt-shadow";

export interface ReceiptShadowHarvesterOptions {
  env?: Record<string, string | undefined>;
  stateDir?: string;
  laneLedgerPath?: string;
  maxPlans?: number;
  now?: () => string;
  command?: ReadCommandRunner;
}

export async function runReceiptShadowHarvester(options: ReceiptShadowHarvesterOptions = {}): Promise<HarvestEdgeProofsResult> {
  const env = options.env ?? process.env;
  try {
    if (receiptShadowMode(env) === "off") return { mode: "off", scanned: 0, appended: 0, supplemented: 0, errors: [] };
    const config = receiptShadowConfig(env);
    if (!config || config.mode !== "shadow") throw new Error("receipt shadow config unavailable");
    const now = options.now ?? (() => new Date().toISOString());
    const adapters = [createProductionWorkspaceEdgeAdapter({ stateDir: options.stateDir, laneLedgerPath: options.laneLedgerPath, now })];
    if (config.github_readback_enabled) {
      adapters.push(createProductionGitHubEdgeAdapter({ stateDir: options.stateDir, now, command: options.command }));
    }
    const result = await harvestEdgeProofs({
      adapters,
      authority: shadowAuthority(env),
      now,
      maxPlans: Math.max(1, Math.min(options.maxPlans ?? 12, 12)),
    }, env);
    result.errors.sort((left, right) => left.planId.localeCompare(right.planId) || left.reasonCode.localeCompare(right.reasonCode));
    return result;
  } catch (error) {
    return {
      mode: "shadow",
      scanned: 0,
      appended: 0,
      supplemented: 0,
      errors: [{ planId: "harvester", reasonCode: "receipt_shadow_harvester_unavailable" }],
    };
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "state-dir": { type: "string" },
      "lane-ledger": { type: "string" },
      "max-plans": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log("Usage: bun run-receipt-shadow-harvest.ts [--state-dir <path>] [--lane-ledger <path>] [--max-plans 1-12]");
    process.exit(0);
  }
  const parsedMax = values["max-plans"] === undefined ? 12 : Number(values["max-plans"]);
  const maxPlans = Number.isInteger(parsedMax) ? parsedMax : 12;
  const result = await runReceiptShadowHarvester({
    stateDir: values["state-dir"],
    laneLedgerPath: values["lane-ledger"],
    maxPlans,
  });
  console.log(JSON.stringify(result));
}
