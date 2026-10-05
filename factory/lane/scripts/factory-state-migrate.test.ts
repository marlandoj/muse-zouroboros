import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FACTORY_WRITER_SENTINEL,
  LIVE_FACTORY_STATE_DESTINATION,
  LIVE_FACTORY_STATE_SOURCE,
  FactoryStateMigrationError,
  applyFactoryStateHardlinkMigration,
  applyFactoryStateMigration,
  captureFactoryStatePostCutoverContinuity,
  compareFactoryStatePostCutoverContinuity,
  digestFactoryState,
  factoryStateContinuityMutationPolicySha256,
  factoryStateHardlinkPlanSha256,
  factoryStatePostCutoverBaselineSha256,
  planFactoryStateHardlinkMigration,
  planFactoryStateMigration,
  recoverFactoryStateHardlinkMigration,
  rollbackFactoryStateHardlinkMigration,
  rollbackFactoryStateMigration,
  statusFactoryStateHardlinkMigration,
  type FactoryStateContinuityMutationPolicy,
  type FactoryStateHardlinkMigrationPlan,
  type FactoryStateHardlinkStage,
  type FactoryStatePostCutoverBaseline,
  serializeFactoryStateContinuityMutationPolicy,
  serializeFactoryStateHardlinkPlan,
  serializeFactoryStatePostCutoverBaseline,
  verifyFactoryStateHardlinkMigrationPlan,
  verifyFactoryStateHardlinkContinuity,
  verifyFactoryStateMigrationPlan,
} from "./factory-state-migrate";
import { FACTORY_STATE_MARKER } from "./factory-state-root";
import {
  createFactoryStateMutationReceipt,
  factoryStateMutationPayloadSha256,
  resolveFactoryStateMutationCycle,
  validateFactoryStateClaimTerminalProof,
  writeFactoryStateMutationReceipt,
} from "./factory-state-mutation-evidence";
import { ticketClaimKey } from "./ticket-claim";

const roots: string[] = [];
const MIGRATION_CLI = join(import.meta.dir, "factory-state-migrate.ts");
function fixture(): { parent: string; source: string; destination: string } {
  const parent = mkdtempSync(join(tmpdir(), "factory-state-migrate-"));
  roots.push(parent);
  const source = join(parent, "source");
  const destination = join(parent, "destination");
  mkdirSync(join(source, "pool"), { recursive: true });
  writeFileSync(join(source, "exec-1.json"), "{\"state\":\"executing\"}\n");
  writeFileSync(join(source, "pool", "queue.json"), "[]\n");
  return { parent, source, destination };
}

function hardlinkFixture(): { parent: string; source: string; destination: string; plan: FactoryStateHardlinkMigrationPlan; planSha256: string } {
  const { parent, source } = fixture();
  const destinationParent = join(parent, "external-state");
  const controlParent = join(parent, "migration-control");
  mkdirSync(destinationParent);
  mkdirSync(controlParent);
  const destination = join(destinationParent, "v1");
  const plan = planFactoryStateHardlinkMigration(source, destination, {
    staging: join(destinationParent, ".v1-staging"),
    journal: join(controlParent, "journal.json"),
    lock: join(controlParent, "migration.lock"),
    compatibilityLinkTemp: join(parent, ".source-link"),
    manifestSha256: "a".repeat(64),
  });
  return { parent, source, destination, plan, planSha256: factoryStateHardlinkPlanSha256(plan) };
}

function orphanLock(plan: FactoryStateHardlinkMigrationPlan): void {
  const lock = JSON.parse(readFileSync(plan.lock, "utf8"));
  writeFileSync(plan.lock, `${JSON.stringify({ ...lock, pid: 2_147_483_647 }, null, 2)}\n`);
}

function completedPostCutoverFixture(): ReturnType<typeof hardlinkFixture> & {
  baseline: FactoryStatePostCutoverBaseline;
  baselineSha256: string;
} {
  const result = hardlinkFixture();
  applyFactoryStateHardlinkMigration(result.plan, result.planSha256);
  const baseline = captureFactoryStatePostCutoverContinuity(result.plan, result.planSha256);
  return { ...result, baseline, baselineSha256: factoryStatePostCutoverBaselineSha256(baseline) };
}

function continuityPolicy(
  baselineSha256: string,
  rules: FactoryStateContinuityMutationPolicy["rules"],
): FactoryStateContinuityMutationPolicy {
  return {
    version: 1,
    mode: "post-cutover-continuity-mutation-policy",
    baseline_sha256: baselineSha256,
    rules,
  };
}

function continuityPolicyV2(
  baselineSha256: string,
  rules: FactoryStateContinuityMutationPolicy["rules"],
): FactoryStateContinuityMutationPolicy {
  return {
    version: 2,
    mode: "post-cutover-continuity-mutation-policy",
    baseline_sha256: baselineSha256,
    rules,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("factory state migration", () => {
  test("plans, verifies, atomically renames, validates, and rolls back disposable state", () => {
    const { source, destination } = fixture();
    const plan = planFactoryStateMigration(source, destination);
    expect(plan.source_digest.files).toBe(2);
    expect(verifyFactoryStateMigrationPlan(plan).sha256).toBe(plan.source_digest.sha256);

    const marker = applyFactoryStateMigration(plan);
    expect(marker.canonical_path).toBe(destination);
    expect(readFileSync(join(destination, FACTORY_STATE_MARKER), "utf8")).toContain(marker.root_id);
    expect(digestFactoryState(destination).sha256).toBe(plan.source_digest.sha256);

    rollbackFactoryStateMigration(plan);
    expect(readFileSync(join(source, "exec-1.json"), "utf8")).toContain("executing");
  });

  test("rejects source drift, active writers, and a nonempty destination", () => {
    const first = fixture();
    const driftPlan = planFactoryStateMigration(first.source, first.destination);
    writeFileSync(join(first.source, "new.json"), "{}\n");
    expect(() => verifyFactoryStateMigrationPlan(driftPlan)).toThrow(/changed/);

    const second = fixture();
    writeFileSync(join(second.source, FACTORY_WRITER_SENTINEL), JSON.stringify({ active_writers: ["worker-1"] }));
    const writerPlan = planFactoryStateMigration(second.source, second.destination);
    expect(() => verifyFactoryStateMigrationPlan(writerPlan)).toThrow(/writers/);

    const third = fixture();
    const destinationPlan = planFactoryStateMigration(third.source, third.destination);
    mkdirSync(third.destination);
    writeFileSync(join(third.destination, "occupied"), "x");
    expect(() => verifyFactoryStateMigrationPlan(destinationPlan)).toThrow(/must not contain/);
  });

  test("rejects symlinks and special path relationships", () => {
    const { source, destination, parent } = fixture();
    symlinkSync(join(source, "exec-1.json"), join(source, "linked.json"));
    expect(() => digestFactoryState(source)).toThrow(/symlink/);
    expect(() => planFactoryStateMigration(source, join(source, "nested"))).toThrow(/overlap/);
    expect(() => planFactoryStateMigration("relative", destination)).toThrow(/canonical absolute/);
    expect(dirname(destination)).toBe(parent);
  });

  test("plans an absent destination hierarchy without creating it", () => {
    const { parent, source } = fixture();
    const destination = join(parent, "not-created", "v1");
    const plan = planFactoryStateMigration(source, destination);
    expect(plan.destination_present).toBe(false);
    expect(plan.destination_parent_device).toBe(statSync(parent).dev);
    expect(existsSync(dirname(destination))).toBe(false);
    expect(() => verifyFactoryStateMigrationPlan(plan)).toThrow();
  });

  test("rejects cross-device targets and special files", () => {
    const { source } = fixture();
    if (existsSync("/dev/shm") && statSync(source).dev !== statSync("/dev/shm").dev) {
      const otherParent = mkdtempSync(join("/dev/shm", "factory-state-migrate-"));
      roots.push(otherParent);
      const plan = planFactoryStateMigration(source, join(otherParent, "destination"));
      expect(() => verifyFactoryStateMigrationPlan(plan)).toThrow(/same filesystem/);
    }

    const special = fixture();
    const fifo = join(special.source, "active.pipe");
    const created = Bun.spawnSync(["mkfifo", fifo], { stdout: "pipe", stderr: "pipe" });
    expect(created.exitCode).toBe(0);
    expect(() => digestFactoryState(special.source)).toThrow(/regular file/);
  });

  test("rejects marker mismatch and stale forward-state rollback", () => {
    const markerFixture = fixture();
    const markerPlan = planFactoryStateMigration(markerFixture.source, markerFixture.destination);
    applyFactoryStateMigration(markerPlan);
    const markerPath = join(markerFixture.destination, FACTORY_STATE_MARKER);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    writeFileSync(markerPath, JSON.stringify({ ...marker, canonical_path: markerFixture.source }));
    expect(() => rollbackFactoryStateMigration(markerPlan)).toThrow(/identity/);

    const staleFixture = fixture();
    const stalePlan = planFactoryStateMigration(staleFixture.source, staleFixture.destination);
    applyFactoryStateMigration(stalePlan);
    writeFileSync(join(staleFixture.destination, "forward.json"), "{\"new\":true}\n");
    expect(() => rollbackFactoryStateMigration(stalePlan)).toThrow(/changed|digest/);
    expect(readFileSync(join(staleFixture.destination, "forward.json"), "utf8")).toContain("true");
  });

  test("never deletes a pre-existing source marker when apply refuses it", () => {
    const { source, destination } = fixture();
    const markerPath = join(source, FACTORY_STATE_MARKER);
    writeFileSync(markerPath, "operator-owned-marker\n");
    const plan = planFactoryStateMigration(source, destination);
    expect(() => applyFactoryStateMigration(plan)).toThrow();
    expect(readFileSync(markerPath, "utf8")).toBe("operator-owned-marker\n");
  });

  test("hashes files larger than the bounded read buffer", () => {
    const { source } = fixture();
    const largePath = join(source, "large.bin");
    writeFileSync(largePath, Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a));
    const first = digestFactoryState(source);
    expect(first.files).toBe(3);
    writeFileSync(largePath, Buffer.alloc(2 * 1024 * 1024 + 17, 0x59));
    expect(digestFactoryState(source).sha256).not.toBe(first.sha256);
  });

  test("refuses live apply and rollback in this seed", () => {
    const fakePlan = {
      version: 1 as const,
      mode: "plan" as const,
      created_at: new Date().toISOString(),
      source: LIVE_FACTORY_STATE_SOURCE,
      destination: LIVE_FACTORY_STATE_DESTINATION,
      source_device: 1,
      destination_parent_device: 1,
      source_digest: { sha256: "0".repeat(64), files: 0, bytes: 0, generation: "x" },
      destination_present: false,
      active_writers: [],
    };
    expect(() => applyFactoryStateMigration(fakePlan)).toThrow(FactoryStateMigrationError);
    expect(() => rollbackFactoryStateMigration(fakePlan)).toThrow(/forbids live/);
  });

  test("hardlink re-home preserves inode identity and supports pre-write rollback", () => {
    const { source, destination, plan, planSha256 } = hardlinkFixture();
    const sourceInode = statSync(join(source, "exec-1.json")).ino;
    const status = applyFactoryStateHardlinkMigration(plan, planSha256);

    expect(status.stage).toBe("compatibility_linked");
    expect(status.lock_present).toBe(false);
    expect(lstatSync(source).isSymbolicLink()).toBe(true);
    expect(readlinkSync(source)).toBe(destination);
    expect(statSync(join(destination, "exec-1.json")).ino).toBe(sourceInode);
    expect(digestFactoryState(destination).sha256).toBe(plan.source_digest.sha256);

    const rolledBack = rollbackFactoryStateHardlinkMigration(plan, planSha256);
    expect(rolledBack.stage).toBe("rolled_back_pre_write");
    expect(lstatSync(source).isDirectory()).toBe(true);
    expect(statSync(join(source, "exec-1.json")).ino).toBe(sourceInode);
    expect(existsSync(destination)).toBe(false);
  });

  test("recovers every durable forward journal stage without losing the last namespace", () => {
    const stages: FactoryStateHardlinkStage[] = [
      "planned",
      "staging",
      "staged_verified",
      "destination_published",
      "legacy_retiring",
      "compatibility_linked",
    ];
    for (const stage of stages) {
      const { source, destination, plan, planSha256 } = hardlinkFixture();
      expect(() => applyFactoryStateHardlinkMigration(plan, planSha256, { interruptAfterStage: stage })).toThrow(/interruption/);
      const interrupted = statusFactoryStateHardlinkMigration(plan, planSha256);
      expect(interrupted.stage).toBe(stage);
      expect(interrupted.source === "directory" || interrupted.source === "compatibility-link").toBe(true);
      orphanLock(plan);
      const recovered = recoverFactoryStateHardlinkMigration(plan, planSha256);
      expect(recovered.stage).toBe("compatibility_linked");
      expect(recovered.source).toBe("compatibility-link");
      expect(recovered.destination_present).toBe(true);
      expect(recovered.lock_present).toBe(false);
      expect(readlinkSync(source)).toBe(destination);
    }
  });

  test("refuses ambiguous locks and recovers only an approved orphan", () => {
    const { plan, planSha256 } = hardlinkFixture();
    expect(() => applyFactoryStateHardlinkMigration(plan, planSha256, { interruptAfterStage: "planned" })).toThrow(/interruption/);
    expect(() => recoverFactoryStateHardlinkMigration(plan, planSha256)).toThrow(/still active/);
    orphanLock(plan);
    expect(recoverFactoryStateHardlinkMigration(plan, planSha256).stage).toBe("compatibility_linked");
  });

  test("resumes an interrupted pre-write rollback", () => {
    const { source, destination, plan, planSha256 } = hardlinkFixture();
    applyFactoryStateHardlinkMigration(plan, planSha256);
    expect(() => rollbackFactoryStateHardlinkMigration(plan, planSha256, { interruptAfterStage: "rolled_back_pre_write" })).toThrow(/interruption/);
    expect(lstatSync(source).isDirectory()).toBe(true);
    expect(existsSync(destination)).toBe(false);
    orphanLock(plan);
    const recovered = recoverFactoryStateHardlinkMigration(plan, planSha256);
    expect(recovered.stage).toBe("rolled_back_pre_write");
    expect(recovered.lock_present).toBe(false);
  });

  test("recovers a forward crash after compatibility-link publication but before its journal transition", () => {
    const { source, destination, plan, planSha256 } = hardlinkFixture();
    applyFactoryStateHardlinkMigration(plan, planSha256);
    const journal = JSON.parse(readFileSync(plan.journal, "utf8"));
    writeFileSync(plan.journal, `${JSON.stringify({ ...journal, stage: "legacy_retiring" }, null, 2)}\n`);
    expect(existsSync(plan.compatibility_link_temp)).toBe(false);
    const recovered = recoverFactoryStateHardlinkMigration(plan, planSha256);
    expect(recovered.stage).toBe("compatibility_linked");
    expect(readlinkSync(source)).toBe(destination);
    expect(existsSync(plan.compatibility_link_temp)).toBe(false);
  });

  test("recovers rollback after a destination file was retired", () => {
    const { source, destination, plan, planSha256 } = hardlinkFixture();
    applyFactoryStateHardlinkMigration(plan, planSha256);
    const journal = JSON.parse(readFileSync(plan.journal, "utf8"));
    writeFileSync(plan.journal, `${JSON.stringify({ ...journal, operation: "rollback" }, null, 2)}\n`);
    unlinkSync(source);
    mkdirSync(join(source, "pool"), { recursive: true });
    linkSync(join(destination, "exec-1.json"), join(source, "exec-1.json"));
    unlinkSync(join(destination, "exec-1.json"));
    const recovered = recoverFactoryStateHardlinkMigration(plan, planSha256);
    expect(recovered.stage).toBe("rolled_back_pre_write");
    expect(readFileSync(join(source, "exec-1.json"), "utf8")).toContain("executing");
    expect(existsSync(destination)).toBe(false);
  });

  test("recovers rollback after destination retirement completed before the journal transition", () => {
    const { source, destination, plan, planSha256 } = hardlinkFixture();
    applyFactoryStateHardlinkMigration(plan, planSha256);
    const journal = JSON.parse(readFileSync(plan.journal, "utf8"));
    writeFileSync(plan.journal, `${JSON.stringify({ ...journal, operation: "rollback" }, null, 2)}\n`);
    unlinkSync(source);
    mkdirSync(join(source, "pool"), { recursive: true });
    linkSync(join(destination, "exec-1.json"), join(source, "exec-1.json"));
    linkSync(join(destination, "pool", "queue.json"), join(source, "pool", "queue.json"));
    rmSync(destination, { recursive: true });

    const recovered = recoverFactoryStateHardlinkMigration(plan, planSha256);
    expect(recovered.stage).toBe("rolled_back_pre_write");
    expect(recovered.source).toBe("directory");
    expect(recovered.destination_present).toBe(false);
    expect(readFileSync(join(source, "pool", "queue.json"), "utf8")).toBe("[]\n");
  });

  test("forbids stale rollback after destination content changes", () => {
    const { source, destination, plan, planSha256 } = hardlinkFixture();
    applyFactoryStateHardlinkMigration(plan, planSha256);
    writeFileSync(join(destination, "exec-1.json"), "{\"state\":\"advanced\"}\n");
    expect(() => rollbackFactoryStateHardlinkMigration(plan, planSha256)).toThrow(/digest|inventory/);
    expect(lstatSync(source).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(destination, "exec-1.json"), "utf8")).toContain("advanced");
    expect(existsSync(plan.lock)).toBe(false);
  });

  test("hardlink planning rejects sentinels, nonunit links, collisions, and path overlap", () => {
    const sentinel = fixture();
    const sentinelDestinationParent = join(sentinel.parent, "external");
    const sentinelControl = join(sentinel.parent, "control");
    mkdirSync(sentinelDestinationParent);
    mkdirSync(sentinelControl);
    writeFileSync(join(sentinel.source, FACTORY_WRITER_SENTINEL), JSON.stringify({ active_writers: [] }));
    expect(() => planFactoryStateHardlinkMigration(sentinel.source, join(sentinelDestinationParent, "v1"), {
      staging: join(sentinelDestinationParent, ".stage"),
      journal: join(sentinelControl, "journal"),
      lock: join(sentinelControl, "lock"),
      compatibilityLinkTemp: join(sentinel.parent, ".source-link"),
      manifestSha256: "b".repeat(64),
    })).toThrow(/sentinel/);

    const linked = fixture();
    const linkedDestinationParent = join(linked.parent, "external");
    const linkedControl = join(linked.parent, "control");
    mkdirSync(linkedDestinationParent);
    mkdirSync(linkedControl);
    linkSync(join(linked.source, "exec-1.json"), join(linked.parent, "second-link.json"));
    expect(() => planFactoryStateHardlinkMigration(linked.source, join(linkedDestinationParent, "v1"), {
      staging: join(linkedDestinationParent, ".stage"),
      journal: join(linkedControl, "journal"),
      lock: join(linkedControl, "lock"),
      compatibilityLinkTemp: join(linked.parent, ".source-link"),
      manifestSha256: "b".repeat(64),
    })).toThrow(/hardlink/);

    const collision = hardlinkFixture();
    mkdirSync(collision.plan.staging);
    expect(() => verifyFactoryStateHardlinkMigrationPlan(collision.plan)).toThrow(/exists/);
    const overlapping = { ...collision.plan, staging: join(collision.plan.destination, "stage") };
    expect(() => factoryStateHardlinkPlanSha256(overlapping)).toThrow(/parent|overlap/);
  });

  test("status is read-only and hash-bound", () => {
    const { plan, planSha256 } = hardlinkFixture();
    const before = statusFactoryStateHardlinkMigration(plan, planSha256);
    expect(before.stage).toBe("planned");
    expect(existsSync(plan.journal)).toBe(false);
    expect(() => statusFactoryStateHardlinkMigration(plan, "0".repeat(64))).toThrow(/hash/);
    expect(existsSync(plan.journal)).toBe(false);
  });

  test("completed continuity survives inode reassignment while same-process cutover retains inode proof", () => {
    const { destination, plan, planSha256 } = hardlinkFixture();
    applyFactoryStateHardlinkMigration(plan, planSha256);
    const baseline = verifyFactoryStateHardlinkContinuity(plan, planSha256);
    const target = join(destination, "exec-1.json");
    const original = statSync(target);
    const replacement = join(destination, ".exec-1-replacement");
    writeFileSync(replacement, readFileSync(target), { mode: original.mode & 0o777 });
    renameSync(replacement, target);
    expect(statSync(target).ino).not.toBe(original.ino);

    const continuity = verifyFactoryStateHardlinkContinuity(plan, planSha256, baseline);
    expect(continuity.stage).toBe("compatibility_linked");
    expect(continuity.digest.sha256).toBe(plan.source_digest.sha256);
    expect(continuity.entries).toBe(plan.entries.length);
  });

  test("completed continuity rejects namespace, marker, journal, link, and residue tampering", () => {
    {
      const { destination, plan, planSha256 } = hardlinkFixture();
      applyFactoryStateHardlinkMigration(plan, planSha256);
      const baseline = verifyFactoryStateHardlinkContinuity(plan, planSha256);
      writeFileSync(join(destination, "exec-1.json"), "changed\n");
      expect(() => verifyFactoryStateHardlinkContinuity(plan, planSha256)).toThrow(/continuity/);
      expect(() => verifyFactoryStateHardlinkContinuity(plan, planSha256, baseline)).toThrow(/continuity/);
    }
    {
      const { destination, plan, planSha256 } = hardlinkFixture();
      applyFactoryStateHardlinkMigration(plan, planSha256);
      const baseline = verifyFactoryStateHardlinkContinuity(plan, planSha256);
      writeFileSync(join(destination, "extra.json"), "{}\n");
      expect(() => verifyFactoryStateHardlinkContinuity(plan, planSha256, baseline)).toThrow(/continuity/);
    }
    {
      const { destination, plan, planSha256 } = hardlinkFixture();
      applyFactoryStateHardlinkMigration(plan, planSha256);
      const baseline = verifyFactoryStateHardlinkContinuity(plan, planSha256);
      chmodSync(join(destination, "pool"), 0o700);
      expect(() => verifyFactoryStateHardlinkContinuity(plan, planSha256, baseline)).toThrow(/continuity/);
    }
    {
      const { destination, plan, planSha256 } = hardlinkFixture();
      applyFactoryStateHardlinkMigration(plan, planSha256);
      const baseline = verifyFactoryStateHardlinkContinuity(plan, planSha256);
      const markerPath = join(destination, FACTORY_STATE_MARKER);
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      writeFileSync(markerPath, `${JSON.stringify({ ...marker, root_id: "00000000-0000-4000-8000-000000000000" }, null, 2)}\n`);
      expect(() => verifyFactoryStateHardlinkContinuity(plan, planSha256, baseline)).toThrow(/marker/);
    }
    {
      const { plan, planSha256 } = hardlinkFixture();
      applyFactoryStateHardlinkMigration(plan, planSha256);
      const baseline = verifyFactoryStateHardlinkContinuity(plan, planSha256);
      const journal = JSON.parse(readFileSync(plan.journal, "utf8"));
      writeFileSync(plan.journal, `${JSON.stringify({ ...journal, root_id: "00000000-0000-4000-8000-000000000000" }, null, 2)}\n`);
      expect(() => verifyFactoryStateHardlinkContinuity(plan, planSha256, baseline)).toThrow(/marker/);
    }
    {
      const { parent, source, plan, planSha256 } = hardlinkFixture();
      applyFactoryStateHardlinkMigration(plan, planSha256);
      const baseline = verifyFactoryStateHardlinkContinuity(plan, planSha256);
      unlinkSync(source);
      symlinkSync(parent, source);
      expect(() => verifyFactoryStateHardlinkContinuity(plan, planSha256, baseline)).toThrow(/compatibility/);
    }
    for (const residue of ["staging", "compatibility_link_temp", "lock"] as const) {
      const { plan, planSha256 } = hardlinkFixture();
      applyFactoryStateHardlinkMigration(plan, planSha256);
      const baseline = verifyFactoryStateHardlinkContinuity(plan, planSha256);
      if (residue === "staging") mkdirSync(plan.staging);
      else if (residue === "compatibility_link_temp") symlinkSync(plan.destination, plan.compatibility_link_temp);
      else writeFileSync(plan.lock, "{}\n");
      expect(() => verifyFactoryStateHardlinkContinuity(plan, planSha256, baseline)).toThrow(/residue/);
    }
  });

  test("captures a read-only post-cutover baseline after legitimate namespace growth", () => {
    const { destination, plan, planSha256, source } = hardlinkFixture();
    applyFactoryStateHardlinkMigration(plan, planSha256);
    appendFileSync(join(destination, "exec-1.json"), "{\"event\":\"complete\"}\n");
    writeFileSync(join(destination, "post-cutover.jsonl"), "{\"receipt\":1}\n", { mode: 0o640 });
    expect(() => verifyFactoryStateHardlinkContinuity(plan, planSha256)).toThrow(/frozen plan/);
    const journalBefore = readFileSync(plan.journal, "utf8");
    const markerBefore = readFileSync(join(destination, FACTORY_STATE_MARKER), "utf8");

    const baseline = captureFactoryStatePostCutoverContinuity(plan, planSha256);
    const baselineSha256 = factoryStatePostCutoverBaselineSha256(baseline);
    expect(baseline.version).toBe(2);
    expect(baseline.mode).toBe("post-cutover-continuity-baseline");
    expect(baseline.entries.map((entry) => entry.path)).toContain("post-cutover.jsonl");
    expect(baseline.entries.find((entry) => entry.path === "exec-1.json")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(serializeFactoryStatePostCutoverBaseline(baseline)).toEndWith("\n");
    expect(readlinkSync(source)).toBe(destination);
    expect(readFileSync(plan.journal, "utf8")).toBe(journalBefore);
    expect(readFileSync(join(destination, FACTORY_STATE_MARKER), "utf8")).toBe(markerBefore);
    expect(compareFactoryStatePostCutoverContinuity(plan, planSha256, baseline, { baselineSha256 }).changes).toEqual([]);
  });

  test("fails closed when the two post-cutover observations see concurrent drift", async () => {
    const { destination, parent, plan, planSha256 } = hardlinkFixture();
    applyFactoryStateHardlinkMigration(plan, planSha256);
    const target = join(destination, "large-drift.bin");
    const ready = join(parent, "drift-writer-ready");
    const writer = join(parent, "drift-writer.ts");
    writeFileSync(target, "");
    truncateSync(target, 16 * 1024 * 1024);
    writeFileSync(writer, [
      "import { appendFileSync, writeFileSync } from 'node:fs';",
      "const [target, ready] = process.argv.slice(2);",
      "appendFileSync(target, 'x');",
      "writeFileSync(ready, 'ready\\n');",
      "for (let i = 0; i < 2_000; i += 1) { appendFileSync(target, 'x'); Bun.sleepSync(1); }",
    ].join("\n"));
    const child = Bun.spawn([
      process.execPath,
      writer,
      target,
      ready,
    ], { stdout: "ignore", stderr: "ignore" });
    for (let attempt = 0; attempt < 500 && !existsSync(ready); attempt += 1) Bun.sleepSync(2);
    expect(existsSync(ready)).toBe(true);
    expect(() => captureFactoryStatePostCutoverContinuity(plan, planSha256)).toThrow(/two required observations/);
    child.kill();
    await child.exited;
  }, 10_000);

  test("accepts only exact policy-bound append and create changes with ownership evidence", () => {
    const { destination, plan, planSha256, baseline, baselineSha256 } = completedPostCutoverFixture();
    appendFileSync(join(destination, "exec-1.json"), "{\"event\":\"verified\"}\n");
    mkdirSync(join(destination, "receipts"), { mode: 0o750 });
    writeFileSync(join(destination, "receipts", "run-1.json"), "{\"ok\":true}\n", { mode: 0o640 });
    expect(() => compareFactoryStatePostCutoverContinuity(plan, planSha256, baseline, { baselineSha256 })).toThrow(/without an append-only rule/);

    const policy = continuityPolicy(baselineSha256, [
      {
        id: "append-exec-1",
        action: "append-only",
        path: "exec-1.json",
        binding: { kind: "operation", id: "op-zou-1055-v1" },
      },
      {
        id: "create-receipts-directory",
        action: "create-only",
        path: "receipts",
        type: "directory",
        mode: 0o750,
        binding: { kind: "receipt", id: "receipt-zou-1055-v1" },
      },
      {
        id: "create-run-receipt",
        action: "create-only",
        path: "receipts/run-1.json",
        type: "file",
        mode: 0o640,
        binding: { kind: "receipt", id: "receipt-zou-1055-v1" },
      },
    ]);
    const policySha256 = factoryStateContinuityMutationPolicySha256(policy);
    const comparison = compareFactoryStatePostCutoverContinuity(plan, planSha256, baseline, {
      baselineSha256,
      policy,
      policySha256,
    });
    expect(comparison.policy_sha256).toBe(policySha256);
    expect(comparison.changes).toHaveLength(3);
    expect(comparison.changes.map((change) => [change.path, change.rule_id, change.binding.kind])).toEqual([
      ["exec-1.json", "append-exec-1", "operation"],
      ["receipts", "create-receipts-directory", "receipt"],
      ["receipts/run-1.json", "create-run-receipt", "receipt"],
    ]);
  });

  test("accepts one exact typed atomic replacement under policy version 2", () => {
    const completed = completedPostCutoverFixture();
    const target = join(completed.destination, "lane-utilization.jsonl.current-cycle");
    writeFileSync(target, "cycle-1\n", { mode: 0o640 });
    const baseline = captureFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256);
    const baselineSha256 = factoryStatePostCutoverBaselineSha256(baseline);
    const receipt = createFactoryStateMutationReceipt({
      action: "atomic-replace",
      binding: resolveFactoryStateMutationCycle({ producerId: "lane-utilization" }),
      target_path: "lane-utilization.jsonl.current-cycle",
      target_schema: "lane-current-cycle/v1",
      before_payload: "cycle-1\n",
      after_payload: "cycle-2\n",
      allowed_transitions: ["$cycle_id"],
      recorded_at: "2026-08-13T14:00:00.000Z",
    });
    writeFactoryStateMutationReceipt(receipt, { stateDir: completed.destination });
    writeFileSync(target, "cycle-2\n", { mode: 0o640 });
    const policy = continuityPolicyV2(baselineSha256, [{
      id: "replace-current-cycle",
      action: "atomic-replace",
      path: "lane-utilization.jsonl.current-cycle",
      target_schema: "lane-current-cycle/v1",
      allowed_transitions: ["$cycle_id"],
      scope: "background",
      binding: { kind: "receipt", id: "lane-utilization" },
    }]);
    const comparison = compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, baseline, {
      baselineSha256,
      policy,
      policySha256: factoryStateContinuityMutationPolicySha256(policy),
    });
    expect(comparison.version).toBe(2);
    expect(comparison.changes).toEqual([expect.objectContaining({
      path: "lane-utilization.jsonl.current-cycle",
      action: "atomic-replace",
      receipt_ids: [receipt.receipt_id],
      observed_transitions: ["$cycle_id"],
    })]);
  });

  test("rejects duplicate, wrong-owner, and over-broad atomic replacement receipts", () => {
    const run = (variant: "duplicate" | "owner" | "broad") => {
      const completed = completedPostCutoverFixture();
      const target = join(completed.destination, "lane-utilization.jsonl.current-cycle");
      writeFileSync(target, "cycle-1\n", { mode: 0o640 });
      const baseline = captureFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256);
      const baselineSha256 = factoryStatePostCutoverBaselineSha256(baseline);
      const producerId = variant === "owner" ? "other-producer" : "lane-utilization";
      const first = createFactoryStateMutationReceipt({
        action: "atomic-replace",
        binding: resolveFactoryStateMutationCycle({ producerId }),
        target_path: "lane-utilization.jsonl.current-cycle",
        target_schema: "lane-current-cycle/v1",
        before_payload: "cycle-1\n",
        after_payload: "cycle-2\n",
        allowed_transitions: variant === "broad" ? ["$cycle_id", "/unowned"] : ["$cycle_id"],
        recorded_at: "2026-08-13T14:00:00.000Z",
      });
      writeFactoryStateMutationReceipt(first, { stateDir: completed.destination });
      if (variant === "duplicate") {
        const duplicate = createFactoryStateMutationReceipt({
          action: "atomic-replace",
          binding: first.binding,
          target_path: "lane-utilization.jsonl.current-cycle",
          target_schema: "lane-current-cycle/v1",
          before_payload: "cycle-1\n",
          after_payload: "cycle-2\n",
          allowed_transitions: ["$cycle_id"],
          recorded_at: "2026-08-13T14:00:01.000Z",
        });
        writeFactoryStateMutationReceipt(duplicate, { stateDir: completed.destination });
      }
      writeFileSync(target, "cycle-2\n", { mode: 0o640 });
      const policy = continuityPolicyV2(baselineSha256, [{
        id: "replace-current-cycle",
        action: "atomic-replace",
        path: "lane-utilization.jsonl.current-cycle",
        target_schema: "lane-current-cycle/v1",
        allowed_transitions: ["$cycle_id"],
        scope: "background",
        binding: { kind: "receipt", id: "lane-utilization" },
      }]);
      expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, baseline, {
        baselineSha256,
        policy,
        policySha256: factoryStateContinuityMutationPolicySha256(policy),
      })).toThrow();
    };
    run("duplicate");
    run("owner");
    run("broad");
  });

  test("accepts only prepared-plus-committed exact claim release with terminal proof", () => {
    const completed = completedPostCutoverFixture();
    const claimOwner = {
      schema_version: 1 as const,
      ticket_id: "linear-uuid",
      execution_id: "exec-one",
      claimed_at: "2026-08-13T12:00:00.000Z",
      lease_expires_at: "2026-08-13T13:00:00.000Z",
      pid: 1234,
    };
    const ownerPayload = `${JSON.stringify(claimOwner, null, 2)}\n`;
    const claimKey = ticketClaimKey(claimOwner.ticket_id);
    const claimRelative = `ticket-claims/${claimKey}`;
    const ownerRelative = `${claimRelative}/owner.json`;
    const claimPath = join(completed.destination, claimRelative);
    mkdirSync(claimPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(completed.destination, ownerRelative), ownerPayload, { mode: 0o600 });
    const executionPath = join(completed.destination, `exec-${claimOwner.execution_id}.json`);
    writeFileSync(executionPath, JSON.stringify({
      execution_id: claimOwner.execution_id,
      ticket_id: claimOwner.ticket_id,
      state: "failed",
      status: "failed",
      started_at: "2026-08-13T12:00:00.000Z",
      completed_at: "2026-08-13T12:30:00.000Z",
    }), { mode: 0o640 });
    const baseline = captureFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256);
    const baselineSha256 = factoryStatePostCutoverBaselineSha256(baseline);
    const terminal = validateFactoryStateClaimTerminalProof(claimOwner, executionPath);
    const binding = resolveFactoryStateMutationCycle({ producerId: "ticket-claim-reaper" });
    const prepared = createFactoryStateMutationReceipt({
      action: "claim-release",
      binding,
      target_path: claimRelative,
      target_schema: "ticket-claim-owner/v1",
      before_payload: ownerPayload,
      after_payload: "",
      allowed_transitions: ["$claim_removed"],
      recorded_at: "2026-08-13T14:00:00.000Z",
      claim_release: {
        stage: "prepared",
        claim_key: claimKey,
        claim_directory_path: claimRelative,
        owner_path: ownerRelative,
        owner_sha256: factoryStateMutationPayloadSha256(ownerPayload),
        owner: claimOwner,
        terminal,
      },
    });
    writeFactoryStateMutationReceipt(prepared, { stateDir: completed.destination });
    rmSync(claimPath, { recursive: true, force: false });
    const policy = continuityPolicyV2(baselineSha256, [{
      id: "release-linear-uuid",
      action: "claim-release",
      path: claimRelative,
      owner_path: ownerRelative,
      scope: "background",
      binding: { kind: "receipt", id: "ticket-claim-reaper" },
    }]);
    expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, baseline, {
      baselineSha256,
      policy,
      policySha256: factoryStateContinuityMutationPolicySha256(policy),
    })).toThrow(/prepared and committed/);

    const committed = createFactoryStateMutationReceipt({
      action: "claim-release",
      binding,
      target_path: claimRelative,
      target_schema: "ticket-claim-owner/v1",
      before_payload: ownerPayload,
      after_payload: "",
      allowed_transitions: ["$claim_removed"],
      recorded_at: "2026-08-13T14:00:01.000Z",
      claim_release: {
        ...prepared.claim_release!,
        stage: "committed",
        prepared_receipt_id: prepared.receipt_id,
      },
    });
    writeFactoryStateMutationReceipt(committed, { stateDir: completed.destination });
    const comparison = compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, baseline, {
      baselineSha256,
      policy,
      policySha256: factoryStateContinuityMutationPolicySha256(policy),
    });
    expect(comparison.changes).toEqual([expect.objectContaining({
      path: claimRelative,
      action: "claim-release",
      receipt_ids: [prepared.receipt_id, committed.receipt_id],
    })]);
  });

  test("rejects deletions, type or mode drift, rewrites, truncation, and undeclared entries", () => {
    const cases: Array<{ name: string; mutate: (fixture: ReturnType<typeof completedPostCutoverFixture>) => void }> = [
      { name: "delete", mutate: ({ destination }) => unlinkSync(join(destination, "exec-1.json")) },
      {
        name: "type",
        mutate: ({ destination }) => {
          unlinkSync(join(destination, "exec-1.json"));
          mkdirSync(join(destination, "exec-1.json"));
        },
      },
      { name: "mode", mutate: ({ destination }) => chmodSync(join(destination, "exec-1.json"), 0o600) },
      { name: "rewrite", mutate: ({ destination }) => writeFileSync(join(destination, "exec-1.json"), "x".repeat(22)) },
      { name: "truncate", mutate: ({ destination }) => truncateSync(join(destination, "exec-1.json"), 1) },
      { name: "unknown-create", mutate: ({ destination }) => writeFileSync(join(destination, "unknown.json"), "{}\n") },
    ];
    for (const candidate of cases) {
      const completed = completedPostCutoverFixture();
      candidate.mutate(completed);
      expect(() => compareFactoryStatePostCutoverContinuity(
        completed.plan,
        completed.planSha256,
        completed.baseline,
        { baselineSha256: completed.baselineSha256 },
      ), candidate.name).toThrow();
    }
  });

  test("rejects append rewrite, symlinks, special files, writer sentinels, and cutover evidence drift", () => {
    {
      const completed = completedPostCutoverFixture();
      const path = join(completed.destination, "exec-1.json");
      writeFileSync(path, `rewritten-${"x".repeat(statSync(path).size)}\n`);
      const policy = continuityPolicy(completed.baselineSha256, [{
        id: "append",
        action: "append-only",
        path: "exec-1.json",
        binding: { kind: "operation", id: "op-rewrite" },
      }]);
      expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, completed.baseline, {
        baselineSha256: completed.baselineSha256,
        policy,
        policySha256: factoryStateContinuityMutationPolicySha256(policy),
      })).toThrow(/exact prefix/);
    }
    {
      const completed = completedPostCutoverFixture();
      symlinkSync("exec-1.json", join(completed.destination, "bad-link"));
      expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, completed.baseline, {
        baselineSha256: completed.baselineSha256,
      })).toThrow(/symlink/);
    }
    {
      const completed = completedPostCutoverFixture();
      const fifo = join(completed.destination, "bad-fifo");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, completed.baseline, {
        baselineSha256: completed.baselineSha256,
      })).toThrow(/regular file/);
    }
    {
      const completed = completedPostCutoverFixture();
      writeFileSync(join(completed.destination, FACTORY_WRITER_SENTINEL), "{}\n");
      expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, completed.baseline, {
        baselineSha256: completed.baselineSha256,
      })).toThrow(/sentinel/);
    }
    {
      const completed = completedPostCutoverFixture();
      const markerPath = join(completed.destination, FACTORY_STATE_MARKER);
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      writeFileSync(markerPath, `${JSON.stringify({ ...marker, created_at: new Date(Date.now() + 1_000).toISOString() }, null, 2)}\n`);
      expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, completed.baseline, {
        baselineSha256: completed.baselineSha256,
      })).toThrow(/identity|metadata/);
    }
    {
      const completed = completedPostCutoverFixture();
      const journal = JSON.parse(readFileSync(completed.plan.journal, "utf8"));
      writeFileSync(completed.plan.journal, `${JSON.stringify({ ...journal, updated_at: new Date(Date.now() + 1_000).toISOString() }, null, 2)}\n`);
      expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, completed.baseline, {
        baselineSha256: completed.baselineSha256,
      })).toThrow(/identity|metadata/);
    }
    {
      const completed = completedPostCutoverFixture();
      unlinkSync(completed.source);
      symlinkSync(completed.parent, completed.source);
      expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, completed.baseline, {
        baselineSha256: completed.baselineSha256,
      })).toThrow(/compatibility/);
    }
    for (const residue of ["staging", "compatibility_link_temp", "lock"] as const) {
      const completed = completedPostCutoverFixture();
      if (residue === "staging") mkdirSync(completed.plan.staging);
      else if (residue === "compatibility_link_temp") symlinkSync(completed.destination, completed.plan.compatibility_link_temp);
      else writeFileSync(completed.plan.lock, "{}\n");
      expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, completed.baseline, {
        baselineSha256: completed.baselineSha256,
      })).toThrow(/residue/);
    }
  });

  test("rejects baseline and policy hash drift plus unsafe or overlapping policy rules", () => {
    const completed = completedPostCutoverFixture();
    const tamperedBaseline = { ...completed.baseline, captured_at: new Date(Date.now() + 1_000).toISOString() };
    expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, tamperedBaseline, {
      baselineSha256: completed.baselineSha256,
    })).toThrow(/expected SHA-256/);
    const valid = continuityPolicy(completed.baselineSha256, [{
      id: "append",
      action: "append-only",
      path: "exec-1.json",
      binding: { kind: "operation", id: "op-1" },
    }]);
    expect(() => compareFactoryStatePostCutoverContinuity(completed.plan, completed.planSha256, completed.baseline, {
      baselineSha256: completed.baselineSha256,
      policy: valid,
      policySha256: "0".repeat(64),
    })).toThrow(/expected SHA-256/);
    for (const path of ["/absolute", "../traversal", "pool/*.json"]) {
      const invalid = continuityPolicy(completed.baselineSha256, [{
        id: "unsafe",
        action: "append-only",
        path,
        binding: { kind: "operation", id: "op-unsafe" },
      }]);
      expect(() => serializeFactoryStateContinuityMutationPolicy(invalid), path).toThrow(/normalized|exact/);
    }
    const overlapping = continuityPolicy(completed.baselineSha256, [
      { id: "one", action: "append-only", path: "exec-1.json", binding: { kind: "operation", id: "op-1" } },
      { id: "two", action: "append-only", path: "exec-1.json", binding: { kind: "receipt", id: "receipt-1" } },
    ]);
    expect(() => serializeFactoryStateContinuityMutationPolicy(overlapping)).toThrow(/overlap/);
  });

  test("exposes the hardlink state machine through the production CLI", () => {
    const { parent, source } = fixture();
    const destinationParent = join(parent, "external-state");
    const controlParent = join(parent, "control");
    mkdirSync(destinationParent);
    mkdirSync(controlParent);
    const destination = join(destinationParent, "v1");
    const staging = join(destinationParent, ".v1-staging");
    const journal = join(controlParent, "journal.json");
    const lock = join(controlParent, "migration.lock");
    const compatibilityLink = join(parent, ".source-link");
    const planPath = join(controlParent, "plan.json");
    const run = (args: string[]) => Bun.spawnSync([process.execPath, MIGRATION_CLI, ...args], { stdout: "pipe", stderr: "pipe" });
    const planned = run([
      "plan-hardlink", "--source", source, "--destination", destination, "--staging", staging,
      "--journal", journal, "--lock", lock, "--compatibility-link", compatibilityLink,
      "--manifest-sha256", "d".repeat(64), "--out", planPath,
    ]);
    expect(planned.exitCode).toBe(0);
    expect(existsSync(planPath)).toBe(true);
    const applied = run(["apply-hardlink", "--plan", planPath]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout.toString()).status.stage).toBe("compatibility_linked");
    const status = run(["status-hardlink", "--plan", planPath]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).status.source).toBe("compatibility-link");
    const continuity = run(["verify-hardlink-continuity", "--plan", planPath]);
    expect(continuity.exitCode).toBe(0);
    expect(JSON.parse(continuity.stdout.toString()).status.stage).toBe("compatibility_linked");
    const baselinePath = join(parent, "continuity-baseline.json");
    writeFileSync(baselinePath, `${JSON.stringify(JSON.parse(continuity.stdout.toString()).status, null, 2)}\n`);
    expect(run(["verify-hardlink-continuity", "--plan", planPath, "--baseline", baselinePath]).exitCode).toBe(0);
    const rolledBack = run(["rollback-hardlink", "--plan", planPath]);
    expect(rolledBack.exitCode).toBe(0);
    expect(JSON.parse(rolledBack.stdout.toString()).status.stage).toBe("rolled_back_pre_write");
  });

  test("round-trips post-cutover capture and policy comparison across separate CLI processes", () => {
    const { parent, destination, plan, planSha256 } = hardlinkFixture();
    const control = dirname(plan.journal);
    const planPath = join(control, "post-cutover-plan.json");
    const baselinePath = join(control, "post-cutover-baseline.json");
    const policyPath = join(control, "post-cutover-policy.json");
    writeFileSync(planPath, serializeFactoryStateHardlinkPlan(plan));
    const run = (args: string[]) => Bun.spawnSync([process.execPath, MIGRATION_CLI, ...args], { stdout: "pipe", stderr: "pipe" });
    expect(run(["apply-hardlink", "--plan", planPath]).exitCode).toBe(0);
    appendFileSync(join(destination, "exec-1.json"), "{\"post_cutover\":true}\n");
    const captured = run(["capture-hardlink-continuity", "--plan", planPath, "--out", baselinePath]);
    expect(captured.exitCode).toBe(0);
    const captureReceipt = JSON.parse(captured.stdout.toString());
    expect(captureReceipt.baseline_sha256).toBe(planSha256 === captureReceipt.baseline_sha256 ? "not-plan-hash" : captureReceipt.baseline_sha256);
    expect(existsSync(baselinePath)).toBe(true);
    expect(run(["capture-hardlink-continuity", "--plan", planPath, "--out", baselinePath]).exitCode).not.toBe(0);
    const exact = run([
      "compare-hardlink-continuity", "--plan", planPath, "--baseline", baselinePath,
      "--baseline-sha256", captureReceipt.baseline_sha256,
    ]);
    expect(exact.exitCode).toBe(0);
    expect(JSON.parse(exact.stdout.toString()).status.changes).toEqual([]);

    appendFileSync(join(destination, "exec-1.json"), "{\"verified\":true}\n");
    writeFileSync(join(destination, "receipt-1.json"), "{\"ok\":true}\n", { mode: 0o640 });
    const policy = continuityPolicy(captureReceipt.baseline_sha256, [
      {
        id: "append-exec",
        action: "append-only",
        path: "exec-1.json",
        binding: { kind: "operation", id: "op-cli-1" },
      },
      {
        id: "create-receipt",
        action: "create-only",
        path: "receipt-1.json",
        type: "file",
        mode: 0o640,
        binding: { kind: "receipt", id: "receipt-cli-1" },
      },
    ]);
    const serializedPolicy = serializeFactoryStateContinuityMutationPolicy(policy);
    const policySha256 = factoryStateContinuityMutationPolicySha256(policy);
    writeFileSync(policyPath, serializedPolicy);
    const compared = run([
      "compare-hardlink-continuity", "--plan", planPath, "--baseline", baselinePath,
      "--baseline-sha256", captureReceipt.baseline_sha256,
      "--policy", policyPath, "--policy-sha256", policySha256,
    ]);
    expect(compared.exitCode).toBe(0);
    expect(JSON.parse(compared.stdout.toString()).status.changes).toHaveLength(2);

    const tampered = JSON.parse(readFileSync(baselinePath, "utf8"));
    tampered.captured_at = new Date(Date.now() + 1_000).toISOString();
    writeFileSync(baselinePath, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(run([
      "compare-hardlink-continuity", "--plan", planPath, "--baseline", baselinePath,
      "--baseline-sha256", captureReceipt.baseline_sha256,
    ]).exitCode).not.toBe(0);
  });

  test("re-homes and rolls back the exact 8,359-file and 495-directory topology", () => {
    const { parent, source } = fixture();
    rmSync(source, { recursive: true });
    mkdirSync(source);
    for (let directoryIndex = 0; directoryIndex < 495; directoryIndex += 1) {
      const directory = join(source, `d-${String(directoryIndex).padStart(3, "0")}`);
      mkdirSync(directory);
      const fileCount = directoryIndex < 439 ? 17 : 16;
      for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
        writeFileSync(join(directory, `f-${String(fileIndex).padStart(2, "0")}`), "");
      }
    }
    const destinationParent = join(parent, "external-state");
    const controlParent = join(parent, "control");
    mkdirSync(destinationParent);
    mkdirSync(controlParent);
    const destination = join(destinationParent, "v1");
    const plan = planFactoryStateHardlinkMigration(source, destination, {
      staging: join(destinationParent, ".v1-staging"),
      journal: join(controlParent, "journal.json"),
      lock: join(controlParent, "migration.lock"),
      compatibilityLinkTemp: join(parent, ".source-link"),
      manifestSha256: "c".repeat(64),
    });
    expect(plan.source_digest.files).toBe(8_359);
    expect(plan.entries.filter((entry) => entry.type === "directory")).toHaveLength(495);
    const planSha256 = factoryStateHardlinkPlanSha256(plan);
    expect(applyFactoryStateHardlinkMigration(plan, planSha256).stage).toBe("compatibility_linked");
    expect(digestFactoryState(destination).files).toBe(8_359);
    expect(rollbackFactoryStateHardlinkMigration(plan, planSha256).stage).toBe("rolled_back_pre_write");
    expect(digestFactoryState(source).files).toBe(8_359);
  }, 30_000);
});
