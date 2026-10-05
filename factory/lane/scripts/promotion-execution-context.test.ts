import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CERTIFICATION_VALIDATION_CLASSES,
  loadPromotionExecutionBinding,
  preservePersistedPromotionExecutionBinding,
  type LoadPromotionExecutionBindingInput,
  type PromotionExecutionContext,
} from "./promotion-execution-context";

interface Fixture {
  root: string;
  templatePath: string;
  context: PromotionExecutionContext;
  input: LoadPromotionExecutionBindingInput;
}

const roots: string[] = [];
let priorStateMode: string | undefined;
let priorCertify: string | undefined;

function writePrivate(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "promotion-context-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const repoDir = join(root, "repo");
  const attestationDir = join(root, "attestations");
  mkdirSync(repoDir, { mode: 0o700 });
  mkdirSync(attestationDir, { mode: 0o700 });
  const operatorApprovalPath = join(root, "operator-approval.json");
  const operatorApprovalKeyPath = join(root, "operator-approval.key");
  const rollbackEvidencePath = join(root, "rollback-evidence.json");
  const certificationValidationEvidencePath = join(root, "certification-validation-evidence.json");
  const personaKeyPath = join(root, "persona.key");
  writePrivate(operatorApprovalPath, "{}\n");
  writePrivate(operatorApprovalKeyPath, "approval-key\n");
  writePrivate(rollbackEvidencePath, "{}\n");
  writePrivate(personaKeyPath, "persona-key\n");
  const context: PromotionExecutionContext = {
    repository: "marlandoj/zouroboros-workspace",
    repoDir,
    pullRequest: 606,
    baseRef: "main",
    headRef: "work/zou-1343",
    headSha: "a".repeat(40),
    diff: "diff --git a/a b/a\n",
    operatorApprovalPath,
    operatorApprovalKeyPath,
    rollbackEvidencePath,
    certificationValidationEvidencePath,
    personaAttestationPath: join(attestationDir, "persona-attestation.json"),
    personaKeyPath,
  };
  writeValidationEvidence(context);
  const templatePath = join(root, "promotion-context.json");
  const input: LoadPromotionExecutionBindingInput = {
    configuredPath: templatePath,
    executionId: "exec-a1b2c3d4",
    ticketIdentifier: "ZOU-1343",
    expectedRepoDir: repoDir,
    expectedPullRequest: 606,
    expectedHeadRef: "work/zou-1343",
    now: () => "2026-08-24T13:00:00.000Z",
  };
  return { root, templatePath, context, input };
}

function validCommands() {
  return CERTIFICATION_VALIDATION_CLASSES.map((entry, index) => ({
    class: entry,
    command: "/root/.bun/bin/bun",
    args: ["test", entry],
    exitCode: 0,
    startedAt: `2026-08-24T12:${String(index).padStart(2, "0")}:00.000Z`,
    completedAt: `2026-08-24T12:${String(index).padStart(2, "0")}:30.000Z`,
    stdoutSha256: String(index + 1).repeat(64).slice(0, 64),
    stderrSha256: "0".repeat(64),
  }));
}

function writeValidationEvidence(
  context: PromotionExecutionContext,
  overrides: Record<string, unknown> = {},
): void {
  writePrivate(context.certificationValidationEvidencePath!, `${JSON.stringify({
    schema: "zouroboros.certification-validation-evidence/v2",
    repository: context.repository,
    pullRequest: context.pullRequest,
    baseRef: context.baseRef,
    headRef: context.headRef,
    headSha: context.headSha,
    generatedAt: "2026-08-24T12:30:00.000Z",
    expiresAt: "2026-08-24T14:00:00.000Z",
    commands: validCommands(),
    predecessorProvenance: ["R31", "R32", "R33", "R34"].map((round, index) => ({
      round,
      evidenceSha256: String(index + 1).repeat(64),
    })),
    findingClosures: [
      ["R34-F1", "blocker"], ["R34-F2", "blocker"], ["R34-F3", "major"],
      ["R34-F4", "major"], ["R34-F5", "minor"], ["R34-F6", "minor"],
    ].map(([id, severity]) => ({
      id,
      severity,
      evidenceSha256: createHash("sha256").update(`${id}:${severity}`).digest("hex"),
    })),
    ...overrides,
  }, null, 2)}\n`);
}

function writeTemplate(f: Fixture, overrides: Record<string, unknown> = {}): void {
  writePrivate(f.templatePath, `${JSON.stringify({
    schema: "zouroboros.promotion-execution-context-template/v1",
    ticket: "ZOU-1343",
    context: f.context,
    ...overrides,
  }, null, 2)}\n`);
}

function claimPath(f: Fixture, executionId = f.input.executionId): string {
  return `${f.templatePath}.claimed-${executionId}`;
}

function lockPath(f: Fixture): string {
  return `${f.templatePath}.lock`;
}

beforeEach(() => {
  priorStateMode = process.env.FACTORY_STATE_MODE;
  priorCertify = process.env.SF010_CERTIFY;
  process.env.FACTORY_STATE_MODE = "test";
  process.env.SF010_CERTIFY = "1";
});

afterEach(() => {
  if (priorStateMode === undefined) delete process.env.FACTORY_STATE_MODE;
  else process.env.FACTORY_STATE_MODE = priorStateMode;
  if (priorCertify === undefined) delete process.env.SF010_CERTIFY;
  else process.env.SF010_CERTIFY = priorCertify;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("promotion execution context", () => {
  test("rejects legacy validation evidence in a promotion-capable context", () => {
    const f = fixture();
    writeValidationEvidence(f.context, {
      schema: "zouroboros.certification-validation-evidence/v1",
      commands: validCommands().slice(0, 9),
      predecessorProvenance: undefined,
      findingClosures: undefined,
    });
    writeTemplate(f);
    expect(() => loadPromotionExecutionBinding(f.input)).toThrow("requires validation evidence schema v2");
  });

  test("preserves the execution-bound v1 envelope contract", () => {
    const f = fixture();
    const legacyContext = { ...f.context, repository: "legacy-repository-reference" };
    writeValidationEvidence(legacyContext);
    writePrivate(f.templatePath, `${JSON.stringify({
      schema: "zouroboros.promotion-execution-context/v1",
      executionId: f.input.executionId,
      ticket: f.input.ticketIdentifier,
      context: legacyContext,
    })}\n`);
    const binding = loadPromotionExecutionBinding(f.input);
    expect(binding).toEqual({ context: legacyContext, claim: null });
    expect(existsSync(f.templatePath)).toBe(true);
  });

  test("claims one valid ticket-bound template and binds the runtime execution ID", () => {
    const f = fixture();
    writeTemplate(f);
    const binding = loadPromotionExecutionBinding(f.input);
    expect(binding.context).toEqual(f.context);
    expect(binding.claim).toMatchObject({
      executionId: f.input.executionId,
      ticket: f.input.ticketIdentifier,
      templatePath: f.templatePath,
      claimPath: claimPath(f),
      lockPath: lockPath(f),
      claimedAt: "2026-08-24T13:00:00.000Z",
    });
    expect(binding.claim?.templateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(f.templatePath)).toBe(false);
    expect(lstatSync(claimPath(f)).mode & 0o777).toBe(0o600);
    expect(lstatSync(lockPath(f)).mode & 0o777).toBe(0o600);
  });

  test("restores a persisted binding after restart without rereading the template", () => {
    const f = fixture();
    writeTemplate(f);
    const binding = loadPromotionExecutionBinding(f.input);
    const persisted = {
      execution_id: f.input.executionId,
      identifier: f.input.ticketIdentifier,
      promotion_context: binding.context,
      promotion_context_claim: binding.claim,
    };
    const incoming = { execution_id: f.input.executionId, identifier: f.input.ticketIdentifier };
    preservePersistedPromotionExecutionBinding(incoming, persisted);
    expect(incoming).toMatchObject({
      promotion_context: f.context,
      promotion_context_claim: binding.claim,
    });
    expect(existsSync(f.templatePath)).toBe(false);
  });

  test("rejects a wrong ticket before reviewer dispatch", () => {
    const f = fixture();
    writeTemplate(f, { ticket: "ZOU-9999" });
    let reviewerDispatches = 0;
    expect(() => {
      loadPromotionExecutionBinding(f.input);
      reviewerDispatches += 1;
    }).toThrow(/ticket does not match/);
    expect(reviewerDispatches).toBe(0);
    expect(existsSync(lockPath(f))).toBe(false);
  });

  test("rejects caller-supplied execution IDs and every unknown template field", () => {
    const f = fixture();
    writeTemplate(f, { executionId: "exec-caller", retryPolicy: "retry" });
    expect(() => loadPromotionExecutionBinding(f.input)).toThrow(/missing or unknown fields/);
    expect(existsSync(lockPath(f))).toBe(false);
  });

  test("rejects a template when certification is disabled", () => {
    const f = fixture();
    writeTemplate(f);
    process.env.SF010_CERTIFY = "0";
    expect(() => loadPromotionExecutionBinding(f.input)).toThrow(/require SF010_CERTIFY=1/);
    expect(existsSync(lockPath(f))).toBe(false);
  });

  test("rejects unsafe permissions and symlink traversal", () => {
    const unsafe = fixture();
    writeTemplate(unsafe);
    chmodSync(unsafe.templatePath, 0o644);
    expect(() => loadPromotionExecutionBinding(unsafe.input)).toThrow(/mode 600/);

    const linked = fixture();
    const target = join(linked.root, "real-template.json");
    writeTemplate(linked);
    writePrivate(target, readFileSync(linked.templatePath, "utf8"));
    unlinkSync(linked.templatePath);
    symlinkSync(target, linked.templatePath);
    expect(() => loadPromotionExecutionBinding(linked.input)).toThrow(/regular file without symlinks/);
  });

  test("rejects missing inputs, an empty diff, and mismatched targets", () => {
    const missing = fixture();
    writeTemplate(missing);
    unlinkSync(missing.context.operatorApprovalPath);
    expect(() => loadPromotionExecutionBinding(missing.input)).toThrow(/operator approval is unavailable/);

    const empty = fixture();
    empty.context.diff = "   ";
    writeTemplate(empty);
    expect(() => loadPromotionExecutionBinding(empty.input)).toThrow(/incomplete or invalid/);

    const mismatch = fixture();
    writeTemplate(mismatch);
    expect(() => loadPromotionExecutionBinding({ ...mismatch.input, expectedPullRequest: 607 })).toThrow(/pull request target/);
  });

  test("rejects absent, stale, incomplete, failed, duplicated, unknown, reordered, and mismatched validation evidence before claim", () => {
    const absent = fixture();
    const absentContext = { ...absent.context } as Record<string, unknown>;
    delete absentContext.certificationValidationEvidencePath;
    writePrivate(absent.templatePath, `${JSON.stringify({
      schema: "zouroboros.promotion-execution-context-template/v1",
      ticket: absent.input.ticketIdentifier,
      context: absentContext,
    })}\n`);
    expect(() => loadPromotionExecutionBinding(absent.input)).toThrow(/missing or unknown fields/);
    expect(existsSync(lockPath(absent))).toBe(false);

    const stale = fixture();
    writeValidationEvidence(stale.context, { expiresAt: "2026-08-24T12:59:59.000Z" });
    writeTemplate(stale);
    expect(() => loadPromotionExecutionBinding(stale.input)).toThrow(/stale or has invalid timestamps/);
    expect(existsSync(lockPath(stale))).toBe(false);

    const incomplete = fixture();
    writeValidationEvidence(incomplete.context, { commands: validCommands().slice(1) });
    writeTemplate(incomplete);
    expect(() => loadPromotionExecutionBinding(incomplete.input)).toThrow(/incomplete/);

    const failed = fixture();
    const failedCommands = validCommands();
    failedCommands[1] = { ...failedCommands[1]!, exitCode: 1 };
    writeValidationEvidence(failed.context, { commands: failedCommands });
    writeTemplate(failed);
    expect(() => loadPromotionExecutionBinding(failed.input)).toThrow(/incomplete or failed/);

    const duplicated = fixture();
    const duplicatedCommands = validCommands();
    duplicatedCommands[1] = { ...duplicatedCommands[1]!, class: duplicatedCommands[0]!.class };
    writeValidationEvidence(duplicated.context, { commands: duplicatedCommands });
    writeTemplate(duplicated);
    expect(() => loadPromotionExecutionBinding(duplicated.input)).toThrow(/unknown or duplicated/);

    const unknown = fixture();
    const unknownCommands = validCommands() as Array<Record<string, unknown>>;
    unknownCommands[0] = { ...unknownCommands[0], class: "invented_gate" };
    writeValidationEvidence(unknown.context, { commands: unknownCommands });
    writeTemplate(unknown);
    expect(() => loadPromotionExecutionBinding(unknown.input)).toThrow(/unknown or duplicated/);

    const reordered = fixture();
    const reorderedCommands = validCommands();
    [reorderedCommands[0], reorderedCommands[1]] = [reorderedCommands[1]!, reorderedCommands[0]!];
    writeValidationEvidence(reordered.context, { commands: reorderedCommands });
    writeTemplate(reordered);
    expect(() => loadPromotionExecutionBinding(reordered.input)).toThrow(/out of order/);

    const mismatch = fixture();
    writeValidationEvidence(mismatch.context, { headSha: "b".repeat(40) });
    writeTemplate(mismatch);
    expect(() => loadPromotionExecutionBinding(mismatch.input)).toThrow(/target is invalid or mismatched/);
  });

  test("rejects validation evidence stored inside the repository or exposed by unsafe permissions", () => {
    const inside = fixture();
    inside.context.certificationValidationEvidencePath = join(inside.context.repoDir, "validation.json");
    writeValidationEvidence(inside.context);
    writeTemplate(inside);
    expect(() => loadPromotionExecutionBinding(inside.input)).toThrow(/outside the repository/);

    const unsafe = fixture();
    chmodSync(unsafe.context.certificationValidationEvidencePath!, 0o644);
    writeTemplate(unsafe);
    expect(() => loadPromotionExecutionBinding(unsafe.input)).toThrow(/mode 600/);
  });

  test("retains a stale lock and never retries automatically", () => {
    const f = fixture();
    writeTemplate(f);
    writePrivate(lockPath(f), "stale\n");
    let validations = 0;
    expect(() => loadPromotionExecutionBinding({
      ...f.input,
      testHooks: { afterValidate: () => { validations += 1; } },
    })).toThrow(/lock already exists/);
    expect(validations).toBe(0);
    expect(readFileSync(lockPath(f), "utf8")).toBe("stale\n");
    expect(existsSync(f.templatePath)).toBe(true);
  });

  test("rejects any existing claim even if a lock was removed", () => {
    const f = fixture();
    writeTemplate(f);
    writePrivate(`${f.templatePath}.claimed-exec-old`, "claimed\n");
    expect(() => loadPromotionExecutionBinding(f.input)).toThrow(/claim already exists/);
    expect(existsSync(f.templatePath)).toBe(true);
    expect(existsSync(lockPath(f))).toBe(false);
  });

  test("retains the lock when the source disappears after validation", () => {
    const f = fixture();
    writeTemplate(f);
    expect(() => loadPromotionExecutionBinding({
      ...f.input,
      testHooks: { afterLock: () => unlinkSync(f.templatePath) },
    })).toThrow(/template is unavailable/);
    expect(existsSync(lockPath(f))).toBe(true);
    expect(existsSync(f.templatePath)).toBe(false);
  });

  test("retains lock and claimed evidence after interrupted claim", () => {
    const f = fixture();
    writeTemplate(f);
    expect(() => loadPromotionExecutionBinding({
      ...f.input,
      testHooks: { afterClaim: () => { throw new Error("simulated interruption"); } },
    })).toThrow(/simulated interruption/);
    expect(existsSync(lockPath(f))).toBe(true);
    expect(existsSync(claimPath(f))).toBe(true);
    expect(existsSync(f.templatePath)).toBe(false);
  });

  test("detects claimed-byte drift and retains all evidence", () => {
    const f = fixture();
    writeTemplate(f);
    expect(() => loadPromotionExecutionBinding({
      ...f.input,
      testHooks: { afterClaim: (path) => writeFileSync(path, "drifted\n") },
    })).toThrow(/digest does not match/);
    expect(existsSync(lockPath(f))).toBe(true);
    expect(existsSync(claimPath(f))).toBe(true);
  });

  test("allows exactly one of two concurrent claimants", async () => {
    const f = fixture();
    writeTemplate(f);
    const modulePath = new URL("./promotion-execution-context.ts", import.meta.url).href;
    const script = `
      import { loadPromotionExecutionBinding } from ${JSON.stringify(modulePath)};
      const input = { ...${JSON.stringify(f.input)}, now: () => "2026-08-24T13:00:00.000Z" };
      loadPromotionExecutionBinding(input);
    `;
    const env = { ...process.env, FACTORY_STATE_MODE: "test", SF010_CERTIFY: "1" };
    const first = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    const second = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    const exits = await Promise.all([first.exited, second.exited]);
    expect(exits.sort()).toEqual([0, 1]);
    expect(existsSync(lockPath(f))).toBe(true);
    expect(existsSync(claimPath(f))).toBe(true);
    expect(existsSync(f.templatePath)).toBe(false);
  });
});
