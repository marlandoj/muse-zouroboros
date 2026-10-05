import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const orchestratorScript = join(import.meta.dir, "..", "..", "scripts", "orchestrate-v5.ts");

describe("hierarchical status summary", () => {
  it("reports persisted delegation telemetry from the results file", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "swarm-status-summary-"));

    try {
      const homeDir = join(tempRoot, "home");
      const swarmDir = join(homeDir, ".swarm");
      const resultsDir = join(swarmDir, "results");
      mkdirSync(resultsDir, { recursive: true });

      writeFileSync(
        join(resultsDir, "hier-status.json"),
        JSON.stringify({
          swarmId: "hier-status",
          status: "complete",
          completed: 2,
          failed: 1,
          total: 3,
          delegatedTasks: 2,
          childTaskCount: 3,
          elapsedMs: 4200,
          results: [
            {
              task: { id: "task-1", executor: "claude-code" },
              success: true,
              durationMs: 1100,
              retries: 0,
              delegated: true,
              effectiveExecutor: "hermes",
              artifacts: ["artifacts/a.md", "artifacts/b.md"],
              childRecords: [{ childId: "child-a" }, { childId: "child-b" }],
            },
            {
              task: { id: "task-2", executor: "hermes" },
              success: true,
              durationMs: 900,
              retries: 0,
              delegated: true,
              effectiveExecutor: "hermes",
              artifacts: ["artifacts/c.md"],
              childRecords: [{ childId: "child-c" }],
            },
            {
              task: { id: "task-3", executor: "codex" },
              success: false,
              durationMs: 700,
              retries: 1,
              delegated: false,
              effectiveExecutor: "codex",
              artifacts: [],
              childRecords: [],
            },
          ],
        }, null, 2),
      );

      const proc = spawnSync("bun", [orchestratorScript, "status", "hier-status"], {
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          HOME: homeDir,
        },
        encoding: "utf8",
      });

      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain("Outcome: 2/3 succeeded, 1 failed");
      expect(proc.stdout).toContain("Duration: 4s");
      expect(proc.stdout).toContain("Delegated: 2 parent / 3 child");
      expect(proc.stdout).toContain("Artifacts: 3");
      expect(proc.stdout).toContain("Reroutes: 1");
      expect(proc.stdout).toContain("Executors: hermes, codex");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
