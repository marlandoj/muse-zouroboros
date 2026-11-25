# workshop-remote — remote mode for web clients

Local clients (Claude Code, Codex, Gemini CLI, OpenCode, Hermes, Kimi, Pi,
Claude Desktop, Cursor, VS Code) spawn the workshop's stdio MCP servers
themselves; see [docs/connect.md](../../docs/connect.md). Web clients —
ChatGPT developer mode, Claude.ai custom connectors, Muse custom connectors —
run in the vendor's cloud and can only reach a public HTTPS URL. This package
is that URL: one MCP endpoint (Streamable HTTP) protected by OAuth 2.1.

It does not implement any tool. It starts the same stdio servers a local
client runs and forwards `tools/list` and `tools/call` to them.

## Secure by default

- **Off** unless `ZO_REMOTE_ENABLE=1`. Nothing in the installer starts it.
- **Refuses to start without an authorization credential**: an operator
  secret file (`ZO_REMOTE_OPERATOR_SECRET_FILE`) that is owner-only (mode 600)
  and at least 32 characters. An unset or loose credential is a startup error,
  never an open server.
- **Binds 127.0.0.1** by default. A non-loopback bind needs
  `ZO_REMOTE_ALLOW_NONLOCAL_BIND=1`, meant for when TLS is terminated in front.
  There is no unauthenticated mode at all: every `/mcp` request needs a bearer
  token that only this server's OAuth flow issues.
- **No token without the operator.** Any client may register (dynamic client
  registration is what web clients use), but the consent page asks for the
  operator secret. Wrong secrets are refused; ten failures in 15 minutes lock
  approvals for 15 minutes.
- **Memory tools only** by default. `ZO_REMOTE_EXPOSE_SWARM=1` adds the swarm
  tools; leave it off unless you want a web client able to start local coding
  agents (`swarm_execute`).
- Codes, access tokens and refresh tokens are stored as SHA-256 hashes in
  `~/.zo/remote/oauth.db` (directory 700, file 600). Access tokens live 1 hour,
  refresh tokens 30 days and rotate on use; reusing a rotated refresh token or
  replaying an authorization code revokes the whole grant.
- The access log records method, path and status only — never query strings
  (codes) or headers (tokens).

## What it speaks

| Endpoint | Standard |
|---|---|
| `GET /.well-known/oauth-protected-resource` (also `/mcp` suffix) | RFC 9728; `resource` = `<public url>/mcp` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414; `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported: true` |
| `POST /register` | RFC 7591 dynamic client registration; redirect URIs must be `https://` or `http://` loopback |
| `GET /authorize`, `POST /authorize` | authorization code + PKCE (S256 only), consent page, RFC 9207 `iss` on every response, RFC 8707 `resource` checked |
| `POST /token` | `authorization_code` and `refresh_token` grants, form-encoded; public (`none`) and confidential clients |
| `POST /revoke` | RFC 7009 |
| `POST /mcp` | MCP Streamable HTTP, stateless JSON responses; `401` + `WWW-Authenticate: Bearer resource_metadata=…` without a valid token |

Client ID Metadata Documents (CIMD) are not implemented; ChatGPT and Claude
both fall back to dynamic client registration when the server does not
advertise CIMD.

## Run it

```bash
cd ~/workspace/zouroboros-workshop && bun install          # once, picks up this package
bash packages/workshop-remote/scripts/remote-init.sh   # writes ~/.config/zouroboros/remote-operator.secret (600)

# expose 127.0.0.1:48410 over HTTPS with your tunnel or reverse proxy, then:
ZO_REMOTE_ENABLE=1 \
ZO_REMOTE_PUBLIC_URL=https://workshop.example.com \
ZO_REMOTE_OPERATOR_SECRET_FILE=$HOME/.config/zouroboros/remote-operator.secret \
  bun packages/workshop-remote/src/server.ts
```

The connector URL to give the web client is `https://workshop.example.com/mcp`.
For a quick test without a domain, `cloudflared tunnel --url http://127.0.0.1:48410`
prints a temporary `https://….trycloudflare.com` origin (no account needed);
use it as `ZO_REMOTE_PUBLIC_URL`. The origin changes every time the tunnel
restarts, and so must the connector.

## Tests

```bash
cd packages/workshop-remote && bun test test/
```
