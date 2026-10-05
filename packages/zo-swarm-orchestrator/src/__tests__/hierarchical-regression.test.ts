import { describe, expect, it } from "bun:test";
import { join } from "path";
import {
  evaluateDelegation,
  renderHierarchicalPolicyBlock,
  stripDelegationReport,
  taskNeedsWriteScopes,
} from "../hierarchical.js";

const testConfig = {
  hierarchicalDelegation: {
    enabled: true,
    maxDepth: 1,
    defaultMode: "auto" as const,
    claudeCodeMaxChildren: 2,
    hermesMaxChildren: 3,
  },
};

describe("hierarchical delegation regressions", () => {
  it("does not require write scopes for read-only analysis prompts that mention child creation", () => {
    expect(taskNeedsWriteScopes({
      task: "Do a two-part read-only analysis. Create at most 2 child tasks and do not edit files.",
      expectedMutations: undefined,
    } as any)).toBe(false);
  });

  it("requires write scopes for mutation-oriented prompts", () => {
    expect(taskNeedsWriteScopes({
      task: "Implement the fix and update the parser to handle retries.",
      expectedMutations: undefined,
    } as any)).toBe(true);
  });

  it("treats codex and gemini as leaf executors in v1 policy", () => {
    const task = {
      id: "leaf-check",
      task: "Research the current executor surfaces and summarize them.",
      priority: "medium",
      persona: "agents-orchestrator",
    } as any;

    expect(evaluateDelegation(task, "codex", testConfig)).toEqual({
      allowed: false,
      blockedReason: "executor is leaf-only",
      maxChildren: 0,
      telemetryMode: "none",
    });
    expect(evaluateDelegation(task, "gemini", testConfig)).toEqual({
      allowed: false,
      blockedReason: "executor is leaf-only",
      maxChildren: 0,
      telemetryMode: "none",
    });
  });

  it("allows hermes delegation within centralized caps for read-only work", () => {
    const task = {
      id: "hermes-analysis",
      task: "Research and compare current executor delegation behavior.",
      priority: "high",
      persona: "agents-orchestrator",
      delegation: { maxChildren: 9 },
    } as any;

    expect(evaluateDelegation(task, "hermes", testConfig)).toEqual({
      allowed: true,
      maxChildren: 3,
      telemetryMode: "child_records",
    });
  });

  it("blocks delegated mutation work without disjoint write scopes", () => {
    const task = {
      id: "mutation-block",
      task: "Implement the change and update the parser files.",
      priority: "high",
      persona: "agents-orchestrator",
      delegation: { mode: "auto" },
    } as any;

    expect(evaluateDelegation(task, "claude-code", testConfig)).toEqual({
      allowed: false,
      blockedReason: "delegated mutation work requires disjoint write scopes",
      maxChildren: 0,
      telemetryMode: "none",
    });
  });

  it("parses tagged delegation reports", () => {
    const parsed = stripDelegationReport([
      "Done.",
      "<delegation_report>",
      JSON.stringify({
        used: true,
        children: [
          { childId: "a", executorId: "claude-code", status: "success", artifacts: ["x.md"] },
        ],
      }),
      "</delegation_report>",
    ].join("\n"));

    expect(parsed.cleanOutput).toBe("Done.");
    expect(parsed.delegated).toBe(true);
    expect(parsed.childRecords).toHaveLength(1);
    expect(parsed.artifacts).toEqual(["x.md"]);
  });

  it("parses fenced json delegation fallback used by live executor output", () => {
    const parsed = stripDelegationReport([
      "Synthesis text",
      "```json",
      JSON.stringify({
        delegation_report: {
          delegation_used: false,
          child_tasks: [],
        },
      }, null, 2),
      "```",
    ].join("\n"));

    expect(parsed.cleanOutput).toBe("Synthesis text");
    expect(parsed.delegated).toBe(false);
    expect(parsed.childRecords).toHaveLength(0);
  });

  it("parses claude-code style tagged delegation output with camelCase child telemetry", () => {
    const parsed = stripDelegationReport([
      "Completed the audit and synthesized the findings.",
      "<delegation_report>",
      JSON.stringify({
        used: true,
        children: [
          {
            childId: "benefits-1",
            parentTaskId: "outer-42",
            executorId: "claude-code",
            delegatedModel: "sonnet",
            writeScope: ["src/parser.ts"],
            toolset: ["Read", "Grep"],
            status: "success",
            durationMs: 1820,
            artifacts: ["notes/benefits.md"],
            source: "executor_bridge",
            summary: "Analyzed benefits branch",
          },
        ],
      }, null, 2),
      "</delegation_report>",
    ].join("\n"));

    expect(parsed.cleanOutput).toBe("Completed the audit and synthesized the findings.");
    expect(parsed.delegated).toBe(true);
    expect(parsed.artifacts).toEqual(["notes/benefits.md"]);
    expect(parsed.childRecords).toEqual([
      {
        childId: "benefits-1",
        parentTaskId: "outer-42",
        executorId: "claude-code",
        delegatedModel: "sonnet",
        writeScope: ["src/parser.ts"],
        toolset: ["Read", "Grep"],
        status: "success",
        durationMs: 1820,
        artifacts: ["notes/benefits.md"],
        source: "executor_bridge",
        summary: "Analyzed benefits branch",
      },
    ]);
  });

  it("parses hermes-style fenced delegation output with snake_case child telemetry", () => {
    const parsed = stripDelegationReport([
      "Hermes synthesis follows.",
      "```json",
      JSON.stringify({
        delegation_report: {
          delegation_used: true,
          child_tasks: [
            {
              child_id: "risk-1",
              parent_task_id: "outer-77",
              executor_id: "hermes",
              delegated_model: "swarm-mid",
              write_scope: ["docs/risk.md"],
              toolset: ["web_search", "read_file"],
              status: "blocked",
              duration_ms: 941,
              artifacts: ["artifacts/risk.md"],
              source: "logger_synthesis",
              summary: "Blocked on missing external credential",
            },
          ],
        },
      }, null, 2),
      "```",
    ].join("\n"));

    expect(parsed.cleanOutput).toBe("Hermes synthesis follows.");
    expect(parsed.delegated).toBe(true);
    expect(parsed.artifacts).toEqual(["artifacts/risk.md"]);
    expect(parsed.childRecords).toEqual([
      {
        childId: "risk-1",
        parentTaskId: "outer-77",
        executorId: "hermes",
        delegatedModel: "swarm-mid",
        writeScope: ["docs/risk.md"],
        toolset: ["web_search", "read_file"],
        status: "blocked",
        durationMs: 941,
        artifacts: ["artifacts/risk.md"],
        source: "logger_synthesis",
        summary: "Blocked on missing external credential",
      },
    ]);
  });

  it("renders the parent synthesis contract in the hierarchical policy block", () => {
    const task = {
      id: "outer-200",
      task: "Synthesize findings from bounded child analyses.",
      priority: "medium",
      persona: "agents-orchestrator",
      delegation: {
        writeScopes: [
          { childId: "child-a", paths: ["src/a.ts"] },
          { childId: "child-b", paths: ["src/b.ts"] },
        ],
      },
    } as any;

    const block = renderHierarchicalPolicyBlock(task, "claude-code", {
      allowed: true,
      maxChildren: 2,
      telemetryMode: "summary_only",
    });

    expect(block).toContain("You remain responsible for the outer task result.");
    expect(block).toContain("Child success does not complete the outer task.");
    expect(block).toContain('parentTaskId": "outer-200"');
    expect(block).toContain("Declared child write scopes:");
  });

  it("guards against duplicate main entrypoints in the orchestrator script", async () => {
    const scriptPath = join(import.meta.dir, "..", "..", "scripts", "orchestrate-v5.ts");
    const text = await Bun.file(scriptPath).text();
    const matches = text.match(/\bmain\(\)\.catch\(/g) || [];
    expect(matches).toHaveLength(1);
  });

  it("prefers an explicit task executor over persona during first-attempt execution", async () => {
    const scriptPath = join(import.meta.dir, "..", "..", "scripts", "orchestrate-v5.ts");
    const text = await Bun.file(scriptPath).text();
    expect(text).toContain('if (task.executor && retries === 0 && reroutes === 0)');
    expect(text).toContain('} else if (task.persona && task.persona !== "auto" && retries === 0 && reroutes === 0)');
  });

  it("aligns episode persistence with the current episodes schema", async () => {
    const scriptPath = join(import.meta.dir, "..", "..", "scripts", "orchestrate-v5.ts");
    const text = await Bun.file(scriptPath).text();
    expect(text).toContain("duration_ms INTEGER");
    expect(text).toContain("INSERT INTO episodes (id,summary,outcome,happened_at,duration_ms,metadata)");
    expect(text).not.toContain("INSERT INTO episodes (summary,outcome,happened_at,entities,metadata)");
  });

  it("supports absolute bridge paths from the executor registry", async () => {
    const scriptPath = join(import.meta.dir, "..", "..", "scripts", "orchestrate-v5.ts");
    const text = await Bun.file(scriptPath).text();
    expect(text).toContain('ex.bridge.startsWith("/") ? ex.bridge : join(WORKSPACE, ex.bridge)');
  });

  it('treats persona "auto" as routeable instead of as a bridge-backed executor during preflight', async () => {
    const scriptPath = join(import.meta.dir, "..", "..", "scripts", "orchestrate-v5.ts");
    const text = await Bun.file(scriptPath).text();
    expect(text).toContain('if (task.persona && task.persona !== "auto") return task.persona;');
    expect(text).toContain("if (!effectiveExec) continue;");
  });
});
