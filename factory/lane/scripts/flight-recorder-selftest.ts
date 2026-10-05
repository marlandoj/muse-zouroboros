#!/usr/bin/env bun
/**
 * Observation Deck P0 — flight-recorder self-test. Fully hermetic: writes only
 * to a throwaway tmp dir, zero network/binaries. Guards the fail-open journal
 * contract (single-line events, corrupt-line tolerance, caps, retention).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DETAIL_CAP,
  _resetForTest,
  appendExecLog,
  execLogPath,
  journalPath,
  readFlightEvents,
  recordFlight,
  tailExecLog,
} from "./flight-recorder";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, note = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${note ? ` — ${note}` : ""}`);
  }
}

const DIR = join(tmpdir(), `flight-selftest-${Date.now()}`);

// 1. record + read round-trip, single-line JSON, ts stamped
_resetForTest();
recordFlight({ execution_id: "exec-aaaa1111", identifier: "ZOU-000", kind: "exec.start", detail: "hello", data: { executor: "claude-code" } }, DIR);
recordFlight({ execution_id: "exec-aaaa1111", identifier: "ZOU-000", kind: "executor.ok", data: { secs: 12 } }, DIR);
let events = readFlightEvents({ dir: DIR });
check("round-trip: 2 events read back", events.length === 2, `got ${events.length}`);
check("ts auto-stamped ISO", typeof events[0]?.ts === "string" && !Number.isNaN(Date.parse(events[0].ts!)));
check("data preserved", (events[0]?.data as any)?.executor === "claude-code");
const rawLines = readFileSync(journalPath(DIR), "utf-8").trim().split("\n");
check("journal is one JSON per line", rawLines.length === 2 && rawLines.every((l) => JSON.parse(l)));

// 2. detail capped
recordFlight({ execution_id: "exec-bbbb2222", identifier: "ZOU-001", kind: "exec.failed", detail: "x".repeat(DETAIL_CAP * 3) }, DIR);
events = readFlightEvents({ dir: DIR });
const capped = events.find((e) => e.execution_id === "exec-bbbb2222");
check("detail capped at DETAIL_CAP", (capped?.detail ?? "").length === DETAIL_CAP);

// 3. corrupt line tolerated
appendFileSync(journalPath(DIR), "{torn-half-line\n");
recordFlight({ execution_id: "exec-cccc3333", identifier: "ZOU-002", kind: "exec.start" }, DIR);
events = readFlightEvents({ dir: DIR });
check("corrupt line skipped, later events survive", events.length === 4 && events.some((e) => e.execution_id === "exec-cccc3333"));

// 4. missing dir → []
check("missing dir reads as empty", readFlightEvents({ dir: join(DIR, "nope") }).length === 0);

// 5. exec log tee + tail
appendExecLog("exec-aaaa1111", "line1\nline2\n", DIR);
appendExecLog("exec-aaaa1111", "line3\n", DIR);
check("tailExecLog round-trip", JSON.stringify(tailExecLog("exec-aaaa1111", 60, DIR)) === JSON.stringify(["line1", "line2", "line3"]));
check("tailExecLog maxLines", JSON.stringify(tailExecLog("exec-aaaa1111", 2, DIR)) === JSON.stringify(["line2", "line3"]));
check("tail of unknown exec is empty", tailExecLog("exec-none", 10, DIR).length === 0);

// 6. hostile execution_id sanitized (no path traversal)
const hostile = execLogPath("../../etc/passwd", DIR);
check("exec log path sanitized", hostile.startsWith(DIR) && !hostile.includes(".."));

// 7. retention: >14-day-old journal + exec log pruned on next record
const oldJournal = join(DIR, "journal-2020-01-01.jsonl");
writeFileSync(oldJournal, "{}\n");
const oldLog = join(DIR, "exec-old00000.log");
writeFileSync(oldLog, "stale\n");
const past = new Date(Date.now() - 30 * 86_400_000);
utimesSync(oldLog, past, past);
_resetForTest();
recordFlight({ execution_id: "exec-dddd4444", identifier: "ZOU-003", kind: "exec.start" }, DIR);
check("old journal pruned", !existsSync(oldJournal));
check("old exec log pruned", !existsSync(oldLog));
check("fresh exec log kept", existsSync(execLogPath("exec-aaaa1111", DIR)));

// 8. fail-open: flight dir path occupied by a FILE → record must not throw
const blocked = join(DIR, "blocked-as-file");
writeFileSync(blocked, "i am a file");
_resetForTest();
let threw = false;
try {
  recordFlight({ execution_id: "exec-eeee5555", identifier: "ZOU-004", kind: "exec.start" }, join(blocked, "sub"));
  appendExecLog("exec-eeee5555", "x", join(blocked, "sub"));
} catch {
  threw = true;
}
check("recorder is fail-open (never throws)", !threw);

rmSync(DIR, { recursive: true, force: true });

console.log(`\nflight-recorder self-test: ${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
