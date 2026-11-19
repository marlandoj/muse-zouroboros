#!/usr/bin/env bun
/**
 * Swarm Configuration Manager
 * Manage default settings and persona registry
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const CONFIG_DIR = join(__dirname, "..");
const CONFIG_FILE = join(CONFIG_DIR, ".swarm-config.json");
const REGISTRY_FILE = join(CONFIG_DIR, "assets/persona-registry.json");

interface SwarmConfig {
  defaultPersonas: string[];
  concurrency: number;
  timeoutSeconds: number;
  defaultFormat: string;
}

const DEFAULT_CONFIG: SwarmConfig = {
  defaultPersonas: [],
  concurrency: 4,
  timeoutSeconds: 120,
  defaultFormat: "markdown"
};

async function loadConfig(): Promise<SwarmConfig> {
  if (!existsSync(CONFIG_FILE)) {
    return DEFAULT_CONFIG;
  }
  const content = await readFile(CONFIG_FILE, "utf-8");
  return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
}

async function saveConfig(config: SwarmConfig) {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function loadRegistry() {
  if (!existsSync(REGISTRY_FILE)) {
    return { personas: [] };
  }
  const content = await readFile(REGISTRY_FILE, "utf-8");
  return JSON.parse(content);
}

async function showConfig() {
  const config = await loadConfig();
  const registry = await loadRegistry();
  
  console.log(`
╔══════════════════════════════════════════════════════════╗
║           SWARM ORCHESTRATOR CONFIGURATION               ║
╚══════════════════════════════════════════════════════════╝

Current Settings:
  Default Personas: ${config.defaultPersonas.join(", ") || "(none)"}
  Concurrency:      ${config.concurrency}
  Timeout:          ${config.timeoutSeconds}s
  Default Format:   ${config.defaultFormat}

Registered Personas (${registry.personas.length}):
${registry.personas.map((p: any) => `  • ${p.id}: ${p.name}
    Expertise: ${p.expertise.join(", ")}`).join("\n")}

Config File: ${CONFIG_FILE}
`);
}

async function setDefaultPersonas(personas: string) {
  const config = await loadConfig();
  config.defaultPersonas = personas.split(",").map(p => p.trim());
  await saveConfig(config);
  console.log(`✅ Default personas set to: ${config.defaultPersonas.join(", ")}`);
}

async function setConcurrency(value: string) {
  const config = await loadConfig();
  config.concurrency = parseInt(value);
  await saveConfig(config);
  console.log(`✅ Concurrency set to: ${config.concurrency}`);
}

async function setTimeout(value: string) {
  const config = await loadConfig();
  config.timeoutSeconds = parseInt(value);
  await saveConfig(config);
  console.log(`✅ Timeout set to: ${config.timeoutSeconds}s`);
}

async function addPersona(
  id: string,
  name: string,
  expertise: string,
  bestFor: string
) {
  const registry = await loadRegistry();
  
  // Check if persona already exists
  const existingIndex = registry.personas.findIndex((p: any) => p.id === id);
  
  const newPersona = {
    id,
    name,
    expertise: expertise.split(",").map(e => e.trim()),
    best_for: bestFor.split(",").map(b => b.trim())
  };
  
  if (existingIndex >= 0) {
    registry.personas[existingIndex] = newPersona;
    console.log(`✅ Updated persona: ${id}`);
  } else {
    registry.personas.push(newPersona);
    console.log(`✅ Added persona: ${id}`);
  }
  
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

async function removePersona(id: string) {
  const registry = await loadRegistry();
  const initialLength = registry.personas.length;
  registry.personas = registry.personas.filter((p: any) => p.id !== id);
  
  if (registry.personas.length < initialLength) {
    await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
    console.log(`✅ Removed persona: ${id}`);
  } else {
    console.log(`❌ Persona not found: ${id}`);
  }
}

async function listPersonas() {
  const registry = await loadRegistry();
  
  console.log(`
╔══════════════════════════════════════════════════════════╗
║              REGISTERED PERSONAS                         ║
╚══════════════════════════════════════════════════════════╝
`);
  
  registry.personas.forEach((p: any) => {
    console.log(`
${p.name} (${p.id})
  Expertise: ${p.expertise.join(", ")}
  Best For:  ${p.best_for.join(", ")}
`);
  });
}

// Main
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes("--help")) {
    console.log(`
Swarm Configuration Manager

Usage: bun swarm-config.ts <command> [options]

Commands:
  --show                        Show current configuration
  --set-default-personas <list> Set default personas (comma-separated)
  --set-concurrency <num>       Set max parallel local executors
  --set-timeout <seconds>       Set default timeout
  --add-persona <id> <name> <expertise> <best_for>
                                Add or update a persona
  --remove-persona <id>         Remove a persona
  --list-personas               List all registered personas
  --help                        Show this help

Examples:
  bun swarm-config.ts --show
  bun swarm-config.ts --set-default-personas "financial-advisor,research-analyst"
  bun swarm-config.ts --set-concurrency 4
  bun swarm-config.ts --add-persona health-coach "Health Coach" "wellness,nutrition" "health plans,diet advice"
`);
    return;
  }
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    
    switch (arg) {
      case "--show":
        await showConfig();
        return;
        
      case "--set-default-personas":
        if (nextArg) {
          await setDefaultPersonas(nextArg);
          i++;
        }
        break;
        
      case "--set-concurrency":
        if (nextArg) {
          await setConcurrency(nextArg);
          i++;
        }
        break;
        
      case "--set-timeout":
        if (nextArg) {
          await setTimeout(nextArg);
          i++;
        }
        break;
        
      case "--add-persona":
        if (args[i + 4]) {
          await addPersona(args[i + 1], args[i + 2], args[i + 3], args[i + 4]);
          i += 4;
        }
        break;
        
      case "--remove-persona":
        if (nextArg) {
          await removePersona(nextArg);
          i++;
        }
        break;
        
      case "--list-personas":
        await listPersonas();
        return;
    }
  }
}

main().catch(console.error);
