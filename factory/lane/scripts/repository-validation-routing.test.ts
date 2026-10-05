import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_REPOSITORY_ENV,
  LEGACY_VALIDATION_ENV,
  SCOPED_VALIDATION_ENV,
  normalizeRepositoryIdentity,
  resolveRepositoryValidationCommands,
} from "./repository-validation-routing";

const COMMANDS = [{ label: "registry", command: "bun", args: ["scripts/validate-registry.ts"] }];
const VERSIONED_ROUTES = readFileSync(
  new URL("../config/repository-validation-routes.json", import.meta.url),
  "utf8",
);

const EXPECTED_ZOUROBOROS_WORKSPACE_ROUTE = [
  {
    label: "Constitutional document verification",
    command: "bun",
    args: ["/home/workspace/Skills/zouroboros-governance/scripts/constitution-gate.ts", "verify-docs"],
    timeout_ms: 30000,
  },
  {
    label: "Game Gauntlet probe suite",
    command: "bun",
    args: ["test", "./Projects/zouroboros-software-factory/game-gauntlet/scripts"],
    timeout_ms: 180000,
  },
  {
    label: "Counter-without-damage regression",
    command: "bun",
    args: ["test", "./Projects/zouroboros-software-factory/game-gauntlet/scripts/game-outcome-probes.test.ts"],
    timeout_ms: 60000,
  },
  {
    label: "Factory game preflight integration",
    command: "bun",
    args: ["test", "./Projects/zouroboros-software-factory/game-gauntlet/scripts/game-outcome-preflight.test.ts"],
    timeout_ms: 60000,
  },
  {
    label: "Strict outcome-probe TypeScript compilation",
    command: "bun",
    args: [
      "x",
      "tsc",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--target",
      "es2022",
      "Projects/zouroboros-software-factory/game-gauntlet/scripts/game-outcome-probes.ts",
      "Projects/zouroboros-software-factory/game-gauntlet/scripts/game-outcome-probes.test.ts",
      "Projects/zouroboros-software-factory/game-gauntlet/scripts/game-outcome-preflight.ts",
      "Projects/zouroboros-software-factory/game-gauntlet/scripts/game-outcome-preflight.test.ts",
    ],
    timeout_ms: 120000,
  },
  {
    label: "Locked dependency installation",
    command: "pnpm",
    args: ["install", "--frozen-lockfile"],
    timeout_ms: 900000,
  },
  {
    label: "Topological repository build",
    command: "pnpm",
    args: ["-r", "build"],
    timeout_ms: 900000,
  },
  {
    label: "Repository TypeScript validation",
    command: "pnpm",
    args: ["-r", "typecheck"],
    timeout_ms: 900000,
  },
  {
    label: "Applicable factory regression suite",
    command: "bash",
    args: [
      "-c",
      "set -euo pipefail; state_dir=$(mktemp -d /home/workspace/.runtime/factory-validation-XXXXXX); test -d \"$state_dir\" || { echo \"FATAL: mktemp did not materialize factory validation state directory\"; exit 1; }; trap 'rm -rf \"$state_dir\"' EXIT; env -i HOME=/root PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin FACTORY_STATE_DIR=\"$state_dir\" FACTORY_STATE_MODE=test FACTORY_STATE_ALLOW_OUTSIDE_ROOT=1 /root/.bun/bin/bun test ./Projects/zouroboros-software-factory/scripts",
    ],
    timeout_ms: 900000,
  },
  {
    label: "Patch whitespace validation",
    command: "git",
    args: ["diff", "--check"],
    timeout_ms: 30000,
  },
];

describe("repository validation routing", () => {
  test("normalizes supported GitHub remotes", () => {
    expect(normalizeRepositoryIdentity("https://github.com/Marlandoj/arcade-games.git")).toBe("marlandoj/arcade-games");
    expect(normalizeRepositoryIdentity("git@github.com:marlandoj/arcade-games.git")).toBe("marlandoj/arcade-games");
  });

  test("selects commands by exact repository identity", () => {
    const repository = mkdtempSync(join(tmpdir(), "validation-routing-"));
    const result = resolveRepositoryValidationCommands({
      repository,
      repositoryIdentity: "marlandoj/arcade-games",
      scopedJson: JSON.stringify({
        "marlandoj/zouroboros-workspace": [{ label: "factory", command: "bun", args: ["test"] }],
        "marlandoj/arcade-games": COMMANDS,
      }),
    });
    expect(result).toEqual(COMMANDS);
  });

  test("preserves the production stages and materializes dependencies before typecheck", () => {
    const repository = mkdtempSync(join(tmpdir(), "validation-routing-versioned-"));
    const result = resolveRepositoryValidationCommands({
      repository,
      repositoryIdentity: "marlandoj/zouroboros-workspace",
      scopedJson: VERSIONED_ROUTES,
    });

    expect(result).toEqual(EXPECTED_ZOUROBOROS_WORKSPACE_ROUTE);
    expect(result.map(({ label }) => label)).toEqual([
      "Constitutional document verification",
      "Game Gauntlet probe suite",
      "Counter-without-damage regression",
      "Factory game preflight integration",
      "Strict outcome-probe TypeScript compilation",
      "Locked dependency installation",
      "Topological repository build",
      "Repository TypeScript validation",
      "Applicable factory regression suite",
      "Patch whitespace validation",
    ]);
  });

  test("selects commands by canonical repository path", () => {
    const repository = mkdtempSync(join(tmpdir(), "validation-routing-path-"));
    const result = resolveRepositoryValidationCommands({
      repository,
      repositoryIdentity: null,
      scopedJson: JSON.stringify({ [realpathSync(repository)]: COMMANDS }),
    });
    expect(result).toEqual(COMMANDS);
  });

  test("refuses a legacy validator list without a repository binding", () => {
    const repository = mkdtempSync(join(tmpdir(), "validation-routing-legacy-"));
    expect(() => resolveRepositoryValidationCommands({
      repository,
      repositoryIdentity: "marlandoj/arcade-games",
      legacyJson: JSON.stringify(COMMANDS),
    })).toThrow(`${LEGACY_VALIDATION_ENV} requires ${LEGACY_REPOSITORY_ENV}`);
  });

  test("refuses a mismatched or missing repository route", () => {
    const repository = mkdtempSync(join(tmpdir(), "validation-routing-missing-"));
    expect(() => resolveRepositoryValidationCommands({
      repository,
      repositoryIdentity: "marlandoj/arcade-games",
      scopedJson: JSON.stringify({ "marlandoj/zouroboros-workspace": COMMANDS }),
      legacyJson: JSON.stringify(COMMANDS),
      legacyRepository: "marlandoj/zouroboros-workspace",
    })).toThrow(`configure ${SCOPED_VALIDATION_ENV}`);
  });

  test("fails closed on malformed selected commands", () => {
    const repository = mkdtempSync(join(tmpdir(), "validation-routing-malformed-"));
    expect(() => resolveRepositoryValidationCommands({
      repository,
      repositoryIdentity: "marlandoj/arcade-games",
      scopedJson: JSON.stringify({ "marlandoj/arcade-games": [] }),
    })).toThrow("coding cascade validation commands are missing");
  });
});
