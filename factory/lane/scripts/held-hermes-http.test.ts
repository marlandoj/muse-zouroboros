import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { admitHeldHermesHttp } from "./held-hermes-http";

const binding = JSON.parse(readFileSync(new URL("../hermes/manifest.json", import.meta.url), "utf8"));

async function work() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hermes\0software-factory\0task-1"));
  return {
    schema: "factory-work/v1",
    factory_work_id: `fw_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`,
    source: "hermes",
    external_references: { hermes_board: "software-factory", hermes_task_id: "task-1" },
    title: "Build", description: "Criteria", source_status: "scheduled", dispatch_eligible: false,
  };
}

async function envelope() {
  return {
    board: "software-factory", dispatch_enabled: false, integrity: "ok",
    schema_version: binding.schema_version, schema_sha256: binding.schema_sha256,
    status_counts: { scheduled: 1 }, source_commit: binding.commit,
    full_schema_sha256: binding.full_schema_sha256,
    full_schema_artifact_sha256: binding.full_schema_artifact_sha256,
    work: [await work()], work_admission: "held",
  };
}

async function withFixtureServer(payload: unknown, status: number, run: (url: string) => Promise<void>) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
  });
  try { await run(`http://127.0.0.1:${server.port}/held-work`); }
  finally { server.stop(true); }
}

test("loopback HTTP admission retains scheduled work as held", async () => {
  await withFixtureServer(await envelope(), 200, async url => {
    const [held] = await admitHeldHermesHttp(url, binding);
    expect(held.source_status).toBe("scheduled");
    expect(held.dispatch_eligible).toBe(false);
    expect(held.admission).toBe("held_untrusted_snapshot");
  });
});

test("fixture CLI consumes the HTTP held-work route", async () => {
  await withFixtureServer(await envelope(), 200, async url => {
    const script = fileURLToPath(new URL("./hermes-work-admission.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, script, "--held-url", url], {
      env: { ...process.env, FACTORY_STATE_MODE: "test" }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe("");
    const held = JSON.parse(output);
    expect(held[0].admission).toBe("held_untrusted_snapshot");
    expect(held[0].dispatch_eligible).toBe(false);
  });
});

test("HTTP envelope drift and unhealthy reader fail closed", async () => {
  await withFixtureServer({ ...await envelope(), full_schema_sha256: "0".repeat(64) }, 200, async url => {
    await expect(admitHeldHermesHttp(url, binding)).rejects.toThrow("HERMES_HTTP_BINDING");
  });
  await withFixtureServer({ status: "unhealthy", dispatch_enabled: false }, 503, async url => {
    await expect(admitHeldHermesHttp(url, binding)).rejects.toThrow("HERMES_HTTP_RESPONSE");
  });
});

test("HTTP status counts must match the statuses in held work", async () => {
  await withFixtureServer({ ...await envelope(), status_counts: { todo: 1 } }, 200, async url => {
    await expect(admitHeldHermesHttp(url, binding)).rejects.toThrow("HERMES_HTTP_COUNTS");
  });
});

test("HTTP admission refuses non-loopback and production mode", async () => {
  await expect(admitHeldHermesHttp("http://example.com/held-work", binding)).rejects.toThrow("HERMES_HTTP_TARGET");
  const prior = process.env.FACTORY_STATE_MODE;
  delete process.env.FACTORY_STATE_MODE;
  try {
    await expect(admitHeldHermesHttp("http://127.0.0.1:1/held-work", binding)).rejects.toThrow("HERMES_HTTP_FIXTURE_ONLY");
  } finally {
    if (prior === undefined) delete process.env.FACTORY_STATE_MODE;
    else process.env.FACTORY_STATE_MODE = prior;
  }
});
