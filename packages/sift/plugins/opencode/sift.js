import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../scripts/sift.py");

function request(harness, payload) {
  return new Promise((done) => {
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) return done({});
    const child = spawn("python3", [script, "request", harness], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({}); }, 3000);
    child.on("error", () => { clearTimeout(timer); done({}); });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > 20 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try { done(code === 0 ? JSON.parse(out) : {}); } catch { done({}); }
    });
    child.stdin.end(input);
  });
}

export const Sift = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      const result = await request("opencode", {
        messages: output.messages,
        session_id: output.messages[0]?.info?.sessionID ?? "",
      });
      if (result.applied === true && Array.isArray(result.messages)) output.messages = result.messages;
    } catch {}
  },
});
