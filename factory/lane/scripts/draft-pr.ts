#!/usr/bin/env bun
/**
 * FH-03 / ZOU-597 — idempotent draft-PR opener (never enables auto-merge).
 *
 * Acceptance criterion #3: a verified branch without a PR "can open a draft PR
 * without enabling auto-merge". Two guarantees:
 *   1. Idempotent — if an open PR already exists for the branch we return it and
 *      never create a second one (no duplicate PR on replay, per AC#4).
 *   2. Human-gated — this helper uses `gh pr create --draft` and NEVER calls
 *      `gh pr merge` or passes `--auto`. A plan whose `auto_merge` is truthy is
 *      rejected outright as defense in depth.
 *
 * The runner is injected so the pure open/idempotency logic is testable with a
 * fake; `ghPrRunner()` is the real `gh`-backed implementation.
 */

import { spawnSync } from "node:child_process";
import type { DraftPrPlan } from "./ship-ready-core";

export interface ExistingPr {
  number: number;
  url: string;
}

export interface OpenDraftPrResult extends ExistingPr {
  /** true when this call created the PR; false when an existing open PR was reused. */
  created: boolean;
}

export interface PrRunner {
  /** Return the open PR for a branch, or null when none exists. */
  findByBranch(branch: string): Promise<ExistingPr | null>;
  /** Create a DRAFT PR for the plan's branch. Must not enable auto-merge. */
  createDraft(plan: DraftPrPlan): Promise<ExistingPr>;
}

export async function openDraftPr(plan: DraftPrPlan, runner: PrRunner): Promise<OpenDraftPrResult> {
  // Defense in depth: this path must never open a merge-eligible PR, even if a
  // caller hand-builds a plan object with auto_merge flipped on.
  if ((plan as { auto_merge?: unknown }).auto_merge) {
    throw new Error(`refusing to open a PR for ${plan.identifier}: auto_merge must be false — merge stays human-gated`);
  }
  if (!plan.draft) {
    throw new Error(`refusing to open a non-draft PR for ${plan.identifier}: ship-ready PRs are draft-only`);
  }
  const existing = await runner.findByBranch(plan.branch);
  if (existing) return { ...existing, created: false };
  const created = await runner.createDraft(plan);
  return { ...created, created: true };
}

/** Real `gh`-backed runner. Never merges; never enables auto-merge. */
export function ghPrRunner(opts: { base?: string; cwd?: string } = {}): PrRunner {
  const cwd = opts.cwd ?? process.env.SF_MULTI_HARNESS_WORKDIR ?? "/home/workspace";
  return {
    async findByBranch(branch: string): Promise<ExistingPr | null> {
      const r = spawnSync(
        "gh",
        ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"],
        { cwd, encoding: "utf8" },
      );
      if (r.status !== 0) return null;
      try {
        const arr = JSON.parse(r.stdout || "[]") as ExistingPr[];
        return arr[0] ?? null;
      } catch {
        return null;
      }
    },
    async createDraft(plan: DraftPrPlan): Promise<ExistingPr> {
      const args = ["pr", "create", "--draft", "--head", plan.branch, "--title", plan.title, "--body", plan.body];
      if (opts.base) args.push("--base", opts.base);
      const r = spawnSync("gh", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) {
        throw new Error(`gh pr create failed for ${plan.identifier}: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
      }
      const url = (r.stdout || "").trim().split("\n").filter(Boolean).pop() ?? "";
      const m = url.match(/\/pull\/(\d+)/);
      return { number: m ? Number(m[1]) : 0, url };
    },
  };
}
