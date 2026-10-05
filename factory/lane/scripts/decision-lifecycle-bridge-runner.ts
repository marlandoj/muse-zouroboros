#!/usr/bin/env bun
import * as fs from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  parseDecisionLifecycleShadowObservation,
  resolveDecisionLifecycleBridgeMode,
  runDecisionLifecycleBridge,
  type DecisionLifecycleBridgeDisposition,
  type DecisionLifecycleBridgeMode,
  type DecisionLifecycleShadowObservation,
} from "./decision-lifecycle-bridge-contract.ts";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

export type DecisionLifecycleLedgerAction = "off" | "not-recorded" | "appended" | "duplicate";

export interface DecisionLifecycleShadowRunnerResult {
  mode: DecisionLifecycleBridgeMode;
  disposition: DecisionLifecycleBridgeDisposition;
  observation: DecisionLifecycleShadowObservation | null;
  reasons: string[];
  ledger_action: DecisionLifecycleLedgerAction;
}

function assertCanonicalAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be a canonical absolute path`);
}

function assertSafeLedgerFile(ledgerPath: string): void {
  assertCanonicalAbsolutePath(ledgerPath, "decision lifecycle ledger path");
  if (!fs.existsSync(ledgerPath)) return;
  const stat = fs.lstatSync(ledgerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("decision lifecycle ledger must be a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("decision lifecycle ledger permissions must be private");
}

function ensureSafeLedgerParent(ledgerPath: string): void {
  const parent = dirname(ledgerPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent) {
    throw new Error("decision lifecycle ledger parent must be a canonical real directory");
  }
}

function sleepSync(milliseconds: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {}
  }
}

function lockOwnerIsAlive(lockPath: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(raw.pid) || Number(raw.pid) <= 0) return true;
    process.kill(Number(raw.pid), 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function acquireLedgerLock(lockPath: string): number {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    let descriptor: number;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
        if (stale && !lockOwnerIsAlive(lockPath)) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw new Error(`decision lifecycle ledger lock timeout: ${lockPath}`);
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      fs.fsyncSync(descriptor);
      return descriptor;
    } catch (error) {
      fs.closeSync(descriptor);
      try {
        fs.unlinkSync(lockPath);
      } catch {}
      throw error;
    }
  }
}

function releaseLedgerLock(lockPath: string, descriptor: number): void {
  fs.closeSync(descriptor);
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function readDecisionLifecycleShadowLedger(ledgerPath: string): DecisionLifecycleShadowObservation[] {
  assertSafeLedgerFile(ledgerPath);
  if (!fs.existsSync(ledgerPath)) return [];
  const contents = fs.readFileSync(ledgerPath, "utf8");
  if (contents.length === 0) return [];
  if (!contents.endsWith("\n")) throw new Error("decision lifecycle ledger has a truncated final row");
  const observations: DecisionLifecycleShadowObservation[] = [];
  const dedupeKeys = new Set<string>();
  for (const [index, line] of contents.slice(0, -1).split("\n").entries()) {
    if (line.length === 0) throw new Error(`decision lifecycle ledger has an empty row at line ${index + 1}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`decision lifecycle ledger has invalid JSON at line ${index + 1}`);
    }
    const observation = parseDecisionLifecycleShadowObservation(parsed);
    if (JSON.stringify(observation) !== line) {
      throw new Error(`decision lifecycle ledger row ${index + 1} is not canonical`);
    }
    if (dedupeKeys.has(observation.dedupe_key)) {
      throw new Error(`decision lifecycle ledger repeats dedupe key at line ${index + 1}`);
    }
    dedupeKeys.add(observation.dedupe_key);
    observations.push(observation);
  }
  return observations;
}

function appendObservation(
  ledgerPath: string,
  observation: DecisionLifecycleShadowObservation,
): { action: "appended" | "duplicate"; observation: DecisionLifecycleShadowObservation } {
  assertCanonicalAbsolutePath(ledgerPath, "decision lifecycle ledger path");
  const canonical = parseDecisionLifecycleShadowObservation(observation);
  ensureSafeLedgerParent(ledgerPath);
  assertSafeLedgerFile(ledgerPath);
  const lockPath = `${ledgerPath}.lock`;
  const descriptor = acquireLedgerLock(lockPath);
  try {
    const existing = readDecisionLifecycleShadowLedger(ledgerPath).find(
      (entry) => entry.dedupe_key === canonical.dedupe_key,
    );
    if (existing) return { action: "duplicate", observation: existing };
    const ledger = fs.openSync(
      ledgerPath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.fchmodSync(ledger, 0o600);
      fs.writeSync(ledger, `${JSON.stringify(canonical)}\n`);
      fs.fsyncSync(ledger);
    } finally {
      fs.closeSync(ledger);
    }
    return { action: "appended", observation: canonical };
  } finally {
    releaseLedgerLock(lockPath, descriptor);
  }
}

export function runDecisionLifecycleShadowRunner(
  mode: DecisionLifecycleBridgeMode,
  loadInput: () => unknown,
  ledgerPath: string,
): DecisionLifecycleShadowRunnerResult {
  const result = runDecisionLifecycleBridge(mode, loadInput);
  if (result.mode === "off") {
    return { ...result, ledger_action: "off" };
  }
  if (!result.observation) {
    return { ...result, ledger_action: "not-recorded" };
  }
  const ledger = appendObservation(ledgerPath, result.observation);
  return {
    mode: "shadow",
    disposition: ledger.observation.disposition,
    observation: ledger.observation,
    reasons: ledger.observation.reasons,
    ledger_action: ledger.action,
  };
}

function readJson(path: string): unknown {
  assertCanonicalAbsolutePath(path, "decision lifecycle request path");
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("decision lifecycle request must be a regular file");
  return JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
}

export function runDecisionLifecycleShadowCli(args = process.argv.slice(2)): number {
  const mode = resolveDecisionLifecycleBridgeMode();
  if (mode === "off") return 0;
  const { values } = parseArgs({
    args,
    options: {
      request: { type: "string" },
      ledger: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.request) throw new Error("--request is required in shadow mode");
  if (!values.ledger) throw new Error("--ledger is required in shadow mode");
  assertCanonicalAbsolutePath(values.request, "decision lifecycle request path");
  assertCanonicalAbsolutePath(values.ledger, "decision lifecycle ledger path");
  const result = runDecisionLifecycleShadowRunner(mode, () => readJson(values.request!), values.ledger);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = runDecisionLifecycleShadowCli();
