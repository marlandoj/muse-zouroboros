#!/usr/bin/env node
// Translates Kimi Code and Gemini CLI hook events into the Claude Code shape Canny reads, and
// (with --out) Canny's verdicts back into each harness's decision format for live mode.
// Input shapes were captured from live sessions (kimi 0.41.0, gemini 0.58.0) on 2026-09-23;
// output formats were read from the same installed versions.
//   adapter.mjs <kimi|gemini>          event in, Claude-shaped event out
//   adapter.mjs --out <kimi|gemini>    {event, verdict} in, harness decision out
import { readFileSync } from "node:fs";

const outMode = process.argv[2] === "--out";
const harness = process.argv[outMode ? 3 : 2];
const raw = JSON.parse(readFileSync(0, "utf8") || "{}");
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === "string" ? v : "");

const EXIT = /exit(?:ed)?(?: with)?(?: code)?:?\s*(-?\d+)/i;

function kimi(e) {
  const out = { ...e, session_id: `kimi-${str(e.session_id) || "unknown"}` };
  const ti = { ...obj(e.tool_input) };
  if (ti.path !== undefined && ti.file_path === undefined) ti.file_path = ti.path;
  out.tool_input = ti;
  if (e.hook_event_name === "PostToolUse") {
    out.tool_response = { stdout: str(e.tool_output), exit_code: 0 };
  } else if (e.hook_event_name === "PostToolUseFailure") {
    const err = obj(e.error);
    const message = str(err.message) || str(e.error);
    const m = message.match(EXIT);
    out.error = m ? `Exit code ${m[1]}\n${message}` : message;
  } else if (e.hook_event_name === "Stop") {
    out.last_assistant_message = str(e.last_assistant_message);
  }
  return out;
}

const GEMINI_EVENTS = {
  SessionStart: "SessionStart",
  BeforeTool: "PreToolUse",
  AfterTool: "PostToolUse",
  AfterAgent: "Stop",
};

function gemini(e) {
  const event = GEMINI_EVENTS[str(e.hook_event_name)] ?? str(e.hook_event_name);
  const ti = obj(e.tool_input);
  const out = {
    hook_event_name: event,
    session_id: `gemini-${str(e.session_id) || "unknown"}`,
    cwd: str(e.cwd),
    tool_name: str(e.tool_name),
    tool_input: ti,
  };
  switch (e.tool_name) {
    case "write_file":
      out.tool_name = "Write";
      out.tool_input = { file_path: str(ti.file_path), content: str(ti.content) };
      break;
    case "replace":
      out.tool_name = "Edit";
      out.tool_input = {
        file_path: str(ti.file_path),
        old_string: str(ti.old_string),
        new_string: str(ti.new_string),
      };
      break;
    case "run_shell_command":
      out.tool_name = "Bash";
      out.tool_input = { command: str(ti.command) };
      if (str(ti.dir_path)) out.cwd = str(ti.dir_path);
      break;
  }
  if (event === "PostToolUse") {
    const r = obj(e.tool_response);
    const text = str(r.llmContent) || str(e.tool_response);
    const m = text.match(/Exit Code:\s*(-?\d+)/);
    const failed = r.error !== undefined && r.error !== null;
    out.tool_response = { stdout: text, exit_code: m ? Number(m[1]) : failed ? 1 : 0 };
  }
  if (event === "Stop") {
    out.last_assistant_message = str(e.prompt_response);
    out.stop_hook_active = e.stop_hook_active === true;
  }
  return out;
}

// Kimi blocks only on exit 2 or hookSpecificOutput.permissionDecision "deny"; a Stop block is fed
// back to the model as a user message once. It has no ask, input rewrite, or context injection.
function kimiOut(v) {
  const h = obj(v.hookSpecificOutput);
  const deny = (reason) => ({
    hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason },
  });
  if (v.decision === "block") return deny(str(v.reason) || str(v.systemMessage));
  if (h.permissionDecision === "deny" || h.permissionDecision === "ask")
    return deny(str(h.permissionDecisionReason) || str(v.systemMessage));
  const msg = str(h.additionalContext) || str(v.systemMessage);
  return msg ? { message: msg } : {};
}

// Gemini reads a top-level decision (block/deny/ask) and reason; AfterAgent "block" makes the
// agent continue with the reason as its next prompt. BeforeTool rewrites via hookSpecificOutput.tool_input.
function geminiOut(v, e) {
  const h = obj(v.hookSpecificOutput);
  const base = v.systemMessage ? { systemMessage: str(v.systemMessage) } : {};
  if (v.decision === "block") return { ...base, decision: "block", reason: str(v.reason) };
  if (h.permissionDecision === "deny" || h.permissionDecision === "ask")
    return { ...base, decision: h.permissionDecision, reason: str(h.permissionDecisionReason) };
  if (h.updatedInput) {
    const ti = { ...obj(e.tool_input), command: str(obj(h.updatedInput).command) };
    return { ...base, hookSpecificOutput: { tool_input: ti, additionalContext: str(h.additionalContext) } };
  }
  if (h.additionalContext) return { ...base, hookSpecificOutput: { additionalContext: str(h.additionalContext) } };
  return base;
}

if (outMode) {
  const translate = { kimi: kimiOut, gemini: geminiOut }[harness];
  const v = obj(raw.verdict);
  process.stdout.write(JSON.stringify(translate ? translate(v, obj(raw.event)) : v));
} else {
  const convert = { kimi, gemini }[harness];
  process.stdout.write(JSON.stringify(convert ? convert(raw) : raw));
}
