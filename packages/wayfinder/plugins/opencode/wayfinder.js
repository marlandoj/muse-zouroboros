// OpenCode plugin: forwards each user message to the Wayfinder hook (harness "opencode").
// Live-mode output is added as a synthetic text part on the message; shadow mode adds nothing.
// Install: copy or symlink to ~/.config/opencode/plugin/wayfinder.js
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = process.env.WAYFINDER_HOOK || resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../scripts/wayfinder-hook.sh");
const TIMEOUT_MS = (Number(process.env.WAYFINDER_TIMEOUT) || 4) * 1000 + 1000;

export const Wayfinder = async ({ directory }) => ({
  "chat.message": async (input, output) => {
    try {
      const prompt = (output.parts || [])
        .filter((p) => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n");
      if (!prompt.trim()) return;
      const payload = JSON.stringify({ prompt, session_id: input.sessionID || "", cwd: directory || "" });
      const r = spawnSync("bash", [HOOK, "opencode"], { input: payload, encoding: "utf8", timeout: TIMEOUT_MS });
      const text = (r.stdout || "").trim();
      if (r.status === 0 && text && output.message?.id && input.sessionID) {
        output.parts.push({ id: `prt_${randomUUID().replaceAll("-", "")}`, sessionID: input.sessionID,
          messageID: output.message.id, type: "text", text, synthetic: true });
      }
    } catch {}
  },
});
