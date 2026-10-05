#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isExecutionRecordFileName } from "./execution-lifecycle";

declare module "node:util" {
  interface TextEncoderEncodeIntoResult {
    read: number;
    written: number;
  }
}

declare module "node:tls" {
  interface ConnectionOptions {}
  interface KeyObject {}
  interface TLSSocket {}
}

export const DREDGE_SCHEMA_VERSION = 1 as const;
export const DREDGE_EVIDENCE_LIMIT = 12;
export const DREDGE_EXCERPT_LIMIT = 240;

export type DredgeCategory = "timeout" | "OOM" | "exception" | "stall";
export type DredgeStatus = "classified" | "unclassified";

export type StubDetector =
  | "stub-body"
  | "not-implemented"
  | "stub-marker"
  | "empty-catch"
  | "skipped-test";

export interface StubFinding {
  detector: StubDetector;
  file: string;
  line: number;
  evidence: string;
  reason: string;
}

export interface StubScanOutcome {
  mode: "off" | "advisory" | "enforce";
  result: {
    ok: boolean;
    findings: StubFinding[];
    reason: string | null;
  };
}

export interface DredgeEvidence {
  source: "execution_record" | "execution_log";
  code: string;
  line: number;
  excerpt: string;
}

export interface DredgeClassification {
  category: DredgeCategory | null;
  reason: string;
}

export interface DredgeArtifacts {
  execution_record: string;
  execution_log: string | null;
  scanner_sidecar: string | null;
}

export interface DredgeReport {
  schema_version: typeof DREDGE_SCHEMA_VERSION;
  execution_id: string | null;
  identifier: string | null;
  status: DredgeStatus;
  classification: DredgeClassification;
  summary: string;
  evidence: DredgeEvidence[];
  artifacts: DredgeArtifacts;
  scanner_evidence: StubScanOutcome | null;
  warnings: string[];
  generated_at: string;
}

export interface DredgeInput {
  executionRecordText: string | null;
  executionRecordPath: string;
  logText?: string | null;
  logPath?: string | null;
  scannerSidecarText?: string | null;
  scannerSidecarPath?: string | null;
  warnings?: readonly string[];
}

export interface DredgeOptions {
  now?: () => Date | string;
}

type JsonObject = Record<string, unknown>;

interface TextSource {
  source: DredgeEvidence["source"];
  text: string;
}

interface ParsedExecutionRecord {
  record: JsonObject | null;
  warning: string | null;
}

interface ClassificationResult {
  classification: DredgeClassification;
  evidence: DredgeEvidence[];
}

const STUB_DETECTORS = new Set<StubDetector>([
  "stub-body",
  "not-implemented",
  "stub-marker",
  "empty-catch",
  "skipped-test",
]);

const STUB_MODES = new Set<StubScanOutcome["mode"]>(["off", "advisory", "enforce"]);

const EXPLICIT_OOM = /\b(?:out of memory|oom[ -]?(?:kill(?:ed)?|killer)|heap exhaustion|heap out of memory|allocation failed|cannot allocate memory|enomem)\b/i;
const EXIT_137 = /\b(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|exit_code|code)\s*[:=]?\s*137\b/i;
const MEMORY_CONTEXT = /\b(?:memory|heap|rss|oom)\b/i;
const IDLE_TIMEOUT = /\bidle[ _-]?(?:timed out|timeout)\b/i;
const EXPLICIT_TIMEOUT = /\b(?:timed out|timeout (?:after|exceeded|reached)|deadline exceeded|deadline expired|cancelled|canceled|etimedout)\b/i;
const REAPER_STALL = /\[reaper\].*\b(?:failed orphaned|reaped:)\b/i;
const STALL_SIGNAL = /\b(?:heartbeat (?:stale|expired|missing)|no heartbeat|stalled execution|execution stalled|no (?:activity|update|progress) for)\b/i;
const EXPLICIT_EXCEPTION = /\b(?:uncaught exception|unhandled(?:promiserejection| exception)|[A-Za-z_$][\w$]*(?:Error|Exception):|panic:|throw:)/i;
const STACK_FRAME = /^\s*at\s+(?:async\s+)?(?:[^\s(]+\s+)?\(?[^\s()]+:\d+:\d+\)?\s*$/;

const SECRET_ASSIGNMENT = /((?:["']?(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer[_-]?token|client[_-]?secret|credential|password|passwd|secret|token)["']?)\s*[:=]\s*)(["']?)([^\s,"'}\]]+)/gi;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const WELL_KNOWN_SECRET = /\b(?:sk|gh[pousr]|xox[baprs])-[A-Za-z0-9_-]{8,}\b/gi;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function lineFor(text: string, predicate: (line: string) => boolean): { line: number; text: string } | null {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (predicate(line)) return { line: index + 1, text: line };
  }
  return null;
}

export function redactAndBoundExcerpt(value: string, limit = DREDGE_EXCERPT_LIMIT): string {
  const redacted = value
    .replace(BEARER_SECRET, "Bearer [REDACTED]")
    .replace(WELL_KNOWN_SECRET, "[REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]`)
    .trim();
  if (limit <= 0) return "";
  return redacted.length <= limit ? redacted : `${redacted.slice(0, Math.max(0, limit - 1))}\u2026`;
}

function warning(value: string): string {
  return redactAndBoundExcerpt(value, 400);
}

export function parseExecutionRecord(text: string | null): ParsedExecutionRecord {
  if (text === null) return { record: null, warning: "execution record is missing or unreadable" };
  if (text.trim().length === 0) return { record: null, warning: "execution record is empty" };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) {
      return { record: null, warning: "execution record must be a JSON object" };
    }
    return { record: parsed, warning: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { record: null, warning: warning(`execution record is malformed JSON: ${detail}`) };
  }
}

function normalizeStubFinding(value: unknown): StubFinding | null {
  if (!isJsonObject(value)) return null;
  const detector = value.detector;
  const file = value.file;
  const line = value.line;
  const evidence = value.evidence;
  const reason = value.reason;
  if (
    typeof detector !== "string"
    || !STUB_DETECTORS.has(detector as StubDetector)
    || typeof file !== "string"
    || !Number.isInteger(line)
    || (line as number) < 1
    || typeof evidence !== "string"
    || typeof reason !== "string"
  ) {
    return null;
  }
  return {
    detector: detector as StubDetector,
    file,
    line: line as number,
    evidence: redactAndBoundExcerpt(evidence, 160),
    reason: redactAndBoundExcerpt(reason, 240),
  };
}

export function normalizeStubScanOutcome(value: unknown): StubScanOutcome | null {
  if (!isJsonObject(value) || typeof value.mode !== "string" || !STUB_MODES.has(value.mode as StubScanOutcome["mode"])) {
    return null;
  }
  if (!isJsonObject(value.result) || typeof value.result.ok !== "boolean" || !Array.isArray(value.result.findings)) {
    return null;
  }
  const findings = value.result.findings.map(normalizeStubFinding);
  if (findings.some((item) => item === null)) return null;
  if (value.result.reason !== null && typeof value.result.reason !== "string") return null;
  return {
    mode: value.mode as StubScanOutcome["mode"],
    result: {
      ok: value.result.ok,
      findings: findings as StubFinding[],
      reason: value.result.reason === null ? null : redactAndBoundExcerpt(value.result.reason, 400),
    },
  };
}

function parseScannerSidecar(text: string | null | undefined): { outcome: StubScanOutcome | null; warning: string | null } {
  if (text === undefined || text === null) return { outcome: null, warning: null };
  if (text.trim().length === 0) return { outcome: null, warning: "scanner sidecar is empty" };
  try {
    const parsed: unknown = JSON.parse(text);
    const candidate = isJsonObject(parsed) && "stub_scan" in parsed ? parsed.stub_scan : parsed;
    const outcome = normalizeStubScanOutcome(candidate);
    return outcome
      ? { outcome, warning: null }
      : { outcome: null, warning: "scanner sidecar does not match the StubScanOutcome contract" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { outcome: null, warning: warning(`scanner sidecar is malformed JSON: ${detail}`) };
  }
}

function embeddedScanner(record: JsonObject | null): { outcome: StubScanOutcome | null; warning: string | null } {
  if (!record || !isJsonObject(record.consensus) || !("stub_scan" in record.consensus)) {
    return { outcome: null, warning: null };
  }
  const outcome = normalizeStubScanOutcome(record.consensus.stub_scan);
  return outcome
    ? { outcome, warning: null }
    : { outcome: null, warning: "embedded consensus.stub_scan does not match the StubScanOutcome contract" };
}

function addEvidence(
  target: DredgeEvidence[],
  source: TextSource,
  code: string,
  match: { line: number; text: string } | null,
): void {
  if (!match) return;
  const item: DredgeEvidence = {
    source: source.source,
    code,
    line: match.line,
    excerpt: redactAndBoundExcerpt(match.text),
  };
  if (!target.some((existing) => existing.source === item.source && existing.code === item.code && existing.line === item.line)) {
    target.push(item);
  }
}

function evidenceFor(
  sources: readonly TextSource[],
  code: string,
  predicate: (line: string) => boolean,
): DredgeEvidence[] {
  const found: DredgeEvidence[] = [];
  for (const source of sources) addEvidence(found, source, code, lineFor(source.text, predicate));
  return found;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function deepFind(record: unknown, wanted: ReadonlySet<string>): { key: string; value: unknown } | null {
  if (Array.isArray(record)) {
    for (const value of record) {
      const found = deepFind(value, wanted);
      if (found) return found;
    }
    return null;
  }
  if (!isJsonObject(record)) return null;
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(normalizedKey(key))) return { key, value };
  }
  for (const value of Object.values(record)) {
    const found = deepFind(value, wanted);
    if (found) return found;
  }
  return null;
}

function deepNumber(record: JsonObject | null, ...keys: string[]): { key: string; value: number } | null {
  const found = deepFind(record, new Set(keys.map(normalizedKey)));
  if (!found || typeof found.value !== "number" || !Number.isFinite(found.value)) return null;
  return { key: found.key, value: found.value };
}

function deepTimestamp(record: JsonObject | null, ...keys: string[]): { key: string; value: number } | null {
  const found = deepFind(record, new Set(keys.map(normalizedKey)));
  if (!found || typeof found.value !== "string") return null;
  const value = Date.parse(found.value);
  return Number.isFinite(value) ? { key: found.key, value } : null;
}

function recordLine(source: TextSource | undefined, key: string): { line: number; text: string } | null {
  if (!source) return null;
  const normalized = normalizedKey(key);
  return lineFor(source.text, (line) => normalizedKey(line).includes(normalized));
}

function isFailedRecord(record: JsonObject | null): boolean {
  if (!record) return false;
  return [record.state, record.status, record.stage].some((value) => typeof value === "string" && value.toLowerCase() === "failed");
}

function isoTimestamp(options: DredgeOptions): string {
  const supplied = options.now?.() ?? new Date();
  const date = supplied instanceof Date ? supplied : new Date(supplied);
  if (Number.isNaN(date.getTime())) throw new Error("Dredge clock returned an invalid timestamp");
  return date.toISOString();
}

export function classifyFailure(
  record: JsonObject | null,
  executionRecordText: string | null,
  logText: string | null,
  now: Date,
): ClassificationResult {
  const sources: TextSource[] = [];
  if (executionRecordText !== null) sources.push({ source: "execution_record", text: executionRecordText });
  if (logText !== null) sources.push({ source: "execution_log", text: logText });
  const execSource = sources.find((source) => source.source === "execution_record");
  const combined = sources.map((source) => source.text).join("\n");

  const byCategory: Record<DredgeCategory, DredgeEvidence[]> = {
    OOM: evidenceFor(sources, "oom.explicit", (line) => EXPLICIT_OOM.test(line)),
    timeout: evidenceFor(sources, "timeout.explicit", (line) => !IDLE_TIMEOUT.test(line) && EXPLICIT_TIMEOUT.test(line)),
    stall: [
      ...evidenceFor(sources, "stall.reaper", (line) => REAPER_STALL.test(line)),
      ...evidenceFor(sources, "stall.idle-timeout", (line) => IDLE_TIMEOUT.test(line)),
      ...evidenceFor(sources, "stall.explicit", (line) => STALL_SIGNAL.test(line)),
    ],
    exception: [
      ...evidenceFor(sources, "exception.explicit", (line) => EXPLICIT_EXCEPTION.test(line)),
      ...evidenceFor(sources, "exception.stack-frame", (line) => STACK_FRAME.test(line)),
    ],
  };

  if (MEMORY_CONTEXT.test(combined)) {
    byCategory.OOM.push(...evidenceFor(sources, "oom.exit-137", (line) => EXIT_137.test(line)));
  }

  const timeoutBudget = deepNumber(record, "executor_timeout_ms", "executorTimeoutMs");
  const elapsed = deepNumber(record, "duration_ms", "durationMs", "elapsed_ms", "elapsedMs");
  if (timeoutBudget && timeoutBudget.value > 0 && elapsed && elapsed.value >= timeoutBudget.value && execSource) {
    addEvidence(byCategory.timeout, execSource, "timeout.budget-exhausted", recordLine(execSource, elapsed.key));
  }

  const idleBudget = deepNumber(record, "executor_idle_timeout_ms", "executorIdleTimeoutMs");
  const heartbeat = deepTimestamp(record, "last_heartbeat_at", "lastHeartbeatAt", "heartbeat_at", "heartbeatAt", "last_activity_at", "lastActivityAt");
  const completed = deepTimestamp(record, "completed_at", "completedAt");
  const referenceTime = completed?.value ?? now.getTime();
  if (idleBudget && idleBudget.value > 0 && heartbeat && referenceTime - heartbeat.value >= idleBudget.value && execSource) {
    addEvidence(byCategory.stall, execSource, "stall.heartbeat-inactive", recordLine(execSource, heartbeat.key));
  }

  const recordError = typeof record?.error === "string" ? record.error : null;
  const errorHasHigherSignal = recordError !== null && (
    EXPLICIT_OOM.test(recordError)
    || EXIT_137.test(recordError) && MEMORY_CONTEXT.test(combined)
    || !IDLE_TIMEOUT.test(recordError) && EXPLICIT_TIMEOUT.test(recordError)
    || REAPER_STALL.test(recordError)
    || IDLE_TIMEOUT.test(recordError)
    || STALL_SIGNAL.test(recordError)
  );
  if (isFailedRecord(record) && recordError?.trim() && !errorHasHigherSignal && execSource) {
    addEvidence(byCategory.exception, execSource, "exception.failed-record-error", lineFor(execSource.text, (line) => /["']?error["']?\s*:/.test(line)));
  }

  const precedence: readonly DredgeCategory[] = ["OOM", "timeout", "stall", "exception"];
  const category = precedence.find((candidate) => byCategory[candidate].length > 0) ?? null;
  const evidence = precedence.flatMap((candidate) => byCategory[candidate]).slice(0, DREDGE_EVIDENCE_LIMIT);
  if (category === null) {
    return {
      classification: {
        category: null,
        reason: "No deterministic timeout, OOM, stall, or exception signal was found.",
      },
      evidence,
    };
  }
  const reasons: Record<DredgeCategory, string> = {
    OOM: "Explicit out-of-memory evidence has highest precedence.",
    timeout: "Explicit wall-clock timeout, deadline, cancellation, or exhausted timeout budget was found.",
    stall: "Reaper, idle-timeout, or stale-heartbeat evidence was found.",
    exception: "An exception signal or failed record with a non-timeout error was found.",
  };
  return { classification: { category, reason: reasons[category] }, evidence };
}

function inferExecutionId(path: string): string | null {
  const name = basename(path);
  if (!isExecutionRecordFileName(name)) return null;
  return name.slice("exec-".length, -".json".length);
}

export function analyzeDredge(input: DredgeInput, options: DredgeOptions = {}): DredgeReport {
  const generatedAt = isoTimestamp(options);
  const parsed = parseExecutionRecord(input.executionRecordText);
  const warnings = [...(input.warnings ?? [])].map(warning);
  if (parsed.warning) warnings.push(parsed.warning);
  if (input.logText === undefined || input.logText === null) {
    warnings.push(input.logPath ? "execution log is missing or unreadable" : "execution log was not supplied");
  } else {
    if (input.logText.includes("\0")) warnings.push("execution log contains NUL bytes and may be malformed");
    if (/\[truncated\]|\b(?:output|log) truncated\b/i.test(input.logText)) warnings.push("execution log appears truncated");
  }

  const sidecar = parseScannerSidecar(input.scannerSidecarText);
  if (sidecar.warning) warnings.push(sidecar.warning);
  const embedded = embeddedScanner(parsed.record);
  if (embedded.warning) warnings.push(embedded.warning);
  const scannerEvidence = sidecar.outcome ?? embedded.outcome;

  const classified = classifyFailure(
    parsed.record,
    input.executionRecordText,
    input.logText ?? null,
    new Date(generatedAt),
  );
  const executionId = stringValue(parsed.record?.execution_id) ?? inferExecutionId(input.executionRecordPath);
  const identifier = stringValue(parsed.record?.identifier);
  const status: DredgeStatus = classified.classification.category === null ? "unclassified" : "classified";
  const subject = executionId ? `Execution ${executionId}` : "Execution";
  const summary = status === "classified"
    ? `${subject} was classified as ${classified.classification.category}. ${classified.classification.reason}`
    : `${subject} could not be classified from the available artifacts.`;

  return {
    schema_version: DREDGE_SCHEMA_VERSION,
    execution_id: executionId,
    identifier,
    status,
    classification: classified.classification,
    summary,
    evidence: classified.evidence,
    artifacts: {
      execution_record: input.executionRecordPath,
      execution_log: input.logPath ?? null,
      scanner_sidecar: input.scannerSidecarPath ?? null,
    },
    scanner_evidence: scannerEvidence,
    warnings: [...new Set(warnings)],
    generated_at: generatedAt,
  };
}

function readArtifact(path: string, label: string): { text: string | null; warning: string | null } {
  try {
    return { text: readFileSync(path, "utf8"), warning: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { text: null, warning: warning(`${label} could not be read at ${path}: ${detail}`) };
  }
}

export function writeDredgeReport(
  report: DredgeReport,
  outputPath: string,
  options: { overwrite?: boolean } = {},
): string {
  const path = resolve(outputPath);
  if (existsSync(path) && options.overwrite !== true) {
    throw new Error(`refusing to clobber existing Dredge report ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
  return path;
}

const USAGE = "Usage: bun dredge.ts --exec <exec-*.json> [--log <executor.log>] [--scanner-sidecar <stub-scan.json>] [--out <report.json>]";

export function runDredgeCli(args: readonly string[] = Bun.argv.slice(2)): number {
  const { values } = parseArgs({
    args: [...args],
    options: {
      exec: { type: "string" },
      log: { type: "string" },
      "scanner-sidecar": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!values.exec) throw new Error(`--exec is required. ${USAGE}`);

  const execPath = resolve(values.exec);
  const logPath = values.log ? resolve(values.log) : null;
  const scannerPath = values["scanner-sidecar"] ? resolve(values["scanner-sidecar"]) : null;
  const outPath = values.out ? resolve(values.out) : null;
  if (outPath && [execPath, logPath, scannerPath].includes(outPath)) {
    throw new Error("--out must not refer to an input artifact");
  }

  const execArtifact = readArtifact(execPath, "execution record");
  const logArtifact = logPath ? readArtifact(logPath, "execution log") : { text: null, warning: null };
  const scannerArtifact = scannerPath ? readArtifact(scannerPath, "scanner sidecar") : { text: null, warning: null };
  const initialWarnings = [execArtifact.warning, logArtifact.warning, scannerArtifact.warning].filter((item): item is string => item !== null);
  const report = analyzeDredge({
    executionRecordText: execArtifact.text,
    executionRecordPath: execPath,
    logText: logArtifact.text,
    logPath,
    scannerSidecarText: scannerArtifact.text,
    scannerSidecarPath: scannerPath,
    warnings: initialWarnings,
  });
  if (outPath) writeDredgeReport(report, outPath);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = runDredgeCli();
  } catch (error) {
    process.stderr.write(`[dredge] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
