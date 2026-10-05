import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type TypeScript from "typescript";
import {
  FACTORY_STATE_MARKER,
  FACTORY_STATE_NAMESPACE,
  FACTORY_STATE_SCHEMA_VERSION,
} from "./factory-state-root";

const typescriptModule = await import(process.env.FACTORY_TYPESCRIPT_MODULE ?? "typescript");
const ts = (typescriptModule.default ?? typescriptModule) as typeof TypeScript;

const roots: string[] = [];
const repositoryRoot = resolve(import.meta.dir, "../../..");
const registryPath = resolve(import.meta.dir, "../config/factory-state-owners-v1.json");

type Registry = {
  owner_count: number;
  owners: Array<{
    path: string;
    group: "critical" | "subsystem" | "observer";
    access: "read_only" | "read_write";
    subpaths: string[];
    locking: string;
  }>;
};

function sourceFile(path: string): TypeScript.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function directStateConstructions(file: TypeScript.SourceFile): string[] {
  const findings: string[] = [];
  const visit = (node: TypeScript.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (callee === "join" || callee === "resolve") {
        const hasStateLiteral = node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === "state");
        const text = node.getText(file);
        if (hasStateLiteral && /import\.meta|PROJECT|FACTORY|RUNTIME|ROOT|DIR|base/i.test(text)) {
          findings.push(`${basename(file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}:${text}`);
        }
      }
    }
    if (ts.isStringLiteral(node) && /factory-conveyor.*Projects\/zouroboros-software-factory\/state/.test(node.text)) {
      findings.push(`${basename(file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}:${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

function writeMarker(root: string): void {
  writeFileSync(join(root, FACTORY_STATE_MARKER), `${JSON.stringify({
    namespace: FACTORY_STATE_NAMESPACE,
    schema_version: FACTORY_STATE_SCHEMA_VERSION,
    root_id: "c75f9077-354d-4b25-b0fb-c7d0914511b5",
    canonical_path: root,
    generation: 1,
    device: statSync(root).dev,
    created_at: "2026-08-11T00:00:00.000Z",
  })}\n`);
}

function runWorker(runtimeRoot: string, stateRoot: string, action: string): unknown {
  const proc = Bun.spawnSync([process.execPath, join(runtimeRoot, "worker.ts"), action], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      FACTORY_STATE_MODE: "production",
      FACTORY_STATE_DIR: stateRoot,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  expect(proc.exitCode, stderr || stdout).toBe(0);
  return JSON.parse(stdout);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("factory state ownership boundary", () => {
  test("registry exactly covers all inventoried owners and every owner uses the helper", () => {
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
    expect(registry.owner_count).toBe(71);
    expect(registry.owners).toHaveLength(71);
    expect(new Set(registry.owners.map((owner) => owner.path)).size).toBe(71);

    for (const owner of registry.owners) {
      expect(["critical", "subsystem", "observer"]).toContain(owner.group);
      expect(["read_only", "read_write"]).toContain(owner.access);
      expect(owner.subpaths.length).toBeGreaterThan(0);
      expect(owner.locking.length).toBeGreaterThan(0);
      const source = readFileSync(join(repositoryRoot, owner.path), "utf8");
      expect(source).toContain('from "./factory-state-root"');
      expect(source).toMatch(/factoryState(?:Path|Root|PathForProject)|resolveFactoryStateOverride/);
      expect(directStateConstructions(sourceFile(join(repositoryRoot, owner.path)))).toEqual([]);
    }
  });

  test("AST audit finds no unregistered production runtime-relative state owner", () => {
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
    const registered = new Set(registry.owners.map((owner) => basename(owner.path)));
    const allowed = new Set(["factory-state-root.ts", "factory-state-migrate.ts", "factory-package-cli.ts"]);
    const findings: string[] = [];
    for (const name of readdirSync(import.meta.dir).filter((entry) => entry.endsWith(".ts")).sort()) {
      if (registered.has(name) || allowed.has(name) || name.includes(".test.") || name.includes("selftest")) continue;
      findings.push(...directStateConstructions(sourceFile(join(import.meta.dir, name))));
    }
    expect(findings).toEqual([]);
  });

  test("helper import is lazy and does not require a production root", () => {
    const env = { ...process.env };
    delete env.FACTORY_STATE_DIR;
    delete env.FACTORY_STATE_MODE;
    const proc = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(resolve(import.meta.dir, "factory-state-root.ts"))})`], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
  });

  test("two detached runtime roots preserve representative state across processes and restart", () => {
    const parent = mkdtempSync(join(tmpdir(), "factory-state-boundary-"));
    roots.push(parent);
    const stateRoot = join(parent, "state");
    const runtimeA = join(parent, "runtime-a", "Projects/zouroboros-software-factory/scripts");
    const runtimeB = join(parent, "runtime-b", "Projects/zouroboros-software-factory/scripts");
    mkdirSync(stateRoot);
    for (const runtime of [runtimeA, runtimeB]) {
      mkdirSync(runtime, { recursive: true });
      const transport = resolve(runtime, '../../../packages/swarm/src/transport');
      mkdirSync(transport, { recursive: true });
      copyFileSync(resolve(repositoryRoot, 'packages/swarm/src/transport/factory-path-profile.ts'), join(transport, 'factory-path-profile.ts'));
    }
    writeMarker(stateRoot);

    const worker = `
      import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      import { factoryStatePath } from "./factory-state-root";
      const files = {
        dedup: factoryStatePath("dedup", "operations.json"),
        execution: factoryStatePath("executions", "exec-open.json"),
        lane: factoryStatePath("lane", "halt.sentinel"),
        shipping: factoryStatePath("ship-ready", "fingerprints.jsonl"),
        approval: factoryStatePath("approval-ledger.jsonl"),
        hold: factoryStatePath("holds", "hold.json"),
        pool: factoryStatePath("pool", "queue.json"),
        audit: factoryStatePath("audit", "events.jsonl"),
      };
      for (const path of Object.values(files)) mkdirSync(dirname(path), { recursive: true });
      const action = process.argv[2];
      if (action === "seed") {
        writeFileSync(files.dedup, JSON.stringify({ ids: ["op-1"] }));
        writeFileSync(files.execution, JSON.stringify({ id: "exec-open", status: "executing" }));
        writeFileSync(files.lane, "halted\\n");
        appendFileSync(files.shipping, JSON.stringify({ fingerprint: "ship-1" }) + "\\n");
        appendFileSync(files.approval, JSON.stringify({ execution_id: "exec-open", decision: "approved" }) + "\\n");
        writeFileSync(files.hold, JSON.stringify({ issue: "ZOU-1", active: true }));
        writeFileSync(files.pool, JSON.stringify([{ id: "exec-open", state: "claimed" }]));
        appendFileSync(files.audit, JSON.stringify({ event: "seed" }) + "\\n");
      } else if (action === "continue") {
        const dedup = JSON.parse(readFileSync(files.dedup, "utf8"));
        if (!dedup.ids.includes("op-1")) dedup.ids.push("op-1");
        writeFileSync(files.dedup, JSON.stringify(dedup));
        appendFileSync(files.approval, JSON.stringify({ execution_id: "exec-open", decision: "confirmed" }) + "\\n");
        appendFileSync(files.audit, JSON.stringify({ event: "continue" }) + "\\n");
      }
      const lines = (path) => readFileSync(path, "utf8").trim().split("\\n").filter(Boolean).length;
      console.log(JSON.stringify({
        dedup: JSON.parse(readFileSync(files.dedup, "utf8")).ids,
        execution: JSON.parse(readFileSync(files.execution, "utf8")).status,
        lane: readFileSync(files.lane, "utf8").trim(),
        shipping: lines(files.shipping),
        approval: lines(files.approval),
        hold: JSON.parse(readFileSync(files.hold, "utf8")).active,
        pool: JSON.parse(readFileSync(files.pool, "utf8"))[0].state,
        audit: lines(files.audit),
      }));
    `;

    for (const runtime of [runtimeA, runtimeB]) {
      copyFileSync(resolve(import.meta.dir, "factory-state-root.ts"), join(runtime, "factory-state-root.ts"));
      writeFileSync(join(runtime, "worker.ts"), worker);
    }

    expect(runWorker(runtimeA, stateRoot, "seed")).toMatchObject({ approval: 1, audit: 1 });
    expect(runWorker(runtimeB, stateRoot, "continue")).toMatchObject({ dedup: ["op-1"], approval: 2, audit: 2 });
    expect(runWorker(runtimeA, stateRoot, "verify")).toEqual({
      dedup: ["op-1"],
      execution: "executing",
      lane: "halted",
      shipping: 1,
      approval: 2,
      hold: true,
      pool: "claimed",
      audit: 2,
    });
  });
});
