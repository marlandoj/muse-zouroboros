// Pi extension: forwards each prompt to the Wayfinder hook (harness "pi").
// Live-mode output is attached as a hidden custom message sent to the model; shadow mode adds nothing.
// Install: copy or symlink to ~/.pi/agent/extensions/wayfinder.ts
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = process.env.WAYFINDER_HOOK || resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../scripts/wayfinder-hook.sh");
const TIMEOUT_MS = (Number(process.env.WAYFINDER_TIMEOUT) || 4) * 1000 + 1000;

export default function (pi: any) {
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const prompt = typeof event?.prompt === "string" ? event.prompt : "";
      if (!prompt.trim()) return;
      let session = "";
      try { session = ctx?.sessionManager?.getSessionId?.() ?? ""; } catch {}
      const payload = JSON.stringify({ prompt, session_id: session, cwd: ctx?.cwd ?? process.cwd() });
      const r = spawnSync("bash", [HOOK, "pi"], { input: payload, encoding: "utf8", timeout: TIMEOUT_MS });
      const text = (r.stdout || "").trim();
      if (r.status === 0 && text) return { message: { customType: "wayfinder", content: text, display: false } };
    } catch {}
  });
}
