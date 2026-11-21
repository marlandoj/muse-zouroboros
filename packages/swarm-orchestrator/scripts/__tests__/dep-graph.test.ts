import { test, expect, describe } from "bun:test";
import { buildDepGraph, type DepGraphResult, type DepGraphOptions } from "../dep-graph";
import { join } from "path";

const SWARM_SRC = join(import.meta.dir, "../../src");
// Scan the repository this test was checked out into. A hard-coded
// /home/workspace/zouroboros only resolves in the operator workspace and
// throws ENOENT on any CI-shaped checkout.
const REPO_ROOT = process.env.SWARM_REPO_ROOT || join(import.meta.dir, "../../../..");

describe("dep-graph", () => {
  let graph: DepGraphResult;

  test("builds graph for swarm/src", async () => {
    graph = await buildDepGraph({ path: SWARM_SRC });
    expect(graph.files.length).toBeGreaterThan(30);
    expect(graph.edges.length).toBeGreaterThan(30);
    expect(graph.root).toBe(SWARM_SRC);
  });

  test("ranks a well-connected hub at the head of the critical path", async () => {
    graph ??= await buildDepGraph({ path: SWARM_SRC });
    expect(graph.criticalPath.length).toBeGreaterThan(0);

    const top = graph.criticalPath[0]!;
    expect(top.dependentCount).toBeGreaterThan(10);

    // Descending by dependentCount, so the head is genuinely the most-depended-upon
    // module. Ranking between near-tied hubs shifts as the package grows; pinning a
    // filename here encodes a snapshot rather than the invariant.
    for (let i = 1; i < graph.criticalPath.length; i++) {
      expect(graph.criticalPath[i]!.dependentCount).toBeLessThanOrEqual(
        graph.criticalPath[i - 1]!.dependentCount
      );
    }
  });

  test("keeps types.ts among the critical-path hubs", async () => {
    graph ??= await buildDepGraph({ path: SWARM_SRC });
    const types = graph.criticalPath.find(e => e.file === "types.ts");
    expect(types).toBeDefined();
    expect(types!.dependentCount).toBeGreaterThan(10);
  });

  test("computes impact radius for specific files", async () => {
    const result = await buildDepGraph({
      path: SWARM_SRC,
      impactFiles: ["types.ts", "circuit/breaker.ts"],
    });
    expect(Object.keys(result.impactRadius).length).toBeGreaterThanOrEqual(1);
    const typesRadius = result.impactRadius["types.ts"];
    expect(typesRadius).toBeDefined();
    expect(typesRadius!.length).toBeGreaterThan(5);
  });

  test("detects no cycles in swarm/src", async () => {
    graph ??= await buildDepGraph({ path: SWARM_SRC });
    expect(graph.cycles.length).toBe(0);
  });

  test("identifies orphan files", async () => {
    graph ??= await buildDepGraph({ path: SWARM_SRC });
    expect(graph.orphans.length).toBeGreaterThan(0);
    for (const orphan of graph.orphans) {
      const hasEdge = graph.edges.some(e => e.from === orphan || e.to === orphan);
      expect(hasEdge).toBe(false);
    }
  });

  test("resolves .js → .ts imports", async () => {
    graph ??= await buildDepGraph({ path: SWARM_SRC });
    const bridgeEdge = graph.edges.find(
      e => e.from.includes("bridge-transport") && e.to === "types.ts"
    );
    expect(bridgeEdge).toBeDefined();
  });
});

describe("dep-graph preflight integration", () => {
  test("detects overlapping impact radii between tasks", async () => {
    const depGraph = await buildDepGraph({
      path: SWARM_SRC,
      impactFiles: ["types.ts", "transport/types.ts", "transport/bridge-transport.ts"],
    });

    const taskA = { id: "task-a", paths: ["types.ts"] };
    const taskB = { id: "task-b", paths: ["transport/types.ts", "transport/bridge-transport.ts"] };

    const radiusA = new Set(taskA.paths.flatMap(p => depGraph.impactRadius[p] || []));
    const radiusB = new Set(taskB.paths.flatMap(p => depGraph.impactRadius[p] || []));

    const aAffectsB = taskB.paths.some(p => radiusA.has(p));
    const bAffectsA = taskA.paths.some(p => radiusB.has(p));

    expect(aAffectsB).toBe(true);
    expect(bAffectsA).toBe(false);
  });

  test("does NOT flag independent tasks as conflicting", async () => {
    const depGraph = await buildDepGraph({
      path: SWARM_SRC,
      impactFiles: ["types.ts", "README.md"],
    });

    const taskA = { id: "task-a", paths: ["types.ts"] };
    const taskC = { id: "task-c", paths: ["README.md"] };

    const radiusA = new Set(taskA.paths.flatMap(p => depGraph.impactRadius[p] || []));
    const radiusC = new Set(taskC.paths.flatMap(p => depGraph.impactRadius[p] || []));

    const aAffectsC = taskC.paths.some(p => radiusA.has(p));
    const cAffectsA = taskA.paths.some(p => radiusC.has(p));

    expect(aAffectsC).toBe(false);
    expect(cAffectsA).toBe(false);
  });

  test("full monorepo scan completes under 5s", async () => {
    const start = Date.now();
    const result = await buildDepGraph({ path: REPO_ROOT });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(result.files.length).toBeGreaterThan(100);
    expect(result.edges.length).toBeGreaterThan(100);
    console.log(`  Monorepo: ${result.files.length} files, ${result.edges.length} edges in ${elapsed}ms`);
  });
});
