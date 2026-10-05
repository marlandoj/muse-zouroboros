#!/usr/bin/env bun
/**
 * Hermetic selftest for flight-status.ts — pure computeFlightStatus only,
 * no fs/network. Prints "flight-status self-test: N/N passed"; exit 1 on fail.
 */

import { computeFlightStatus, TERMINAL_KINDS, type ExecRecordLite } from "./flight-status";
import type { FlightEvent } from "./flight-recorder";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: string): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const NOW = Date.parse("2026-07-09T12:00:00Z");
const ts = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
const ev = (execution_id: string, kind: string, secAgo: number, data?: Record<string, unknown>, detail?: string): FlightEvent => ({
  ts: ts(secAgo),
  execution_id,
  identifier: "ZOU-999",
  kind,
  detail,
  data,
});
const noTail = () => [] as string[];

// 1. empty inputs → empty status
{
  const s = computeFlightStatus({ events: [], execRecords: [], nowMs: NOW, tail: noTail });
  check("empty inputs", s.live.length === 0 && s.recent.length === 0 && s.counts.events === 0);
}

// 2. live run: exec.start + executor.start, no terminal → live with current executor
{
  const s = computeFlightStatus({
    events: [ev("exec-aaa", "exec.start", 120), ev("exec-aaa", "executor.start", 90, { executor: "claude-code" })],
    execRecords: [{ execution_id: "exec-aaa", status: "executing", completed_at: null }],
    nowMs: NOW,
    tail: (id) => (id === "exec-aaa" ? ["line1", "line2"] : []),
  });
  const v = s.live[0];
  check("live run detected", s.live.length === 1 && s.recent.length === 0);
  check("current executor", v?.current_executor === "claude-code");
  check("live tail attached", v?.log_tail.length === 2);
  check("age computed", v?.last_event_age_s === 90);
}

// 3. executor.fail clears current executor; second executor.start replaces it
{
  const s = computeFlightStatus({
    events: [
      ev("exec-bbb", "executor.start", 300, { executor: "claude-code" }),
      ev("exec-bbb", "executor.fail", 250, { executor: "claude-code" }),
      ev("exec-bbb", "executor.start", 200, { executor: "codex" }),
    ],
    execRecords: [],
    nowMs: NOW,
    tail: noTail,
  });
  const v = s.live[0];
  check("executor rotation tracked", v?.current_executor === "codex");
  check("executors_tried ordered", JSON.stringify(v?.executors_tried) === '["claude-code","codex"]');
}

// 4. terminal event → recent, not live, current_executor null
{
  const s = computeFlightStatus({
    events: [
      ev("exec-ccc", "executor.start", 500, { executor: "claude-code" }),
      ev("exec-ccc", "executor.ok", 400, { executor: "claude-code" }),
      ev("exec-ccc", "exec.complete", 399, undefined, "done"),
    ],
    execRecords: [{ execution_id: "exec-ccc", status: "complete", completed_at: ts(399) }],
    nowMs: NOW,
    tail: () => ["tail-of-run"],
  });
  check("terminal → recent", s.live.length === 0 && s.recent.length === 1);
  check("recent keeps short tail", s.recent[0]?.log_tail.length === 1);
  check("recent last kind", s.recent[0]?.last_event_kind === "exec.complete");
}

// 5. torn-write guard: no terminal event but exec record completed_at set → not live
{
  const s = computeFlightStatus({
    events: [ev("exec-ddd", "executor.start", 100, { executor: "gemini" })],
    execRecords: [{ execution_id: "exec-ddd", status: "failed", completed_at: ts(50) }],
    nowMs: NOW,
    tail: noTail,
  });
  check("torn-write guard", s.live.length === 0 && s.recent.length === 1);
}

// 6. stale flag: live but quiet past threshold
{
  const s = computeFlightStatus({
    events: [ev("exec-eee", "executor.start", 3600, { executor: "codex" })],
    execRecords: [],
    nowMs: NOW,
    tail: noTail,
    staleAfterMs: 10 * 60_000,
  });
  check("stale flagged", s.live[0]?.stale === true && s.counts.stale === 1);
}

// 7. heartbeat bytes surface; fallback.zo-ask sets flag + clears executor
{
  const s = computeFlightStatus({
    events: [
      ev("exec-fff", "executor.start", 400, { executor: "claude-code" }),
      ev("exec-fff", "executor.heartbeat", 300, { executor: "claude-code", bytes: 4096 }),
      ev("exec-fff", "executor.throw", 200, { executor: "claude-code" }),
      ev("exec-fff", "fallback.zo-ask", 190),
    ],
    execRecords: [],
    nowMs: NOW,
    tail: noTail,
  });
  const v = s.live[0];
  check("heartbeat bytes", v?.streamed_bytes === 4096);
  check("fallback flag", v?.fell_back_to_ask === true && v?.current_executor === null);
}

// 8. recentCap honored, newest first
{
  const events: FlightEvent[] = [];
  for (let i = 0; i < 5; i++) events.push(ev(`exec-r${i}`, "exec.complete", 1000 - i));
  const s = computeFlightStatus({ events, execRecords: [], nowMs: NOW, tail: noTail, recentCap: 3 });
  check("recentCap", s.recent.length === 3);
  check("recent newest first", s.recent[0]?.execution_id === "exec-r4");
}

// 9. corrupt-ish event (missing ts) doesn't crash; hand-off kinds are terminal
{
  const s = computeFlightStatus({
    events: [
      { execution_id: "exec-ggg", identifier: "ZOU-1", kind: "exec.queued" },
      ev("exec-hhh", "exec.pool-enqueued", 10),
      ev("exec-iii", "exec.held", 10),
    ],
    execRecords: [],
    nowMs: NOW,
    tail: noTail,
  });
  check("hand-off kinds terminal", s.live.length === 0 && s.recent.length === 3);
  check("TERMINAL_KINDS coherent", TERMINAL_KINDS.has("exec.queued") && !TERMINAL_KINDS.has("executor.start"));
}

// 10. enrichment from exec record (gate/status/summary/error)
{
  const rec: ExecRecordLite = {
    execution_id: "exec-jjj",
    identifier: "ZOU-544",
    gate_decision: "SWARM",
    status: "executing",
    completed_at: null,
    result_summary: null,
    error: null,
  };
  const s = computeFlightStatus({
    events: [ev("exec-jjj", "exec.start", 60)],
    execRecords: [rec],
    nowMs: NOW,
    tail: noTail,
  });
  check("record enrichment", s.live[0]?.gate_decision === "SWARM" && s.live[0]?.status === "executing");
}

// 11. canonical implementation completion is terminal for this process and
// reports the lifecycle state even when the compatibility status is stale.
{
  const s = computeFlightStatus({
    events: [ev("exec-kkk", "exec.implementation_complete", 30)],
    execRecords: [{
      execution_id: "exec-kkk",
      status: "complete",
      state: "implementation_complete",
      delivery_target: "accepted",
      completed_at: ts(30),
    }],
    nowMs: NOW,
    tail: noTail,
  });
  check("canonical completion is process-terminal", s.live.length === 0 && s.recent.length === 1);
  check("canonical state supersedes compatibility status", s.recent[0]?.status === "implementation_complete");
}

// 12. bookkeeping pseudo-executions retire on their own terminal kinds.
// serial-<twin> opens with .promoted and closes with .canonical-complete; a
// reconcile pass closes on .enforced/.shadow. None carry completed_at, so
// before this was fixed each one accrued as a permanent "live, stale" run.
{
  const s = computeFlightStatus({
    events: [
      ev("serial-ZOU-933", "serial-promotion.promoted", 7200),
      ev("serial-ZOU-933", "serial-promotion.canonical-complete", 3600),
      ev("reconcile-ZOU-933", "reconcile.enforced", 3600),
      ev("reconcile-ZOU-912", "reconcile.shadow", 3600),
    ],
    execRecords: [],
    nowMs: NOW,
    tail: noTail,
  });
  check("completed promotion is not live", s.live.length === 0, `live=${s.live.length}`);
  check("all three bookkeeping runs retire", s.recent.length === 3, `recent=${s.recent.length}`);
}

// 13. an unclosed promotion must STAY live — the fix must not blind the
// detector to a promotion that genuinely stalled after .promoted.
{
  const s = computeFlightStatus({
    events: [ev("serial-ZOU-920", "serial-promotion.promoted", 7200)],
    execRecords: [],
    nowMs: NOW,
    tail: noTail,
  });
  check("unclosed promotion stays live", s.live.length === 1 && s.live[0]?.stale === true);
  check("promoted is not itself terminal", !TERMINAL_KINDS.has("serial-promotion.promoted"));
  check("degradation warning is not terminal", !TERMINAL_KINDS.has("serial-promotion.evidence-degraded"));
}

console.log(`flight-status self-test: ${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
