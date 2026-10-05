import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const script = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../scripts/sift.py");

function request(payload: unknown): Promise<{ applied?: boolean; messages?: unknown[] }> {
  return new Promise((done) => {
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) return done({});
    const child = spawn("python3", [script, "request", "pi"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({}); }, 3000);
    child.on("error", () => { clearTimeout(timer); done({}); });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > 20 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try { done(code === 0 ? JSON.parse(out) : {}); } catch { done({}); }
    });
    child.stdin.end(input);
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event, ctx) => {
    try {
      const result = await request({ messages: event.messages, session_id: ctx.sessionManager.getSessionId() });
      if (result.applied === true && Array.isArray(result.messages)) {
        return { messages: result.messages as typeof event.messages };
      }
    } catch {}
  });
}
