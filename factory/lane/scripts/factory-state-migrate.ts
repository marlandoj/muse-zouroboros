#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  FACTORY_STATE_MARKER,
  FACTORY_STATE_NAMESPACE,
  FACTORY_STATE_SCHEMA_VERSION,
  type FactoryStateMarker,
  validateFactoryStateMarker,
} from "./factory-state-root";
import {
  FACTORY_STATE_MUTATION_EVIDENCE_ROOT,
  readFactoryStateMutationReceipt,
  validateFactoryStateClaimTerminalProof,
  type FactoryStateMutationReceipt,
  type FactoryStateMutationScope,
  type FactoryStateMutationTargetSchema,
} from "./factory-state-mutation-evidence";

export const LIVE_FACTORY_STATE_SOURCE = "/home/workspace/.runtime/factory-conveyor/Projects/zouroboros-software-factory/state";
export const LIVE_FACTORY_STATE_DESTINATION = "/home/workspace/.runtime/factory-state/v1";
export const FACTORY_WRITER_SENTINEL = ".factory-state-writers.json";

export interface FactoryStateDigest {
  sha256: string;
  files: number;
  bytes: number;
  generation: string;
}

export interface FactoryStateMigrationPlan {
  version: 1;
  mode: "plan";
  created_at: string;
  source: string;
  destination: string;
  source_device: number;
  destination_parent_device: number;
  source_digest: FactoryStateDigest;
  destination_present: boolean;
  active_writers: string[];
}

export type FactoryStateHardlinkStage =
  | "planned"
  | "staging"
  | "staged_verified"
  | "destination_published"
  | "legacy_retiring"
  | "compatibility_linked"
  | "rolled_back_pre_write";

export interface FactoryStateHardlinkEntry {
  path: string;
  type: "directory" | "file";
  mode: number;
  size?: number;
  device?: number;
  inode?: number;
  initial_links?: number;
}

export interface FactoryStateHardlinkMigrationPlan {
  version: 2;
  mode: "hardlink-rehome";
  created_at: string;
  source: string;
  destination: string;
  staging: string;
  journal: string;
  lock: string;
  compatibility_link_temp: string;
  manifest_sha256: string;
  source_device: number;
  destination_parent_device: number;
  source_mode: number;
  source_digest: FactoryStateDigest;
  entries: FactoryStateHardlinkEntry[];
}

export interface FactoryStateHardlinkPlanOptions {
  staging: string;
  journal: string;
  lock: string;
  compatibilityLinkTemp: string;
  manifestSha256: string;
}

export interface FactoryStateHardlinkExecutionOptions {
  interruptAfterStage?: FactoryStateHardlinkStage;
}

export interface FactoryStateHardlinkStatus {
  plan_sha256: string;
  manifest_sha256: string;
  operation: "forward" | "rollback";
  stage: FactoryStateHardlinkStage;
  source: "absent" | "directory" | "compatibility-link" | "other";
  destination_present: boolean;
  staging_present: boolean;
  compatibility_link_temp_present: boolean;
  lock_present: boolean;
}

export interface FactoryStateHardlinkContinuity {
  version: 1;
  plan_sha256: string;
  journal_sha256: string;
  manifest_sha256: string;
  root_id: string;
  stage: "compatibility_linked";
  source: string;
  destination: string;
  root_mode: number;
  inventory_sha256: string;
  digest: Pick<FactoryStateDigest, "sha256" | "files" | "bytes">;
  entries: number;
}

export interface FactoryStatePostCutoverEntry {
  path: string;
  type: "directory" | "file";
  mode: number;
  size?: number;
  sha256?: string;
}

export interface FactoryStatePostCutoverBaseline {
  version: 2;
  mode: "post-cutover-continuity-baseline";
  captured_at: string;
  plan_sha256: string;
  journal_sha256: string;
  manifest_sha256: string;
  root_id: string;
  stage: "compatibility_linked";
  source: string;
  destination: string;
  root_mode: number;
  marker_sha256: string;
  marker: FactoryStateMarker;
  inventory_sha256: string;
  digest: Pick<FactoryStateDigest, "sha256" | "files" | "bytes">;
  entries: FactoryStatePostCutoverEntry[];
}

export interface FactoryStateContinuityPolicyBinding {
  kind: "receipt" | "operation";
  id: string;
}

export type FactoryStateContinuityPolicyRule =
  | {
    id: string;
    action: "append-only";
    path: string;
    binding: FactoryStateContinuityPolicyBinding;
  }
  | {
    id: string;
    action: "create-only";
    path: string;
    type: "directory" | "file";
    mode: number;
    binding: FactoryStateContinuityPolicyBinding;
  }
  | {
    id: string;
    action: "atomic-replace";
    path: string;
    target_schema: Exclude<FactoryStateMutationTargetSchema, "ticket-claim-owner/v1">;
    allowed_transitions: string[];
    scope: FactoryStateMutationScope;
    binding: FactoryStateContinuityPolicyBinding & { kind: "receipt" };
  }
  | {
    id: string;
    action: "claim-release";
    path: string;
    owner_path: string;
    scope: FactoryStateMutationScope;
    binding: FactoryStateContinuityPolicyBinding & { kind: "receipt" };
  };

export interface FactoryStateContinuityMutationPolicy {
  version: 1 | 2;
  mode: "post-cutover-continuity-mutation-policy";
  baseline_sha256: string;
  rules: FactoryStateContinuityPolicyRule[];
}

export interface FactoryStateContinuityChange {
  path: string;
  action: "append-only" | "create-only" | "atomic-replace" | "claim-release";
  rule_id: string;
  binding: FactoryStateContinuityPolicyBinding;
  before_size?: number;
  after_size?: number;
  after_sha256?: string;
  receipt_ids?: string[];
  observed_transitions?: string[];
}

export interface FactoryStateContinuityComparison {
  version: 1 | 2;
  mode: "post-cutover-continuity-comparison";
  baseline_sha256: string;
  policy_sha256?: string;
  plan_sha256: string;
  journal_sha256: string;
  manifest_sha256: string;
  root_id: string;
  inventory_sha256: string;
  digest: Pick<FactoryStateDigest, "sha256" | "files" | "bytes">;
  changes: FactoryStateContinuityChange[];
}

export interface FactoryStateContinuityComparisonOptions {
  baselineSha256: string;
  policy?: FactoryStateContinuityMutationPolicy;
  policySha256?: string;
}

interface FactoryStateHardlinkJournal {
  version: 1;
  plan_sha256: string;
  manifest_sha256: string;
  operation: "forward" | "rollback";
  stage: FactoryStateHardlinkStage;
  root_id: string;
  updated_at: string;
}

interface FactoryStateHardlinkLock {
  version: 1;
  pid: number;
  plan_sha256: string;
  manifest_sha256: string;
  source: string;
  destination: string;
  started_at: string;
}

export class FactoryStateMigrationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "FactoryStateMigrationError";
  }
}

function canonicalAbsolute(path: string, label: string): string {
  if (!path || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path || path === sep) {
    throw new FactoryStateMigrationError("invalid_path", `${label} must be a canonical absolute path`);
  }
  return path;
}

function assertNoSymlinkComponents(path: string): void {
  let cursor = path;
  const chain: string[] = [];
  while (cursor !== dirname(cursor)) {
    chain.push(cursor);
    cursor = dirname(cursor);
  }
  for (const entry of chain.reverse()) {
    if (!existsSync(entry)) continue;
    if (lstatSync(entry).isSymbolicLink()) {
      throw new FactoryStateMigrationError("symlink_rejected", `symlink component rejected: ${entry}`);
    }
  }
}

function nearestExistingAncestor(path: string): string {
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new FactoryStateMigrationError("destination_ancestor_missing", "destination has no existing filesystem ancestor");
    cursor = parent;
  }
  return cursor;
}

function activeWriters(source: string): string[] {
  const path = join(source, FACTORY_WRITER_SENTINEL);
  if (!existsSync(path)) return [];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new FactoryStateMigrationError("writer_sentinel_invalid", `writer sentinel is invalid: ${path}`);
  }
  const writers = (value as { active_writers?: unknown })?.active_writers;
  if (!Array.isArray(writers) || writers.some((entry) => typeof entry !== "string" || !entry)) {
    throw new FactoryStateMigrationError("writer_sentinel_invalid", "active_writers must be an array of non-empty strings");
  }
  return [...writers].sort();
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function walk(root: string, current: string, rows: string[], totals: { files: number; bytes: number }): void {
  for (const name of readdirSync(current).sort()) {
    if (name === FACTORY_STATE_MARKER || name === FACTORY_WRITER_SENTINEL) continue;
    const path = join(current, name);
    const stat = lstatSync(path);
    const rel = relative(root, path).replaceAll("\\", "/");
    if (stat.isSymbolicLink()) throw new FactoryStateMigrationError("symlink_rejected", `state entry is a symlink: ${rel}`);
    if (stat.isDirectory()) {
      rows.push(`d\0${rel}\0${stat.mode & 0o777}`);
      walk(root, path, rows, totals);
      continue;
    }
    if (!stat.isFile()) throw new FactoryStateMigrationError("special_file_rejected", `state entry is not a regular file: ${rel}`);
    const contentHash = hashFile(path);
    rows.push(`f\0${rel}\0${stat.mode & 0o777}\0${stat.size}\0${contentHash}`);
    totals.files += 1;
    totals.bytes += stat.size;
  }
}

export function digestFactoryState(rootInput: string): FactoryStateDigest {
  const root = canonicalAbsolute(rootInput, "state root");
  assertNoSymlinkComponents(root);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new FactoryStateMigrationError("source_missing", `state root is not a directory: ${root}`);
  }
  const rows: string[] = [];
  const totals = { files: 0, bytes: 0 };
  walk(root, root, rows, totals);
  const stat = statSync(root);
  return {
    sha256: createHash("sha256").update(rows.join("\n")).digest("hex"),
    files: totals.files,
    bytes: totals.bytes,
    generation: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${totals.files}:${totals.bytes}`,
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new FactoryStateMigrationError("invalid_hash", `${label} must be a lowercase SHA-256 digest`);
  }
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertSeparatePaths(paths: Array<[string, string]>): void {
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      const [leftLabel, left] = paths[i]!;
      const [rightLabel, right] = paths[j]!;
      if (left === right || isContained(left, right) || isContained(right, left)) {
        throw new FactoryStateMigrationError("path_overlap", `${leftLabel} and ${rightLabel} may not overlap`);
      }
    }
  }
}

function directDirectory(path: string, label: string): void {
  assertNoSymlinkComponents(path);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    throw new FactoryStateMigrationError("parent_missing", `${label} must be an existing directory`);
  }
}

function assertHardlinkExecutionParents(plan: FactoryStateHardlinkMigrationPlan): void {
  for (const [label, path] of [
    ["source parent", dirname(plan.source)],
    ["destination parent", dirname(plan.destination)],
    ["journal parent", dirname(plan.journal)],
    ["lock parent", dirname(plan.lock)],
    ["compatibility parent", dirname(plan.compatibility_link_temp)],
  ] as Array<[string, string]>) directDirectory(path, label);
  if (
    statSync(dirname(plan.source)).dev !== plan.source_device ||
    statSync(dirname(plan.destination)).dev !== plan.destination_parent_device
  ) {
    throw new FactoryStateMigrationError("device_drift", "source or destination parent device changed after planning");
  }
}

function hardlinkInventory(root: string, requireUnitLinks: boolean): { digest: FactoryStateDigest; entries: FactoryStateHardlinkEntry[]; rootMode: number } {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new FactoryStateMigrationError("source_missing", `state root is not a real directory: ${root}`);
  }
  const rows: string[] = [];
  const entries: FactoryStateHardlinkEntry[] = [];
  let files = 0;
  let bytes = 0;
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === FACTORY_STATE_MARKER || name === FACTORY_WRITER_SENTINEL) continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (stat.isSymbolicLink()) throw new FactoryStateMigrationError("symlink_rejected", `state entry is a symlink: ${rel}`);
      if (stat.dev !== rootStat.dev) throw new FactoryStateMigrationError("foreign_device", `state entry is on another device: ${rel}`);
      if (stat.isDirectory()) {
        const mode = stat.mode & 0o777;
        rows.push(`d\0${rel}\0${mode}`);
        entries.push({ path: rel, type: "directory", mode });
        visit(path);
        continue;
      }
      if (!stat.isFile()) throw new FactoryStateMigrationError("special_file_rejected", `state entry is not a regular file: ${rel}`);
      if (requireUnitLinks && stat.nlink !== 1) {
        throw new FactoryStateMigrationError("nonunit_link_count", `state entry must have exactly one initial hardlink: ${rel}`);
      }
      const mode = stat.mode & 0o777;
      rows.push(`f\0${rel}\0${mode}\0${stat.size}\0${hashFile(path)}`);
      entries.push({
        path: rel,
        type: "file",
        mode,
        size: stat.size,
        device: stat.dev,
        inode: stat.ino,
        initial_links: stat.nlink,
      });
      files += 1;
      bytes += stat.size;
    }
  };
  visit(root);
  return {
    digest: {
      sha256: sha256Text(rows.join("\n")),
      files,
      bytes,
      generation: `${rootStat.dev}:${rootStat.ino}:${rootStat.mtimeMs}:${files}:${bytes}`,
    },
    entries,
    rootMode: rootStat.mode & 0o777,
  };
}

function assertRelativeEntryPath(path: string): void {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path)) {
    throw new FactoryStateMigrationError("plan_invalid", `invalid inventory path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new FactoryStateMigrationError("plan_invalid", `invalid inventory path: ${path}`);
  }
}

function rootEntry(root: string, rel: string): string {
  assertRelativeEntryPath(rel);
  const path = resolve(root, rel);
  if (!isContained(root, path) || path === root) {
    throw new FactoryStateMigrationError("path_escape", `inventory path escapes root: ${rel}`);
  }
  return path;
}

function assertHardlinkPlanShape(plan: FactoryStateHardlinkMigrationPlan): void {
  if (plan.version !== 2 || plan.mode !== "hardlink-rehome") {
    throw new FactoryStateMigrationError("plan_invalid", "hardlink migration plan version or mode is invalid");
  }
  for (const [label, value] of [
    ["source", plan.source],
    ["destination", plan.destination],
    ["staging", plan.staging],
    ["journal", plan.journal],
    ["lock", plan.lock],
    ["compatibility link", plan.compatibility_link_temp],
  ] as Array<[string, string]>) canonicalAbsolute(value, label);
  assertSha256(plan.manifest_sha256, "manifest_sha256");
  assertSha256(plan.source_digest.sha256, "source_digest.sha256");
  if (dirname(plan.staging) !== dirname(plan.destination)) {
    throw new FactoryStateMigrationError("staging_parent", "staging and destination must share an exact parent");
  }
  if (dirname(plan.compatibility_link_temp) !== dirname(plan.source)) {
    throw new FactoryStateMigrationError("compatibility_parent", "temporary compatibility link must be a source sibling");
  }
  assertSeparatePaths([
    ["source", plan.source],
    ["destination", plan.destination],
    ["staging", plan.staging],
    ["journal", plan.journal],
    ["lock", plan.lock],
    ["compatibility link", plan.compatibility_link_temp],
  ]);
  if (!Number.isInteger(plan.source_mode) || plan.source_mode < 0 || plan.source_mode > 0o777) {
    throw new FactoryStateMigrationError("plan_invalid", "source mode is invalid");
  }
  const seen = new Set<string>();
  let fileCount = 0;
  let byteCount = 0;
  for (const entry of plan.entries) {
    assertRelativeEntryPath(entry.path);
    if (seen.has(entry.path)) throw new FactoryStateMigrationError("plan_invalid", `duplicate inventory path: ${entry.path}`);
    seen.add(entry.path);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new FactoryStateMigrationError("plan_invalid", `invalid mode for ${entry.path}`);
    }
    if (entry.type === "file") {
      if (
        !Number.isSafeInteger(entry.size) || entry.size! < 0 ||
        !Number.isSafeInteger(entry.device) || !Number.isSafeInteger(entry.inode) ||
        entry.initial_links !== 1
      ) throw new FactoryStateMigrationError("plan_invalid", `invalid file inventory for ${entry.path}`);
      fileCount += 1;
      byteCount += entry.size!;
    } else if (entry.type !== "directory") {
      throw new FactoryStateMigrationError("plan_invalid", `invalid entry type for ${entry.path}`);
    }
  }
  if (fileCount !== plan.source_digest.files || byteCount !== plan.source_digest.bytes) {
    throw new FactoryStateMigrationError("plan_invalid", "inventory totals do not match the source digest");
  }
}

export function serializeFactoryStateHardlinkPlan(plan: FactoryStateHardlinkMigrationPlan): string {
  assertHardlinkPlanShape(plan);
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function factoryStateHardlinkPlanSha256(plan: FactoryStateHardlinkMigrationPlan): string {
  return sha256Text(serializeFactoryStateHardlinkPlan(plan));
}

function assertPlanHash(plan: FactoryStateHardlinkMigrationPlan, planSha256: string): void {
  assertSha256(planSha256, "plan SHA-256");
  if (factoryStateHardlinkPlanSha256(plan) !== planSha256) {
    throw new FactoryStateMigrationError("plan_hash_mismatch", "hardlink migration plan hash does not match its canonical bytes");
  }
}

function sameInventory(left: FactoryStateHardlinkEntry[], right: FactoryStateHardlinkEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceKind(plan: FactoryStateHardlinkMigrationPlan): FactoryStateHardlinkStatus["source"] {
  if (!existsSync(plan.source)) return "absent";
  const stat = lstatSync(plan.source);
  if (stat.isSymbolicLink()) {
    return readlinkSync(plan.source) === plan.destination ? "compatibility-link" : "other";
  }
  return stat.isDirectory() ? "directory" : "other";
}

function verifyEntryAtRoot(root: string, entry: FactoryStateHardlinkEntry, requirePlannedInode: boolean): void {
  const path = rootEntry(root, entry.path);
  if (!existsSync(path)) throw new FactoryStateMigrationError("entry_missing", `planned entry is missing: ${entry.path}`);
  const stat = lstatSync(path);
  if (entry.type === "directory") {
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== entry.mode) {
      throw new FactoryStateMigrationError("entry_mismatch", `directory inventory mismatch: ${entry.path}`);
    }
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || (stat.mode & 0o777) !== entry.mode) {
    throw new FactoryStateMigrationError("entry_mismatch", `file inventory mismatch: ${entry.path}`);
  }
  if (requirePlannedInode && (stat.dev !== entry.device || stat.ino !== entry.inode)) {
    throw new FactoryStateMigrationError("inode_mismatch", `file inode identity mismatch: ${entry.path}`);
  }
}

function verifyCompleteNamespace(root: string, plan: FactoryStateHardlinkMigrationPlan, requireMarker: boolean): FactoryStateDigest {
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new FactoryStateMigrationError("namespace_missing", `migration namespace is not a real directory: ${root}`);
  }
  const inventory = hardlinkInventory(root, false);
  if (
    inventory.digest.sha256 !== plan.source_digest.sha256 ||
    inventory.digest.files !== plan.source_digest.files ||
    inventory.digest.bytes !== plan.source_digest.bytes
  ) throw new FactoryStateMigrationError("digest_mismatch", `namespace digest does not match the plan: ${root}`);
  const logicalEntries = inventory.entries.map((entry) => entry.type === "file" ? { ...entry, initial_links: 1 } : entry);
  if (!sameInventory(logicalEntries, plan.entries)) {
    throw new FactoryStateMigrationError("inventory_mismatch", `namespace inventory does not match the plan: ${root}`);
  }
  for (const entry of plan.entries) verifyEntryAtRoot(root, entry, entry.type === "file");
  if (requireMarker) {
    const marker = validateFactoryStateMarker(root);
    if (marker.generation !== 1 || marker.canonical_path !== plan.destination || marker.device !== plan.source_device) {
      throw new FactoryStateMigrationError("marker_mismatch", "hardlink destination marker does not match the plan");
    }
  }
  return inventory.digest;
}

function stableEntry(entry: FactoryStateHardlinkEntry): Pick<FactoryStateHardlinkEntry, "path" | "type" | "mode" | "size"> {
  return entry.type === "file"
    ? { path: entry.path, type: entry.type, mode: entry.mode, size: entry.size }
    : { path: entry.path, type: entry.type, mode: entry.mode };
}

function observeStableCompletedNamespace(root: string): {
  digest: Pick<FactoryStateDigest, "sha256" | "files" | "bytes">;
  entries: number;
  inventorySha256: string;
  rootMode: number;
} {
  if (!pathExists(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new FactoryStateMigrationError("namespace_missing", `migration namespace is not a real directory: ${root}`);
  }
  if (pathExists(join(root, FACTORY_WRITER_SENTINEL))) {
    throw new FactoryStateMigrationError("writer_sentinel_present", "completed migration continuity requires an absent writer sentinel");
  }
  const inventory = hardlinkInventory(root, false);
  const stableInventory = inventory.entries.map(stableEntry);
  return {
    digest: {
      sha256: inventory.digest.sha256,
      files: inventory.digest.files,
      bytes: inventory.digest.bytes,
    },
    entries: stableInventory.length,
    inventorySha256: sha256Text(JSON.stringify(stableInventory)),
    rootMode: inventory.rootMode,
  };
}

type FactoryStatePostCutoverObservation = Omit<
  FactoryStatePostCutoverBaseline,
  "version" | "mode" | "captured_at"
>;

function hashFilePrefix(path: string, byteLength: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  let remaining = byteLength;
  try {
    while (remaining > 0) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) {
        throw new FactoryStateMigrationError("continuity_change_rejected", `file became shorter while verifying append-only content: ${path}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function postCutoverInventory(root: string): {
  entries: FactoryStatePostCutoverEntry[];
  inventorySha256: string;
  digest: Pick<FactoryStateDigest, "sha256" | "files" | "bytes">;
  rootMode: number;
} {
  if (!pathExists(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new FactoryStateMigrationError("namespace_missing", `migration namespace is not a real directory: ${root}`);
  }
  if (pathExists(join(root, FACTORY_WRITER_SENTINEL))) {
    throw new FactoryStateMigrationError("writer_sentinel_present", "post-cutover continuity requires an absent writer sentinel");
  }
  const rootStat = lstatSync(root);
  const entries: FactoryStatePostCutoverEntry[] = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === FACTORY_STATE_MARKER || name === FACTORY_WRITER_SENTINEL) continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (stat.isSymbolicLink()) throw new FactoryStateMigrationError("symlink_rejected", `state entry is a symlink: ${rel}`);
      if (stat.dev !== rootStat.dev) throw new FactoryStateMigrationError("foreign_device", `state entry is on another device: ${rel}`);
      if (stat.isDirectory()) {
        entries.push({ path: rel, type: "directory", mode: stat.mode & 0o777 });
        visit(path);
      } else if (stat.isFile()) {
        entries.push({
          path: rel,
          type: "file",
          mode: stat.mode & 0o777,
          size: stat.size,
          sha256: hashFile(path),
        });
      } else {
        throw new FactoryStateMigrationError("special_file_rejected", `state entry is not a regular file: ${rel}`);
      }
    }
  };
  visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const rows = entries.map((entry) => entry.type === "file"
    ? `f\0${entry.path}\0${entry.mode}\0${entry.size}\0${entry.sha256}`
    : `d\0${entry.path}\0${entry.mode}`);
  const files = entries.filter((entry) => entry.type === "file");
  return {
    entries,
    inventorySha256: sha256Text(JSON.stringify(entries)),
    digest: {
      sha256: sha256Text(rows.join("\n")),
      files: files.length,
      bytes: files.reduce((total, entry) => total + entry.size!, 0),
    },
    rootMode: rootStat.mode & 0o777,
  };
}

function observeCompletedPostCutoverState(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256: string,
): FactoryStatePostCutoverObservation {
  assertPlanHash(plan, planSha256);
  assertHardlinkExecutionParents(plan);
  if (!pathExists(plan.journal) || !lstatSync(plan.journal).isFile() || lstatSync(plan.journal).isSymbolicLink()) {
    throw new FactoryStateMigrationError("journal_mismatch", "completed migration journal must be a regular file");
  }
  const journalRaw = readFileSync(plan.journal, "utf8");
  const journal = readHardlinkJournal(plan, planSha256);
  if (journalRaw !== `${JSON.stringify(journal, null, 2)}\n`) {
    throw new FactoryStateMigrationError("journal_not_canonical", "completed migration journal bytes are not canonical");
  }
  if (journal.operation !== "forward" || journal.stage !== "compatibility_linked") {
    throw new FactoryStateMigrationError("continuity_stage", "post-cutover continuity requires a completed forward compatibility-link cutover");
  }
  if (pathExists(plan.lock) || pathExists(plan.staging) || pathExists(plan.compatibility_link_temp)) {
    throw new FactoryStateMigrationError("continuity_residue", "completed migration retains lock, staging, or temporary compatibility residue");
  }
  if (sourceKind(plan) !== "compatibility-link") {
    throw new FactoryStateMigrationError("compatibility_mismatch", "completed migration lacks the exact compatibility link");
  }
  const marker = validateFactoryStateMarker(plan.destination);
  if (
    marker.root_id !== journal.root_id || marker.generation !== 1 ||
    marker.canonical_path !== plan.destination || marker.device !== plan.source_device
  ) {
    throw new FactoryStateMigrationError("marker_mismatch", "destination marker is not bound to the completed migration journal and plan");
  }
  const markerRaw = readFileSync(join(plan.destination, FACTORY_STATE_MARKER), "utf8");
  if (markerRaw !== `${JSON.stringify(marker, null, 2)}\n`) {
    throw new FactoryStateMigrationError("marker_not_canonical", "destination marker bytes are not canonical");
  }
  const inventory = postCutoverInventory(plan.destination);
  return {
    plan_sha256: planSha256,
    journal_sha256: sha256Text(journalRaw),
    manifest_sha256: plan.manifest_sha256,
    root_id: marker.root_id,
    stage: "compatibility_linked",
    source: plan.source,
    destination: plan.destination,
    root_mode: inventory.rootMode,
    marker_sha256: sha256Text(markerRaw),
    marker,
    inventory_sha256: inventory.inventorySha256,
    digest: inventory.digest,
    entries: inventory.entries,
  };
}

function observeStablePostCutoverState(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256: string,
): FactoryStatePostCutoverObservation {
  const first = observeCompletedPostCutoverState(plan, planSha256);
  const second = observeCompletedPostCutoverState(plan, planSha256);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new FactoryStateMigrationError("continuity_unstable", "post-cutover namespace changed between the two required observations");
  }
  return second;
}

function assertPostCutoverBaselineShape(baseline: FactoryStatePostCutoverBaseline): void {
  if (baseline.version !== 2 || baseline.mode !== "post-cutover-continuity-baseline") {
    throw new FactoryStateMigrationError("baseline_invalid", "post-cutover baseline version or mode is invalid");
  }
  if (!baseline.captured_at || Number.isNaN(Date.parse(baseline.captured_at))) {
    throw new FactoryStateMigrationError("baseline_invalid", "post-cutover baseline captured_at is invalid");
  }
  for (const [label, value] of [
    ["plan_sha256", baseline.plan_sha256],
    ["journal_sha256", baseline.journal_sha256],
    ["manifest_sha256", baseline.manifest_sha256],
    ["marker_sha256", baseline.marker_sha256],
    ["inventory_sha256", baseline.inventory_sha256],
    ["digest.sha256", baseline.digest?.sha256],
  ] as Array<[string, string]>) assertSha256(value, label);
  canonicalAbsolute(baseline.source, "baseline source");
  canonicalAbsolute(baseline.destination, "baseline destination");
  if (
    baseline.stage !== "compatibility_linked" || !baseline.root_id ||
    !Number.isInteger(baseline.root_mode) || baseline.root_mode < 0 || baseline.root_mode > 0o777
  ) throw new FactoryStateMigrationError("baseline_invalid", "post-cutover baseline identity is invalid");
  if (
    baseline.marker?.namespace !== FACTORY_STATE_NAMESPACE ||
    baseline.marker?.schema_version !== FACTORY_STATE_SCHEMA_VERSION ||
    baseline.marker?.root_id !== baseline.root_id ||
    baseline.marker?.canonical_path !== baseline.destination ||
    baseline.marker?.generation !== 1 ||
    !Number.isSafeInteger(baseline.marker?.device) ||
    !baseline.marker?.created_at || Number.isNaN(Date.parse(baseline.marker.created_at))
  ) throw new FactoryStateMigrationError("baseline_invalid", "post-cutover baseline marker is invalid");
  if (!Array.isArray(baseline.entries)) throw new FactoryStateMigrationError("baseline_invalid", "post-cutover baseline inventory is invalid");
  const seen = new Set<string>();
  for (const entry of baseline.entries) {
    assertRelativeEntryPath(entry.path);
    if (seen.has(entry.path)) throw new FactoryStateMigrationError("baseline_invalid", `duplicate baseline path: ${entry.path}`);
    seen.add(entry.path);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new FactoryStateMigrationError("baseline_invalid", `invalid baseline mode: ${entry.path}`);
    }
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.size) || entry.size! < 0 || typeof entry.sha256 !== "string") {
        throw new FactoryStateMigrationError("baseline_invalid", `invalid baseline file: ${entry.path}`);
      }
      assertSha256(entry.sha256, `baseline file SHA-256 for ${entry.path}`);
    } else if (entry.type === "directory") {
      if (entry.size !== undefined || entry.sha256 !== undefined) {
        throw new FactoryStateMigrationError("baseline_invalid", `invalid baseline directory: ${entry.path}`);
      }
    } else {
      throw new FactoryStateMigrationError("baseline_invalid", `invalid baseline entry type: ${entry.path}`);
    }
  }
  const sorted = [...baseline.entries].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(sorted) !== JSON.stringify(baseline.entries)) {
    throw new FactoryStateMigrationError("baseline_invalid", "post-cutover baseline inventory is not path-sorted");
  }
  const rows = baseline.entries.map((entry) => entry.type === "file"
    ? `f\0${entry.path}\0${entry.mode}\0${entry.size}\0${entry.sha256}`
    : `d\0${entry.path}\0${entry.mode}`);
  const files = baseline.entries.filter((entry) => entry.type === "file");
  if (
    baseline.inventory_sha256 !== sha256Text(JSON.stringify(baseline.entries)) ||
    baseline.digest.sha256 !== sha256Text(rows.join("\n")) ||
    baseline.digest.files !== files.length ||
    baseline.digest.bytes !== files.reduce((total, entry) => total + entry.size!, 0)
  ) throw new FactoryStateMigrationError("baseline_invalid", "post-cutover baseline inventory hashes or totals are inconsistent");
}

export function serializeFactoryStatePostCutoverBaseline(baseline: FactoryStatePostCutoverBaseline): string {
  assertPostCutoverBaselineShape(baseline);
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function factoryStatePostCutoverBaselineSha256(baseline: FactoryStatePostCutoverBaseline): string {
  return sha256Text(serializeFactoryStatePostCutoverBaseline(baseline));
}

export function captureFactoryStatePostCutoverContinuity(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256 = factoryStateHardlinkPlanSha256(plan),
): FactoryStatePostCutoverBaseline {
  const observation = observeStablePostCutoverState(plan, planSha256);
  return {
    version: 2,
    mode: "post-cutover-continuity-baseline",
    captured_at: new Date().toISOString(),
    ...observation,
  };
}

function assertPolicyPath(path: string): void {
  try {
    assertRelativeEntryPath(path);
  } catch {
    throw new FactoryStateMigrationError("policy_invalid", `mutation policy path is not normalized: ${path}`);
  }
  if (/[*?\[\]{}!]/.test(path)) {
    throw new FactoryStateMigrationError("policy_invalid", `mutation policy path must be exact, not a pattern: ${path}`);
  }
}

function assertContinuityMutationPolicyShape(policy: FactoryStateContinuityMutationPolicy): void {
  if (![1, 2].includes(policy.version) || policy.mode !== "post-cutover-continuity-mutation-policy") {
    throw new FactoryStateMigrationError("policy_invalid", "continuity mutation policy version or mode is invalid");
  }
  assertSha256(policy.baseline_sha256, "mutation policy baseline_sha256");
  if (!Array.isArray(policy.rules)) throw new FactoryStateMigrationError("policy_invalid", "continuity mutation policy rules are invalid");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const rule of policy.rules) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rule.id) || ids.has(rule.id)) {
      throw new FactoryStateMigrationError("policy_invalid", `mutation policy rule id is invalid or duplicated: ${rule.id}`);
    }
    ids.add(rule.id);
    assertPolicyPath(rule.path);
    if (paths.has(rule.path)) throw new FactoryStateMigrationError("policy_invalid", `mutation policy rules overlap at exact path: ${rule.path}`);
    paths.add(rule.path);
    if (
      !rule.binding || !["receipt", "operation"].includes(rule.binding.kind) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(rule.binding.id)
    ) throw new FactoryStateMigrationError("policy_invalid", `mutation policy rule lacks deterministic ownership: ${rule.id}`);
    if (rule.action === "create-only") {
      if (
        !["directory", "file"].includes(rule.type) ||
        !Number.isInteger(rule.mode) || rule.mode < 0 || rule.mode > 0o777
      ) throw new FactoryStateMigrationError("policy_invalid", `create-only rule is invalid: ${rule.id}`);
    } else if (rule.action === "atomic-replace") {
      if (policy.version !== 2) throw new FactoryStateMigrationError("policy_invalid", "atomic-replace requires mutation policy version 2");
      if (rule.binding.kind !== "receipt") throw new FactoryStateMigrationError("policy_invalid", `atomic-replace rule requires receipt ownership: ${rule.id}`);
      if (!(["lane-current-cycle/v1", "product-gate/v1", "slo-state/v1"] as string[]).includes(rule.target_schema)) {
        throw new FactoryStateMigrationError("policy_invalid", `atomic-replace target schema is invalid: ${rule.id}`);
      }
      if (!(["scheduled-cycle", "background"] as string[]).includes(rule.scope)) {
        throw new FactoryStateMigrationError("policy_invalid", `atomic-replace scope is invalid: ${rule.id}`);
      }
      if (!Array.isArray(rule.allowed_transitions) || rule.allowed_transitions.length === 0) {
        throw new FactoryStateMigrationError("policy_invalid", `atomic-replace transitions are invalid: ${rule.id}`);
      }
      const transitions = new Set(rule.allowed_transitions);
      if (
        transitions.size !== rule.allowed_transitions.length ||
        rule.allowed_transitions.some((transition) => !/^(?:\$[A-Za-z0-9._:-]+|\/(?:[^~/]|~[01])*(?:\/(?:[^~/]|~[01])*)*)$/.test(transition))
      ) throw new FactoryStateMigrationError("policy_invalid", `atomic-replace transitions are invalid: ${rule.id}`);
    } else if (rule.action === "claim-release") {
      if (policy.version !== 2) throw new FactoryStateMigrationError("policy_invalid", "claim-release requires mutation policy version 2");
      if (rule.binding.kind !== "receipt") throw new FactoryStateMigrationError("policy_invalid", `claim-release rule requires receipt ownership: ${rule.id}`);
      assertPolicyPath(rule.owner_path);
      if (rule.owner_path !== `${rule.path}/owner.json`) {
        throw new FactoryStateMigrationError("policy_invalid", `claim-release owner path is not exact: ${rule.id}`);
      }
      if (!(["scheduled-cycle", "background"] as string[]).includes(rule.scope)) {
        throw new FactoryStateMigrationError("policy_invalid", `claim-release scope is invalid: ${rule.id}`);
      }
    } else if (rule.action !== "append-only") {
      throw new FactoryStateMigrationError("policy_invalid", "mutation policy action is invalid");
    }
    if (policy.version === 1 && !["append-only", "create-only"].includes(rule.action)) {
      throw new FactoryStateMigrationError("policy_invalid", "mutation policy version 1 supports only append-only and create-only actions");
    }
  }
}

export function serializeFactoryStateContinuityMutationPolicy(policy: FactoryStateContinuityMutationPolicy): string {
  assertContinuityMutationPolicyShape(policy);
  return `${JSON.stringify(policy, null, 2)}\n`;
}

export function factoryStateContinuityMutationPolicySha256(policy: FactoryStateContinuityMutationPolicy): string {
  return sha256Text(serializeFactoryStateContinuityMutationPolicy(policy));
}

function rejectContinuityChange(path: string, reason: string): never {
  throw new FactoryStateMigrationError("continuity_change_rejected", `${reason}: ${path}`);
}

interface LoadedMutationReceipt {
  path: string;
  receipt: FactoryStateMutationReceipt;
}

function loadMutationReceipts(destination: string): LoadedMutationReceipt[] {
  const root = join(destination, FACTORY_STATE_MUTATION_EVIDENCE_ROOT);
  if (!existsSync(root)) return [];
  if (!lstatSync(root).isDirectory()) rejectContinuityChange(FACTORY_STATE_MUTATION_EVIDENCE_ROOT, "mutation evidence root is not a directory");
  const loaded: LoadedMutationReceipt[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = `${FACTORY_STATE_MUTATION_EVIDENCE_ROOT}/${entry.name}`;
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
      rejectContinuityChange(relativePath, "mutation evidence entry is not an exact content-addressed receipt");
    }
    let receipt: FactoryStateMutationReceipt;
    try {
      receipt = readFactoryStateMutationReceipt(join(root, entry.name));
    } catch (error) {
      rejectContinuityChange(relativePath, `mutation receipt is invalid (${error instanceof Error ? error.message : String(error)})`);
    }
    if (entry.name !== `${receipt.content_hash}.json`) rejectContinuityChange(relativePath, "mutation receipt filename does not match content hash");
    loaded.push({ path: relativePath, receipt });
  }
  return loaded;
}

function assertReceiptBinding(
  loaded: LoadedMutationReceipt,
  rule: Extract<FactoryStateContinuityPolicyRule, { action: "atomic-replace" | "claim-release" }>,
): void {
  const receipt = loaded.receipt;
  if (receipt.producer_id !== rule.binding.id || receipt.binding.producer_id !== rule.binding.id) {
    rejectContinuityChange(rule.path, "mutation receipt producer does not match policy ownership");
  }
  if (receipt.scope !== rule.scope || receipt.binding.scope !== rule.scope) {
    rejectContinuityChange(rule.path, "mutation receipt scope does not match policy scope");
  }
  if (rule.scope === "scheduled-cycle" && (
    receipt.binding.requested_cycle_id !== receipt.cycle_id ||
    receipt.binding.reason !== null ||
    !receipt.binding.sentinel_path ||
    !receipt.binding.lane_log_path
  )) rejectContinuityChange(rule.path, "scheduled mutation receipt lacks an exact active-cycle binding");
}

function consumeAtomicReplace(
  plan: FactoryStateHardlinkMigrationPlan,
  path: string,
  before: FactoryStatePostCutoverEntry,
  after: FactoryStatePostCutoverEntry,
  rule: Extract<FactoryStateContinuityPolicyRule, { action: "atomic-replace" }>,
  receipts: LoadedMutationReceipt[],
  consumedReceipts: Set<string>,
): FactoryStateContinuityChange {
  if (before.type !== "file" || after.type !== "file") rejectContinuityChange(path, "atomic-replace requires an existing regular file");
  const candidates = receipts.filter(({ receipt }) => receipt.action === "atomic-replace" && receipt.target_path === path);
  if (candidates.length !== 1) rejectContinuityChange(path, `atomic-replace requires exactly one receipt; found ${candidates.length}`);
  const loaded = candidates[0]!;
  const receipt = loaded.receipt;
  assertReceiptBinding(loaded, rule);
  if (receipt.target_schema !== rule.target_schema) rejectContinuityChange(path, "atomic-replace receipt schema does not match policy");
  if (receipt.before_sha256 !== before.sha256 || receipt.after_sha256 !== after.sha256) {
    rejectContinuityChange(path, "atomic-replace receipt hashes do not match baseline and live entries");
  }
  if (sha256Text(receipt.before_payload) !== before.sha256) rejectContinuityChange(path, "atomic-replace prior payload does not match baseline hash");
  if (readFileSync(rootEntry(plan.destination, path), "utf8") !== receipt.after_payload) {
    rejectContinuityChange(path, "atomic-replace resulting payload does not match the live file");
  }
  if (receipt.observed_transitions.some((transition) => !rule.allowed_transitions.includes(transition))) {
    rejectContinuityChange(path, "atomic-replace observed an undeclared policy transition");
  }
  if (receipt.allowed_transitions.some((transition) => !rule.allowed_transitions.includes(transition))) {
    rejectContinuityChange(path, "atomic-replace receipt declares broader transitions than the policy");
  }
  consumedReceipts.add(loaded.path);
  return {
    path,
    action: "atomic-replace",
    rule_id: rule.id,
    binding: rule.binding,
    before_size: before.size,
    after_size: after.size,
    after_sha256: after.sha256,
    receipt_ids: [receipt.receipt_id],
    observed_transitions: receipt.observed_transitions,
  };
}

function consumeClaimRelease(
  plan: FactoryStateHardlinkMigrationPlan,
  rule: Extract<FactoryStateContinuityPolicyRule, { action: "claim-release" }>,
  baselineEntries: Map<string, FactoryStatePostCutoverEntry>,
  currentEntries: Map<string, FactoryStatePostCutoverEntry>,
  receipts: LoadedMutationReceipt[],
  consumedReceipts: Set<string>,
  consumedBaselinePaths: Set<string>,
): FactoryStateContinuityChange {
  const directory = baselineEntries.get(rule.path);
  const owner = baselineEntries.get(rule.owner_path);
  if (!directory || directory.type !== "directory" || !owner || owner.type !== "file") {
    rejectContinuityChange(rule.path, "claim-release baseline directory or owner file is missing");
  }
  const descendants = [...baselineEntries.keys()].filter((path) => path.startsWith(`${rule.path}/`));
  if (descendants.length !== 1 || descendants[0] !== rule.owner_path) {
    rejectContinuityChange(rule.path, "claim-release baseline contains undeclared descendants");
  }
  if (currentEntries.has(rule.path) || currentEntries.has(rule.owner_path)) {
    rejectContinuityChange(rule.path, "claim-release target remains present");
  }
  const candidates = receipts.filter(({ receipt }) => receipt.action === "claim-release" && receipt.target_path === rule.path);
  if (candidates.length !== 2) rejectContinuityChange(rule.path, `claim-release requires prepared and committed receipts; found ${candidates.length}`);
  const prepared = candidates.find(({ receipt }) => receipt.claim_release?.stage === "prepared");
  const committed = candidates.find(({ receipt }) => receipt.claim_release?.stage === "committed");
  if (!prepared || !committed) rejectContinuityChange(rule.path, "claim-release receipt stages are incomplete or ambiguous");
  for (const loaded of [prepared, committed]) {
    assertReceiptBinding(loaded, rule);
    const receipt = loaded.receipt;
    const proof = receipt.claim_release!;
    if (receipt.target_schema !== "ticket-claim-owner/v1" || receipt.before_sha256 !== owner.sha256 || receipt.after_payload !== "") {
      rejectContinuityChange(rule.path, "claim-release receipt does not bind the baseline owner deletion");
    }
    if (proof.claim_directory_path !== rule.path || proof.owner_path !== rule.owner_path || proof.owner_sha256 !== owner.sha256) {
      rejectContinuityChange(rule.path, "claim-release ownership paths or hashes do not match policy and baseline");
    }
    const exactExecutionPath = join(plan.destination, `exec-${proof.owner.execution_id}.json`);
    if (proof.terminal.execution_record_path !== exactExecutionPath) {
      rejectContinuityChange(rule.path, "claim-release terminal record path is not the exact factory execution record");
    }
    let terminal;
    try {
      terminal = validateFactoryStateClaimTerminalProof(proof.owner, exactExecutionPath);
    } catch (error) {
      rejectContinuityChange(rule.path, `claim-release terminal proof is invalid (${error instanceof Error ? error.message : String(error)})`);
    }
    if (
      terminal.execution_record_sha256 !== proof.terminal.execution_record_sha256 ||
      terminal.lifecycle_state !== proof.terminal.lifecycle_state
    ) rejectContinuityChange(rule.path, "claim-release terminal record changed after receipt capture");
    consumedReceipts.add(loaded.path);
  }
  if (committed.receipt.claim_release?.prepared_receipt_id !== prepared.receipt.receipt_id) {
    rejectContinuityChange(rule.path, "committed claim-release receipt does not bind the prepared receipt");
  }
  if (
    prepared.receipt.before_sha256 !== committed.receipt.before_sha256 ||
    prepared.receipt.claim_release?.terminal.execution_record_sha256 !== committed.receipt.claim_release?.terminal.execution_record_sha256
  ) rejectContinuityChange(rule.path, "claim-release receipt stages disagree on immutable evidence");
  consumedBaselinePaths.add(rule.path);
  consumedBaselinePaths.add(rule.owner_path);
  return {
    path: rule.path,
    action: "claim-release",
    rule_id: rule.id,
    binding: rule.binding,
    before_size: owner.size,
    receipt_ids: [prepared.receipt.receipt_id, committed.receipt.receipt_id],
    observed_transitions: ["$claim_removed"],
  };
}

export function compareFactoryStatePostCutoverContinuity(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256: string,
  baseline: FactoryStatePostCutoverBaseline,
  options: FactoryStateContinuityComparisonOptions,
): FactoryStateContinuityComparison {
  assertSha256(options.baselineSha256, "expected baseline SHA-256");
  const measuredBaselineSha256 = factoryStatePostCutoverBaselineSha256(baseline);
  if (measuredBaselineSha256 !== options.baselineSha256) {
    throw new FactoryStateMigrationError("baseline_hash_mismatch", "post-cutover baseline does not match its expected SHA-256");
  }
  let policySha256: string | undefined;
  const policyRules = new Map<string, FactoryStateContinuityPolicyRule>();
  if (options.policy) {
    if (!options.policySha256) throw new FactoryStateMigrationError("policy_hash_required", "mutation policy requires an expected SHA-256");
    assertSha256(options.policySha256, "expected mutation policy SHA-256");
    policySha256 = factoryStateContinuityMutationPolicySha256(options.policy);
    if (policySha256 !== options.policySha256) {
      throw new FactoryStateMigrationError("policy_hash_mismatch", "continuity mutation policy does not match its expected SHA-256");
    }
    if (options.policy.baseline_sha256 !== measuredBaselineSha256) {
      throw new FactoryStateMigrationError("policy_baseline_mismatch", "continuity mutation policy is bound to another baseline");
    }
    for (const rule of options.policy.rules) policyRules.set(rule.path, rule);
  } else if (options.policySha256) {
    throw new FactoryStateMigrationError("policy_missing", "mutation policy SHA-256 was supplied without a policy");
  }

  const current = observeStablePostCutoverState(plan, planSha256);
  if (
    baseline.plan_sha256 !== current.plan_sha256 ||
    baseline.journal_sha256 !== current.journal_sha256 ||
    baseline.manifest_sha256 !== current.manifest_sha256 ||
    baseline.root_id !== current.root_id ||
    baseline.stage !== current.stage ||
    baseline.source !== current.source ||
    baseline.destination !== current.destination ||
    baseline.root_mode !== current.root_mode ||
    baseline.marker_sha256 !== current.marker_sha256 ||
    JSON.stringify(baseline.marker) !== JSON.stringify(current.marker)
  ) throw new FactoryStateMigrationError("continuity_binding_mismatch", "post-cutover migration identity or immutable metadata changed from the baseline");

  const baselineEntries = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const currentEntries = new Map(current.entries.map((entry) => [entry.path, entry]));
  const receipts = loadMutationReceipts(plan.destination).filter(({ path }) => !baselineEntries.has(path));
  const consumedReceipts = new Set<string>();
  const consumedBaselinePaths = new Set<string>();
  const changes: FactoryStateContinuityChange[] = [];
  for (const rule of policyRules.values()) {
    if (rule.action === "claim-release") {
      changes.push(consumeClaimRelease(
        plan,
        rule,
        baselineEntries,
        currentEntries,
        receipts,
        consumedReceipts,
        consumedBaselinePaths,
      ));
    }
  }
  for (const [path, before] of baselineEntries) {
    if (consumedBaselinePaths.has(path)) continue;
    const after = currentEntries.get(path);
    if (!after) rejectContinuityChange(path, "baseline entry was deleted");
    if (after.type !== before.type) rejectContinuityChange(path, "entry type changed");
    if (after.mode !== before.mode) rejectContinuityChange(path, "entry mode changed");
    if (before.type === "directory") continue;
    if (after.size === before.size && after.sha256 === before.sha256) continue;
    const rule = policyRules.get(path);
    if (rule?.action === "atomic-replace") {
      changes.push(consumeAtomicReplace(plan, path, before, after, rule, receipts, consumedReceipts));
      continue;
    }
    if (!rule || rule.action !== "append-only") rejectContinuityChange(path, "file content changed without an append-only rule");
    if (after.size! <= before.size!) rejectContinuityChange(path, "append-only file was rewritten or truncated");
    if (hashFilePrefix(rootEntry(plan.destination, path), before.size!) !== before.sha256) {
      rejectContinuityChange(path, "append-only file does not retain the baseline content as an exact prefix");
    }
    changes.push({
      path,
      action: "append-only",
      rule_id: rule.id,
      binding: rule.binding,
      before_size: before.size,
      after_size: after.size,
      after_sha256: after.sha256,
    });
  }
  for (const [path, after] of currentEntries) {
    if (baselineEntries.has(path)) continue;
    if (path === FACTORY_STATE_MUTATION_EVIDENCE_ROOT) {
      if (after.type !== "directory" || after.mode !== 0o700) rejectContinuityChange(path, "mutation evidence root mode or type is invalid");
      continue;
    }
    if (path.startsWith(`${FACTORY_STATE_MUTATION_EVIDENCE_ROOT}/`)) {
      if (!consumedReceipts.has(path)) rejectContinuityChange(path, "mutation receipt was not consumed by exactly one typed policy rule");
      if (after.type !== "file" || after.mode !== 0o600) rejectContinuityChange(path, "mutation receipt mode or type is invalid");
      continue;
    }
    const rule = policyRules.get(path);
    if (!rule || rule.action !== "create-only") rejectContinuityChange(path, "entry was created without a create-only rule");
    if (after.type !== rule.type || after.mode !== rule.mode) rejectContinuityChange(path, "created entry does not match its declared type and mode");
    changes.push({
      path,
      action: "create-only",
      rule_id: rule.id,
      binding: rule.binding,
      after_size: after.size,
      after_sha256: after.sha256,
    });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: options.policy?.version === 2 ? 2 : 1,
    mode: "post-cutover-continuity-comparison",
    baseline_sha256: measuredBaselineSha256,
    ...(policySha256 ? { policy_sha256: policySha256 } : {}),
    plan_sha256: current.plan_sha256,
    journal_sha256: current.journal_sha256,
    manifest_sha256: current.manifest_sha256,
    root_id: current.root_id,
    inventory_sha256: current.inventory_sha256,
    digest: current.digest,
    changes,
  };
}

export function planFactoryStateHardlinkMigration(
  sourceInput: string,
  destinationInput: string,
  options: FactoryStateHardlinkPlanOptions,
): FactoryStateHardlinkMigrationPlan {
  const source = canonicalAbsolute(sourceInput, "source");
  const destination = canonicalAbsolute(destinationInput, "destination");
  const staging = canonicalAbsolute(options.staging, "staging");
  const journal = canonicalAbsolute(options.journal, "journal");
  const lock = canonicalAbsolute(options.lock, "lock");
  const compatibilityLinkTemp = canonicalAbsolute(options.compatibilityLinkTemp, "compatibility link");
  assertSha256(options.manifestSha256, "manifest SHA-256");
  assertSeparatePaths([
    ["source", source],
    ["destination", destination],
    ["staging", staging],
    ["journal", journal],
    ["lock", lock],
    ["compatibility link", compatibilityLinkTemp],
  ]);
  if (dirname(staging) !== dirname(destination)) {
    throw new FactoryStateMigrationError("staging_parent", "staging and destination must share an exact parent");
  }
  if (dirname(compatibilityLinkTemp) !== dirname(source)) {
    throw new FactoryStateMigrationError("compatibility_parent", "temporary compatibility link must be a source sibling");
  }
  assertNoSymlinkComponents(source);
  directDirectory(dirname(destination), "destination parent");
  directDirectory(dirname(journal), "journal parent");
  directDirectory(dirname(lock), "lock parent");
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    throw new FactoryStateMigrationError("source_missing", "source must be a real directory");
  }
  if (existsSync(join(source, FACTORY_WRITER_SENTINEL))) {
    throw new FactoryStateMigrationError("writer_sentinel_present", "writer sentinel presence prevents hardlink planning");
  }
  for (const [label, path] of [
    ["destination", destination],
    ["staging", staging],
    ["journal", journal],
    ["lock", lock],
    ["compatibility link", compatibilityLinkTemp],
  ] as Array<[string, string]>) {
    if (pathExists(path)) throw new FactoryStateMigrationError("collision", `${label} already exists: ${path}`);
  }
  const sourceStat = lstatSync(source);
  const destinationParentStat = lstatSync(dirname(destination));
  if (sourceStat.dev !== destinationParentStat.dev) {
    throw new FactoryStateMigrationError("cross_device", "source and destination must be on the same filesystem");
  }
  const inventory = hardlinkInventory(source, true);
  return {
    version: 2,
    mode: "hardlink-rehome",
    created_at: new Date().toISOString(),
    source,
    destination,
    staging,
    journal,
    lock,
    compatibility_link_temp: compatibilityLinkTemp,
    manifest_sha256: options.manifestSha256,
    source_device: sourceStat.dev,
    destination_parent_device: destinationParentStat.dev,
    source_mode: inventory.rootMode,
    source_digest: inventory.digest,
    entries: inventory.entries,
  };
}

export function verifyFactoryStateHardlinkMigrationPlan(plan: FactoryStateHardlinkMigrationPlan): FactoryStateDigest {
  assertHardlinkPlanShape(plan);
  assertHardlinkExecutionParents(plan);
  if (sourceKind(plan) !== "directory") {
    throw new FactoryStateMigrationError("source_missing", "hardlink planning requires the complete legacy source directory");
  }
  if (existsSync(join(plan.source, FACTORY_WRITER_SENTINEL))) {
    throw new FactoryStateMigrationError("writer_sentinel_present", "writer sentinel presence prevents hardlink cutover");
  }
  directDirectory(dirname(plan.destination), "destination parent");
  if (statSync(plan.source).dev !== plan.source_device || statSync(dirname(plan.destination)).dev !== plan.destination_parent_device) {
    throw new FactoryStateMigrationError("device_drift", "source or destination-parent device changed after planning");
  }
  if (plan.source_device !== plan.destination_parent_device) {
    throw new FactoryStateMigrationError("cross_device", "source and destination must be on the same filesystem");
  }
  for (const [label, path] of [
    ["destination", plan.destination],
    ["staging", plan.staging],
    ["journal", plan.journal],
    ["lock", plan.lock],
    ["compatibility link", plan.compatibility_link_temp],
  ] as Array<[string, string]>) {
    if (pathExists(path)) throw new FactoryStateMigrationError("collision", `${label} already exists: ${path}`);
  }
  const inventory = hardlinkInventory(plan.source, true);
  if (
    inventory.digest.sha256 !== plan.source_digest.sha256 ||
    inventory.digest.generation !== plan.source_digest.generation ||
    inventory.rootMode !== plan.source_mode ||
    !sameInventory(inventory.entries, plan.entries)
  ) throw new FactoryStateMigrationError("source_drift", "source state changed after the hardlink migration plan was created");
  return inventory.digest;
}

export function planFactoryStateMigration(sourceInput: string, destinationInput: string): FactoryStateMigrationPlan {
  const source = canonicalAbsolute(sourceInput, "source");
  const destination = canonicalAbsolute(destinationInput, "destination");
  if (source === destination || destination.startsWith(`${source}${sep}`) || source.startsWith(`${destination}${sep}`)) {
    throw new FactoryStateMigrationError("path_overlap", "source and destination may not overlap");
  }
  assertNoSymlinkComponents(source);
  assertNoSymlinkComponents(dirname(destination));
  const sourceStat = statSync(source);
  if (!sourceStat.isDirectory()) throw new FactoryStateMigrationError("source_missing", "source must be a directory");
  const destinationParent = dirname(destination);
  const destinationDeviceAnchor = nearestExistingAncestor(destinationParent);
  assertNoSymlinkComponents(destinationDeviceAnchor);
  const parentStat = statSync(destinationDeviceAnchor);
  const writers = activeWriters(source);
  return {
    version: 1,
    mode: "plan",
    created_at: new Date().toISOString(),
    source,
    destination,
    source_device: sourceStat.dev,
    destination_parent_device: parentStat.dev,
    source_digest: digestFactoryState(source),
    destination_present: existsSync(destination),
    active_writers: writers,
  };
}

export function verifyFactoryStateMigrationPlan(plan: FactoryStateMigrationPlan): FactoryStateDigest {
  if (plan.version !== 1 || plan.mode !== "plan") throw new FactoryStateMigrationError("plan_invalid", "migration plan version or mode is invalid");
  const current = digestFactoryState(plan.source);
  if (current.sha256 !== plan.source_digest.sha256 || current.generation !== plan.source_digest.generation) {
    throw new FactoryStateMigrationError("source_drift", "source state changed after the migration plan was created");
  }
  if (activeWriters(plan.source).length > 0) throw new FactoryStateMigrationError("active_writers", "active factory writers prevent cutover");
  const sourceDevice = statSync(plan.source).dev;
  const destinationParentDevice = statSync(dirname(plan.destination)).dev;
  if (sourceDevice !== plan.source_device || destinationParentDevice !== plan.destination_parent_device) {
    throw new FactoryStateMigrationError("device_drift", "source or destination-parent device changed after planning");
  }
  if (sourceDevice !== destinationParentDevice) {
    throw new FactoryStateMigrationError("cross_device", "source and destination must be on the same filesystem");
  }
  if (existsSync(plan.destination)) {
    const entries = lstatSync(plan.destination).isDirectory() ? readdirSync(plan.destination) : [basename(plan.destination)];
    if (entries.length > 0) throw new FactoryStateMigrationError("destination_nonempty", "destination must not contain state");
    throw new FactoryStateMigrationError("destination_exists", "destination must not exist before atomic rename");
  }
  return current;
}

function assertDisposable(plan: FactoryStateMigrationPlan): void {
  if (
    plan.source === LIVE_FACTORY_STATE_SOURCE ||
    plan.destination === LIVE_FACTORY_STATE_DESTINATION ||
    plan.source.startsWith(`${LIVE_FACTORY_STATE_SOURCE}${sep}`) ||
    plan.destination.startsWith(`${LIVE_FACTORY_STATE_DESTINATION}${sep}`)
  ) {
    throw new FactoryStateMigrationError("live_apply_forbidden", "this seed permits planning against live state but forbids live apply or rollback");
  }
}

export function applyFactoryStateMigration(plan: FactoryStateMigrationPlan): FactoryStateMarker {
  assertDisposable(plan);
  verifyFactoryStateMigrationPlan(plan);
  const marker: FactoryStateMarker = {
    namespace: FACTORY_STATE_NAMESPACE,
    schema_version: FACTORY_STATE_SCHEMA_VERSION,
    root_id: randomUUID(),
    canonical_path: plan.destination,
    generation: 1,
    device: plan.source_device,
    created_at: new Date().toISOString(),
  };
  const sourceMarker = join(plan.source, FACTORY_STATE_MARKER);
  let markerCreated = false;
  try {
    writeFileSync(sourceMarker, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
    markerCreated = true;
    renameSync(plan.source, plan.destination);
  } catch (error) {
    if (markerCreated && existsSync(sourceMarker)) rmSync(sourceMarker);
    throw error;
  }
  validateFactoryStateMarker(plan.destination);
  const after = digestFactoryState(plan.destination);
  if (after.sha256 !== plan.source_digest.sha256) throw new FactoryStateMigrationError("digest_mismatch", "destination digest does not match the migration plan");
  return marker;
}

export function rollbackFactoryStateMigration(plan: FactoryStateMigrationPlan): void {
  assertDisposable(plan);
  if (existsSync(plan.source) || !existsSync(plan.destination)) {
    throw new FactoryStateMigrationError("rollback_precondition", "rollback requires an absent source and present destination");
  }
  validateFactoryStateMarker(plan.destination);
  const current = digestFactoryState(plan.destination);
  if (current.sha256 !== plan.source_digest.sha256) throw new FactoryStateMigrationError("digest_mismatch", "forward state changed since the plan; stale rollback is forbidden");
  if (statSync(plan.destination).dev !== statSync(dirname(plan.source)).dev) {
    throw new FactoryStateMigrationError("cross_device", "rollback requires the same filesystem");
  }
  renameSync(plan.destination, plan.source);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const parent = dirname(path);
  directDirectory(parent, "journal parent");
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncDirectory(parent);
}

function readJsonFile<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new FactoryStateMigrationError("invalid_json", `${label} is not valid JSON: ${path}`);
  }
}

function readHardlinkJournal(plan: FactoryStateHardlinkMigrationPlan, planSha256: string): FactoryStateHardlinkJournal {
  if (!pathExists(plan.journal)) throw new FactoryStateMigrationError("journal_missing", "hardlink migration journal is missing");
  const journal = readJsonFile<FactoryStateHardlinkJournal>(plan.journal, "hardlink migration journal");
  if (
    journal.version !== 1 || journal.plan_sha256 !== planSha256 ||
    journal.manifest_sha256 !== plan.manifest_sha256 ||
    !["forward", "rollback"].includes(journal.operation) ||
    ![
      "planned", "staging", "staged_verified", "destination_published",
      "legacy_retiring", "compatibility_linked", "rolled_back_pre_write",
    ].includes(journal.stage) ||
    !journal.root_id
  ) throw new FactoryStateMigrationError("journal_mismatch", "hardlink migration journal does not match the approved plan");
  return journal;
}

function writeHardlinkJournal(plan: FactoryStateHardlinkMigrationPlan, journal: FactoryStateHardlinkJournal): void {
  writeJsonAtomic(plan.journal, { ...journal, updated_at: new Date().toISOString() });
}

function acquireHardlinkLock(plan: FactoryStateHardlinkMigrationPlan, planSha256: string): void {
  const lock: FactoryStateHardlinkLock = {
    version: 1,
    pid: process.pid,
    plan_sha256: planSha256,
    manifest_sha256: plan.manifest_sha256,
    source: plan.source,
    destination: plan.destination,
    started_at: new Date().toISOString(),
  };
  let descriptor: number;
  try {
    descriptor = openSync(plan.lock, "wx", 0o600);
  } catch {
    throw new FactoryStateMigrationError("lock_exists", "hardlink migration lock already exists");
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(plan.lock));
}

function releaseHardlinkLock(plan: FactoryStateHardlinkMigrationPlan): void {
  if (!pathExists(plan.lock)) return;
  const lock = readJsonFile<FactoryStateHardlinkLock>(plan.lock, "hardlink migration lock");
  if (lock.pid !== process.pid) throw new FactoryStateMigrationError("lock_owner", "hardlink migration lock is owned by another process");
  unlinkSync(plan.lock);
  fsyncDirectory(dirname(plan.lock));
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function clearOrphanHardlinkLock(plan: FactoryStateHardlinkMigrationPlan, planSha256: string): void {
  if (!pathExists(plan.lock)) return;
  const lock = readJsonFile<FactoryStateHardlinkLock>(plan.lock, "hardlink migration lock");
  if (
    lock.version !== 1 || lock.plan_sha256 !== planSha256 || lock.manifest_sha256 !== plan.manifest_sha256 ||
    lock.source !== plan.source || lock.destination !== plan.destination
  ) throw new FactoryStateMigrationError("lock_mismatch", "orphan lock does not match the approved plan");
  if (processIsAlive(lock.pid)) throw new FactoryStateMigrationError("lock_active", `hardlink migration process is still active: ${lock.pid}`);
  unlinkSync(plan.lock);
  fsyncDirectory(dirname(plan.lock));
}

function maybeInterrupt(stage: FactoryStateHardlinkStage, options: FactoryStateHardlinkExecutionOptions): void {
  if (options.interruptAfterStage === stage) {
    throw new FactoryStateMigrationError("injected_interrupt", `injected interruption after ${stage}`);
  }
}

function moveJournalStage(
  plan: FactoryStateHardlinkMigrationPlan,
  journal: FactoryStateHardlinkJournal,
  stage: FactoryStateHardlinkStage,
  options: FactoryStateHardlinkExecutionOptions,
): FactoryStateHardlinkJournal {
  const next = { ...journal, stage };
  writeHardlinkJournal(plan, next);
  maybeInterrupt(stage, options);
  return next;
}

function createStagingTree(plan: FactoryStateHardlinkMigrationPlan): void {
  if (!pathExists(plan.staging)) mkdirSync(plan.staging, { mode: 0o700 });
  const rootStat = lstatSync(plan.staging);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== plan.source_device) {
    throw new FactoryStateMigrationError("staging_mismatch", "staging root is not a same-device real directory");
  }
  const directories = plan.entries.filter((entry) => entry.type === "directory");
  for (const entry of directories) {
    const target = rootEntry(plan.staging, entry.path);
    if (!pathExists(target)) mkdirSync(target, { mode: 0o700 });
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new FactoryStateMigrationError("staging_mismatch", `staging directory mismatch: ${entry.path}`);
    }
  }
  for (const entry of plan.entries.filter((candidate) => candidate.type === "file")) {
    const source = rootEntry(plan.source, entry.path);
    const target = rootEntry(plan.staging, entry.path);
    verifyEntryAtRoot(plan.source, entry, true);
    if (!pathExists(target)) linkSync(source, target);
    verifyEntryAtRoot(plan.staging, entry, true);
  }
  for (const entry of [...directories].sort((left, right) => right.path.split("/").length - left.path.split("/").length)) {
    chmodSync(rootEntry(plan.staging, entry.path), entry.mode);
  }
  chmodSync(plan.staging, plan.source_mode);
  verifyCompleteNamespace(plan.staging, plan, false);
}

function expectedHardlinkMarker(plan: FactoryStateHardlinkMigrationPlan, journal: FactoryStateHardlinkJournal): FactoryStateMarker {
  return {
    namespace: FACTORY_STATE_NAMESPACE,
    schema_version: FACTORY_STATE_SCHEMA_VERSION,
    root_id: journal.root_id,
    canonical_path: plan.destination,
    generation: 1,
    device: plan.source_device,
    created_at: journal.updated_at,
  };
}

function ensureStagingMarker(plan: FactoryStateHardlinkMigrationPlan, journal: FactoryStateHardlinkJournal): void {
  const markerPath = join(plan.staging, FACTORY_STATE_MARKER);
  const expected = expectedHardlinkMarker(plan, journal);
  if (!pathExists(markerPath)) {
    writeFileSync(markerPath, `${JSON.stringify(expected, null, 2)}\n`, { flag: "wx" });
    return;
  }
  const current = readJsonFile<FactoryStateMarker>(markerPath, "staging marker");
  if (
    current.namespace !== expected.namespace || current.schema_version !== expected.schema_version ||
    current.root_id !== expected.root_id || current.canonical_path !== expected.canonical_path ||
    current.generation !== expected.generation || current.device !== expected.device
  ) throw new FactoryStateMigrationError("marker_mismatch", "pre-existing staging marker does not match the journal");
}

function ensureCompatibilityTemp(plan: FactoryStateHardlinkMigrationPlan): void {
  if (!pathExists(plan.compatibility_link_temp)) symlinkSync(plan.destination, plan.compatibility_link_temp);
  const stat = lstatSync(plan.compatibility_link_temp);
  if (!stat.isSymbolicLink() || readlinkSync(plan.compatibility_link_temp) !== plan.destination) {
    throw new FactoryStateMigrationError("compatibility_mismatch", "temporary compatibility link does not target the destination");
  }
}

function verifyRemainingSource(plan: FactoryStateHardlinkMigrationPlan): void {
  if (sourceKind(plan) === "absent") return;
  if (sourceKind(plan) !== "directory") {
    throw new FactoryStateMigrationError("source_mismatch", "legacy source is neither a directory nor absent during retirement");
  }
  const planned = new Map(plan.entries.map((entry) => [entry.path, entry]));
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const rel = relative(plan.source, path).replaceAll("\\", "/");
      const entry = planned.get(rel);
      if (!entry) throw new FactoryStateMigrationError("source_drift", `unexpected source entry during retirement: ${rel}`);
      verifyEntryAtRoot(plan.source, entry, entry.type === "file");
      if (entry.type === "directory") visit(path);
    }
  };
  visit(plan.source);
}

function retireLegacySource(plan: FactoryStateHardlinkMigrationPlan): void {
  const kind = sourceKind(plan);
  if (kind === "compatibility-link") return;
  if (kind !== "absent" && kind !== "directory") {
    throw new FactoryStateMigrationError("source_mismatch", "legacy source cannot be retired safely");
  }
  if (kind === "directory") {
    verifyRemainingSource(plan);
    for (const entry of plan.entries.filter((candidate) => candidate.type === "file")) {
      const source = rootEntry(plan.source, entry.path);
      if (!pathExists(source)) continue;
      const destination = rootEntry(plan.destination, entry.path);
      const sourceStat = lstatSync(source);
      const destinationStat = lstatSync(destination);
      if (sourceStat.dev !== destinationStat.dev || sourceStat.ino !== destinationStat.ino) {
        throw new FactoryStateMigrationError("inode_mismatch", `source retirement lacks destination inode proof: ${entry.path}`);
      }
      unlinkSync(source);
    }
    const directories = plan.entries
      .filter((entry) => entry.type === "directory")
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length || right.path.localeCompare(left.path));
    for (const entry of directories) {
      const path = rootEntry(plan.source, entry.path);
      if (pathExists(path)) rmdirSync(path);
    }
    rmdirSync(plan.source);
  }
  if (!pathExists(plan.source)) {
    if (!pathExists(plan.compatibility_link_temp)) {
      throw new FactoryStateMigrationError("compatibility_missing", "temporary compatibility link is missing after source retirement");
    }
    renameSync(plan.compatibility_link_temp, plan.source);
    fsyncDirectory(dirname(plan.source));
  }
  if (sourceKind(plan) !== "compatibility-link") {
    throw new FactoryStateMigrationError("compatibility_mismatch", "legacy source compatibility link was not installed");
  }
}

function resumeForwardHardlinkMigration(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256: string,
  options: FactoryStateHardlinkExecutionOptions,
): FactoryStateHardlinkStatus {
  let journal = readHardlinkJournal(plan, planSha256);
  if (journal.operation !== "forward") throw new FactoryStateMigrationError("journal_operation", "journal is not in forward mode");
  if (journal.stage === "planned") {
    journal = moveJournalStage(plan, journal, "staging", options);
  }
  if (journal.stage === "staging") {
    createStagingTree(plan);
    journal = moveJournalStage(plan, journal, "staged_verified", options);
  }
  if (journal.stage === "staged_verified") {
    if (pathExists(plan.destination)) {
      if (pathExists(plan.staging)) throw new FactoryStateMigrationError("publish_ambiguous", "both staging and destination exist");
      verifyCompleteNamespace(plan.destination, plan, true);
    } else {
      createStagingTree(plan);
      ensureStagingMarker(plan, journal);
      renameSync(plan.staging, plan.destination);
      fsyncDirectory(dirname(plan.destination));
      verifyCompleteNamespace(plan.destination, plan, true);
    }
    journal = moveJournalStage(plan, journal, "destination_published", options);
  }
  if (journal.stage === "destination_published") {
    verifyCompleteNamespace(plan.destination, plan, true);
    ensureCompatibilityTemp(plan);
    journal = moveJournalStage(plan, journal, "legacy_retiring", options);
  }
  if (journal.stage === "legacy_retiring") {
    verifyCompleteNamespace(plan.destination, plan, true);
    if (sourceKind(plan) !== "compatibility-link") ensureCompatibilityTemp(plan);
    retireLegacySource(plan);
    journal = moveJournalStage(plan, journal, "compatibility_linked", options);
  }
  if (journal.stage !== "compatibility_linked") {
    throw new FactoryStateMigrationError("journal_stage", `forward recovery cannot continue from ${journal.stage}`);
  }
  verifyCompleteNamespace(plan.destination, plan, true);
  if (sourceKind(plan) !== "compatibility-link") {
    throw new FactoryStateMigrationError("compatibility_mismatch", "completed migration lacks the compatibility link");
  }
  return statusFactoryStateHardlinkMigration(plan, planSha256);
}

export function applyFactoryStateHardlinkMigration(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256 = factoryStateHardlinkPlanSha256(plan),
  options: FactoryStateHardlinkExecutionOptions = {},
): FactoryStateHardlinkStatus {
  assertPlanHash(plan, planSha256);
  verifyFactoryStateHardlinkMigrationPlan(plan);
  acquireHardlinkLock(plan, planSha256);
  const journal: FactoryStateHardlinkJournal = {
    version: 1,
    plan_sha256: planSha256,
    manifest_sha256: plan.manifest_sha256,
    operation: "forward",
    stage: "planned",
    root_id: randomUUID(),
    updated_at: new Date().toISOString(),
  };
  writeHardlinkJournal(plan, journal);
  maybeInterrupt("planned", options);
  const status = resumeForwardHardlinkMigration(plan, planSha256, options);
  releaseHardlinkLock(plan);
  return { ...status, lock_present: false };
}

export function statusFactoryStateHardlinkMigration(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256 = factoryStateHardlinkPlanSha256(plan),
): FactoryStateHardlinkStatus {
  assertPlanHash(plan, planSha256);
  const journal = pathExists(plan.journal) ? readHardlinkJournal(plan, planSha256) : undefined;
  return {
    plan_sha256: planSha256,
    manifest_sha256: plan.manifest_sha256,
    operation: journal?.operation ?? "forward",
    stage: journal?.stage ?? "planned",
    source: sourceKind(plan),
    destination_present: pathExists(plan.destination),
    staging_present: pathExists(plan.staging),
    compatibility_link_temp_present: pathExists(plan.compatibility_link_temp),
    lock_present: pathExists(plan.lock),
  };
}

export function verifyFactoryStateHardlinkContinuity(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256 = factoryStateHardlinkPlanSha256(plan),
  baseline?: FactoryStateHardlinkContinuity,
): FactoryStateHardlinkContinuity {
  assertPlanHash(plan, planSha256);
  assertHardlinkExecutionParents(plan);
  if (!pathExists(plan.journal) || !lstatSync(plan.journal).isFile() || lstatSync(plan.journal).isSymbolicLink()) {
    throw new FactoryStateMigrationError("journal_mismatch", "completed migration journal must be a regular file");
  }
  const journal = readHardlinkJournal(plan, planSha256);
  if (journal.operation !== "forward" || journal.stage !== "compatibility_linked") {
    throw new FactoryStateMigrationError("continuity_stage", "continuity proof requires a completed forward compatibility-link cutover");
  }
  if (pathExists(plan.lock) || pathExists(plan.staging) || pathExists(plan.compatibility_link_temp)) {
    throw new FactoryStateMigrationError("continuity_residue", "completed migration retains lock, staging, or temporary compatibility residue");
  }
  if (sourceKind(plan) !== "compatibility-link") {
    throw new FactoryStateMigrationError("compatibility_mismatch", "completed migration lacks the exact compatibility link");
  }
  const namespace = observeStableCompletedNamespace(plan.destination);
  const expectedInventorySha256 = sha256Text(JSON.stringify(plan.entries.map(stableEntry)));
  if (
    namespace.rootMode !== plan.source_mode ||
    namespace.inventorySha256 !== expectedInventorySha256 ||
    namespace.entries !== plan.entries.length ||
    namespace.digest.sha256 !== plan.source_digest.sha256 ||
    namespace.digest.files !== plan.source_digest.files ||
    namespace.digest.bytes !== plan.source_digest.bytes
  ) {
    throw new FactoryStateMigrationError("continuity_mismatch", "completed migration continuity does not match the frozen plan");
  }
  const marker = validateFactoryStateMarker(plan.destination);
  if (
    marker.root_id !== journal.root_id || marker.generation !== 1 ||
    marker.canonical_path !== plan.destination || marker.device !== plan.source_device
  ) {
    throw new FactoryStateMigrationError("marker_mismatch", "destination marker is not bound to the completed migration journal and plan");
  }
  const observation: FactoryStateHardlinkContinuity = {
    version: 1,
    plan_sha256: planSha256,
    journal_sha256: sha256Text(readFileSync(plan.journal, "utf8")),
    manifest_sha256: plan.manifest_sha256,
    root_id: marker.root_id,
    stage: "compatibility_linked",
    source: plan.source,
    destination: plan.destination,
    root_mode: namespace.rootMode,
    inventory_sha256: namespace.inventorySha256,
    digest: namespace.digest,
    entries: namespace.entries,
  };
  if (baseline) {
    const normalized: FactoryStateHardlinkContinuity = {
      version: baseline.version,
      plan_sha256: baseline.plan_sha256,
      journal_sha256: baseline.journal_sha256,
      manifest_sha256: baseline.manifest_sha256,
      root_id: baseline.root_id,
      stage: baseline.stage,
      source: baseline.source,
      destination: baseline.destination,
      root_mode: baseline.root_mode,
      inventory_sha256: baseline.inventory_sha256,
      digest: {
        sha256: baseline.digest?.sha256,
        files: baseline.digest?.files,
        bytes: baseline.digest?.bytes,
      },
      entries: baseline.entries,
    };
    if (JSON.stringify(normalized) !== JSON.stringify(observation)) {
      throw new FactoryStateMigrationError("continuity_mismatch", "completed migration namespace changed from the supplied continuity baseline");
    }
  }
  return observation;
}

function rebuildLegacySource(plan: FactoryStateHardlinkMigrationPlan): void {
  const kind = sourceKind(plan);
  if (kind === "compatibility-link") unlinkSync(plan.source);
  else if (kind !== "absent" && kind !== "directory") {
    throw new FactoryStateMigrationError("rollback_source", "rollback source path is unsafe");
  }
  if (!pathExists(plan.source)) mkdirSync(plan.source, { mode: 0o700 });
  for (const entry of plan.entries.filter((candidate) => candidate.type === "directory")) {
    const target = rootEntry(plan.source, entry.path);
    if (!pathExists(target)) mkdirSync(target, { mode: 0o700 });
    if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) {
      throw new FactoryStateMigrationError("rollback_source", `rollback directory mismatch: ${entry.path}`);
    }
  }
  for (const entry of plan.entries.filter((candidate) => candidate.type === "file")) {
    const destination = rootEntry(plan.destination, entry.path);
    const source = rootEntry(plan.source, entry.path);
    if (!pathExists(source)) {
      if (!pathExists(destination)) {
        throw new FactoryStateMigrationError("rollback_incomplete", `file is absent from both rollback namespaces: ${entry.path}`);
      }
      linkSync(destination, source);
    }
    const sourceStat = lstatSync(source);
    if (pathExists(destination)) {
      const destinationStat = lstatSync(destination);
      if (sourceStat.dev !== destinationStat.dev || sourceStat.ino !== destinationStat.ino) {
        throw new FactoryStateMigrationError("inode_mismatch", `rollback lacks destination inode proof: ${entry.path}`);
      }
    } else if (sourceStat.dev !== entry.device || sourceStat.ino !== entry.inode) {
      throw new FactoryStateMigrationError("inode_mismatch", `rollback lacks destination inode proof: ${entry.path}`);
    }
  }
  const directories = plan.entries
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const entry of directories) chmodSync(rootEntry(plan.source, entry.path), entry.mode);
  chmodSync(plan.source, plan.source_mode);
  verifyCompleteNamespace(plan.source, plan, false);
}

function retireHardlinkDestination(plan: FactoryStateHardlinkMigrationPlan): void {
  if (!pathExists(plan.destination)) {
    verifyCompleteNamespace(plan.source, plan, false);
    return;
  }
  for (const entry of plan.entries.filter((candidate) => candidate.type === "file")) {
    const destination = rootEntry(plan.destination, entry.path);
    if (!pathExists(destination)) continue;
    const source = rootEntry(plan.source, entry.path);
    const sourceStat = lstatSync(source);
    const destinationStat = lstatSync(destination);
    if (sourceStat.dev !== destinationStat.dev || sourceStat.ino !== destinationStat.ino) {
      throw new FactoryStateMigrationError("inode_mismatch", `destination retirement lacks source inode proof: ${entry.path}`);
    }
    unlinkSync(destination);
  }
  if (pathExists(join(plan.destination, FACTORY_STATE_MARKER))) unlinkSync(join(plan.destination, FACTORY_STATE_MARKER));
  const directories = plan.entries
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length || right.path.localeCompare(left.path));
  for (const entry of directories) {
    const path = rootEntry(plan.destination, entry.path);
    if (pathExists(path)) rmdirSync(path);
  }
  rmdirSync(plan.destination);
  fsyncDirectory(dirname(plan.destination));
}

function resumeRollbackHardlinkMigration(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256: string,
  options: FactoryStateHardlinkExecutionOptions,
): FactoryStateHardlinkStatus {
  const journal = readHardlinkJournal(plan, planSha256);
  if (journal.operation !== "rollback") throw new FactoryStateMigrationError("journal_operation", "journal is not in rollback mode");
  if (journal.stage === "rolled_back_pre_write") return statusFactoryStateHardlinkMigration(plan, planSha256);
  if (journal.stage !== "compatibility_linked") {
    throw new FactoryStateMigrationError("rollback_precondition", "rollback requires a completed compatibility-link cutover");
  }
  rebuildLegacySource(plan);
  retireHardlinkDestination(plan);
  const completed = moveJournalStage(plan, journal, "rolled_back_pre_write", options);
  if (completed.stage !== "rolled_back_pre_write" || sourceKind(plan) !== "directory" || pathExists(plan.destination)) {
    throw new FactoryStateMigrationError("rollback_incomplete", "pre-write rollback did not restore one legacy namespace");
  }
  return statusFactoryStateHardlinkMigration(plan, planSha256);
}

export function rollbackFactoryStateHardlinkMigration(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256 = factoryStateHardlinkPlanSha256(plan),
  options: FactoryStateHardlinkExecutionOptions = {},
): FactoryStateHardlinkStatus {
  assertPlanHash(plan, planSha256);
  assertHardlinkExecutionParents(plan);
  const journal = readHardlinkJournal(plan, planSha256);
  if (journal.operation !== "forward" || journal.stage !== "compatibility_linked") {
    throw new FactoryStateMigrationError("rollback_precondition", "rollback requires a completed forward hardlink migration");
  }
  if (sourceKind(plan) !== "compatibility-link") {
    throw new FactoryStateMigrationError("rollback_precondition", "rollback requires the validated compatibility link");
  }
  verifyCompleteNamespace(plan.destination, plan, true);
  acquireHardlinkLock(plan, planSha256);
  writeHardlinkJournal(plan, { ...journal, operation: "rollback" });
  const status = resumeRollbackHardlinkMigration(plan, planSha256, options);
  releaseHardlinkLock(plan);
  return { ...status, lock_present: false };
}

export function recoverFactoryStateHardlinkMigration(
  plan: FactoryStateHardlinkMigrationPlan,
  planSha256 = factoryStateHardlinkPlanSha256(plan),
  options: FactoryStateHardlinkExecutionOptions = {},
): FactoryStateHardlinkStatus {
  assertPlanHash(plan, planSha256);
  assertHardlinkExecutionParents(plan);
  const journal = readHardlinkJournal(plan, planSha256);
  clearOrphanHardlinkLock(plan, planSha256);
  acquireHardlinkLock(plan, planSha256);
  const status = journal.operation === "forward"
    ? resumeForwardHardlinkMigration(plan, planSha256, options)
    : resumeRollbackHardlinkMigration(plan, planSha256, options);
  releaseHardlinkLock(plan);
  return { ...status, lock_present: false };
}

function readCanonicalHardlinkPlan(path: string): { plan: FactoryStateHardlinkMigrationPlan; sha256: string } {
  const raw = readFileSync(path, "utf8");
  const plan = readJsonFile<FactoryStateHardlinkMigrationPlan>(path, "hardlink migration plan");
  const canonical = serializeFactoryStateHardlinkPlan(plan);
  if (raw !== canonical) {
    throw new FactoryStateMigrationError("plan_not_canonical", "hardlink migration plan bytes are not canonical");
  }
  return { plan, sha256: sha256Text(raw) };
}

function readCanonicalPostCutoverBaseline(path: string): { baseline: FactoryStatePostCutoverBaseline; sha256: string } {
  const raw = readFileSync(path, "utf8");
  const baseline = readJsonFile<FactoryStatePostCutoverBaseline>(path, "post-cutover continuity baseline");
  if (raw !== serializeFactoryStatePostCutoverBaseline(baseline)) {
    throw new FactoryStateMigrationError("baseline_not_canonical", "post-cutover continuity baseline bytes are not canonical");
  }
  return { baseline, sha256: sha256Text(raw) };
}

function readCanonicalContinuityMutationPolicy(path: string): {
  policy: FactoryStateContinuityMutationPolicy;
  sha256: string;
} {
  const raw = readFileSync(path, "utf8");
  const policy = readJsonFile<FactoryStateContinuityMutationPolicy>(path, "post-cutover continuity mutation policy");
  if (raw !== serializeFactoryStateContinuityMutationPolicy(policy)) {
    throw new FactoryStateMigrationError("policy_not_canonical", "post-cutover continuity mutation policy bytes are not canonical");
  }
  return { policy, sha256: sha256Text(raw) };
}

function parseArgs(argv: string[]): Record<string, string> & { command: string } {
  const [command = "plan", ...rest] = argv;
  const result: Record<string, string> & { command: string } = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (!key || !rest[i]?.startsWith("--") || !rest[i + 1]) {
      throw new FactoryStateMigrationError("usage", `missing value for ${rest[i]}`);
    }
    result[key] = rest[i + 1];
  }
  return result;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "plan") {
    if (!args.source || !args.destination) throw new FactoryStateMigrationError("usage", "plan requires --source and --destination");
    const plan = planFactoryStateMigration(args.source, args.destination);
    if (args.out) writeFileSync(args.out, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify(plan, null, 2));
  } else if (args.command === "plan-hardlink") {
    if (
      !args.source || !args.destination || !args.staging || !args.journal || !args.lock ||
      !args["compatibility-link"] || !args["manifest-sha256"]
    ) {
      throw new FactoryStateMigrationError(
        "usage",
        "plan-hardlink requires --source, --destination, --staging, --journal, --lock, --compatibility-link, and --manifest-sha256",
      );
    }
    const plan = planFactoryStateHardlinkMigration(args.source, args.destination, {
      staging: args.staging,
      journal: args.journal,
      lock: args.lock,
      compatibilityLinkTemp: args["compatibility-link"],
      manifestSha256: args["manifest-sha256"],
    });
    const serialized = serializeFactoryStateHardlinkPlan(plan);
    if (args.out) writeFileSync(args.out, serialized, { flag: "wx" });
    console.log(serialized.trimEnd());
  } else if (args.command === "capture-hardlink-continuity") {
    if (!args.plan) throw new FactoryStateMigrationError("usage", "capture-hardlink-continuity requires --plan");
    const loaded = readCanonicalHardlinkPlan(args.plan);
    const baseline = captureFactoryStatePostCutoverContinuity(loaded.plan, loaded.sha256);
    const serialized = serializeFactoryStatePostCutoverBaseline(baseline);
    const baselineSha256 = sha256Text(serialized);
    if (args.out) writeFileSync(args.out, serialized, { flag: "wx" });
    console.log(JSON.stringify({ ok: true, baseline_sha256: baselineSha256, status: baseline }, null, 2));
  } else if (args.command === "compare-hardlink-continuity") {
    if (!args.plan || !args.baseline || !args["baseline-sha256"]) {
      throw new FactoryStateMigrationError(
        "usage",
        "compare-hardlink-continuity requires --plan, --baseline, and --baseline-sha256",
      );
    }
    if ((args.policy && !args["policy-sha256"]) || (!args.policy && args["policy-sha256"])) {
      throw new FactoryStateMigrationError("usage", "--policy and --policy-sha256 must be supplied together");
    }
    const loaded = readCanonicalHardlinkPlan(args.plan);
    const loadedBaseline = readCanonicalPostCutoverBaseline(args.baseline);
    if (loadedBaseline.sha256 !== args["baseline-sha256"]) {
      throw new FactoryStateMigrationError("baseline_hash_mismatch", "baseline file does not match --baseline-sha256");
    }
    const loadedPolicy = args.policy ? readCanonicalContinuityMutationPolicy(args.policy) : undefined;
    if (loadedPolicy && loadedPolicy.sha256 !== args["policy-sha256"]) {
      throw new FactoryStateMigrationError("policy_hash_mismatch", "policy file does not match --policy-sha256");
    }
    const status = compareFactoryStatePostCutoverContinuity(
      loaded.plan,
      loaded.sha256,
      loadedBaseline.baseline,
      {
        baselineSha256: args["baseline-sha256"],
        ...(loadedPolicy ? { policy: loadedPolicy.policy, policySha256: args["policy-sha256"] } : {}),
      },
    );
    console.log(JSON.stringify({ ok: true, status }, null, 2));
  } else if (["apply-hardlink", "status-hardlink", "recover-hardlink", "rollback-hardlink", "verify-hardlink-continuity"].includes(args.command)) {
    if (!args.plan) throw new FactoryStateMigrationError("usage", `${args.command} requires --plan`);
    const loaded = readCanonicalHardlinkPlan(args.plan);
    const status = args.command === "apply-hardlink"
      ? applyFactoryStateHardlinkMigration(loaded.plan, loaded.sha256)
      : args.command === "status-hardlink"
        ? statusFactoryStateHardlinkMigration(loaded.plan, loaded.sha256)
        : args.command === "verify-hardlink-continuity"
          ? verifyFactoryStateHardlinkContinuity(
            loaded.plan,
            loaded.sha256,
            args.baseline
              ? readJsonFile<FactoryStateHardlinkContinuity>(args.baseline, "hardlink continuity baseline")
              : undefined,
          )
        : args.command === "recover-hardlink"
          ? recoverFactoryStateHardlinkMigration(loaded.plan, loaded.sha256)
          : rollbackFactoryStateHardlinkMigration(loaded.plan, loaded.sha256);
    console.log(JSON.stringify({ ok: true, status }, null, 2));
  } else {
    if (!args.plan) throw new FactoryStateMigrationError("usage", `${args.command} requires --plan`);
    const plan = JSON.parse(readFileSync(args.plan, "utf8")) as FactoryStateMigrationPlan;
    if (args.command === "verify") console.log(JSON.stringify({ ok: true, digest: verifyFactoryStateMigrationPlan(plan) }, null, 2));
    else if (args.command === "apply") console.log(JSON.stringify({ ok: true, marker: applyFactoryStateMigration(plan) }, null, 2));
    else if (args.command === "rollback") { rollbackFactoryStateMigration(plan); console.log(JSON.stringify({ ok: true })); }
    else throw new FactoryStateMigrationError("usage", `unknown command: ${args.command}`);
  }
}
