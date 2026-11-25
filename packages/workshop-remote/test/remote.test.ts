// remote.test.ts — remote mode: fail-closed startup, discovery, DCR, PKCE,
// consent, token rotation and the bearer gate on /mcp. Drives app.fetch
// directly with a stub tool bridge (the real stdio bridge is exercised by
// the end-to-end proof, not here).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash, randomBytes } from "crypto";
import { ConfigError, loadConfig } from "../src/config";
import { createApp } from "../src/server";

const dir = mkdtempSync(join(tmpdir(), "zo-remote-test-"));
const secretFile = join(dir, "operator.secret");
const SECRET = randomBytes(32).toString("base64url");
const ORIGIN = "https://workshop.example.test";
const baseEnv = () => ({ ZO_REMOTE_ENABLE: "1", ZO_REMOTE_PUBLIC_URL: ORIGIN, ZO_REMOTE_OPERATOR_SECRET_FILE: secretFile, ZO_REMOTE_STATE_DIR: join(dir, "state"), HOME: dir });
let app: ReturnType<typeof createApp>;
const calls: string[] = [];

beforeAll(() => {
  writeFileSync(secretFile, SECRET); chmodSync(secretFile, 0o600);
  app = createApp(loadConfig(baseEnv()), {
    listTools: async () => [{ name: "memory_store", inputSchema: { type: "object" } }],
    callTool: async (name: string) => { calls.push(name); return { content: [{ type: "text", text: `called ${name}` }] }; },
    close: async () => {},
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init));
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const pkce = () => { const v = randomBytes(32).toString("base64url"); return { v, c: createHash("sha256").update(v).digest("base64url") }; };
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function register(extra: object = {}) {
  const r = await req("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], ...extra }) });
  return { status: r.status, body: (await r.json()) as any };
}
async function consent(clientId: string, challenge: string, redirect = REDIRECT, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: `${ORIGIN}/mcp`, scope: "workshop", ...extra });
  const r = await req(`/authorize?${q}`);
  const html = await r.text();
  return { r, html, txn: html.match(/name="txn" value="([^"]+)"/)?.[1] };
}
async function approve(txn: string, secret = SECRET) {
  return req("/authorize", { ...form({ txn, operator_secret: secret, decision: "approve" }), redirect: "manual" });
}
async function fullGrant() {
  const { body: c } = await register();
  const { v, c: ch } = pkce();
  const { txn } = await consent(c.client_id, ch);
  const loc = new URL((await approve(txn!)).headers.get("location")!);
  const t = await req("/token", form({ grant_type: "authorization_code", client_id: c.client_id, code: loc.searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: v, resource: `${ORIGIN}/mcp` }));
  return { client: c, tokens: (await t.json()) as any, code: loc.searchParams.get("code")!, verifier: v };
}

describe("startup is fail-closed", () => {
  const refuse = (env: Record<string, string | undefined>, msg: RegExp) => expect(() => loadConfig(env)).toThrow(msg);
  test("off unless enabled", () => refuse({ ...baseEnv(), ZO_REMOTE_ENABLE: undefined }, /remote mode is off/));
  test("no credential configured = startup error", () => refuse({ ...baseEnv(), ZO_REMOTE_OPERATOR_SECRET_FILE: undefined }, /never runs without an authorization credential/));
  test("missing credential file", () => refuse({ ...baseEnv(), ZO_REMOTE_OPERATOR_SECRET_FILE: join(dir, "nope") }, /not found/));
  test("group/other-readable credential", () => {
    const f = join(dir, "loose.secret"); writeFileSync(f, SECRET); chmodSync(f, 0o644);
    refuse({ ...baseEnv(), ZO_REMOTE_OPERATOR_SECRET_FILE: f }, /owner-only/);
  });
  test("short credential", () => {
    const f = join(dir, "short.secret"); writeFileSync(f, "abc"); chmodSync(f, 0o600);
    refuse({ ...baseEnv(), ZO_REMOTE_OPERATOR_SECRET_FILE: f }, /too short/);
  });
  test("public URL must be https (http only on loopback)", () => {
    refuse({ ...baseEnv(), ZO_REMOTE_PUBLIC_URL: "http://example.test" }, /must be https/);
    expect(loadConfig({ ...baseEnv(), ZO_REMOTE_PUBLIC_URL: "http://127.0.0.1:48410" }).publicUrl).toBe("http://127.0.0.1:48410");
  });
  test("non-loopback bind needs explicit opt-in", () => {
    refuse({ ...baseEnv(), ZO_REMOTE_HOST: "0.0.0.0" }, /refusing to bind non-loopback/);
    expect(loadConfig({ ...baseEnv(), ZO_REMOTE_HOST: "0.0.0.0", ZO_REMOTE_ALLOW_NONLOCAL_BIND: "1" }).host).toBe("0.0.0.0");
  });
  test("errors are ConfigError", () => expect(() => loadConfig({})).toThrow(ConfigError));
});

describe("discovery", () => {
  test("/mcp without a token is 401 with resource_metadata", async () => {
    const r = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  });
  test("protected resource metadata (both well-known forms)", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const m = (await (await req(p)).json()) as any;
      expect(m.resource).toBe(`${ORIGIN}/mcp`);
      expect(m.authorization_servers).toEqual([ORIGIN]);
    }
  });
  test("authorization server metadata", async () => {
    const m = (await (await req("/.well-known/oauth-authorization-server")).json()) as any;
    expect(m.issuer).toBe(ORIGIN);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(m.token_endpoint_auth_methods_supported).toContain("none");
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
  });
});

describe("dynamic client registration", () => {
  test("rejects http non-loopback and fragment redirects", async () => {
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    expect((await register({ redirect_uris: ["https://ok.example/cb#x"] })).status).toBe(400);
  });
  test("accepts the vendor callbacks and loopback", async () => {
    for (const u of [REDIRECT, "https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:3118/callback", "http://127.0.0.1:53280/callback"]) {
      const r = await register({ redirect_uris: [u] });
      expect(r.status).toBe(201);
      expect(r.body.client_id).toStartWith("zoc_");
    }
  });
  test("confidential registration gets a secret", async () => {
    const r = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(r.body.client_secret).toBeString();
  });
});

describe("authorization + token", () => {
  test("PKCE is mandatory and S256-only", async () => {
    const { body: c } = await register();
    const q = (o: Record<string, string>) => req(`/authorize?${new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, state: "s", ...o })}`, { redirect: "manual" });
    const noPkce = new URL((await q({})).headers.get("location")!);
    expect(noPkce.searchParams.get("error")).toBe("invalid_request");
    expect(noPkce.searchParams.get("iss")).toBe(ORIGIN);
    const plain = new URL((await q({ code_challenge: "x".repeat(43), code_challenge_method: "plain" })).headers.get("location")!);
    expect(plain.searchParams.get("error")).toBe("invalid_request");
  });
  test("unregistered redirect is never redirected to", async () => {
    const { body: c } = await register();
    const { r } = await consent(c.client_id, pkce().c, "https://attacker.example/cb");
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
  });
  test("wrong resource is invalid_target", async () => {
    const { body: c } = await register();
    const { r } = await consent(c.client_id, pkce().c, REDIRECT, { resource: "https://other.example/mcp" });
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
  test("consent page is unframeable and names the redirect host", async () => {
    const { body: c } = await register();
    const { r, html } = await consent(c.client_id, pkce().c);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("claude.ai");
  });
  test("wrong operator secret is refused; three strikes deny", async () => {
    const { body: c } = await register();
    const { txn } = await consent(c.client_id, pkce().c);
    expect((await approve(txn!, "wrong-secret")).status).toBe(401);
    expect((await approve(txn!, "wrong-secret")).status).toBe(401);
    const third = await approve(txn!, "wrong-secret");
    expect(new URL(third.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });
  test("happy path: code carries state and iss; tokens issued; wrong verifier fails", async () => {
    const { body: c } = await register();
    const { v, c: ch } = pkce();
    const { txn } = await consent(c.client_id, ch);
    const loc = new URL((await approve(txn!)).headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st-1");
    expect(loc.searchParams.get("iss")).toBe(ORIGIN);
    const code = loc.searchParams.get("code")!;
    const bad = await req("/token", form({ grant_type: "authorization_code", client_id: c.client_id, code, redirect_uri: REDIRECT, code_verifier: pkce().v }));
    expect(((await bad.json()) as any).error).toBe("invalid_grant");
    // the code was consumed by the failed attempt: single use
    const again = await req("/token", form({ grant_type: "authorization_code", client_id: c.client_id, code, redirect_uri: REDIRECT, code_verifier: v }));
    expect(((await again.json()) as any).error).toBe("invalid_grant");
  });
  test("code replay revokes the tokens it issued", async () => {
    const g = await fullGrant();
    expect(g.tokens.access_token).toBeString();
    const replay = await req("/token", form({ grant_type: "authorization_code", client_id: g.client.client_id, code: g.code, redirect_uri: REDIRECT, code_verifier: g.verifier }));
    expect(((await replay.json()) as any).error).toBe("invalid_grant");
    const r = await req("/mcp", { method: "POST", headers: { authorization: `Bearer ${g.tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(401);
  });
  test("refresh rotates; reusing a rotated refresh token revokes the grant", async () => {
    const g = await fullGrant();
    const r1 = (await (await req("/token", form({ grant_type: "refresh_token", client_id: g.client.client_id, refresh_token: g.tokens.refresh_token }))).json()) as any;
    expect(r1.access_token).toBeString();
    expect(r1.refresh_token).not.toBe(g.tokens.refresh_token);
    const reuse = (await (await req("/token", form({ grant_type: "refresh_token", client_id: g.client.client_id, refresh_token: g.tokens.refresh_token }))).json()) as any;
    expect(reuse.error).toBe("invalid_grant");
    const r2 = (await (await req("/token", form({ grant_type: "refresh_token", client_id: g.client.client_id, refresh_token: r1.refresh_token }))).json()) as any;
    expect(r2.error).toBe("invalid_grant");
  });
});

describe("the bearer-gated MCP endpoint", () => {
  const rpc = (token: string, body: object) => req("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  test("garbage token is 401 invalid_token", async () => {
    const r = await rpc("not-a-token", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
  test("valid token: initialize, tools/list, tools/call", async () => {
    const { tokens } = await fullGrant();
    const init = (await (await rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json()) as any;
    expect(init.result.serverInfo.name).toBe("zouroboros-workshop-remote");
    const list = (await (await rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["memory_store"]);
    const call = (await (await rpc(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_store", arguments: {} } })).json()) as any;
    expect(call.result.content[0].text).toBe("called memory_store");
  });
  test("revoked token stops working", async () => {
    const g = await fullGrant();
    await req("/revoke", form({ client_id: g.client.client_id, token: g.tokens.refresh_token }));
    expect((await rpc(g.tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  });
  test("GET /mcp is 405 (stateless endpoint)", async () => {
    expect((await req("/mcp")).status).toBe(405);
  });
});
