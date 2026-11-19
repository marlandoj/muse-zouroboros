import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemdRunArgs, envFileLine, failedUnits, launchIsolated, unitState, type TransientLaunch } from "../factory-bridge/transient-unit";

const base = (over: Partial<TransientLaunch> = {}): TransientLaunch => ({
  unit: "factory-t_0000abcd", argv: ["runuser", "-u", "zouroboros", "--", "bash", "/x/run-remote.sh", "t_0000abcd"],
  cwd: "/opt/zouroboros/factory-dispatch", env: { PATH: "/usr/bin", HOME: "/home/zouroboros" },
  logPath: join(mkdtempSync(join(tmpdir(), "tu-")), "job.log"), ...over,
});

function fakeRun(calls: { cmd: string; args: string[] }[], opts: { runStatus?: number; pid?: string; capture?: (args: string[]) => void } = {}) {
  return (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd.endsWith("systemd-run")) { opts.capture?.(args); return { status: opts.runStatus ?? 0, stdout: "", stderr: opts.runStatus ? "Unit already exists" : "" }; }
    if (args[0] === "show") return { status: 0, stdout: `${opts.pid ?? "4242"}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}
const which = (b: string) => (b === "systemd-run" ? "/usr/bin/systemd-run" : b === "runuser" ? "/usr/sbin/runuser" : null);

describe("transient-unit launcher (runner-killer fix)", () => {
  test("root + systemd-run → own unit in the jobs slice, Type=exec, log append, absolute argv0, MainPID reported", () => {
    const calls: any[] = [];
    let legacyCalled = false;
    const r = launchIsolated(base(), { getuid: () => 0, env: {}, which, run: fakeRun(calls), legacy: () => { legacyCalled = true; return 1; } });
    expect(r).toEqual({ isolated: true, unit: "factory-t_0000abcd.service", pid: 4242, isolation: "systemd-unit" });
    expect(legacyCalled).toBe(false);
    const a = calls[0].args as string[];
    expect(a).toContain("--unit=factory-t_0000abcd");
    expect(a).toContain("--slice=zouroboros-jobs.slice");
    expect(a).toContain("--service-type=exec");
    expect(a).toContain("--working-directory=/opt/zouroboros/factory-dispatch");
    expect(a.some((x) => x.startsWith("StandardOutput=append:"))).toBe(true);
    expect(a).toContain("CollectMode=inactive");
    expect(a).toContain("--setenv=HOME=/home/zouroboros");
    expect(a.slice(a.indexOf("--") + 1)).toEqual(["/usr/sbin/runuser", "-u", "zouroboros", "--", "bash", "/x/run-remote.sh", "t_0000abcd"]);
  });

  test("secretEnv: values never on argv; 0600 env file used and deleted after start", () => {
    const calls: any[] = [];
    let fileSeen = "";
    let mode = 0;
    const o = base({ env: { OPENROUTER_API_KEY: "sk-secret-123", PATH: "/usr/bin" }, secretEnv: true });
    const r = launchIsolated(o, { getuid: () => 0, env: {}, which, run: fakeRun(calls, { capture: (args) => {
      const p = args.find((x) => x.startsWith("EnvironmentFile="))!.slice("EnvironmentFile=".length);
      fileSeen = readFileSync(p, "utf8"); mode = require("node:fs").statSync(p).mode & 0o777;
    } }) });
    expect(r.isolated).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("sk-secret-123");
    expect(fileSeen).toContain('OPENROUTER_API_KEY="sk-secret-123"');
    expect(mode).toBe(0o600);
    expect(readdirSync(join(o.logPath, "..")).filter((f) => f.endsWith(".env"))).toEqual([]);
  });

  test("fallbacks are reported, never silent", () => {
    const legacy = () => 777;
    expect(launchIsolated(base(), { getuid: () => 1000, env: {}, which, run: fakeRun([]), legacy })).toMatchObject({ isolated: false, pid: 777, isolation: expect.stringContaining("not root") });
    expect(launchIsolated(base(), { getuid: () => 0, env: { ZOUROBOROS_ISOLATE_JOBS: "0" }, which, run: fakeRun([]), legacy })).toMatchObject({ isolated: false, reason: expect.stringContaining("ZOUROBOROS_ISOLATE_JOBS=0") });
    expect(launchIsolated(base(), { getuid: () => 0, env: {}, which: () => null, run: fakeRun([]), legacy })).toMatchObject({ isolated: false, reason: "systemd-run not found" });
    expect(launchIsolated(base(), { getuid: () => 0, env: {}, which, run: fakeRun([], { runStatus: 1 }), legacy })).toMatchObject({ isolated: false, reason: expect.stringContaining("already exists") });
    expect(launchIsolated(base({ unit: "bad name;rm" }), { getuid: () => 0, env: {}, which, run: fakeRun([]), legacy })).toMatchObject({ isolated: false });
    expect(launchIsolated(base({ env: { K: "multi\nline" }, secretEnv: true }), { getuid: () => 0, env: {}, which, run: fakeRun([]), legacy })).toMatchObject({ isolated: false, reason: expect.stringContaining("K") });
  });

  test("EnvironmentFile escaping", () => {
    expect(envFileLine("A", `x"y$z\\w\`q`)).toBe('A="x\\"y\\$z\\\\w\\`q"');
    expect(envFileLine("1BAD", "x")).toBeNull();
    expect(envFileLine("A", "a\nb")).toBeNull();
  });

  test("helpers: failedUnits filters by prefix; unitState parses show output", () => {
    const run = (_c: string, a: string[]) => a[0] === "list-units"
      ? { status: 0, stdout: "factory-t_aa.service loaded failed failed x\nother.service loaded failed failed y\n", stderr: "" }
      : { status: 0, stdout: "ActiveState=active\nSubState=running\nMainPID=99\n", stderr: "" };
    expect(failedUnits("factory-t_", { run })).toEqual(["factory-t_aa.service"]);
    expect(unitState("factory-t_aa.service", { run })).toEqual({ active: "active", sub: "running", pid: 99 });
  });

  test("buildSystemdRunArgs puts extra properties before the command", () => {
    const a = buildSystemdRunArgs(base({ properties: ["TimeoutStopSec=30"] }), ["/bin/true"], null);
    expect(a.indexOf("TimeoutStopSec=30")).toBeLessThan(a.indexOf("--"));
  });
});
