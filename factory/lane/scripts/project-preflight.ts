#!/usr/bin/env bun
/**
 * FH-01 (P0-1) — Preflight the entire project queue before the first promotion.
 *
 * The ZBRE run validated nothing project-wide before promoting ticket one. A
 * `LINEUP_ROLE_CHAINS` value wrapped in Markdown backticks entered the queue,
 * failed inside the consensus process on ZOU-929, was retried unchanged, and
 * then propagated to ZOU-930, ZOU-931 and ZOU-933 — four tickets and three
 * wasted consensus budgets for a defect that was visible in the ticket body
 * before any work started.
 *
 * Preflight parses every queued ticket with the *production* parsers — the same
 * `parseContractFields`/`validateTicket` and `parseModelPolicy` the conveyor
 * runs — so a value that will fail at execution fails here instead, once, with
 * the offending ticket and field named.
 *
 * Checks, and the audit finding each one closes:
 *   contract          every required contract field present         (P0-1)
 *   model_policy      policy parses; role-chain JSON is valid       (§2, root cause)
 *   provider_alias    every pinned model id is well-formed          (P0-1)
 *   consensus_seats   ≥ quorum routes return a real verdict         (P0-3, FH-22)
 *   target_repo       repository resolves on disk                   (P0-1)
 *   base_branch       the base ref exists                           (P0-1)
 *   serial_chain      declared dependencies exist in the queue      (P0-1)
 *   lane_halt         no open halt for this project                 (P0-7)
 *
 * Severity is binary and deliberate. `blocking` findings stop promotion;
 * `advisory` ones are reported and do not. Nothing is silently tolerated: a
 * check that could not run reports `unknown` and is treated as blocking, because
 * "we could not tell" and "it is fine" are the two answers this run confused.
 *
 * Reachability: the conveyor calls `bun project-preflight.ts check --queue
 * <file>` before the first `serial-intake-promoter` promotion of a project.
 * Exit 0 = promote, 1 = blocked, 2 = usage error.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseContractFields, validateTicket, type IntakeTicket } from "./ticket-contract";
import { parseModelPolicy, type ExecutionPolicy } from "./model-policy";
import { classifyFailure } from "./failure-policy";
import { readHalt } from "./lane-halt";
import { refreshIfStale, type ProbeCall } from "./consensus-capability";

const PROJECT_DIR = join(import.meta.dir, "..");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** FH-08 — panel size is not an agreement threshold. See QUORUM.md. */
export const DEFAULT_MIN_CAPABLE_SEATS = 3;

export type FindingSeverity = "blocking" | "advisory";

export interface PreflightFinding {
  check: string;
  severity: FindingSeverity;
  ticket: string | null;
  /** The field or route the finding is attributable to. */
  subject: string | null;
  message: string;
  /** Typed class, so a preflight finding and a runtime failure agree. */
  failure_class: string;
}

export interface PreflightReport {
  ok: boolean;
  project: string;
  generated_at: string;
  tickets_examined: number;
  checks_run: string[];
  checks_skipped: string[];
  findings: PreflightFinding[];
}

export interface QueuedTicket extends IntakeTicket {
  /** Stable project-level key this ticket belongs to (e.g. `ZBRE-004`). */
  stable_key?: string;
  /** Stable keys that must complete before this ticket runs. */
  depends_on?: string[];
}

function finding(
  check: string,
  severity: FindingSeverity,
  message: string,
  options: { ticket?: string | null; subject?: string | null; failureClass?: string } = {},
): PreflightFinding {
  return {
    check,
    severity,
    ticket: options.ticket ?? null,
    subject: options.subject ?? null,
    message,
    failure_class: options.failureClass ?? classifyFailure({ message }).failure_class,
  };
}

// ─── Individual checks ────────────────────────────────────────────────────────

export function checkContracts(tickets: readonly QueuedTicket[]): PreflightFinding[] {
  return tickets.flatMap((ticket) => {
    const missing = validateTicket(ticket);
    if (missing.length === 0) return [];
    return [finding(
      "contract",
      "blocking",
      `missing required contract field(s): ${missing.join(", ")}`,
      { ticket: ticket.identifier, subject: missing[0], failureClass: "configuration_error" },
    )];
  });
}

export interface PolicyCheck {
  findings: PreflightFinding[];
  /** Successfully parsed policies, keyed by ticket identifier. */
  policies: Map<string, ExecutionPolicy>;
}

/**
 * Parse each ticket's Model Policy with the production parser. This is the
 * check that would have stopped the ZBRE propagation: `parseModelPolicy` now
 * validates role-chain JSON, so a backticked value throws here rather than
 * inside a consensus subprocess four tickets later.
 */
export function checkModelPolicies(tickets: readonly QueuedTicket[]): PolicyCheck {
  const findings: PreflightFinding[] = [];
  const policies = new Map<string, ExecutionPolicy>();

  for (const ticket of tickets) {
    let policy: ExecutionPolicy | null;
    try {
      policy = parseModelPolicy(ticket.description);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const verdict = classifyFailure({ message });
      findings.push(finding("model_policy", "blocking", message, {
        ticket: ticket.identifier,
        subject: verdict.subject,
        failureClass: verdict.failure_class,
      }));
      continue;
    }
    if (policy) policies.set(ticket.identifier, policy);
  }

  return { findings, policies };
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const KNOWN_PREFIXES = ["byok:", "oc:", "hf:", "syn:", "xai:", "kimi:"];

/**
 * A pinned id that is malformed, or carries an unknown prefix, resolves to no
 * route at call time. Unprefixed ids are valid — they route to OpenRouter — so
 * only a colon-bearing id with an unrecognized scheme is a finding.
 */
export function checkProviderAliases(policies: ReadonlyMap<string, ExecutionPolicy>): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const [ticket, policy] of policies) {
    const ids = [
      ...policy.pin_proposers.map((id) => ["LINEUP_PIN_PROPOSERS", id] as const),
      ...(policy.pin_aggregator ? [["LINEUP_PIN_AGGREGATOR", policy.pin_aggregator] as const] : []),
      ...policy.model_chain.map((id) => ["FACTORY_MODEL_CHAIN", id] as const),
    ];
    for (const [field, id] of ids) {
      if (!MODEL_ID.test(id)) {
        findings.push(finding("provider_alias", "blocking", `${field} contains a malformed model id: ${id}`, {
          ticket, subject: field, failureClass: "configuration_error",
        }));
        continue;
      }
      const scheme = id.includes(":") ? `${id.split(":")[0]}:` : null;
      if (scheme && !KNOWN_PREFIXES.includes(scheme)) {
        findings.push(finding("provider_alias", "blocking", `${field} uses an unknown provider prefix "${scheme}" in ${id}`, {
          ticket, subject: field, failureClass: "configuration_error",
        }));
      }
    }
  }
  return findings;
}

/**
 * FH-03 + FH-22 — prove the panel can actually review before promoting. Routes
 * are the union of every pinned proposer/aggregator in the queue; a project
 * that pins nothing inherits the factory default and is checked by the caller
 * passing `defaultRoutes`.
 */
export async function checkConsensusSeats(
  policies: ReadonlyMap<string, ExecutionPolicy>,
  options: {
    defaultRoutes?: readonly string[];
    minCapable?: number;
    call?: ProbeCall;
    now?: number;
    path?: string;
  } = {},
): Promise<PreflightFinding[]> {
  const minCapable = options.minCapable ?? DEFAULT_MIN_CAPABLE_SEATS;
  const routes = new Set<string>(options.defaultRoutes ?? []);
  for (const policy of policies.values()) {
    for (const id of policy.pin_proposers) routes.add(id);
    if (policy.pin_aggregator) routes.add(policy.pin_aggregator);
  }
  if (routes.size === 0) {
    return [finding("consensus_seats", "blocking", "no consensus routes to probe — cannot prove a panel exists", {
      failureClass: "configuration_error",
    })];
  }

  const outcome = await refreshIfStale({
    models: [...routes],
    call: options.call,
    now: options.now,
    path: options.path,
  });

  if (outcome.capable >= minCapable) return [];

  const unusable = [...routes].filter((route) => !outcome.capable_routes.includes(route));
  return [finding(
    "consensus_seats",
    "blocking",
    `only ${outcome.capable} of ${routes.size} route(s) returned a parseable verdict; ${minCapable} required.`
    + ` Unusable: ${unusable.join(", ")}`,
    { subject: unusable[0] ?? null, failureClass: "provider_unavailable" },
  )];
}

export function checkTargetRepos(
  tickets: readonly QueuedTicket[],
  options: { repoRoot?: string; exists?: (path: string) => boolean } = {},
): PreflightFinding[] {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const fileExists = options.exists ?? existsSync;
  const findings: PreflightFinding[] = [];

  for (const ticket of tickets) {
    const target = parseContractFields(ticket.description).target_repo?.trim();
    if (!target) continue; // absence is already a contract finding
    // A URL target is resolved by the shipping layer, not on disk.
    if (/^(https?:|git@)/.test(target)) continue;
    const candidates = [target, join(repoRoot, target), join(repoRoot, "Projects", target)];
    if (candidates.some(fileExists)) continue;
    findings.push(finding("target_repo", "blocking", `target_repo "${target}" does not resolve on disk`, {
      ticket: ticket.identifier, subject: "target_repo", failureClass: "configuration_error",
    }));
  }
  return findings;
}

export type RefResolver = (ref: string) => boolean;

const defaultRefResolver: RefResolver = (ref) =>
  Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], {
    cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
  }).exitCode === 0;

export function checkBaseBranch(
  baseRef: string,
  options: { resolve?: RefResolver } = {},
): PreflightFinding[] {
  const resolve = options.resolve ?? defaultRefResolver;
  if (resolve(baseRef)) return [];
  return [finding("base_branch", "blocking", `base ref "${baseRef}" does not resolve`, {
    subject: baseRef, failureClass: "configuration_error",
  })];
}

/**
 * A serial project declares its own order. A dependency naming a stable key
 * that is not in the queue means the chain cannot complete, and a cycle means
 * it can never start — both are better found now than at ticket seven of twelve.
 */
export function checkSerialChain(tickets: readonly QueuedTicket[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const keys = new Set(tickets.map((ticket) => ticket.stable_key ?? ticket.identifier));
  const edges = new Map<string, string[]>();

  for (const ticket of tickets) {
    const key = ticket.stable_key ?? ticket.identifier;
    const deps = ticket.depends_on ?? [];
    edges.set(key, deps);
    for (const dep of deps) {
      if (!keys.has(dep)) {
        findings.push(finding("serial_chain", "blocking", `depends on "${dep}", which is not in the queue`, {
          ticket: ticket.identifier, subject: dep, failureClass: "configuration_error",
        }));
      }
    }
  }

  // Iterative DFS; a serial chain of twelve is small but cycles must not hang.
  const state = new Map<string, 0 | 1 | 2>();
  for (const start of edges.keys()) {
    if (state.get(start)) continue;
    const stack: Array<{ node: string; index: number }> = [{ node: start, index: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const deps = edges.get(frame.node) ?? [];
      if (frame.index >= deps.length) {
        state.set(frame.node, 2);
        stack.pop();
        continue;
      }
      const next = deps[frame.index++];
      if (!edges.has(next)) continue;
      if (state.get(next) === 1) {
        findings.push(finding("serial_chain", "blocking", `dependency cycle involving "${next}"`, {
          ticket: frame.node, subject: next, failureClass: "configuration_error",
        }));
        state.set(next, 2);
        continue;
      }
      if (!state.get(next)) {
        state.set(next, 1);
        stack.push({ node: next, index: 0 });
      }
    }
  }

  return findings;
}

export function checkLaneHalt(project: string, base = PROJECT_DIR): PreflightFinding[] {
  const halt = readHalt(project, base);
  if (!halt.halted) return [];
  return [finding("lane_halt", "blocking", `lane is halted: ${halt.reason}`, {
    subject: halt.fingerprint, failureClass: "configuration_error",
  })];
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export interface PreflightOptions {
  project: string;
  tickets: readonly QueuedTicket[];
  baseRef?: string;
  defaultRoutes?: readonly string[];
  minCapable?: number;
  /** Skip the network probe; the seat check then reports as skipped. */
  skipSeatProbe?: boolean;
  probeCall?: ProbeCall;
  now?: string;
  base?: string;
  repoRoot?: string;
  resolveRef?: RefResolver;
  exists?: (path: string) => boolean;
  healthPath?: string;
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const now = options.now ?? new Date().toISOString();
  const findings: PreflightFinding[] = [];
  const checksRun: string[] = [];
  const checksSkipped: string[] = [];

  findings.push(...checkLaneHalt(options.project, options.base));
  checksRun.push("lane_halt");

  findings.push(...checkContracts(options.tickets));
  checksRun.push("contract");

  const policy = checkModelPolicies(options.tickets);
  findings.push(...policy.findings);
  checksRun.push("model_policy");

  findings.push(...checkProviderAliases(policy.policies));
  checksRun.push("provider_alias");

  findings.push(...checkTargetRepos(options.tickets, { repoRoot: options.repoRoot, exists: options.exists }));
  checksRun.push("target_repo");

  if (options.baseRef) {
    findings.push(...checkBaseBranch(options.baseRef, { resolve: options.resolveRef }));
    checksRun.push("base_branch");
  } else {
    checksSkipped.push("base_branch");
  }

  findings.push(...checkSerialChain(options.tickets));
  checksRun.push("serial_chain");

  if (options.skipSeatProbe) {
    checksSkipped.push("consensus_seats");
  } else {
    findings.push(...await checkConsensusSeats(policy.policies, {
      defaultRoutes: options.defaultRoutes,
      minCapable: options.minCapable,
      call: options.probeCall,
      path: options.healthPath,
    }));
    checksRun.push("consensus_seats");
  }

  return {
    // A skipped check is not a pass. Promotion requires every check to have run
    // and every one of them to be clean.
    ok: findings.every((item) => item.severity !== "blocking") && checksSkipped.length === 0,
    project: options.project,
    generated_at: now,
    tickets_examined: options.tickets.length,
    checks_run: checksRun,
    checks_skipped: checksSkipped,
    findings,
  };
}

export function formatReport(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push(`Preflight ${report.project}: ${report.ok ? "CLEAR" : "BLOCKED"}`);
  lines.push(`${report.tickets_examined} ticket(s); checks run: ${report.checks_run.join(", ") || "none"}`);
  if (report.checks_skipped.length) lines.push(`skipped (counts as blocking): ${report.checks_skipped.join(", ")}`);
  for (const item of report.findings) {
    lines.push(
      `  [${item.severity}] ${item.check}${item.ticket ? ` ${item.ticket}` : ""}`
      + `${item.subject ? ` (${item.subject})` : ""}: ${item.message}`,
    );
  }
  if (report.findings.length === 0) lines.push("  no findings");
  return lines.join("\n");
}

function loadQueue(path: string): QueuedTicket[] {
  const raw = path === "-" ? readFileSync(0, "utf-8") : readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  const tickets = Array.isArray(parsed) ? parsed : parsed?.tickets;
  if (!Array.isArray(tickets)) throw new Error("queue must be an array of tickets or {tickets: [...]}");
  return tickets as QueuedTicket[];
}

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      queue: { type: "string" },
      project: { type: "string" },
      base: { type: "string" },
      routes: { type: "string" },
      "min-capable": { type: "string" },
      "skip-seat-probe": { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: false,
  });

  if (cmd !== "check" || !values.queue || !values.project) {
    console.error(
      "Usage: bun project-preflight.ts check --project <key> --queue <file|-> [--base origin/main]"
      + " [--routes id,id] [--min-capable 3] [--skip-seat-probe] [--json]",
    );
    process.exit(2);
  }

  let tickets: QueuedTicket[];
  try {
    tickets = loadQueue(String(values.queue));
  } catch (error) {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const minCapable = Number.parseInt(String(values["min-capable"] ?? DEFAULT_MIN_CAPABLE_SEATS), 10);
  const report = await runPreflight({
    project: String(values.project),
    tickets,
    baseRef: values.base ? String(values.base) : undefined,
    defaultRoutes: String(values.routes ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    minCapable: Number.isFinite(minCapable) ? minCapable : DEFAULT_MIN_CAPABLE_SEATS,
    skipSeatProbe: Boolean(values["skip-seat-probe"]),
  });

  if (values.json) console.log(JSON.stringify(report));
  else console.log(formatReport(report));
  process.exit(report.ok ? 0 : 1);
}
