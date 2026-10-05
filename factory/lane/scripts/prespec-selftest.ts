#!/usr/bin/env bun
/**
 * ZOU-437 T4 — Speculative Pre-Spec self-test (SF-P3).
 *
 * Fully sandboxed (dedup-selftest.ts pattern): all seed/ledger fixtures live in a
 * mkdtemp dir; every side effect (Linear fetch, decision gate, /zo/ask interview)
 * is INJECTED — no network, no spend, real state/ never touched. Sandbox removed in
 * finally.
 *
 * Cases:
 *   1. selectPrespecCandidates ranks (priority→FIFO) + drops non-SWARM + honors topN
 *   2. dry-run writes nothing / zero /zo/ask spend (interview spy never fires)
 *   3. cache-hit → evaluateFreshness skips re-interview (fresh source_hash + mtime)
 *   4. cooldown expiry → regen (interview)
 *   5. source_hash mismatch → consume-guard ignores cache (stamp ≠ current ticket)
 *   + stamp/parse round-trips (stampSourceHash, readSeedSourceHash, parsePrespecOutput)
 *   6. ZOU-1282 persona association contract validated at publication, lineage read back
 *
 * Exit 0 = all green.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceHash } from "./intake-ledger";
import { parseSeedTasks, readSeedPersonaLineage, readSeedSourceHash } from "./pool-queue";
import {
  buildPrespecPrompt,
  declaresPersonaContract,
  cachedSeedValidationError,
  evaluateFreshness,
  freshnessFor,
  parsePrespecOutput,
  PRESPEC_ZO_CHAIN_DEPTH,
  PRESPEC_ZO_REQUEST_TIMEOUT_MS,
  prespecZoModelChain,
  run,
  selectPrespecCandidates,
  stampSourceHash,
  validatePrespecSeed,
  type GateFn,
  type RunDeps,
} from "./prespec-runner";
import { type IntakeTicket } from "./linear-puller";

const NOW = Date.now();

let passed = 0;
let failed = 0;
function checkT(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

function ticket(overrides: Partial<IntakeTicket> & { identifier: string }): IntakeTicket {
  return {
    linear_id: `id-${overrides.identifier}`,
    identifier: overrides.identifier,
    title: overrides.title ?? `Title ${overrides.identifier}`,
    description: overrides.description ?? `Description ${overrides.identifier}`,
    url: "",
    state: "Backlog",
    state_type: "backlog",
    labels: [],
    created_at: overrides.created_at ?? "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    priority: overrides.priority,
  };
}

const SEED_BODY = `id: ZOU-9001
title: "fixture"
tasks:
  - id: T1
    name: do the thing
    deps: []
validation_commands:
  - label: focused-test
    command: bun
    args: ["test", "fixture.test.ts"]
`;

const sandbox = mkdtempSync(join(tmpdir(), "prespec-selftest-"));
const savedPrespec = process.env.SF_PRESPEC;

try {
  section('0. factory seed contract prompt');
  {
    checkT('pre-spec uses one bounded Zo rung before overflow',
      PRESPEC_ZO_CHAIN_DEPTH === 1 && prespecZoModelChain(['primary', 'fallback']).join(',') === 'primary');
    checkT('pre-spec Zo request deadline stays below one minute', PRESPEC_ZO_REQUEST_TIMEOUT_MS === 45_000);
    const prompt = buildPrespecPrompt(ticket({ identifier: 'ZOU-CONTRACT', priority: 1 }));
    checkT('prompt requires repository commit pins', prompt.includes('repositories[]') && prompt.includes('commit_sha'));
    checkT('prompt requires bounded build plumbing', prompt.includes('build_plumbing_allowance') && prompt.includes('max_changed_lines'));
    checkT('prompt requires hardware-aware performance baselines', prompt.includes('performance_baseline') && prompt.includes('release_verification'));
    checkT('prompt requires rendering embodiment proof', prompt.includes('visible pixels or scene-graph nodes'));
    checkT('prompt requires structured validation commands', prompt.includes('validation_commands[]') && prompt.includes('string[] args'));
    checkT('prompt requires repo-root deterministic commands', prompt.includes('deterministic, non-interactive') && prompt.includes('repository root'));
    checkT('valid generated seed passes validation-command contract', validatePrespecSeed(SEED_BODY).id === 'ZOU-9001');
    checkT('generated seed missing validation commands fails closed', (() => {
      try {
        validatePrespecSeed('id: ZOU-BAD\ntasks:\n  - id: T1\n    name: valid task\n    deps: []\n');
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes('validation commands are missing');
      }
    })());
    checkT('generated seed with malformed command args fails closed', (() => {
      try {
        validatePrespecSeed('id: ZOU-BAD\ntasks:\n  - id: T1\n    name: valid task\n    deps: []\nvalidation_commands:\n  - label: bad\n    command: bun\n    args: nope\n');
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes('requires label, command, and string[] args');
      }
    })());
    checkT('generated seed missing task name fails closed', (() => {
      try {
        validatePrespecSeed('id: ZOU-BAD\ntasks:\n  - id: T1\n    deps: []\nvalidation_commands:\n  - label: test\n    command: bun\n    args: ["test"]\n');
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes('missing name');
      }
    })());
  }

  // ─── 1. candidate selection ────────────────────────────────────────────────
  section("1. selectPrespecCandidates (rank + drop non-SWARM + topN)");
  {
    // Priority 1 (urgent) sorts first; 0/None sorts last; created_at breaks ties.
    const pull: IntakeTicket[] = [
      ticket({ identifier: "ZOU-LOWPRI", priority: 4, created_at: "2026-07-01T00:00:00Z" }),
      ticket({ identifier: "ZOU-URGENT", priority: 1, created_at: "2026-07-02T00:00:00Z" }),
      ticket({ identifier: "ZOU-DIRECT", priority: 1, created_at: "2026-07-01T00:00:00Z" }),
      ticket({ identifier: "ZOU-NONE", priority: 0, created_at: "2026-06-01T00:00:00Z" }),
      ticket({ identifier: "ZOU-TIE", priority: 1, created_at: "2026-07-03T00:00:00Z" }),
    ];
    // Gate: everything SWARM except ZOU-DIRECT.
    const gate: GateFn = (t) => (t.identifier === "ZOU-DIRECT" ? "DIRECT" : "SWARM");

    const top2 = selectPrespecCandidates(pull, 2, gate);
    checkT("honors topN (2 selected)", top2.length === 2);
    checkT(
      "ranked urgent-first, DIRECT dropped, FIFO tie-break",
      top2[0].identifier === "ZOU-URGENT" && top2[1].identifier === "ZOU-TIE",
      top2.map((t) => t.identifier).join(","),
    );

    const all = selectPrespecCandidates(pull, 10, gate);
    checkT("non-SWARM excluded entirely", !all.some((t) => t.identifier === "ZOU-DIRECT"));
    checkT("None-priority sorts last", all[all.length - 1].identifier === "ZOU-NONE");
    checkT("FORCE_SWARM also selected", selectPrespecCandidates(
      [ticket({ identifier: "ZOU-F", priority: 2 })], 1, () => "FORCE_SWARM",
    ).length === 1);
    checkT("empty pull → no candidates", selectPrespecCandidates([], 3, gate).length === 0);
  }

  // ─── 2. dry-run zero spend / no writes ─────────────────────────────────────
  section("2. dry-run — zero spend, no writes");
  {
    let interviewCalls = 0;
    const deps: Partial<RunDeps> = {
      fetchPullable: async () => [
        ticket({ identifier: "ZOU-99001", priority: 1 }),
        ticket({ identifier: "ZOU-99002", priority: 2 }),
      ],
      gateFn: () => "SWARM",
      interview: async () => {
        interviewCalls++;
      },
      nowMs: NOW,
    };
    const r = await run({ dryRun: true, topOverride: 2, deps });
    checkT("dry-run selects candidates", r.selected === 2);
    checkT("dry-run plans an interview for each uncached", r.plans.every((p) => p.decision === "interview"));
    checkT("dry-run NEVER calls interview (zero spend)", interviewCalls === 0);
    checkT("dry-run records no interviewed ids", r.interviewed.length === 0);
    checkT("dry-run marks dry_run + top_n", r.dry_run === true && r.top_n === 2);
  }
  {
    // default OFF, not dry-run → no-op, no fetch, no interview
    delete process.env.SF_PRESPEC;
    let fetched = false;
    let interviewCalls = 0;
    const r = await run({
      dryRun: false,
      deps: {
        fetchPullable: async () => {
          fetched = true;
          return [ticket({ identifier: "ZOU-X" })];
        },
        gateFn: () => "SWARM",
        interview: async () => {
          interviewCalls++;
        },
        nowMs: NOW,
      },
    });
    checkT("SF_PRESPEC unset + live → no-op (selected 0)", r.selected === 0 && r.enabled === false);
    checkT("disabled no-op never fetches or interviews", fetched === false && interviewCalls === 0);
  }

  // ─── 3. cache-hit → skip (fresh source_hash + mtime) ───────────────────────
  section("3. cache-hit — fresh cache skips re-interview");
  {
    const t = ticket({ identifier: "ZOU-CACHE", title: "Cache me", description: "stable body" });
    const seedPath = join(sandbox, "seed-zou-cache.yaml");
    const stamped = stampSourceHash(SEED_BODY, sourceHash(t.title, t.description));
    writeFileSync(seedPath, stamped);
    const fresh = freshnessFor(t, seedPath, 72, NOW);
    checkT("fresh stamped cache → skip-fresh-cache", fresh.decision === "skip-fresh-cache", fresh.reason);
    checkT("valid fresh cache passes publication read-back", cachedSeedValidationError(seedPath) === null);
  }
  {
    const seedPath = join(sandbox, "seed-zou-invalid-cache.yaml");
    const invalid = `id: ZOU-INVALID\ntasks:\n  - id: T1\n    deps: []\nvalidation_commands:\n  - label: test\n    command: bun\n    args: ["test"]\n`;
    writeFileSync(seedPath, invalid);
    checkT("invalid fresh cache is rejected before skip", cachedSeedValidationError(seedPath)?.includes("missing name") === true);
  }
  {
    // pure evaluateFreshness: fresh match
    const cur = sourceHash("t", "d");
    const e = evaluateFreshness({
      exists: true,
      stampedSourceHash: cur,
      mtimeMs: NOW - 10 * 3_600_000,
      currentSourceHash: cur,
      cooldownHours: 72,
      nowMs: NOW,
    });
    checkT("evaluateFreshness: 10h-old match → skip-fresh-cache", e.decision === "skip-fresh-cache");
    checkT("no cached seed → interview", evaluateFreshness({
      exists: false, stampedSourceHash: null, mtimeMs: null, currentSourceHash: cur, cooldownHours: 72, nowMs: NOW,
    }).decision === "interview");
    checkT("hand-authored (unstamped) seed → skip, never clobbered", evaluateFreshness({
      exists: true, stampedSourceHash: null, mtimeMs: NOW, currentSourceHash: cur, cooldownHours: 72, nowMs: NOW,
    }).decision === "skip-hand-authored");
  }

  // ─── 4. cooldown expiry → regen ────────────────────────────────────────────
  section("4. cooldown expiry — stale cache regenerates");
  {
    const t = ticket({ identifier: "ZOU-STALE", title: "Stale", description: "same body" });
    const seedPath = join(sandbox, "seed-zou-stale.yaml");
    writeFileSync(seedPath, stampSourceHash(SEED_BODY, sourceHash(t.title, t.description)));
    // mtime is "now" on disk; simulate a past-cooldown clock by advancing nowMs 100h.
    const stale = freshnessFor(t, seedPath, 72, NOW + 100 * 3_600_000);
    checkT("cache older than cooldown → interview (regen)", stale.decision === "interview", stale.reason);

    const cur = sourceHash("t", "d");
    const e = evaluateFreshness({
      exists: true, stampedSourceHash: cur, mtimeMs: NOW - 100 * 3_600_000, currentSourceHash: cur, cooldownHours: 72, nowMs: NOW,
    });
    checkT("evaluateFreshness: 100h > 72h cooldown → interview", e.decision === "interview");
  }

  // ─── 5. source_hash mismatch → consume-guard ignores cache ─────────────────
  section("5. source_hash mismatch — re-scoped ticket rejected");
  {
    const orig = ticket({ identifier: "ZOU-RESCOPE", title: "Original", description: "original scope" });
    const seedPath = join(sandbox, "seed-zou-rescope.yaml");
    // Stamp with the ORIGINAL identity, then the ticket is re-scoped.
    writeFileSync(seedPath, stampSourceHash(SEED_BODY, sourceHash(orig.title, orig.description)));
    const rescoped = { ...orig, description: "COMPLETELY NEW SCOPE after re-authoring" };

    // Runner side: freshness sees a stamp mismatch → interview (regenerate).
    const fr = freshnessFor(rescoped, seedPath, 72, NOW);
    checkT("runner: stamp mismatch → interview (regen own speculative seed)", fr.decision === "interview", fr.reason);

    // Consume-guard side (the always-on swarm-exec guard is built on these two
    // primitives): the cached stamp equals the ORIGINAL identity but NOT the
    // re-scoped one → guard would refuse the cache and fall through to inline.
    const cachedStamp = readSeedSourceHash(seedPath);
    checkT("cached stamp round-trips to original identity", cachedStamp === sourceHash(orig.title, orig.description));
    checkT("consume-guard: stamp ≠ re-scoped ticket → reject cache", cachedStamp !== sourceHash(rescoped.title, rescoped.description));
    checkT("consume-guard: stamp == unchanged ticket → trust cache", cachedStamp === sourceHash(orig.title, orig.description));
  }

  // ─── 6. stamp / parse round-trips ──────────────────────────────────────────
  section("6. stamp + interview-output parsing");
  {
    const h = sourceHash("Some title", "Some body");
    const stamped = stampSourceHash(SEED_BODY, h);
    checkT("stampSourceHash prepends top-level source_hash", stamped.startsWith(`source_hash: "${h}"\n`));
    const p = join(sandbox, "seed-roundtrip.yaml");
    writeFileSync(p, stamped);
    checkT("readSeedSourceHash reads the stamp back", readSeedSourceHash(p) === h);
    checkT("stamping is idempotent (no duplicate key)", (stampSourceHash(stamped, h).match(/^source_hash:/gm) ?? []).length === 1);
    checkT("unstamped seed reads null", (() => {
      const up = join(sandbox, "seed-unstamped.yaml");
      writeFileSync(up, SEED_BODY);
      return readSeedSourceHash(up) === null;
    })());

    // Regression lock (consensus cg-1783363455835-43dfmb, Kimi finding #5): a seed
    // opening with a `---` document marker must NOT be split into two YAML docs by
    // stamping — that returns an array from Bun.YAML.parse, silently dropping the
    // stamp (guard bypass: stamped seed read as null → trusted as hand-authored)
    // and breaking task parsing. Stamp must land INSIDE the first document.
    {
      const docLed = `---\n${SEED_BODY}`;
      const dh = sourceHash("doc-led title", "doc-led body");
      const stampedDoc = stampSourceHash(docLed, dh);
      const dp = join(sandbox, "seed-docmarker.yaml");
      writeFileSync(dp, stampedDoc);
      checkT("`---`-led seed keeps the document marker first", stampedDoc.startsWith("---\n"));
      checkT("`---`-led stamp is NOT lost to a doc split (reads back, not null)", readSeedSourceHash(dp) === dh);
      checkT("`---`-led seed still parses its tasks block (single document)", (() => {
        try {
          return parseSeedTasks(dp).length === 1;
        } catch {
          return false;
        }
      })());
    }

    const output = [
      "Here is the spec you asked for.",
      "===SEED_YAML===",
      "```yaml",
      "id: ZOU-1",
      "tasks: []",
      "```",
      "===INTERVIEW_NOTES===",
      "## Decisions",
      "- did the thing",
      "===END===",
      "trailing chatter ignored",
    ].join("\n");
    const parsed = parsePrespecOutput(output);
    checkT("parsePrespecOutput extracts seed (fences stripped)", parsed.seedYaml === "id: ZOU-1\ntasks: []");
    checkT("parsePrespecOutput extracts notes (END + trailing stripped)", parsed.notes === "## Decisions\n- did the thing");
    checkT("parsePrespecOutput on garbage → nulls", parsePrespecOutput("no delimiters here").seedYaml === null);
  }

  // ─── 7. wiring guard: consume-guard is always-on in swarm-exec ──────────────
  section("7. wiring guards");
  {
    const swarmSrc = readFileSync(join(import.meta.dir, "swarm-exec.ts"), "utf-8");
    checkT("swarm-exec computes seedCacheUsable with seedStampMatches", swarmSrc.includes("seedStampMatches(seedPath, ticket)"));
    checkT("consume-guard is independent of SF_PRESPEC (no flag gate around it)", !swarmSrc.includes('process.env.SF_PRESPEC') );
    checkT("unstamped seed trusted (byte-identical legacy path)", swarmSrc.includes("unstamped → hand-authored → trust"));
    checkT("cached-seed consumption parses the persona contract", swarmSrc.includes("parseSeedContract(seedPath)"));
    checkT("pool enqueue forwards the association lineage", swarmSrc.includes("persona_association: seedContract.persona_association"));
    checkT("execution records carry identity-free lineage", swarmSrc.includes("personaAssociationLineage(seedContract.persona_association)") && swarmSrc.includes("readSeedPersonaLineage(sf006SeedPath)"));
    checkT("swarm-exec resolves no persona identity", !swarmSrc.includes("resolvePersonas") && !swarmSrc.includes("list_personas"));
  }

  // ─── 8. ZOU-1282 persona contract at speculative publication ────────────────
  section("8. persona association contract (ZOU-1282)");
  {
    const personaSeed = (authority: string, ownedPath: string, extra = ""): string =>
      [
        "id: ZOU-9002",
        'title: "persona fixture"',
        "persona_association:",
        '  template_reference: "game@1.0.0"',
        '  version: "1.0.0"',
        `  sha256: "${"d".repeat(64)}"`,
        "  declared_capabilities:",
        "    - realtime-3d",
        "  selector_values:",
        "    engine: unity",
        "  fleet:",
        '    - role_id: "technical-artist"',
        '      persona_name: "GameDev · Technical Artist"',
        "      required: true",
        "      phases: [advise, implement, review]",
        "      required_scopes: [files:read, files:write]",
        `      invocation_cap: 1${extra}`,
        "  omitted_roles: []",
        "tasks:",
        "  - id: T1",
        "    name: do the thing",
        "    deps: []",
        "    files:",
        "      - src/render/",
        "    persona_assignments:",
        '      - role_id: "technical-artist"',
        `        authority: "${authority}"`,
        "        owned_paths:",
        `          - ${ownedPath}`,
        "validation_commands:",
        "  - label: focused-test",
        "    command: bun",
        '    args: ["test", "fixture.test.ts"]',
      ].join("\n");

    const rejectsWith = (body: string, fragment: string): boolean => {
      try {
        validatePrespecSeed(body);
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes(fragment);
      }
    };

    checkT("legacy seed with no persona metadata is unchanged", declaresPersonaContract(validatePrespecSeed(SEED_BODY)) === false);
    checkT("valid persona seed publishes", validatePrespecSeed(personaSeed("implement", "src/render/shader.ts")).id === "ZOU-9002");
    checkT("speculative seed with unknown role fails closed", rejectsWith(personaSeed("implement", "src/render/shader.ts").replace('role_id: "technical-artist"\n        authority', 'role_id: "ghost"\n        authority'), "unknown role"));
    checkT("speculative implement path escape fails closed", rejectsWith(personaSeed("implement", "src/network/socket.ts"), "outside the task's owned files"));
    checkT("speculative embedded persona uuid fails closed", rejectsWith(personaSeed("advise", "src/render/shader.ts", '\n      persona_id: "9fa5bf37"'), 'must not embed mutable "persona_id"'));
    checkT("speculative floating association version fails closed", rejectsWith(personaSeed("advise", "src/render/shader.ts").replace('version: "1.0.0"', 'version: "1.0"'), "exact semantic version"));

    // The plan record carries lineage from a cached seed, and nothing otherwise.
    const personaTicket = ticket({ identifier: "ZOU-99010", priority: 1 });
    const cachedPath = join(sandbox, `seed-${personaTicket.identifier.toLowerCase()}.yaml`);
    writeFileSync(cachedPath, stampSourceHash(personaSeed("implement", "src/render/shader.ts"), sourceHash(personaTicket.title, personaTicket.description)));
    const lineage = readSeedPersonaLineage(cachedPath);
    checkT(
      "cached seed lineage is readable and identity-free",
      lineage?.template_reference === "game@1.0.0" &&
        lineage.required_role_ids.join(",") === "technical-artist" &&
        !JSON.stringify(lineage).includes("GameDev · Technical Artist"),
    );
    checkT("legacy cached seed yields no lineage", readSeedPersonaLineage(join(sandbox, "does-not-exist.yaml")) === null);
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`SF-P3 pre-spec self-test: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  process.exit(0);
} finally {
  if (savedPrespec === undefined) delete process.env.SF_PRESPEC;
  else process.env.SF_PRESPEC = savedPrespec;
  rmSync(sandbox, { recursive: true, force: true });
}
