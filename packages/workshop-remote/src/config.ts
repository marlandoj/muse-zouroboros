/**
 * config.ts — remote mode configuration, validated fail-closed.
 *
 * Remote mode is OFF unless the operator turns it on, and it refuses to start
 * on any setting that would leave it open. Every refusal is a startup error
 * (exit 1) naming the setting — never a silent fallback to an open server.
 *
 *   ZO_REMOTE_ENABLE=1                  required; anything else = remote mode off
 *   ZO_REMOTE_PUBLIC_URL=https://host   required; the HTTPS origin web clients use
 *                                       (http:// only for a loopback host, tests)
 *   ZO_REMOTE_OPERATOR_SECRET_FILE=...  required; file holding the operator secret
 *                                       (owner-only mode, >= 32 chars). This is the
 *                                       authorization credential: nobody can approve
 *                                       a client without it.
 *   ZO_REMOTE_HOST=127.0.0.1            bind address (default loopback; TLS is
 *                                       terminated by the tunnel / reverse proxy)
 *   ZO_REMOTE_ALLOW_NONLOCAL_BIND=1     required to bind a non-loopback address
 *   ZO_REMOTE_PORT=48410
 *   ZO_REMOTE_STATE_DIR=~/.zo/remote    OAuth state (clients, hashed tokens), 0700
 *   ZO_REMOTE_EXPOSE_SWARM=1            also expose the swarm tools (off by default:
 *                                       swarm_execute runs local coding agents)
 *   ZO_REMOTE_REPO=<checkout>           defaults to this file's checkout
 */
import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";

export class ConfigError extends Error {}

export interface RemoteConfig {
  publicUrl: string; // origin, no trailing slash
  resource: string; // publicUrl + "/mcp"
  host: string;
  port: number;
  secretSha256: Buffer; // sha256 of the operator secret (the secret itself is not kept)
  secretFingerprint: string;
  stateDir: string;
  exposeSwarm: boolean;
  repo: string;
  memoryDb: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, "");
  return LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function fingerprint(secret: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RemoteConfig {
  if (env.ZO_REMOTE_ENABLE !== "1") {
    throw new ConfigError("remote mode is off (set ZO_REMOTE_ENABLE=1 to turn it on; see packages/workshop-remote/README.md)");
  }

  const rawUrl = (env.ZO_REMOTE_PUBLIC_URL || "").trim();
  if (!rawUrl) throw new ConfigError("ZO_REMOTE_PUBLIC_URL is required (the https:// origin web clients will use)");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new ConfigError(`ZO_REMOTE_PUBLIC_URL is not a URL: ${rawUrl}`); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new ConfigError("ZO_REMOTE_PUBLIC_URL must be https:// (plain http is accepted only for a loopback host)");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError("ZO_REMOTE_PUBLIC_URL must be a bare origin (no path, query or fragment)");
  }
  const publicUrl = url.origin;

  const secretFile = (env.ZO_REMOTE_OPERATOR_SECRET_FILE || "").trim();
  if (!secretFile) {
    throw new ConfigError("ZO_REMOTE_OPERATOR_SECRET_FILE is required — remote mode never runs without an authorization credential (create one: bash packages/workshop-remote/scripts/remote-init.sh)");
  }
  if (!existsSync(secretFile)) throw new ConfigError(`operator secret file not found: ${secretFile}`);
  const st = statSync(secretFile);
  if (!st.isFile()) throw new ConfigError(`operator secret path is not a file: ${secretFile}`);
  if ((st.mode & 0o077) !== 0) {
    throw new ConfigError(`operator secret file must be owner-only (chmod 600 ${secretFile}); it is ${(st.mode & 0o777).toString(8)}`);
  }
  const secret = readFileSync(secretFile, "utf8").trim();
  if (secret.length < 32) throw new ConfigError("operator secret is too short (need at least 32 characters; remote-init.sh generates 43)");

  const host = (env.ZO_REMOTE_HOST || "127.0.0.1").trim();
  if (!isLoopbackHost(host) && env.ZO_REMOTE_ALLOW_NONLOCAL_BIND !== "1") {
    throw new ConfigError(`refusing to bind non-loopback address ${host}: put the server behind a TLS tunnel or reverse proxy on 127.0.0.1, or set ZO_REMOTE_ALLOW_NONLOCAL_BIND=1 if TLS is terminated in front of it`);
  }
  const port = Number(env.ZO_REMOTE_PORT || 48410);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`ZO_REMOTE_PORT is not a port: ${env.ZO_REMOTE_PORT}`);

  const home = env.HOME || "/tmp";
  const repo = resolve(env.ZO_REMOTE_REPO || join(import.meta.dir, "..", "..", ".."));
  const memoryDb = env.ZOUROBOROS_MEMORY_DB || env.ZO_MEMORY_DB || join(home, ".zo", "memory", "shared-facts.db");

  return {
    publicUrl,
    resource: `${publicUrl}/mcp`,
    host,
    port,
    secretSha256: createHash("sha256").update(secret).digest(),
    secretFingerprint: fingerprint(secret),
    stateDir: env.ZO_REMOTE_STATE_DIR || join(home, ".zo", "remote"),
    exposeSwarm: env.ZO_REMOTE_EXPOSE_SWARM === "1",
    repo,
    memoryDb,
  };
}
