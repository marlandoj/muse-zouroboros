#!/usr/bin/env bun
/**
 * register.ts — Manage the executor registry.
 *
 * Subcommands:
 *   list                    — List all registered executors
 *   validate                — Validate registry schema
 *   add <json-file>         — Add an executor from a JSON file
 *   remove <id>             — Remove an executor by ID
 *
 * Usage:
 *   bun register.ts list
 *   bun register.ts validate
 *   bun register.ts add new-executor.json
 *   bun register.ts remove my-executor
 */

import { readFileSync, writeFileSync } from "fs";
import { resolveExecutorRegistryPath } from "../registry/loader";
import type { ExecutorRegistry, ExecutorEntry } from "./types/executor";

const REGISTRY_PATH = resolveExecutorRegistryPath();

function loadRegistry(): ExecutorRegistry {
  const raw = readFileSync(REGISTRY_PATH, "utf-8");
  return JSON.parse(raw);
}

function saveRegistry(registry: ExecutorRegistry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

function cmdList(): void {
  const registry = loadRegistry();
  console.log(`\n  Executor Registry: ${REGISTRY_PATH}`);
  console.log(`  Executors: ${registry.executors.length}\n`);

  for (const e of registry.executors) {
    console.log(`  ${e.id}`);
    console.log(`    Name:    ${e.name}`);
    console.log(`    Bridge:  ${e.bridge}`);
    console.log(`    Timeout: ${e.config.defaultTimeout}s`);
    console.log(`    Tags:    ${e.expertise.join(", ")}`);
    console.log();
  }
}

function cmdValidate(): void {
  const registry = loadRegistry();
  const errors: string[] = [];

  if (!registry.$schema) errors.push("Missing $schema field");
  if (!Array.isArray(registry.executors)) errors.push("executors must be an array");

  const ids = new Set<string>();
  for (const e of registry.executors) {
    if (!e.id) errors.push("Executor missing id");
    if (ids.has(e.id)) errors.push(`Duplicate id: ${e.id}`);
    ids.add(e.id);

    if ((e.transport ?? "bridge") === "bridge" && !e.bridge) {
      errors.push(`${e.id}: bridge transport requires a bridge path`);
    }
    if (e.transport === "acp" && !e.acp?.adapterBin) {
      errors.push(`${e.id}: ACP transport requires acp.adapterBin`);
    }
    if (e.executor !== "local") errors.push(`${e.id}: executor must be "local"`);
    if (!e.config?.defaultTimeout) errors.push(`${e.id}: missing config.defaultTimeout`);
    if (!e.healthCheck?.command) errors.push(`${e.id}: missing healthCheck.command`);
    if (!Array.isArray(e.expertise)) errors.push(`${e.id}: expertise must be an array`);
    if (!Array.isArray(e.best_for)) errors.push(`${e.id}: best_for must be an array`);
  }

  if (errors.length === 0) {
    console.log(`\n  ✓ Registry valid (${registry.executors.length} executors)\n`);
  } else {
    console.error(`\n  ✗ Registry has ${errors.length} errors:\n`);
    for (const err of errors) console.error(`    - ${err}`);
    console.log();
    process.exit(1);
  }
}

function cmdAdd(jsonPath: string): void {
  const registry = loadRegistry();
  const raw = readFileSync(jsonPath, "utf-8");
  const entry: ExecutorEntry = JSON.parse(raw);

  if (!entry.id) {
    console.error("Error: executor JSON must have an 'id' field");
    process.exit(1);
  }

  if (registry.executors.find((e) => e.id === entry.id)) {
    console.error(`Error: executor '${entry.id}' already exists. Remove it first.`);
    process.exit(1);
  }

  registry.executors.push(entry);
  saveRegistry(registry);
  console.log(`\n  ✓ Added executor: ${entry.id} (${entry.name})\n`);
}

function cmdRemove(id: string): void {
  const registry = loadRegistry();
  const idx = registry.executors.findIndex((e) => e.id === id);

  if (idx === -1) {
    console.error(`Error: executor '${id}' not found`);
    console.error(`Available: ${registry.executors.map((e) => e.id).join(", ")}`);
    process.exit(1);
  }

  const removed = registry.executors.splice(idx, 1)[0];
  saveRegistry(registry);
  console.log(`\n  ✓ Removed executor: ${removed.id} (${removed.name})\n`);
}

// --- Main ---

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "list":
    cmdList();
    break;
  case "validate":
    cmdValidate();
    break;
  case "add":
    if (!rest[0]) {
      console.error("Usage: bun register.ts add <path-to-executor.json>");
      process.exit(1);
    }
    cmdAdd(rest[0]);
    break;
  case "remove":
    if (!rest[0]) {
      console.error("Usage: bun register.ts remove <executor-id>");
      process.exit(1);
    }
    cmdRemove(rest[0]);
    break;
  default:
    console.log(`
  Usage: bun register.ts <command>

  Commands:
    list       List all registered executors
    validate   Validate registry schema
    add <file> Add an executor from a JSON file
    remove <id> Remove an executor by ID
`);
    process.exit(cmd ? 1 : 0);
}
