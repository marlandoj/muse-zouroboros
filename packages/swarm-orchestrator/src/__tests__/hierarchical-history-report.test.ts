import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const orchestratorScript = join(import.meta.dir, "..", "..", "scripts", "orchestrate-v5.ts");

describe("hierarchical history report", () => {
  it("prints delegation-aware executor history from the persisted history database", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "swarm-history-report-"));

    try {
      const homeDir = join(tempRoot, "home");
      const swarmDir = join(homeDir, ".swarm");
      mkdirSync(swarmDir, { recursive: true });

      const db = new Database(join(swarmDir, "executor-history.db"));
      db.run(`CREATE TABLE executor_history (
        executor TEXT NOT NULL,
        category TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        avg_ms REAL NOT NULL DEFAULT 0,
        delegated_attempts INTEGER NOT NULL DEFAULT 0,
        delegated_successes INTEGER NOT NULL DEFAULT 0,
        child_attempts INTEGER NOT NULL DEFAULT 0,
        child_successes INTEGER NOT NULL DEFAULT 0,
        avg_child_count REAL NOT NULL DEFAULT 0,
        avg_child_duration_ms REAL NOT NULL DEFAULT 0,
        last_updated INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (executor, category)
      )`);
      db.run(
        `INSERT INTO executor_history (
          executor, category, attempts, successes, avg_ms,
          delegated_attempts, delegated_successes, child_attempts, child_successes,
          avg_child_count, avg_child_duration_ms, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["hermes", "validation", 12, 10, 800, 6, 5, 14, 12, 2.3, 160, 1_775_177_200],
      );
      db.run(
        `INSERT INTO executor_history (
          executor, category, attempts, successes, avg_ms,
          delegated_attempts, delegated_successes, child_attempts, child_successes,
          avg_child_count, avg_child_duration_ms, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["claude-code", "implementation", 9, 7, 1300, 3, 2, 5, 4, 1.2, 290, 1_775_177_100],
      );
      db.close();

      const proc = spawnSync("bun", [orchestratorScript, "history", "2"], {
        cwd: join(import.meta.dir, "..", ".."),
        env: {
          ...process.env,
          HOME: homeDir,
        },
        encoding: "utf8",
      });

      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain("📚 Swarm Executor History");
      expect(proc.stdout).toContain("hermes [validation]");
      expect(proc.stdout).toContain("Base: 10/12 (83%) avg 800ms");
      expect(proc.stdout).toContain("Delegation: 6 attempts (83% success)");
      expect(proc.stdout).toContain("Children: 12/14 (86%) avg count 2.3 avg child 160ms");
      expect(proc.stdout).toContain("claude-code [implementation]");
      expect(proc.stdout).toContain("Delegation: 3 attempts (67% success)");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
