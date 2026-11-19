import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bridge = resolve(import.meta.dir, "../bridges/hermes-bridge.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeHermesProject(output: string): { project: string; countFile: string; hermesBin: string } {
  const project = mkdtempSync(join(tmpdir(), "hermes-bridge-test-"));
  tempDirs.push(project);
  mkdirSync(join(project, ".venv/bin"), { recursive: true });
  writeFileSync(join(project, ".venv/bin/activate"), "");
  const countFile = join(project, "calls.txt");
  const hermesBin = join(project, ".venv/bin/hermes");
  writeFileSync(
    hermesBin,
    [
      "#!/usr/bin/env bash",
      `printf 'call\\n' >> ${JSON.stringify(countFile)}`,
      "[[ \" $* \" == *\" -z \"* ]] || exit 64",
      "[[ \" $* \" != *\" -q \"* ]] || exit 64",
      output ? `printf '%s\\n' ${JSON.stringify(output)}` : "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { project, countFile, hermesBin };
}

async function runBridge(project: string, hermesBin: string) {
  const resultPath = join(project, "result.json");
  const proc = Bun.spawn(["bash", bridge, "test prompt", project], {
    cwd: project,
    env: {
      ...process.env,
      HERMES_PROJECT_DIR: project,
      HERMES_VENV: join(project, ".venv/bin/activate"),
      HERMES_BIN: hermesBin,
      HERMES_TIMEOUT: "10",
      RESULT_PATH: resultPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    result: JSON.parse(readFileSync(resultPath, "utf8")),
  };
}

describe("Hermes bridge one-shot contract", () => {
  test("uses -z once and returns the final response", async () => {
    const { project, countFile, hermesBin } = fakeHermesProject("BRIDGE_OK");
    const run = await runBridge(project, hermesBin);

    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe("BRIDGE_OK");
    expect(run.stderr).toBe("");
    expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(1);
    expect(run.result.status).toBe("success");
  });

  test("fails without replay when Hermes produces no final response", async () => {
    const { project, countFile, hermesBin } = fakeHermesProject("");
    const run = await runBridge(project, hermesBin);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("without a final response");
    expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(1);
    expect(run.result.status).toBe("failure");
  });
});
