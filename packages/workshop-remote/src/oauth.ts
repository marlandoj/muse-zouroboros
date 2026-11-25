/**
 * oauth.ts — a small OAuth 2.1 authorization server + resource-server check
 * for the workshop's remote mode, written against the public specs only:
 *
 *   RFC 9728  protected resource metadata   /.well-known/oauth-protected-resource[/mcp]
 *   RFC 8414  authorization server metadata /.well-known/oauth-authorization-server
 *   RFC 7591  dynamic client registration   POST /register
 *   RFC 6749 + RFC 7636 (PKCE, S256 only)   GET/POST /authorize, POST /token
 *   RFC 8707  resource indicators           `resource` is checked and bound into every token
 *   RFC 9207  issuer identification         `iss` on every authorization response
 *   RFC 7009  token revocation              POST /revoke
 *
 * There is one user: the operator. The consent page asks for the operator
 * secret, so no client — however it registered — gets a token unless the
 * operator approves it with that secret. Codes, access tokens and refresh
 * tokens are stored only as SHA-256 hashes; refresh tokens rotate, and
 * presenting a rotated refresh token (or replaying a code) revokes the whole
 * grant.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { isLoopbackHost, type RemoteConfig } from "./config";

export const SCOPE = "workshop";
const ACCESS_TTL = 3600; // seconds
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 60;
const TXN_TTL = 600;
const MAX_CLIENTS = 500;
const MAX_REGISTRATIONS_PER_HOUR = 60;
const LOCKOUT_FAILURES = 10; // wrong operator secrets within LOCKOUT_WINDOW lock approvals
const LOCKOUT_WINDOW = 900;

const now = () => Math.floor(Date.now() / 1000);
const tok = (n = 32) => randomBytes(n).toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64urlSha = (s: string) => createHash("sha256").update(s).digest("base64url");

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };
function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...NO_STORE, ...extra } });
}
function oauthError(error: string, description: string, status = 400, extra: Record<string, string> = {}): Response {
  return json({ error, error_description: description }, status, extra);
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** RFC 8252 §7.3: loopback redirects match with the port ignored. */
function redirectMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const a = new URL(registered), b = new URL(presented);
    if (a.protocol !== "http:" || b.protocol !== "http:") return false;
    if (!isLoopbackHost(a.hostname) || a.hostname !== b.hostname) return false;
    return a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

function validRedirect(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch { return false; }
}

async function formOrJson(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const o = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
  }
  const p = new URLSearchParams(await req.text());
  return Object.fromEntries(p.entries());
}

export class OAuthServer {
  private db: Database;
  private failures: number[] = [];
  private registrations: number[] = [];

  constructor(private cfg: RemoteConfig) {
    mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(cfg.stateDir, 0o700);
    const path = join(cfg.stateDir, "oauth.db");
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, secret_sha TEXT, auth_method TEXT NOT NULL,
        redirect_uris TEXT NOT NULL, client_name TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (txn TEXT PRIMARY KEY, params TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (code_sha TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        challenge TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL, grant_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tokens (token_sha TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL,
        scope TEXT NOT NULL, resource TEXT NOT NULL, grant_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0);
    `);
    for (const f of ["-wal", "-shm"]) { try { chmodSync(path + f, 0o600); } catch { /* created lazily */ } }
  }

  // ---------------------------------------------------------------- metadata
  protectedResourceMetadata(): Response {
    return json({
      resource: this.cfg.resource,
      authorization_servers: [this.cfg.publicUrl],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Zouroboros Workshop (Community Edition, remote mode)",
    });
  }

  authorizationServerMetadata(): Response {
    const u = this.cfg.publicUrl;
    return json({
      issuer: u,
      authorization_endpoint: `${u}/authorize`,
      token_endpoint: `${u}/token`,
      registration_endpoint: `${u}/register`,
      revocation_endpoint: `${u}/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [SCOPE, "offline_access"],
      authorization_response_iss_parameter_supported: true,
    });
  }

  /** 401 for the MCP endpoint, pointing clients at the discovery document. */
  unauthorized(error?: string): Response {
    let h = `Bearer resource_metadata="${this.cfg.publicUrl}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;
    if (error) h += `, error="${error}"`;
    return json({ error: error || "unauthorized", error_description: "a bearer token from this server's OAuth flow is required" }, 401, { "www-authenticate": h });
  }

  // ------------------------------------------------------------ registration
  async register(req: Request): Promise<Response> {
    const t = now();
    this.registrations = this.registrations.filter((x) => x > t - 3600);
    if (this.registrations.length >= MAX_REGISTRATIONS_PER_HOUR) return oauthError("temporarily_unavailable", "registration rate limit", 429);
    const count = (this.db.query("SELECT COUNT(*) AS n FROM clients").get() as { n: number }).n;
    if (count >= MAX_CLIENTS) return oauthError("temporarily_unavailable", "client limit reached; revoke old clients", 503);

    let meta: any;
    try { meta = await req.json(); } catch { return oauthError("invalid_client_metadata", "body must be JSON"); }
    const uris = meta?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u: unknown) => typeof u === "string" && validRedirect(u))) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be 1-10 https:// URIs (or http:// loopback), without fragments");
    }
    const method = meta.token_endpoint_auth_method ?? "client_secret_basic"; // RFC 7591 §2 default
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) return oauthError("invalid_client_metadata", `unsupported token_endpoint_auth_method ${method}`);
    const grants: string[] = meta.grant_types ?? ["authorization_code"];
    if (!grants.every((g) => ["authorization_code", "refresh_token"].includes(g))) return oauthError("invalid_client_metadata", "grant_types may only be authorization_code and refresh_token");
    const responses: string[] = meta.response_types ?? ["code"];
    if (!responses.every((r) => r === "code")) return oauthError("invalid_client_metadata", "response_types may only be code");
    const name = typeof meta.client_name === "string" ? meta.client_name.slice(0, 120) : "unnamed client";

    const clientId = `zoc_${tok(18)}`;
    const secret = method === "none" ? null : tok(32);
    this.db.query("INSERT INTO clients VALUES (?, ?, ?, ?, ?, ?)").run(clientId, secret ? sha(secret) : null, method, JSON.stringify(uris), name, t);
    this.registrations.push(t);
    return json({
      client_id: clientId,
      client_id_issued_at: t,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: grants,
      response_types: ["code"],
      scope: SCOPE,
    }, 201);
  }

  private client(id: string | null | undefined): any {
    if (!id) return null;
    return this.db.query("SELECT * FROM clients WHERE client_id = ?").get(id) as any;
  }

  // ----------------------------------------------------------- authorization
  private redirectWith(redirectUri: string, params: Record<string, string | undefined>): Response {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set("iss", this.cfg.publicUrl); // RFC 9207
    return new Response(null, { status: 302, headers: { location: u.toString(), ...NO_STORE } });
  }

  private page(title: string, body: string, status = 200, formTarget?: string): Response {
    const formAction = formTarget ? `'self' ${formTarget}` : "'self'";
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}code{background:#eee;padding:0 .25rem}.warn{background:#fff3cd;padding:.5rem .75rem;border-radius:.3rem}.err{color:#a00}input[type=password]{width:100%;padding:.4rem;font:inherit}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}</style>
</head><body>${body}</body></html>`, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        ...NO_STORE,
      },
    });
  }

  private consentPage(txn: string, p: Record<string, string>, error?: string): Response {
    const c = this.client(p.client_id);
    const host = new URL(p.redirect_uri);
    const loopbackOnly = (JSON.parse(c.redirect_uris) as string[]).every((u) => isLoopbackHost(new URL(u).hostname));
    const body = `<h1>Approve a connection to your workshop?</h1>
<p><b>${esc(c.client_name || "unnamed client")}</b> wants access to this Zouroboros workshop (${esc(this.cfg.publicUrl)}).</p>
<p>After approval you will be sent to <code>${esc(host.host)}</code>.</p>
${loopbackOnly ? `<p class="warn">This client only redirects to your own machine (<code>${esc(host.hostname)}</code>). Any local program can claim that address: approve only if you started this connection yourself.</p>` : ""}
<p>Access granted: the workshop's MCP tools (memory${this.cfg.exposeSwarm ? " and swarm" : ""}).</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="txn" value="${esc(txn)}">
<p><label>Operator secret<br><input type="password" name="operator_secret" autocomplete="current-password" autofocus></label></p>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`;
    return this.page("Approve connection", body, error ? 401 : 200, host.origin);
  }

  async authorizeGet(req: Request): Promise<Response> {
    const q = Object.fromEntries(new URL(req.url).searchParams.entries());
    const c = this.client(q.client_id);
    if (!c) return this.page("Unknown client", "<h1>Unknown client</h1><p>This client is not registered with the workshop.</p>", 400);
    const regs = JSON.parse(c.redirect_uris) as string[];
    if (!q.redirect_uri || !regs.some((r) => redirectMatches(r, q.redirect_uri))) {
      return this.page("Bad redirect", "<h1>Redirect URI mismatch</h1><p>The redirect URI is not registered for this client.</p>", 400);
    }
    // From here on, errors go back to the (validated) redirect URI.
    const back = (error: string, desc: string) => this.redirectWith(q.redirect_uri, { error, error_description: desc, state: q.state });
    if (q.response_type !== "code") return back("unsupported_response_type", "only response_type=code");
    if (!q.code_challenge) return back("invalid_request", "PKCE code_challenge is required");
    if ((q.code_challenge_method || "plain") !== "S256") return back("invalid_request", "code_challenge_method must be S256");
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return back("invalid_request", "malformed code_challenge");
    if (q.resource && q.resource !== this.cfg.resource) return back("invalid_target", `resource must be ${this.cfg.resource}`);
    const scopes = (q.scope || SCOPE).split(/\s+/).filter(Boolean);
    if (!scopes.every((s) => s === SCOPE || s === "offline_access")) return back("invalid_scope", `supported scopes: ${SCOPE} offline_access`);

    const txn = tok(32);
    const params = { client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state ?? "", code_challenge: q.code_challenge, scope: SCOPE, resource: this.cfg.resource };
    this.db.query("DELETE FROM pending WHERE expires_at < ?").run(now());
    this.db.query("INSERT INTO pending (txn, params, expires_at) VALUES (?, ?, ?)").run(txn, JSON.stringify(params), now() + TXN_TTL);
    return this.consentPage(txn, params);
  }

  private secretOk(presented: string): boolean {
    const d = createHash("sha256").update(presented.trim()).digest();
    return timingSafeEqual(d, this.cfg.secretSha256);
  }

  async authorizePost(req: Request): Promise<Response> {
    const f = await formOrJson(req);
    const row = this.db.query("SELECT * FROM pending WHERE txn = ?").get(f.txn ?? "") as any;
    if (!row || row.expires_at < now()) return this.page("Expired", "<h1>This approval request expired</h1><p>Start the connection again from your client.</p>", 400);
    const p = JSON.parse(row.params) as Record<string, string>;
    const state = p.state || undefined;
    if (f.decision !== "approve") {
      this.db.query("DELETE FROM pending WHERE txn = ?").run(f.txn);
      return this.redirectWith(p.redirect_uri, { error: "access_denied", error_description: "the operator denied the request", state });
    }
    const t = now();
    this.failures = this.failures.filter((x) => x > t - LOCKOUT_WINDOW);
    if (this.failures.length >= LOCKOUT_FAILURES) {
      return this.page("Locked", "<h1>Too many wrong secrets</h1><p>Approvals are locked for 15 minutes.</p>", 429);
    }
    if (!this.secretOk(f.operator_secret ?? "")) {
      this.failures.push(t);
      const attempts = row.attempts + 1;
      if (attempts >= 3) {
        this.db.query("DELETE FROM pending WHERE txn = ?").run(f.txn);
        return this.redirectWith(p.redirect_uri, { error: "access_denied", error_description: "operator secret rejected", state });
      }
      this.db.query("UPDATE pending SET attempts = ? WHERE txn = ?").run(attempts, f.txn);
      return this.consentPage(f.txn, p, "That is not the operator secret.");
    }
    this.db.query("DELETE FROM pending WHERE txn = ?").run(f.txn);
    const code = tok(32);
    this.db.query("INSERT INTO codes (code_sha, client_id, redirect_uri, challenge, scope, resource, grant_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sha(code), p.client_id, p.redirect_uri, p.code_challenge, p.scope, p.resource, tok(12), t + CODE_TTL);
    return this.redirectWith(p.redirect_uri, { code, state });
  }

  // ------------------------------------------------------------------- token
  private authenticateClient(req: Request, f: Record<string, string>): { client: any } | { error: Response } {
    let id = f.client_id, secret = f.client_secret;
    const basic = req.headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      const dec = Buffer.from(basic.slice(6), "base64").toString();
      const i = dec.indexOf(":");
      if (i < 0) return { error: oauthError("invalid_client", "malformed basic credentials", 401) };
      id = decodeURIComponent(dec.slice(0, i)); secret = decodeURIComponent(dec.slice(i + 1));
    }
    const c = this.client(id);
    if (!c) return { error: oauthError("invalid_client", "unknown client", 401) };
    if (c.auth_method !== "none") {
      if (!secret) return { error: oauthError("invalid_client", "client authentication required", 401) };
      const a = Buffer.from(sha(secret), "hex"), b = Buffer.from(c.secret_sha, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: oauthError("invalid_client", "bad client secret", 401) };
    }
    return { client: c };
  }

  private issue(clientId: string, scope: string, resource: string, grantId: string): Record<string, unknown> {
    const access = tok(32), refresh = tok(32), t = now();
    const ins = this.db.query("INSERT INTO tokens (token_sha, kind, client_id, scope, resource, grant_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    ins.run(sha(access), "access", clientId, scope, resource, grantId, t + ACCESS_TTL);
    ins.run(sha(refresh), "refresh", clientId, scope, resource, grantId, t + REFRESH_TTL);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope };
  }

  private revokeGrant(grantId: string) {
    this.db.query("UPDATE tokens SET revoked = 1 WHERE grant_id = ?").run(grantId);
  }

  async token(req: Request): Promise<Response> {
    const f = await formOrJson(req);
    const auth = this.authenticateClient(req, f);
    if ("error" in auth) return auth.error;
    const c = auth.client;
    if (f.resource && f.resource !== this.cfg.resource) return oauthError("invalid_target", `resource must be ${this.cfg.resource}`);

    if (f.grant_type === "authorization_code") {
      const row = this.db.query("SELECT * FROM codes WHERE code_sha = ?").get(sha(f.code ?? "")) as any;
      if (!row || row.client_id !== c.client_id) return oauthError("invalid_grant", "unknown authorization code");
      if (row.used) { this.revokeGrant(row.grant_id); return oauthError("invalid_grant", "authorization code already used; its tokens are revoked"); }
      this.db.query("UPDATE codes SET used = 1 WHERE code_sha = ?").run(row.code_sha);
      if (row.expires_at < now()) return oauthError("invalid_grant", "authorization code expired");
      if (f.redirect_uri !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
      const v = f.code_verifier ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(v)) return oauthError("invalid_grant", "code_verifier missing or malformed");
      if (b64urlSha(v) !== row.challenge) return oauthError("invalid_grant", "PKCE verification failed");
      return json(this.issue(c.client_id, row.scope, row.resource, row.grant_id));
    }

    if (f.grant_type === "refresh_token") {
      const row = this.db.query("SELECT * FROM tokens WHERE token_sha = ? AND kind = 'refresh'").get(sha(f.refresh_token ?? "")) as any;
      if (!row || row.client_id !== c.client_id) return oauthError("invalid_grant", "unknown refresh token");
      if (row.revoked) { this.revokeGrant(row.grant_id); return oauthError("invalid_grant", "refresh token was already used or revoked; the grant is revoked"); }
      if (row.expires_at < now()) return oauthError("invalid_grant", "refresh token expired");
      this.db.query("UPDATE tokens SET revoked = 1 WHERE token_sha = ?").run(row.token_sha); // rotation
      return json(this.issue(c.client_id, row.scope, row.resource, row.grant_id));
    }
    return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  async revoke(req: Request): Promise<Response> {
    const f = await formOrJson(req);
    const auth = this.authenticateClient(req, f);
    if ("error" in auth) return auth.error;
    const row = this.db.query("SELECT * FROM tokens WHERE token_sha = ?").get(sha(f.token ?? "")) as any;
    if (row && row.client_id === auth.client.client_id) this.revokeGrant(row.grant_id);
    return new Response(null, { status: 200, headers: NO_STORE });
  }

  // ------------------------------------------------------ resource-server side
  /** Returns the token's client on success, or a 401 Response. */
  verifyBearer(req: Request): { clientId: string } | Response {
    const h = req.headers.get("authorization") || "";
    if (!h.startsWith("Bearer ")) return this.unauthorized();
    const row = this.db.query("SELECT * FROM tokens WHERE token_sha = ? AND kind = 'access'").get(sha(h.slice(7).trim())) as any;
    if (!row || row.revoked || row.expires_at < now() || row.resource !== this.cfg.resource) return this.unauthorized("invalid_token");
    return { clientId: row.client_id };
  }
}
