import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFailure } from "./failure-policy";
import {
  clearHalt,
  deterministicLedgerPath,
  evaluateHalt,
  haltSentinelPath,
  readHalt,
  recordRawFailure,
} from "./lane-halt";

const bases: string[] = [];
function scratch(): string {
  const base = mkdtempSync(join(tmpdir(), "lane-halt-"));
  bases.push(base);
  return base;
}

afterEach(() => {
  while (bases.length) rmSync(bases.pop()!, { recursive: true, force: true });
});

/** The value that propagated through ZOU-929 → ZOU-930 → ZOU-931 → ZOU-933. */
const ROLE_CHAIN_DEFECT = "LINEUP_ROLE_CHAINS must be valid JSON: Unrecognized token '\x60'";

describe("lane halt (FH-07)", () => {
  test("halts the lane when one deterministic defect reaches a second ticket", () => {
    const base = scratch();
    const first = recordRawFailure(
      { project: "ZBRE", ticket: "ZOU-929", execution_id: "exec-dc65b3e3", message: ROLE_CHAIN_DEFECT },
      { base },
    );
    expect(first.halted).toBe(false);
    expect(first.occurrences).toBe(1);

    const second = recordRawFailure(
      { project: "ZBRE", ticket: "ZOU-930", execution_id: "exec-8f36d6b4", message: ROLE_CHAIN_DEFECT },
      { base },
    );
    expect(second.halted).toBe(true);
    expect(second.tickets).toEqual(["ZOU-929", "ZOU-930"]);
    expect(second.reason).toContain("LINEUP_ROLE_CHAINS");
  });

  test("one ticket retrying the same defect is a single occurrence, not propagation", () => {
    const base = scratch();
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = recordRawFailure(
        { project: "ZBRE", ticket: "ZOU-929", execution_id: "exec-dc65b3e3", message: ROLE_CHAIN_DEFECT },
        { base },
      );
      expect(state.halted).toBe(false);
    }
  });

  test("provider flakiness never counts toward the halt", () => {
    const base = scratch();
    for (const ticket of ["ZOU-901", "ZOU-902", "ZOU-903"]) {
      const state = recordRawFailure(
        { project: "ZBRE", ticket, execution_id: `exec-${ticket}`, message: "API error: 503 Service Unavailable" },
        { base },
      );
      expect(state.halted).toBe(false);
      expect(state.reason).toContain("not deterministic");
    }
    expect(readHalt("ZBRE", base).halted).toBe(false);
  });

  test("halt is scoped to its own project lane", () => {
    const base = scratch();
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-929", execution_id: "e1", message: ROLE_CHAIN_DEFECT }, { base });
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-930", execution_id: "e2", message: ROLE_CHAIN_DEFECT }, { base });
    expect(readHalt("ZBRE", base).halted).toBe(true);
    expect(readHalt("OFS", base).halted).toBe(false);
  });

  test("halt survives a fresh process — state is on disk, not in the environment", () => {
    const base = scratch();
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-929", execution_id: "e1", message: ROLE_CHAIN_DEFECT }, { base });
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-930", execution_id: "e2", message: ROLE_CHAIN_DEFECT }, { base });
    // A separate conveyor step reads only the sentinel.
    const rehydrated = readHalt("ZBRE", base);
    expect(rehydrated.halted).toBe(true);
    expect(rehydrated.tickets).toEqual(["ZOU-929", "ZOU-930"]);
  });

  test("evaluation is idempotent under repeated calls", () => {
    const base = scratch();
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-929", execution_id: "e1", message: ROLE_CHAIN_DEFECT }, { base });
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-930", execution_id: "e2", message: ROLE_CHAIN_DEFECT }, { base });
    const a = evaluateHalt("ZBRE", null, { base });
    const b = evaluateHalt("ZBRE", null, { base });
    expect(a.halted && b.halted).toBe(true);
    expect(a.halted_at).toBe(b.halted_at!);
  });

  test("an unreadable sentinel fails closed", () => {
    const base = scratch();
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-929", execution_id: "e1", message: ROLE_CHAIN_DEFECT }, { base });
    writeFileSync(haltSentinelPath("ZBRE", base), "{ not json");
    const state = readHalt("ZBRE", base);
    expect(state.halted).toBe(true);
    expect(state.reason).toContain("fail-closed");
  });

  test("a torn ledger line does not blind the remaining evidence", () => {
    const base = scratch();
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-929", execution_id: "e1", message: ROLE_CHAIN_DEFECT }, { base });
    const ledger = deterministicLedgerPath(base);
    writeFileSync(ledger, Bun.file(ledger).size ? `{"partial":\n` : "", { flag: "a" });
    const state = recordRawFailure(
      { project: "ZBRE", ticket: "ZOU-930", execution_id: "e2", message: ROLE_CHAIN_DEFECT },
      { base },
    );
    expect(state.halted).toBe(true);
  });

  test("an operator can clear the halt and the lane resumes", () => {
    const base = scratch();
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-929", execution_id: "e1", message: ROLE_CHAIN_DEFECT }, { base });
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-930", execution_id: "e2", message: ROLE_CHAIN_DEFECT }, { base });
    expect(clearHalt("ZBRE", "marlandoj", base).cleared).toBe(true);
    expect(readHalt("ZBRE", base).halted).toBe(false);
    expect(clearHalt("ZBRE", "marlandoj", base).cleared).toBe(false);
  });

  test("a project key cannot escape its path segment", () => {
    const base = scratch();
    const path = haltSentinelPath("../../etc/passwd", base);
    expect(path.startsWith(join(base, "state"))).toBe(true);
    expect(path).not.toContain("..");
  });

  test("accepts a pre-classified verdict from the consensus record", () => {
    const base = scratch();
    const verdict = classifyFailure({ reason_code: "gate_error", message: ROLE_CHAIN_DEFECT });
    expect(verdict.failure_class).toBe("configuration_error");
    const state = evaluateHalt("ZBRE", verdict.fingerprint, { base, write: false });
    expect(state.halted).toBe(false);
  });
});
