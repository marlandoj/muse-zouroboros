#!/usr/bin/env bun
/**
 * server.ts — the Community workshop's remote mode: one HTTPS-reachable MCP
 * endpoint (Streamable HTTP, stateless JSON responses) protected by OAuth 2.1
 * with PKCE, dynamic client registration and discovery metadata, for web
 * clients (ChatGPT developer mode, Claude.ai custom connectors, Muse custom
 * connectors) that cannot spawn a local stdio server.
 *
 * Off unless ZO_REMOTE_ENABLE=1, and it refuses to start without an operator
 * secret file (see config.ts). Local stdio use is unaffected: nothing here
 * runs unless the operator starts this file.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server       RFC 8414
 *   POST /register                                     RFC 7591
 *   GET  /authorize  (consent page)  POST /authorize   PKCE S256 only
 *   POST /token  POST /revoke
 *   POST /mcp                                          bearer token required
 *   GET  /health
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ConfigError, loadConfig, type RemoteConfig } from "./config";
import { OAuthServer } from "./oauth";
import { StdioBridge } from "./bridge";

export function createApp(cfg: RemoteConfig, bridgeOverride?: Pick<StdioBridge, "listTools" | "callTool" | "close">) {
  const oauth = new OAuthServer(cfg);
  const bridge = bridgeOverride ?? new StdioBridge(cfg);

  async function mcp(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed", error_description: "this endpoint is stateless: POST JSON-RPC only" }), { status: 405, headers: { allow: "POST", "content-type": "application/json" } });
    }
    const who = oauth.verifyBearer(req);
    if (who instanceof Response) return who;
    const server = new Server({ name: "zouroboros-workshop-remote", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await bridge.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => bridge.callTool(r.params.name, (r.params.arguments ?? {}) as Record<string, unknown>));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  }

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    let res: Response;
    try {
      if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") res = oauth.protectedResourceMetadata();
      else if (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/openid-configuration") res = oauth.authorizationServerMetadata();
      else if (pathname === "/register" && req.method === "POST") res = await oauth.register(req);
      else if (pathname === "/authorize" && req.method === "GET") res = await oauth.authorizeGet(req);
      else if (pathname === "/authorize" && req.method === "POST") res = await oauth.authorizePost(req);
      else if (pathname === "/token" && req.method === "POST") res = await oauth.token(req);
      else if (pathname === "/revoke" && req.method === "POST") res = await oauth.revoke(req);
      else if (pathname === "/mcp") res = await mcp(req);
      else if (pathname === "/health") res = new Response(JSON.stringify({ status: "ok", mode: "remote" }), { headers: { "content-type": "application/json" } });
      else res = new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error(`[zo-remote] error on ${req.method} ${pathname}: ${(e as Error).message}`);
      res = new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    // Access log: method, path, status. Never query strings (codes) or headers (tokens).
    console.error(`[zo-remote] ${new Date().toISOString()} ${req.method} ${pathname} ${res.status}`);
    return res;
  }

  return { fetch, oauth, bridge };
}

if (import.meta.main) {
  let cfg: RemoteConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) { console.error(`[zo-remote] refusing to start: ${e.message}`); process.exit(1); }
    throw e;
  }
  const app = createApp(cfg);
  Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: app.fetch });
  console.error(`[zo-remote] remote mode ON — listening on http://${cfg.host}:${cfg.port}, public origin ${cfg.publicUrl}`);
  console.error(`[zo-remote] MCP endpoint ${cfg.resource} — tools: memory${cfg.exposeSwarm ? " + swarm" : " (swarm not exposed; ZO_REMOTE_EXPOSE_SWARM=1 to add)"}`);
  console.error(`[zo-remote] operator secret ${cfg.secretFingerprint}; OAuth state in ${cfg.stateDir}`);
}
