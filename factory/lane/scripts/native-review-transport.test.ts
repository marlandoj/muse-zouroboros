import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { invokeNativeReviewCommand, type NativeCommand } from "./native-review-adapter";

const linuxTest = process.platform === "linux" ? test : test.skip;
const python = "/usr/bin/python3";
const adapter = fileURLToPath(new URL("./native-review-adapter.ts", import.meta.url));
const environment = (root: string) => ({ HOME: root, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });

const fixtureSource = `import json, os, sys, time
mode = sys.argv[1]
if mode == "utf8":
    assert sys.stdin.read() == "synthetic evidence"
    for fd, value in ((1, "review: ✓ 😀\\n"), (2, "note: λ\\n")):
        for byte in value.encode("utf-8"):
            os.write(fd, bytes([byte]))
            time.sleep(0.005)
elif mode == "timeout":
    os.write(1, b"started\\n")
    time.sleep(10)
elif mode == "overflow":
    os.write(1, b"a" * 96)
    os.write(2, b"b" * 96)
    time.sleep(10)
elif mode == "descendant":
    parent = os.getpid()
    child = os.fork()
    if child == 0:
        # Stay in the inherited process group, but release transport pipes so
        # the parent's normal close must trigger descendant cleanup.
        with open(os.devnull, "r+b", buffering=0) as null:
            for fd in (0, 1, 2):
                os.dup2(null.fileno(), fd)
        time.sleep(10)
        os._exit(1)
    with open("pids.json", "x") as output:
        json.dump({"parent": parent, "descendant": child}, output)
    os.write(1, b"parent complete\\n")
else:
    raise RuntimeError("unknown synthetic fixture")
`;

async function withFixture<T>(body: (root: string, script: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "native-review-transport-"));
  const script = join(root, "fixture.py");
  try {
    await writeFile(script, fixtureSource, { mode: 0o600 });
    return await body(root, script);
  } finally {
    // mkdtemp created this exact private root; never remove a caller path.
    await rm(root, { recursive: true, force: true });
  }
}

function command(root: string, script: string, mode: string,
  overrides: Partial<NativeCommand> = {}): NativeCommand {
  return { executable: python, args: ["-I", "-B", script, mode],
    stdin: "", cwd: root, env: environment(root), timeoutMs: 1500,
    outputLimit: 1024, ...overrides };
}

// A private Linux subreaper owns only the nested Bun worker and its fixtures.
// This makes orphan cleanup observable without relying on the host's PID 1.
const supervisorSource = `import ctypes, errno, json, os, pathlib, signal, subprocess, sys, time
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "cannot establish fixture subreaper")
root = pathlib.Path(sys.argv[3])
worker = subprocess.Popen([sys.argv[1], "run", sys.argv[2]],
                          cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
reaped = {}
def collect():
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return
        reaped[pid] = status
try:
    out, err = worker.communicate(timeout=4)
    pids = json.loads((root / "pids.json").read_text())
    deadline = time.monotonic() + 1
    while pids["descendant"] not in reaped and time.monotonic() < deadline:
        collect()
        time.sleep(0.01)
    status = reaped.get(pids["descendant"])
    result = {"workerExit": worker.returncode, "workerStderrEmpty": not err,
              "transport": json.loads(out),
              "descendantReaped": status is not None,
              "descendantKilled": status is not None and os.WIFSIGNALED(status)
                                   and os.WTERMSIG(status) == signal.SIGKILL,
              "parentGone": not pathlib.Path("/proc", str(pids["parent"])).exists(),
              "descendantGone": not pathlib.Path("/proc", str(pids["descendant"])).exists()}
    print(json.dumps(result))
finally:
    # Kill only still-owned direct/adopted children. waitpid verifies ownership
    # before a cleanup signal; already-reaped/reused PID numbers are untouched.
    if worker.poll() is None:
        worker.kill()
        worker.wait(timeout=1)
    children = pathlib.Path("/proc/self/task", str(os.getpid()), "children")
    # Re-read after each generation: killing an adopted parent may adopt its
    # children next. No process is allowed to escape this fixture supervisor.
    cleanup_deadline = time.monotonic() + 1
    while children.read_text().split() and time.monotonic() < cleanup_deadline:
        for value in children.read_text().split():
            pid = int(value)
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
                if done == 0:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
            except (ChildProcessError, ProcessLookupError):
                pass
    if children.read_text().strip():
        raise RuntimeError("owned fixture children were not reaped")
`;

describe("native reviewer Linux transport, credential-free fixtures", () => {
  linuxTest("decodes UTF-8 split across actual stdout/stderr chunks", async () => {
    await withFixture(async (root, script) => {
      const result = await invokeNativeReviewCommand(command(root, script, "utf8", {
        stdin: "synthetic evidence",
      }));
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe("review: ✓ 😀\n");
      expect(result.stderr).toBe("note: λ\n");
      expect(result.timedOut).toBe(false);
      expect(result.overflow).toBe(false);
    });
  }, 3000);

  linuxTest("kills and reaps a timed-out direct child", async () => {
    await withFixture(async (root, script) => {
      const began = performance.now();
      const result = await invokeNativeReviewCommand(command(root, script, "timeout", { timeoutMs: 150 }));
      expect(result.timedOut).toBe(true);
      expect(result.overflow).toBe(false);
      expect(result.signal).toBe("SIGKILL");
      expect(result.stdout).toBe("started\n");
      expect(performance.now() - began).toBeLessThan(2000);
    });
  }, 3000);

  linuxTest("bounds combined stdout and stderr rather than each channel alone", async () => {
    await withFixture(async (root, script) => {
      const result = await invokeNativeReviewCommand(command(root, script, "overflow", { outputLimit: 128 }));
      expect(result.overflow).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBe("SIGKILL");
      expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(128);
    });
  }, 3000);

  linuxTest("normal parent exit kills its inherited-group descendant, which is reaped", async () => {
    await withFixture(async (root, script) => {
      const worker = join(root, "worker.ts"), supervisor = join(root, "supervisor.py");
      const invocation = command(root, script, "descendant");
      await writeFile(worker, `import { invokeNativeReviewCommand } from ${JSON.stringify(adapter)};\n`
        + `console.log(JSON.stringify(await invokeNativeReviewCommand(${JSON.stringify(invocation)})));\n`, { mode: 0o600 });
      await writeFile(supervisor, supervisorSource, { mode: 0o600 });
      const observed = spawnSync(python, ["-I", "-B", supervisor, resolve(process.execPath), worker, root], {
        cwd: root, env: environment(root), encoding: "utf8", timeout: 6500, maxBuffer: 8192,
      });
      expect(observed.error).toBeUndefined();
      expect(observed.status).toBe(0);
      expect(observed.stderr).toBe("");
      const result = JSON.parse(observed.stdout);
      expect(result.workerExit).toBe(0);
      expect(result.workerStderrEmpty).toBe(true);
      expect(result.transport.exitCode).toBe(0);
      expect(result.transport.timedOut).toBe(false);
      expect(result.transport.stdout).toBe("parent complete\n");
      expect(result.descendantKilled).toBe(true);
      expect(result.descendantReaped).toBe(true);
      expect(result.parentGone).toBe(true);
      expect(result.descendantGone).toBe(true);
      expect(JSON.parse(await readFile(join(root, "pids.json"), "utf8")).descendant).toBeGreaterThan(1);
    });
  }, 7000);
});
