#!/usr/bin/env bun

import { describe, test, expect } from "bun:test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT = resolve(__dirname, "../../routing/swarm-decision-gate.ts");

interface GateResult {
  decision: "SWARM" | "DIRECT" | "SUGGEST" | "FORCE_SWARM";
  score: number;
  signals: Record<string, number>;
  override: string | null;
  performanceMs: number;
}

async function runGate(message: string): Promise<GateResult> {
  const proc = Bun.spawn(["bun", GATE_SCRIPT, "--json", message], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(stdout);
}

describe("Swarm Decision Gate", () => {
  describe("DIRECT — tasks that should NOT trigger swarm", () => {
    test("simple question", async () => {
      const r = await runGate("What time is it in Phoenix?");
      expect(r.decision).toBe("DIRECT");
      expect(r.score).toBeLessThan(0.1);
    });

    test("single file fix", async () => {
      const r = await runGate("Fix the TypeScript error in bot-engine.ts line 42");
      expect(r.decision).toBe("DIRECT");
      expect(r.score).toBeLessThan(0.1);
    });

    test("conversational response", async () => {
      const r = await runGate("How does the memory gate work?");
      expect(r.decision).toBe("DIRECT");
    });

    test("single-step deployment", async () => {
      const r = await runGate("Restart the trading service");
      expect(r.decision).toBe("DIRECT");
    });

    test("simple lookup", async () => {
      const r = await runGate("Show me the current git status");
      expect(r.decision).toBe("DIRECT");
    });

    test("quick keyword with complex-sounding content", async () => {
      const r = await runGate("Just quickly check if the tests pass");
      expect(r.decision).toBe("DIRECT");
      expect(r.override).toBe("bias_direct");
    });
  });

  describe("SUGGEST — tasks where swarm adds value but isn't mandatory", () => {
    test("research + structured deliverable", async () => {
      const r = await runGate(
        "Deep dive into the everything-claude-code repository. Catalogue all agents, skills, hooks, and architectural patterns. Cross-reference each against the Zouroboros ecosystem to identify gaps. Generate a prioritized gap matrix with effort estimates. Compile into a PDF report and email it to me."
      );
      expect(["SUGGEST", "SWARM"]).toContain(r.decision);
      expect(r.score).toBeGreaterThan(0.35);
    });

    test("multi-domain implementation", async () => {
      const r = await runGate(
        "Implement a new authentication system across the API, frontend dashboard, and database schema. Create migration scripts, update all route handlers, add test coverage for each endpoint, deploy to production, and send a comprehensive report with benchmark results via email."
      );
      expect(["SUGGEST", "SWARM"]).toContain(r.decision);
      expect(r.score).toBeGreaterThan(0.50);
    });

    test("multi-step analysis with comparison", async () => {
      const r = await runGate(
        "Audit the entire Zouroboros ecosystem for security vulnerabilities. Scan each package, review authentication flows, test API endpoints, and generate a comprehensive security report with remediation priorities."
      );
      expect(["SUGGEST", "SWARM"]).toContain(r.decision);
      expect(r.score).toBeGreaterThan(0.35);
    });
  });

  describe("SWARM — tasks that should auto-trigger swarm pipeline", () => {
    test("massive cross-system overhaul", async () => {
      const r = await runGate(
        "Migrate the entire platform from SQLite to PostgreSQL. Update all database schemas, migration scripts, and ORM queries across the API server, task orchestrator, and memory system. Create integration tests for each service, update CI pipeline configuration, deploy to staging, run benchmark comparisons, and compile a comprehensive migration report with rollback procedures."
      );
      expect(r.decision).toBe("SWARM");
      expect(r.score).toBeGreaterThan(0.55);
    });

    test("multi-service implementation with full pipeline", async () => {
      const r = await runGate(
        "Build a complete notification system: design the database schema, implement the API endpoints, create the frontend dashboard components, integrate email and SMS delivery services, write end-to-end test coverage, configure CI/CD pipeline, deploy all services to production, and send a detailed architecture report."
      );
      expect(["SWARM", "SUGGEST"]).toContain(r.decision);
      expect(r.score).toBeGreaterThan(0.50);
    });
  });

  describe("Override detection", () => {
    test("'use swarm orchestration' forces SWARM", async () => {
      const r = await runGate("Use swarm orchestration to analyze this repo");
      expect(r.decision).toBe("FORCE_SWARM");
      expect(r.override).toBe("force_swarm");
    });

    test("'swarm this' forces SWARM", async () => {
      const r = await runGate("Swarm this task");
      expect(r.decision).toBe("FORCE_SWARM");
      expect(r.override).toBe("force_swarm");
    });

    test("'run through the swarm' forces SWARM", async () => {
      const r = await runGate("Run this through the swarm pipeline");
      expect(r.decision).toBe("FORCE_SWARM");
      expect(r.override).toBe("force_swarm");
    });

    test("'just' biases toward DIRECT", async () => {
      const r = await runGate("Just update the README with the new API docs");
      expect(r.override).toBe("bias_direct");
    });

    test("'quick' biases toward DIRECT", async () => {
      const r = await runGate("Quick review of the PR changes");
      expect(r.override).toBe("bias_direct");
    });
  });

  describe("Signal accuracy", () => {
    test("parallelism detects multiple action verbs", async () => {
      const r = await runGate("Implement the feature, test it, deploy it, and document it");
      expect(r.signals.parallelism).toBeGreaterThan(0.2);
    });

    test("scopeBreadth detects multiple domains", async () => {
      const r = await runGate("Update the database schema, API endpoint, and frontend component");
      expect(r.signals.scopeBreadth).toBeGreaterThanOrEqual(0.3);
    });

    test("qualityGates detects testing requirements", async () => {
      const r = await runGate("Make sure all tests pass and the build is green before deploying");
      expect(r.signals.qualityGates).toBeGreaterThanOrEqual(0.3);
    });

    test("mutationRisk detects production deployment", async () => {
      const r = await runGate("Deploy the updated service to production");
      expect(r.signals.mutationRisk).toBeGreaterThan(0.2);
    });

    test("deliverableComplexity detects multiple artifacts", async () => {
      const r = await runGate("Create a detailed report with charts, generate a PDF document, then email it to me along with a summary");
      expect(r.signals.deliverableComplexity).toBeGreaterThan(0.3);
    });
  });

  describe("Performance", () => {
    test("completes in under 50ms", async () => {
      const r = await runGate("A moderately complex task involving multiple systems");
      expect(r.performanceMs).toBeLessThan(50);
    });
  });

  describe("Exit codes", () => {
    test("SWARM/FORCE_SWARM exits 0", async () => {
      const proc = Bun.spawn(["bun", GATE_SCRIPT, "Use swarm orchestration to do this"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(code).toBe(0);
    });

    test("DIRECT exits 2", async () => {
      const proc = Bun.spawn(["bun", GATE_SCRIPT, "What time is it?"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(code).toBe(2);
    });

    test("SUGGEST exits 3", async () => {
      const proc = Bun.spawn(["bun", GATE_SCRIPT, "Research MAGMA, MemEvolve, and Supermemory - compare with zo-memory"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(code).toBe(3);
    });
  });
});
