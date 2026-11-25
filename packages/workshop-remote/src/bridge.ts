/**
 * bridge.ts — the remote endpoint does not re-implement any tool. It starts
 * the workshop's own stdio MCP servers (the same commands a local client
 * runs) and forwards tools/list and tools/call to them, so the remote path
 * and the local path always serve the same tools from the same code.
 */
import { join } from "path";
import type { RemoteConfig } from "./config";

type Backend = { name: string; args: string[]; env: Record<string, string>; client?: any; tools?: any[] };

export class StdioBridge {
  private backends: Backend[];
  private sdk: Promise<{ Client: any; StdioClientTransport: any }>;

  constructor(private cfg: RemoteConfig) {
    const mem = join(cfg.repo, "packages", "memory-system", "scripts", "mcp-server.ts");
    const swarm = join(cfg.repo, "packages", "swarm-orchestrator", "scripts", "mcp-server.ts");
    this.backends = [{ name: "memory", args: [mem], env: { ZOUROBOROS_MEMORY_DB: cfg.memoryDb } }];
    if (cfg.exposeSwarm) {
      this.backends.push({ name: "swarm", args: [swarm], env: {
        ZOUROBOROS_MEMORY_DB: cfg.memoryDb,
        SWARM_EXECUTOR_REGISTRY: join(cfg.repo, "packages", "swarm-executors", "registry", "executor-registry.json"),
        SWARM_WORKSPACE: cfg.repo,
      } });
    }
    this.sdk = (async () => ({
      Client: (await import("@modelcontextprotocol/sdk/client/index.js")).Client,
      StdioClientTransport: (await import("@modelcontextprotocol/sdk/client/stdio.js")).StdioClientTransport,
    }))();
  }

  private async connect(b: Backend): Promise<any> {
    if (b.client) return b.client;
    const { Client, StdioClientTransport } = await this.sdk;
    // Only a minimal environment reaches the tool servers: no remote-mode
    // secret, no client tokens.
    const base: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "OPENAI_API_KEY", "ZO_EMBEDDING_MODEL"]) if (process.env[k]) base[k] = process.env[k]!;
    const transport = new StdioClientTransport({ command: process.execPath, args: b.args, env: { ...base, ...b.env }, stderr: "inherit" });
    const client = new Client({ name: "zouroboros-remote-bridge", version: "0.1.0" });
    transport.onclose = () => { b.client = undefined; b.tools = undefined; };
    await client.connect(transport);
    b.client = client;
    b.tools = (await client.listTools()).tools;
    return client;
  }

  async listTools(): Promise<any[]> {
    const out: any[] = [];
    for (const b of this.backends) { await this.connect(b); out.push(...(b.tools ?? [])); }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    for (const b of this.backends) {
      await this.connect(b);
      if ((b.tools ?? []).some((t) => t.name === name)) return b.client.callTool({ name, arguments: args });
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  async close() {
    for (const b of this.backends) { try { await b.client?.close(); } catch { /* already gone */ } }
  }
}
