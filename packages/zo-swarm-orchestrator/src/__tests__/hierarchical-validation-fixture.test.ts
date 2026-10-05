import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const orchestratorScript = join(import.meta.dir, "..", "..", "scripts", "orchestrate-v5.ts");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("hierarchical validation fixture", () => {
  it("persists child telemetry and routes delegation-friendly work using executor history", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "swarm-hier-fixture-"));

    try {
      const workspaceDir = join(tempRoot, "workspace");
      const homeDir = join(tempRoot, "home");
      const swarmDir = join(homeDir, ".swarm");
      const logsDir = join(swarmDir, "logs");
      const resultsDir = join(swarmDir, "results");
      const memoryDbPath = join(workspaceDir, ".zo", "memory", "shared-facts.db");
      const registryDir = join(workspaceDir, "packages", "swarm", "src", "executor", "registry");
      const assetsDir = join(workspaceDir, "Skills", "zo-swarm-orchestrator", "assets");
      const identityDir = join(workspaceDir, "IDENTITY");
      const bridgesDir = join(workspaceDir, "bridges");

      [
        workspaceDir,
        homeDir,
        swarmDir,
        logsDir,
        resultsDir,
        join(workspaceDir, ".zo", "memory"),
        registryDir,
        assetsDir,
        identityDir,
        bridgesDir,
      ].forEach(dir => mkdirSync(dir, { recursive: true }));
      // The writer intentionally skips a missing memory database.
      new Database(memoryDbPath).close();

      const hermesBridge = join(bridgesDir, "synthetic-hermes.sh");
      const claudeBridge = join(bridgesDir, "synthetic-claude-code.sh");

      writeExecutable(
        hermesBridge,
        `#!/usr/bin/env bash
set -euo pipefail
prompt="\${1:-}"
result_path="\${RESULT_PATH:?}"

if [[ "$prompt" == *"AUTO_ROUTE_PROBE"* ]]; then
  cat >"$result_path" <<'JSON'
{"output":"Auto route probe complete.\\n<delegation_report>{\\"used\\":true,\\"children\\":[{\\"childId\\":\\"route-a\\",\\"parentTaskId\\":\\"auto-route-probe\\",\\"executorId\\":\\"hermes\\",\\"delegatedModel\\":\\"synthetic-hermes\\",\\"status\\":\\"success\\",\\"durationMs\\":120,\\"artifacts\\":[\\"artifacts/route-a.md\\"],\\"summary\\":\\"Generated route child A\\"},{\\"childId\\":\\"route-b\\",\\"parentTaskId\\":\\"auto-route-probe\\",\\"executorId\\":\\"hermes\\",\\"delegatedModel\\":\\"synthetic-hermes\\",\\"status\\":\\"success\\",\\"durationMs\\":140,\\"artifacts\\":[\\"artifacts/route-b.md\\"],\\"summary\\":\\"Generated route child B\\"}]}</delegation_report>","metrics":{"model":"synthetic-hermes"},"artifacts":{"filesCreated":["artifacts/route-parent.md"]}}
JSON
  exit 0
fi

cat >"$result_path" <<'JSON'
{"output":"Research fanout complete.\\n<delegation_report>{\\"used\\":true,\\"children\\":[{\\"childId\\":\\"research-a\\",\\"parentTaskId\\":\\"research-fanout\\",\\"executorId\\":\\"hermes\\",\\"delegatedModel\\":\\"synthetic-hermes\\",\\"status\\":\\"success\\",\\"durationMs\\":150,\\"artifacts\\":[\\"artifacts/research-a.md\\"],\\"summary\\":\\"Generated research child A\\"},{\\"childId\\":\\"research-b\\",\\"parentTaskId\\":\\"research-fanout\\",\\"executorId\\":\\"hermes\\",\\"delegatedModel\\":\\"synthetic-hermes\\",\\"status\\":\\"success\\",\\"durationMs\\":180,\\"artifacts\\":[\\"artifacts/research-b.md\\"],\\"summary\\":\\"Generated research child B\\"}]}</delegation_report>","metrics":{"model":"synthetic-hermes"},"artifacts":{"filesCreated":["artifacts/research-parent.md"]}}
JSON
`,
      );

      writeExecutable(
        claudeBridge,
        `#!/usr/bin/env bash
set -euo pipefail
prompt="\${1:-}"
result_path="\${RESULT_PATH:?}"

if [[ "$prompt" == *"Do not delegate this task."* ]]; then
  cat >"$result_path" <<'JSON'
{"output":"Blocked mutation completed as a leaf executor.","metrics":{"model":"synthetic-claude"},"artifacts":{"filesCreated":["artifacts/blocked-leaf.md"]}}
JSON
  exit 0
fi

cat >"$result_path" <<'JSON'
{"output":"Safe implementation complete.\\n<delegation_report>{\\"used\\":true,\\"children\\":[{\\"childId\\":\\"impl-a\\",\\"parentTaskId\\":\\"implementation-safe\\",\\"executorId\\":\\"claude-code\\",\\"delegatedModel\\":\\"synthetic-claude\\",\\"writeScope\\":[\\"src/a.ts\\"],\\"status\\":\\"success\\",\\"durationMs\\":210,\\"artifacts\\":[\\"artifacts/impl-a.md\\"],\\"summary\\":\\"Updated child-owned file\\"}]}</delegation_report>","metrics":{"model":"synthetic-claude"},"artifacts":{"filesCreated":["artifacts/impl-parent.md"]}}
JSON
`,
      );

      writeJson(join(registryDir, "executor-registry.json"), {
        executors: [
          {
            id: "hermes",
            name: "Hermes",
            executor: "local",
            bridge: hermesBridge,
            expertise: ["analysis", "research", "synthesis"],
            best_for: ["parallel analysis", "delegation"],
          },
          {
            id: "claude-code",
            name: "Claude Code",
            executor: "local",
            bridge: claudeBridge,
            expertise: ["analysis", "research", "synthesis"],
            best_for: ["parallel analysis", "delegation"],
          },
        ],
      });
      writeJson(join(assetsDir, "persona-registry.json"), { personas: [] });
      writeJson(join(identityDir, "agency-agents-personas.json"), { personas: [] });

      const historyDb = new Database(join(swarmDir, "executor-history.db"));
      historyDb.run(`CREATE TABLE executor_history (
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
      historyDb.run(
        `INSERT INTO executor_history (
          executor, category, attempts, successes, avg_ms,
          delegated_attempts, delegated_successes, child_attempts, child_successes,
          avg_child_count, avg_child_duration_ms, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["hermes", "validation", 8, 7, 900, 4, 4, 8, 7, 2, 400, Math.floor(Date.now() / 1000)],
      );
      historyDb.run(
        `INSERT INTO executor_history (
          executor, category, attempts, successes, avg_ms,
          delegated_attempts, delegated_successes, child_attempts, child_successes,
          avg_child_count, avg_child_duration_ms, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["claude-code", "validation", 8, 7, 900, 4, 1, 5, 2, 1, 3000, Math.floor(Date.now() / 1000)],
      );
      historyDb.close();

      const tasksPath = join(workspaceDir, "hierarchical-validation.json");
      writeJson(tasksPath, [
        {
          id: "research-fanout",
          executor: "hermes",
          persona: "auto",
          task: "RESEARCH_FANOUT: Perform a read-only parallel analysis and synthesize the results.",
          priority: "high",
          timeoutSeconds: 5,
          delegation: { mode: "auto", maxChildren: 3 },
          memoryMetadata: { category: "validation", tags: ["hierarchical", "research"] },
        },
        {
          id: "implementation-safe",
          executor: "claude-code",
          persona: "auto",
          task: "IMPLEMENT_SAFE: Implement the parser fix and update child-owned files only.",
          priority: "high",
          timeoutSeconds: 5,
          delegation: {
            mode: "auto",
            maxChildren: 2,
            writeScopes: [
              { childId: "impl-a", paths: ["src/a.ts"] },
              { childId: "impl-b", paths: ["src/b.ts"] },
            ],
          },
          memoryMetadata: { category: "validation", tags: ["hierarchical", "mutation"] },
        },
        {
          id: "implementation-blocked",
          executor: "claude-code",
          persona: "auto",
          task: "IMPLEMENT_BLOCKED: Implement a mutation-heavy change without declared child ownership.",
          priority: "medium",
          timeoutSeconds: 5,
          delegation: { mode: "auto", maxChildren: 2 },
          memoryMetadata: { category: "validation", tags: ["hierarchical", "blocked"] },
        },
        {
          id: "auto-route-probe",
          persona: "auto",
          task: "AUTO_ROUTE_PROBE: Research and compare bounded alternatives, then synthesize the result.",
          priority: "high",
          timeoutSeconds: 5,
          delegation: { mode: "auto", maxChildren: 3 },
          memoryMetadata: { category: "validation", tags: ["hierarchical", "routing"] },
        },
      ]);

      const proc = spawnSync(
        "bun",
        [
          orchestratorScript,
          tasksPath,
          "--swarm-id",
          "hierarchical-broader-validation-test",
          "--timeout",
          "5",
        ],
        {
          cwd: join(import.meta.dir, "..", ".."),
          env: {
            ...process.env,
            HOME: homeDir,
            SWARM_DIR: swarmDir,
            SWARM_WORKSPACE: workspaceDir,
            ZOUROBOROS_MEMORY_DB: memoryDbPath,
            ZO_MEMORY_DB: memoryDbPath,
            ZO_TRACE_ID: "",
          },
          encoding: "utf8",
        },
      );

      expect(proc.status).toBe(0);
      expect(proc.stderr).not.toContain("[episodes] Failed");

      const episodeDb = new Database(memoryDbPath, { readonly: true });
      try {
        const episodes = episodeDb.query("SELECT id, summary, metadata FROM episodes").all() as Array<{
          id: string; summary: string; metadata: string;
        }>;
        expect(episodes).toHaveLength(6); // One parent plus all five delegated children.
        expect(episodes.filter(row => JSON.parse(row.metadata).parent_episode_id)).toHaveLength(5);
        expect(episodeDb.query("SELECT count(*) AS n FROM episode_documents").get()).toEqual({ n: 6 });
        expect(episodeDb.query("SELECT count(*) AS n FROM episode_documents_fts").get()).toEqual({ n: 6 });
        for (const episode of episodes) {
          // Canonical format: summary, optional entity line, then serialized metadata.
          const expected = `${episode.summary}\n${episode.metadata}`;
          expect(episodeDb.query("SELECT text FROM episode_documents WHERE episode_id = ?").get(episode.id))
            .toEqual({ text: expected });
          expect(episodeDb.query("SELECT text FROM episode_documents_fts WHERE episode_id = ?").all(episode.id))
            .toEqual([{ text: expected }]);
        }
        expect(episodeDb.query("SELECT count(*) AS n FROM episode_documents_fts WHERE episode_documents_fts MATCH 'swarm_id'").get())
          .toEqual({ n: 6 });
      } finally {
        episodeDb.close();
      }

      const results = JSON.parse(
        readFileSync(join(resultsDir, "hierarchical-broader-validation-test.json"), "utf8"),
      ) as {
        delegatedTasks: number;
        childTaskCount: number;
        results: Array<{
          task: { id: string };
          delegated?: boolean;
          childRecords?: Array<{ childId: string }>;
          effectiveExecutor?: string;
        }>;
      };
      const ndjson = readFileSync(join(logsDir, "hierarchical-broader-validation-test.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map(line => JSON.parse(line));

      const byTask = Object.fromEntries(results.results.map(result => [result.task.id, result]));

      expect(results.delegatedTasks).toBe(3);
      expect(results.childTaskCount).toBe(5);
      expect(byTask["research-fanout"]?.delegated).toBe(true);
      expect(byTask["implementation-safe"]?.delegated).toBe(true);
      expect(byTask["implementation-blocked"]?.delegated).toBe(false);
      expect(byTask["auto-route-probe"]?.effectiveExecutor).toBe("hermes");
      expect(byTask["auto-route-probe"]?.childRecords?.map(record => record.childId)).toEqual(["route-a", "route-b"]);

      const childRecordEvents = ndjson.filter(event => event.event === "task_child_records");
      expect(childRecordEvents).toHaveLength(3);

      const updatedHistoryDb = new Database(join(swarmDir, "executor-history.db"), { readonly: true });
      const hermesRow = updatedHistoryDb
        .query(
          `SELECT delegated_attempts, delegated_successes, child_attempts, child_successes
           FROM executor_history WHERE executor=? AND category=?`,
        )
        .get("hermes", "validation") as {
          delegated_attempts: number;
          delegated_successes: number;
          child_attempts: number;
          child_successes: number;
        };
      updatedHistoryDb.close();

      expect(hermesRow.delegated_attempts).toBeGreaterThanOrEqual(6);
      expect(hermesRow.delegated_successes).toBeGreaterThanOrEqual(6);
      expect(hermesRow.child_attempts).toBeGreaterThanOrEqual(12);
      expect(hermesRow.child_successes).toBeGreaterThanOrEqual(11);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 20000);
});
