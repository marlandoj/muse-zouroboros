import { describe, expect, test } from "bun:test";
import {
  MAX_TITLE_LENGTH,
  deriveTitle,
  derivedTitleOrThrow,
  ticketTitleForExecution,
  validateProvenance,
} from "./pr-provenance";

/** The shape of narration PR #400 was opened with. */
const NARRATION =
  "I've successfully implemented the private deployment for the Results Explorer, "
  + "including the production server, smoke tests, and the operator runbook as requested";

describe("title derivation (FH-15)", () => {
  test("prefers the Linear ticket title over executor narration", () => {
    const derivation = deriveTitle({
      identifier: "ZOU-933",
      ticket_title: "Privately deploy, smoke test, and hand off the Results Explorer",
      result_summary: NARRATION,
      execution_id: "exec-d50452ec",
    });
    expect(derivation.source).toBe("linear_ticket");
    expect(derivation.title).toBe("ZOU-933: Privately deploy, smoke test, and hand off the Results Explorer");
  });

  test("falls back to the execution summary only when no ticket title exists", () => {
    const derivation = deriveTitle({
      identifier: "ZOU-933",
      ticket_title: null,
      result_summary: "Deploy the explorer as a private managed service",
      execution_id: "exec-d50452ec",
    });
    expect(derivation.source).toBe("execution_summary");
  });

  test("falls back to the execution id when there is nothing else", () => {
    const derivation = deriveTitle({ identifier: "ZOU-933", execution_id: "exec-d50452ec" });
    expect(derivation.source).toBe("fallback");
    expect(derivation.title).toBe("ZOU-933: factory execution exec-d50452ec");
  });

  test("does not double the identifier when the ticket title already carries it", () => {
    const derivation = deriveTitle({
      identifier: "ZOU-933",
      ticket_title: "ZOU-933: Deploy the explorer",
      execution_id: "e",
    });
    expect(derivation.title).toBe("ZOU-933: Deploy the explorer");
  });

  test("a ticket title that is only an identifier is not a usable source", () => {
    const derivation = deriveTitle({
      identifier: "ZOU-933",
      ticket_title: "ZOU-933",
      result_summary: "Deploy the explorer as a private service",
      execution_id: "e",
    });
    expect(derivation.source).toBe("execution_summary");
  });

  test("truncates on a word boundary rather than mid-word", () => {
    const derivation = deriveTitle({
      identifier: "ZOU-933",
      ticket_title: "Deploy ".repeat(40),
      execution_id: "e",
    });
    expect(derivation.truncated).toBe(true);
    expect(Array.from(derivation.title).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(derivation.title.endsWith("Deploy")).toBe(true);
  });

  test("collapses whitespace so a multi-line summary cannot break the title", () => {
    const derivation = deriveTitle({
      identifier: "ZOU-933",
      ticket_title: "Deploy\n  the\n\texplorer",
      execution_id: "e",
    });
    expect(derivation.title).toBe("ZOU-933: Deploy the explorer");
  });
});

describe("provenance validation (FH-15)", () => {
  const valid = { identifier: "ZOU-933", title: "ZOU-933: Deploy the explorer as a private service" };

  test("accepts a ticket-derived title", () => {
    expect(validateProvenance(valid)).toMatchObject({ ok: true, violations: [] });
  });

  test("rejects executor narration", () => {
    const verdict = validateProvenance({ identifier: "ZOU-933", title: `ZOU-933: ${NARRATION}`.slice(0, 99) });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContain("narration_voice");
  });

  test("rejects a title missing its identifier", () => {
    expect(validateProvenance({ identifier: "ZOU-933", title: "Deploy the explorer" }).violations)
      .toContain("missing_identifier");
  });

  test("rejects a title that is only the identifier", () => {
    const verdict = validateProvenance({ identifier: "ZOU-933", title: "ZOU-933:" });
    expect(verdict.violations).toContain("identifier_only");
  });

  test("rejects a truncation artifact — a title that was cut, not composed", () => {
    expect(validateProvenance({ identifier: "ZOU-933", title: "ZOU-933: Deploy the explorer and…" }).violations)
      .toContain("truncation_artifact");
    expect(validateProvenance({ identifier: "ZOU-933", title: "ZOU-933: Deploy the explorer and..." }).violations)
      .toContain("truncation_artifact");
  });

  test("rejects a title over GitHub's cap", () => {
    expect(validateProvenance({ identifier: "ZOU-933", title: `ZOU-933: ${"x".repeat(MAX_TITLE_LENGTH)}` }).violations)
      .toContain("too_long");
    // The cap is GitHub's, unchanged from PR #401 — FH-15 does not tighten it.
    expect(MAX_TITLE_LENGTH).toBe(256);
  });

  test("rejects a body that cites none of the verified evidence", () => {
    const verdict = validateProvenance({
      ...valid,
      body: "This change deploys the explorer.",
      evidence: ["cg-1785077062687", "exec-d50452ec"],
    });
    expect(verdict.violations).toContain("unverified_body");
  });

  test("accepts a body that cites verified evidence", () => {
    expect(validateProvenance({
      ...valid,
      body: "Consensus gate cg-1785077062687 passed for exec-d50452ec.",
      evidence: ["cg-1785077062687", "exec-d50452ec"],
    }).ok).toBe(true);
  });

  test("an absent body is permitted; a body citing nothing is not", () => {
    expect(validateProvenance({ ...valid, body: null, evidence: ["cg-1"] }).ok).toBe(true);
    expect(validateProvenance({ ...valid, body: "no citation", evidence: ["cg-1"] }).ok).toBe(false);
  });

  test("derivedTitleOrThrow refuses to hand back a title that fails validation", () => {
    // Opening a PR is the point of no return, so this throws rather than
    // returning something the caller might use anyway.
    expect(() => derivedTitleOrThrow({
      identifier: "ZOU-933",
      ticket_title: "I've implemented the deployment",
      execution_id: "e",
    })).toThrow(/provenance validation/);
  });

  test("derivedTitleOrThrow passes a clean ticket-derived title through", () => {
    expect(derivedTitleOrThrow({
      identifier: "ZOU-933",
      ticket_title: "Deploy the explorer as a private service",
      execution_id: "e",
    }).source).toBe("linear_ticket");
  });
});

describe("ticketTitleForExecution", () => {
  test("strips queue routing prefixes and keeps the change description", () => {
    expect(ticketTitleForExecution("[Factory Intake][OFS-006] OpenFlight Sim T6 — arcade registration"))
      .toBe("OpenFlight Sim T6 — arcade registration");
    expect(ticketTitleForExecution("[Factory Intake] Add a thing")).toBe("Add a thing");
    expect(ticketTitleForExecution("Add a thing")).toBe("Add a thing");
  });

  test("returns null for an absent or empty title", () => {
    expect(ticketTitleForExecution(null)).toBeNull();
    expect(ticketTitleForExecution(undefined)).toBeNull();
    expect(ticketTitleForExecution("   ")).toBeNull();
  });

  test("keeps the original when the title is nothing but routing prefixes", () => {
    // Falling through to empty would silently restore the narration fallback.
    expect(ticketTitleForExecution("[Factory Intake][OFS-006]")).toBe("[Factory Intake][OFS-006]");
  });

  test("a populated ticket_title keeps the shipper off the narration fallback", () => {
    const narration = "I'll start by verifying remote state and understanding the project.";
    const bare = deriveTitle({ identifier: "ZOU-954", execution_id: "exec-1", ticket_title: null, result_summary: narration });
    expect(bare.source).toBe("execution_summary");
    expect(validateProvenance({ identifier: "ZOU-954", title: bare.title }).violations).toContain("narration_voice");

    const withTitle = deriveTitle({
      identifier: "ZOU-954",
      execution_id: "exec-1",
      ticket_title: ticketTitleForExecution("[Factory Intake][OFS-006] OpenFlight Sim T6 — arcade registration"),
      result_summary: narration,
    });
    expect(withTitle.source).toBe("linear_ticket");
    expect(validateProvenance({ identifier: "ZOU-954", title: withTitle.title }).violations).toHaveLength(0);
  });
});
