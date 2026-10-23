/**
 * transient-unit.ts — launch a long-lived workshop job in its OWN systemd
 * transient unit (runner-killer fix, t_efdab56f).
 *
 * Why: zouroboros-workshop.service runs with the default KillMode=control-group.
 * `spawn(..., {detached: true})` only makes a new session; the child stays in
 * the workshop's cgroup, so every workshop restart/stop SIGTERMs it. Factory
 * runners (run-remote.sh / run-swarm.sh), swarm campaigns and skill-learning
 * jobs died mid-task that way. A transient unit (`systemd-run`) gets its own
 * cgroup under a separate slice, so a workshop restart never signals it, and
 * the job keeps an inspectable lifecycle (`systemctl status <unit>`).
 *
 * Lifecycle: CollectMode=inactive (systemd default, set explicitly): a unit
 * that exits 0 is garbage-collected; a failed unit stays loaded (inspectable)
 * until someone runs `systemctl reset-failed <unit>` (factory_queue does that
 * once the task's outbox result is recorded).
 *
 * Fallback: when isolation is impossible (not root, no systemd-run, the
 * systemd-run call fails) or explicitly disabled with
 * ZOUROBOROS_ISOLATE_JOBS=0 (the no-code rollback switch), the job is launched
 * the legacy way (detached child of the caller) and the result says
 * `isolated: false` with the reason, so callers can surface it honestly.
 *
 * Secrets: env that carries API keys must never land on a command line
 * (visible in ps) or in unit properties (`systemctl show -p Environment` is
 * world-readable). With `secretEnv: true` the env goes through a 0600
 * EnvironmentFile that is deleted as soon as the unit has exec'd (Type=exec
 * makes systemd-run return only after the exec, i.e. after the file was read).
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_SLICE = "zouroboros-jobs.slice";
const UNIT_RE = /^[A-Za-z0-9:_.\\-]{1,200}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface TransientLaunch {
  /** Unit name WITHOUT the .service suffix (e.g. "factory-t_1234abcd"). */
  unit: string;
  /** Command + args. argv[0] is resolved to an absolute path when needed. */
  argv: string[];
  cwd: string;
  /** The COMPLETE environment for the job (systemd gives units a clean env). */
  env: Record<string, string | undefined>;
  /** stdout + stderr are appended here (same as the legacy logFd). */
  logPath: string;
  description?: string;
  slice?: string;
  /** Pass env via a 0600 EnvironmentFile (deleted after exec) instead of --setenv. */
  secretEnv?: boolean;
  /** Where the transient EnvironmentFile is written (default: dirname of logPath). */
  envFileDir?: string;
  /** Extra `-p Key=Value` unit properties. */
  properties?: string[];
}

export interface LaunchResult {
  isolated: boolean;
  /** Full unit name ("x.service") when isolated. */
  unit: string | null;
  /** Main PID of the job (unit MainPID, or the legacy child pid). */
  pid: number | null;
  /** "systemd-unit" | "none (<reason>)" — human-readable isolation mode. */
  isolation: string;
  reason?: string;
}

export interface LaunchDeps {
  getuid?: () => number;
  /** spawnSync seam for tests. */
  run?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };
  /** Legacy spawn seam for tests. */
  legacy?: (o: TransientLaunch) => number | null;
  env?: Record<string, string | undefined>;
  which?: (bin: string) => string | null;
}

const defaultRun = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000 });
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), error: r.error };
};

const defaultWhich = (bin: string): string | null => {
  const B = (globalThis as any).Bun;
  if (B?.which) return B.which(bin) || null;
  const r = spawnSync("sh", ["-c", `command -v "$0"`, bin], { encoding: "utf8" });
  return r.status === 0 ? String(r.stdout).trim() || null : null;
};

/** The legacy path (pre-fix behaviour): a detached child of the caller. */
export function legacyDetached(o: TransientLaunch): number | null {
  const fd = openSync(o.logPath, "a");
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;
    const child = spawn(o.argv[0], o.argv.slice(1), { cwd: o.cwd, detached: true, stdio: ["ignore", fd, fd], env });
    child.unref();
    return child.pid ?? null;
  } finally { closeSync(fd); }
}

/** systemd EnvironmentFile line: KEY="value" with \ " $ ` escaped; newlines as \n inside quotes are NOT
 *  supported by systemd's parser, so values with newlines are refused (caller falls back). */
export function envFileLine(k: string, v: string): string | null {
  if (!ENV_KEY_RE.test(k)) return null;
  if (/[\n\r\0]/.test(v)) return null;
  return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

export function buildSystemdRunArgs(o: TransientLaunch, argv: string[], envFile: string | null): string[] {
  const a = [
    `--unit=${o.unit}`,
    `--description=${o.description || o.unit}`,
    `--slice=${o.slice || DEFAULT_SLICE}`,
    "--service-type=exec",
    `--working-directory=${o.cwd}`,
    "--quiet",
    "--no-ask-password",
    "-p", `StandardOutput=append:${o.logPath}`,
    "-p", `StandardError=append:${o.logPath}`,
    "-p", "CollectMode=inactive",
  ];
  for (const p of o.properties || []) a.push("-p", p);
  if (envFile) a.push("-p", `EnvironmentFile=${envFile}`);
  else for (const [k, v] of Object.entries(o.env)) if (v !== undefined && ENV_KEY_RE.test(k)) a.push(`--setenv=${k}=${v}`);
  a.push("--", ...argv);
  return a;
}

/**
 * Launch `o` in its own transient unit; fall back to the legacy detached spawn
 * (reported, never silent) when that is impossible. Never throws for the
 * isolation step; a legacy-spawn failure propagates.
 */
export function launchIsolated(o: TransientLaunch, deps: LaunchDeps = {}): LaunchResult {
  const env = deps.env || process.env;
  const run = deps.run || defaultRun;
  const which = deps.which || defaultWhich;
  const legacy = deps.legacy || legacyDetached;
  const fallback = (reason: string): LaunchResult => {
    const pid = legacy(o);
    return { isolated: false, unit: null, pid, isolation: `none (${reason})`, reason };
  };

  if (env.ZOUROBOROS_ISOLATE_JOBS === "0") return fallback("disabled by ZOUROBOROS_ISOLATE_JOBS=0");
  const uid = (deps.getuid || process.getuid)?.() ?? -1;
  if (uid !== 0) return fallback("not root: system transient units need root");
  if (!UNIT_RE.test(o.unit)) return fallback(`invalid unit name ${JSON.stringify(o.unit)}`);
  const systemdRun = which("systemd-run");
  if (!systemdRun) return fallback("systemd-run not found");

  const argv = [...o.argv];
  if (!isAbsolute(argv[0])) {
    const abs = which(argv[0]);
    if (!abs) return fallback(`cannot resolve ${argv[0]}`);
    argv[0] = abs;
  }

  let envFile: string | null = null;
  if (o.secretEnv) {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(o.env)) {
      if (v === undefined) continue;
      const line = envFileLine(k, v);
      if (line === null) {
        if (!ENV_KEY_RE.test(k)) continue; // not a valid env name: systemd would drop it anyway
        return fallback(`env var ${k} has a value an EnvironmentFile cannot carry`);
      }
      lines.push(line);
    }
    const dir = o.envFileDir || join(o.logPath, "..");
    try {
      mkdirSync(dir, { recursive: true });
      envFile = join(dir, `.${o.unit}.${randomBytes(4).toString("hex")}.env`);
      writeFileSync(envFile, lines.join("\n") + "\n", { mode: 0o600 });
      chmodSync(envFile, 0o600);
    } catch (e: any) {
      return fallback(`env file: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  let r: ReturnType<typeof run>;
  try { r = run(systemdRun, buildSystemdRunArgs(o, argv, envFile)); }
  finally { if (envFile) { try { unlinkSync(envFile); } catch {} } }
  if (r.error || r.status !== 0) {
    return fallback(`systemd-run failed: ${String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 200)}`);
  }
  const unit = `${o.unit}.service`;
  let pid: number | null = null;
  const s = run("systemctl", ["show", "-p", "MainPID", "--value", unit]);
  const n = Number(String(s.stdout).trim());
  if (s.status === 0 && Number.isFinite(n) && n > 0) pid = n;
  return { isolated: true, unit, pid, isolation: "systemd-unit" };
}

/** Units in `failed` state whose name starts with `prefix` (e.g. "factory-t_"). */
export function failedUnits(prefix: string, deps: LaunchDeps = {}): string[] {
  const run = deps.run || defaultRun;
  const r = run("systemctl", ["list-units", "--all", "--state=failed", "--no-legend", "--plain", `${prefix}*`]);
  if (r.status !== 0) return [];
  return String(r.stdout).split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u) => !!u && u.startsWith(prefix));
}

/** Clear a failed unit once its result is recorded elsewhere (outbox / status.json). */
export function resetFailed(unit: string, deps: LaunchDeps = {}): boolean {
  const run = deps.run || defaultRun;
  if (!UNIT_RE.test(unit)) return false;
  return run("systemctl", ["reset-failed", unit]).status === 0;
}

/** ActiveState/SubState/MainPID of one unit ("inactive"/"dead" when unknown or collected). */
export function unitState(unit: string, deps: LaunchDeps = {}): { active: string; sub: string; pid: number | null } {
  const run = deps.run || defaultRun;
  const r = run("systemctl", ["show", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", unit]);
  const kv: Record<string, string> = {};
  for (const l of String(r.stdout).split("\n")) { const i = l.indexOf("="); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim(); }
  const pid = Number(kv.MainPID);
  return { active: kv.ActiveState || "unknown", sub: kv.SubState || "unknown", pid: pid > 0 ? pid : null };
}
