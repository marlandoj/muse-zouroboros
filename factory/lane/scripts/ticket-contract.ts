#!/usr/bin/env bun
/**
 * T2 — Ticket Contract Validator
 *
 * Validates that each IntakeTicket has the 5 required contract fields:
 *   title, acceptance_criteria, target_repo, archetype, repro/area
 *
 * Contract fields are parsed from the ticket description using a structured
 * markdown convention (## Field: value) or YAML frontmatter.
 *
 * Missing fields → post a Linear comment routing the ticket to 'needs-triage'.
 * Never silent drop. Returns { valid: IntakeTicket[], rejected: Reject[] }.
 *
 * Usage:
 *   bun ticket-contract.ts --tickets <json-file>    # Validate from file
 *   bun ticket-contract.ts --tickets -               # Validate from stdin
 *   bun ticket-contract.ts --dry-run --tickets <json>  # Report without writing to Linear
 *   bun ticket-contract.ts --help
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { assertLegacyLinearTicket } from "./factory-work-contract";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IntakeTicket {
  linear_id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

export interface Reject {
  ticket: IntakeTicket;
  missing_fields: string[];
  comment_posted: boolean;
}

export interface ValidationResult {
  valid: IntakeTicket[];
  rejected: Reject[];
}

// ─── Contract fields ──────────────────────────────────────────────────────────

const REQUIRED_FIELDS = [
  "title",
  "acceptance_criteria",
  "target_repo",
  "archetype",
  "repro",
] as const;

// ─── Field parser ──────────────────────────────────────────────────────────────

/**
 * Extract contract fields from a ticket description.
 * Supports two conventions:
 * 1. YAML frontmatter: ---\n key: value\n ---
 * 2. Markdown headers: ## Acceptance Criteria\n ...
 */
export function parseContractFields(description: string): Record<string, string> {
  const fields: Record<string, string> = {};

  // Try YAML frontmatter
  const fm = description.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) fields[m[1].trim()] = m[2].trim();
    }
    // Map common aliases
    if (fields["ac"] && !fields["acceptance_criteria"]) fields["acceptance_criteria"] = fields["ac"];
    if (fields["repo"] && !fields["target_repo"]) fields["target_repo"] = fields["repo"];
    if (fields["area"] && !fields["repro"]) fields["repro"] = fields["area"];
    return fields;
  }

  // Try markdown headers
  const sections: Record<string, string> = {};
  let current: string | null = null;
  const lines = description.split("\n");
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      current = h[1].trim().toLowerCase().replace(/\s+/g, "_");
      sections[current] = "";
    } else if (current) {
      sections[current] += line + "\n";
    }
  }

  // Map section names to contract fields
  const aliases: Record<string, string> = {
    "acceptance_criteria": "acceptance_criteria",
    "acceptance_criteria_(ac)": "acceptance_criteria",
    "ac": "acceptance_criteria",
    "target_repo": "target_repo",
    "target_repository": "target_repo",
    "repo": "target_repo",
    "archetype": "archetype",
    "repro": "repro",
    "repro/area": "repro",
    "area": "repro",
    "reproduction": "repro",
  };

  for (const [key, val] of Object.entries(sections)) {
    const mapped = aliases[key] || aliases[key.replace(/[\s\/]/g, "_")] || key;
    if (REQUIRED_FIELDS.includes(mapped as any)) {
      fields[mapped] = val.trim();
    }
  }

  // Also extract inline bold fields: **field:** value
  const boldFieldRegex = /\*\*(\w[\w\s\/]*?):\*\*\s*(.+)$/gm;
  let boldMatch;
  while ((boldMatch = boldFieldRegex.exec(description)) !== null) {
    const rawKey = boldMatch[1].trim().toLowerCase().replace(/\s+/g, "_");
    const mapped = aliases[rawKey] || rawKey;
    if (REQUIRED_FIELDS.includes(mapped as any) && !fields[mapped]) {
      fields[mapped] = boldMatch[2].trim();
    }
  }

  return fields;
}

// ─── Validator ────────────────────────────────────────────────────────────────

export function validateTicket(ticket: IntakeTicket): string[] {
  const fields = parseContractFields(ticket.description);
  const missing: string[] = [];

  // title is from the ticket title field, not the description
  if (!ticket.title?.trim()) missing.push("title");

  for (const f of REQUIRED_FIELDS) {
    if (f === "title") continue;
    if (!fields[f] || !fields[f].trim()) missing.push(f);
  }

  return missing;
}

// ─── Linear write helpers ──────────────────────────────────────────────────────

const API = process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";

async function gql<T = any>(query: string, vars?: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    console.error("FATAL: LINEAR_API_KEY not set");
    process.exit(2);
  }
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables: vars }),
  });
  const j = (await r.json()) as any;
  if (j.errors?.length) {
    console.error("GQL ERR:", JSON.stringify(j.errors, null, 2));
    return j.data as T;
  }
  return j.data as T;
}

const COMMENT_MUTATION = `
  mutation PostTriageComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id }
    }
  }
`;

export async function postTriageComment(ticket: IntakeTicket, missingFields: string[]): Promise<boolean> {
  assertLegacyLinearTicket(ticket);
  const fieldList = missingFields.map((f) => `- \`${f}\``).join("\n");
  const body = `⚠️ **Ticket contract validation failed** — missing required fields:\n\n${fieldList}\n\nThis ticket has been moved to **needs-triage**. Please add the missing fields and re-apply the \`factory-ready\` label.\n\nRequired contract: \`title, acceptance_criteria, target_repo, archetype, repro/area\``;

  const data = await gql<{ commentCreate: { success: boolean } }>(COMMENT_MUTATION, {
    input: { issueId: ticket.linear_id, body },
  });
  return data?.commentCreate?.success ?? false;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function validateTickets(tickets: IntakeTicket[], dryRun = false): Promise<ValidationResult> {
  const valid: IntakeTicket[] = [];
  const rejected: Reject[] = [];

  // Admit the entire batch before any rejected Linear ticket can produce a comment.
  if (!Array.isArray(tickets)) throw new Error("LINEAR_TICKETS_REQUIRED");
  for (const ticket of tickets) assertLegacyLinearTicket(ticket);

  for (const ticket of tickets) {
    const missing = validateTicket(ticket);
    if (missing.length === 0) {
      valid.push(ticket);
    } else {
      let commentPosted = false;
      if (!dryRun) {
        commentPosted = await postTriageComment(ticket, missing);
      }
      rejected.push({ ticket, missing_fields: missing, comment_posted: commentPosted });
    }
  }

  return { valid, rejected };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
// Guarded so the module is importable (SF-007 triage imports validateTicket);
// CLI behavior is byte-identical when run directly.

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      tickets: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help || !values.tickets) {
    console.log(`
ticket-contract — Validate IntakeTicket contract fields

USAGE:
  bun ticket-contract.ts --tickets <json-file>     # Validate from JSON file
  bun ticket-contract.ts --tickets -                # Validate from stdin
  bun ticket-contract.ts --dry-run --tickets <json> # Report without writing to Linear

CONTRACT FIELDS (all required):
  title, acceptance_criteria, target_repo, archetype, repro/area

OUTPUT:
  JSON object { valid: [...], rejected: [...] } to stdout.
`);
    process.exit(values.help ? 0 : 1);
  }

  const raw =
    values.tickets === "-" ? readFileSync(0, "utf-8") : readFileSync(values.tickets as string, "utf-8");

  const tickets: IntakeTicket[] = JSON.parse(raw);
  const result = await validateTickets(tickets, Boolean(values["dry-run"]));
  console.log(JSON.stringify(result, null, 2));
}
