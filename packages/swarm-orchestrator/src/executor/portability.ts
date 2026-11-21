import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutorRegistryEntry } from '../types.js';
import { findExecutor, loadRegistry } from '../registry/loader.js';

export type PortableTool = 'read' | 'write' | 'shell' | 'web' | 'mcp';
export type HarnessId = 'claude-code' | 'codex' | 'gemini' | 'hermes' | 'kimi' | 'opencode' | 'pi';

interface HarnessOverlay {
  transport: 'acp' | 'bridge';
  instructionFile: string;
}

interface HarnessDefinition {
  executorId: string;
  aliases: string[];
  environmentSignals: string[];
  processSignals: string[];
  overlay: HarnessOverlay;
  tools: Record<PortableTool, string | null>;
}

export interface HarnessContract {
  $schema: 'harness-portability/v1';
  version: 1;
  detectionOrder: ['explicit', 'environment', 'process'];
  harnesses: Record<HarnessId, HarnessDefinition>;
}

export interface HarnessDetectionInput {
  explicitHarness?: string;
  env?: Record<string, string | undefined>;
  argv?: string[];
}

export interface ResolvedPortableHarness {
  id: HarnessId;
  contractVersion: 1;
  executor: ExecutorRegistryEntry;
  overlay: HarnessOverlay;
  tools: Record<PortableTool, string | null>;
}

export interface PortableHarnessInventoryEntry {
  id: HarnessId;
  executorId: string;
  executorName: string;
  executorClass: 'local' | 'remote';
  transport: 'acp' | 'bridge';
  instructionFile: string;
  tools: Record<PortableTool, string | null>;
  capabilities: {
    read: boolean;
    write: boolean;
    shell: boolean;
    web: boolean;
    mcp: boolean;
  };
  adapterSha256: string;
}

export interface PortableHarnessInventory {
  schema: 'harness-adapter-inventory/v1';
  contractVersion: 1;
  entries: PortableHarnessInventoryEntry[];
  inventorySha256: string;
}

// RB-8 (2026-09-07): live VPS harness set — kimi/opencode/pi added; cursor dropped (removed on VPS).
export const PORTABLE_HARNESS_IDS: readonly HarnessId[] = ['claude-code', 'codex', 'gemini', 'hermes', 'kimi', 'opencode', 'pi'];
const TOP_LEVEL_KEYS = new Set(['$schema', 'version', 'detectionOrder', 'harnesses']);
const HARNESS_KEYS = new Set(['executorId', 'aliases', 'environmentSignals', 'processSignals', 'overlay', 'tools']);
const OVERLAY_KEYS = new Set(['transport', 'instructionFile']);
const TOOL_KEYS: PortableTool[] = ['read', 'write', 'shell', 'web', 'mcp'];
const DEFAULT_CONTRACT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'registry', 'harness-contract.json');

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function assertKeys(value: Record<string, unknown>, allowed: Set<string>, context: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${context} contains unknown fields: ${unknown.join(', ')}`);
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${context} must be a non-empty string array`);
  }
  return value;
}

export function validateHarnessContract(value: unknown): HarnessContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Harness contract must be an object');
  const raw = value as Record<string, unknown>;
  assertKeys(raw, TOP_LEVEL_KEYS, 'Harness contract');
  if (raw.$schema !== 'harness-portability/v1' || raw.version !== 1) throw new Error('Unsupported harness contract version');
  if (JSON.stringify(raw.detectionOrder) !== JSON.stringify(['explicit', 'environment', 'process'])) {
    throw new Error('Harness detection precedence must be explicit, environment, process');
  }
  if (!raw.harnesses || typeof raw.harnesses !== 'object' || Array.isArray(raw.harnesses)) {
    throw new Error('Harness contract is missing harnesses');
  }
  const harnesses = raw.harnesses as Record<string, unknown>;
  const ids = Object.keys(harnesses).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...PORTABLE_HARNESS_IDS].sort())) {
    throw new Error(`Harness contract must define exactly ${PORTABLE_HARNESS_IDS.length} supported harnesses`);
  }
  for (const id of PORTABLE_HARNESS_IDS) {
    const definition = harnesses[id];
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`Invalid harness: ${id}`);
    const item = definition as Record<string, unknown>;
    assertKeys(item, HARNESS_KEYS, `Harness ${id}`);
    if (item.executorId !== id) throw new Error(`Harness ${id} must map to executor ${id}`);
    stringArray(item.aliases, `${id}.aliases`);
    stringArray(item.environmentSignals, `${id}.environmentSignals`);
    stringArray(item.processSignals, `${id}.processSignals`);
    if (!item.overlay || typeof item.overlay !== 'object' || Array.isArray(item.overlay)) throw new Error(`Invalid overlay for ${id}`);
    const overlay = item.overlay as Record<string, unknown>;
    assertKeys(overlay, OVERLAY_KEYS, `Harness ${id} overlay`);
    if (!['acp', 'bridge'].includes(String(overlay.transport)) || typeof overlay.instructionFile !== 'string') {
      throw new Error(`Invalid overlay values for ${id}`);
    }
    if (!item.tools || typeof item.tools !== 'object' || Array.isArray(item.tools)) throw new Error(`Invalid tool map for ${id}`);
    const tools = item.tools as Record<string, unknown>;
    if (JSON.stringify(Object.keys(tools).sort()) !== JSON.stringify([...TOOL_KEYS].sort())) throw new Error(`Tool map for ${id} is incomplete`);
    for (const tool of TOOL_KEYS) {
      if (tools[tool] !== null && (typeof tools[tool] !== 'string' || tools[tool] === '')) throw new Error(`Invalid ${tool} tool for ${id}`);
    }
  }
  return value as HarnessContract;
}

export function loadHarnessContract(path = DEFAULT_CONTRACT_PATH): HarnessContract {
  const resolved = isAbsolute(path) ? path : join(process.cwd(), path);
  if (!existsSync(resolved)) throw new Error(`Harness contract not found: ${resolved}`);
  return validateHarnessContract(JSON.parse(readFileSync(resolved, 'utf8')));
}

function normalizeHarness(value: string, contract: HarnessContract): HarnessId | null {
  const normalized = value.trim().toLowerCase();
  for (const id of PORTABLE_HARNESS_IDS) {
    if (id === normalized || contract.harnesses[id].aliases.includes(normalized)) return id;
  }
  return null;
}

export function detectHarness(contract: HarnessContract, input: HarnessDetectionInput = {}): HarnessId {
  const env = input.env ?? process.env;
  const explicit = input.explicitHarness ?? env.SWARM_HARNESS;
  if (explicit) {
    const id = normalizeHarness(explicit, contract);
    if (!id) throw new Error(`Unsupported harness: ${explicit}`);
    return id;
  }
  const environmentMatches = PORTABLE_HARNESS_IDS.filter((id) => contract.harnesses[id].environmentSignals.some((name) => Boolean(env[name])));
  if (environmentMatches.length === 1) return environmentMatches[0];
  if (environmentMatches.length > 1) throw new Error(`Ambiguous harness environment: ${environmentMatches.join(', ')}`);
  const processes = (input.argv ?? process.argv).map((arg) => basename(arg).toLowerCase());
  const processMatches = PORTABLE_HARNESS_IDS.filter((id) => contract.harnesses[id].processSignals.some((signal) => processes.includes(signal)));
  if (processMatches.length === 1) return processMatches[0];
  if (processMatches.length > 1) throw new Error(`Ambiguous harness process: ${processMatches.join(', ')}`);
  throw new Error('Unable to detect a supported harness');
}

export function resolvePortableHarness(options: HarnessDetectionInput & { contractPath?: string; registryPath?: string } = {}): ResolvedPortableHarness {
  const contract = loadHarnessContract(options.contractPath);
  const id = detectHarness(contract, options);
  const definition = contract.harnesses[id];
  const executor = findExecutor(loadRegistry(options.registryPath), definition.executorId);
  if (!executor) throw new Error(`Harness ${id} references missing executor ${definition.executorId}`);
  if (executor.transport !== definition.overlay.transport) throw new Error(`Harness ${id} transport drift: registry=${executor.transport}, overlay=${definition.overlay.transport}`);
  const capabilityMap: Record<PortableTool, keyof NonNullable<ExecutorRegistryEntry['capabilities']>> = {
    read: 'fileRead', write: 'fileWrite', shell: 'shellExec', web: 'webResearch', mcp: 'mcp',
  };
  for (const tool of TOOL_KEYS) {
    if (definition.tools[tool] && executor.capabilities?.[capabilityMap[tool]] !== true) {
      throw new Error(`Harness ${id} maps unsupported capability: ${tool}`);
    }
  }
  return { id, contractVersion: 1, executor, overlay: definition.overlay, tools: definition.tools };
}

export function buildPortableHarnessInventory(options: { contractPath?: string; registryPath?: string } = {}): PortableHarnessInventory {
  const entries = PORTABLE_HARNESS_IDS.map((id): PortableHarnessInventoryEntry => {
    const resolved = resolvePortableHarness({
      explicitHarness: id,
      contractPath: options.contractPath,
      registryPath: options.registryPath,
      env: {},
      argv: [],
    });
    const capabilities = {
      read: resolved.executor.capabilities?.fileRead === true,
      write: resolved.executor.capabilities?.fileWrite === true,
      shell: resolved.executor.capabilities?.shellExec === true,
      web: resolved.executor.capabilities?.webResearch === true,
      mcp: resolved.executor.capabilities?.mcp === true,
    };
    const projection = {
      id: resolved.id,
      executorId: resolved.executor.id,
      executorName: resolved.executor.name,
      executorClass: resolved.executor.executor,
      transport: resolved.overlay.transport,
      instructionFile: resolved.overlay.instructionFile,
      tools: resolved.tools,
      capabilities,
    };
    return { ...projection, adapterSha256: sha256(projection) };
  });
  const inventory = {
    schema: 'harness-adapter-inventory/v1' as const,
    contractVersion: 1 as const,
    entries,
  };
  return { ...inventory, inventorySha256: sha256(inventory) };
}

export function renderCompatibilityMatrix(contract: HarnessContract, registryPath?: string): string {
  const inventory = buildPortableHarnessInventory({ registryPath });
  const lines = [
    '# Harness Compatibility Matrix',
    '',
    'Generated from `executor-registry.json` and `harness-contract.json`. Do not edit manually.',
    '',
    `Adapter inventory SHA-256: \`${inventory.inventorySha256}\``,
    '',
    '| Harness | Transport | Instruction file | Read | Write | Shell | Web | MCP |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const id of PORTABLE_HARNESS_IDS) {
    const item = contract.harnesses[id];
    const executor = inventory.entries.find((entry) => entry.id === id);
    if (!executor) throw new Error(`Missing executor for matrix: ${item.executorId}`);
    const display = (tool: PortableTool) => item.tools[tool] ?? 'unsupported';
    lines.push(`| ${id} | ${executor.transport ?? 'bridge'} | ${item.overlay.instructionFile} | ${display('read')} | ${display('write')} | ${display('shell')} | ${display('web')} | ${display('mcp')} |`);
  }
  return `${lines.join('\n')}\n`;
}
