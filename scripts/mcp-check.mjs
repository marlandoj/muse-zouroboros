// mcp-check.mjs — prove an MCP stdio server actually starts: send
// `initialize`, wait for the answer, print the server name, exit 0.
// Exit 1 (with the server's stderr tail) if it crashes or does not answer.
// Usage: bun scripts/mcp-check.mjs <cwd> <cmd> [args...]
import { spawn } from "node:child_process";

const [cwd, cmd, ...args] = process.argv.slice(2);
const TIMEOUT_MS = Number(process.env.MCP_CHECK_TIMEOUT_MS || 20000);
const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
let out = "";
let err = "";
const done = (code, msg) => {
  console.log(msg);
  if (code !== 0 && err.trim()) console.log(err.trim().split("\n").slice(-5).join("\n"));
  child.kill();
  process.exit(code);
};
child.on("error", (e) => done(1, `spawn failed: ${e.message}`));
child.stderr.on("data", (d) => { err += d.toString(); });
child.on("exit", (c) => done(1, `server exited (${c}) before answering initialize`));
child.stdout.on("data", (d) => {
  out += d.toString();
  for (const line of out.split("\n")) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result) {
        const info = msg.result.serverInfo ?? {};
        done(0, `initialize answered: ${info.name ?? "?"} ${info.version ?? ""}`.trim());
      } else if (msg.id === 1 && msg.error) {
        done(1, `initialize error: ${JSON.stringify(msg.error)}`);
      }
    } catch { /* partial line or log output */ }
  }
});
child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-check", version: "0" } },
}) + "\n");
setTimeout(() => done(1, `no initialize answer within ${TIMEOUT_MS}ms`), TIMEOUT_MS);
