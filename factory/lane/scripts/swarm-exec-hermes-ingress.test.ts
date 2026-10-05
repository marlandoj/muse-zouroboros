import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("executor CLI rejects a Hermes dispatch before claim or execution state", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-hermes-reject-"));
  const fixture = join(stateDir, "dispatch.json");
  writeFileSync(fixture, JSON.stringify([{
    ticket: { source: "hermes", factory_work_id: `fw_${"a".repeat(64)}`, dispatch_eligible: false,
      identifier: "H-1", title: "Fixture", description: "Fixture" },
    decision: "DIRECT", score: 0.1, override: false,
  }]));
  try {
    const run = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "swarm-exec.ts"),
      "--dispatch", fixture,
    ], {
      env: { ...process.env, FACTORY_STATE_MODE: "test", FACTORY_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(run.stderr)).toContain("LINEAR_TICKET_REQUIRED");
    expect(readdirSync(stateDir)).toEqual(["dispatch.json"]);
  } finally {
    unlinkSync(fixture);
    rmdirSync(stateDir);
  }
});
