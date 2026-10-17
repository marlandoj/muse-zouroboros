// Hook-event → ledger-fact translation. Facts record what happened
// (paths, commands, outcomes), never file contents or command output beyond
// a one-line summary.
import { hash16, lastLine, relPath } from "./util.js";
import { commandCodeFiles, isCodeFile, isVerify } from "./checks.js";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function editFiles(toolInput, tool) {
  const ti = toolInput || {};
  const raw =
    tool === "NotebookEdit"
      ? ti.notebook_path
      : ti.file_path || ti.path;
  if (!raw) return [];
  return [raw];
}

/**
 * Build the ledger fact for a hook event. Returns { fact, phase } or null
 * when the event is not ledgered. `cfg` carries trusted verify patterns
 * for check classification. PostToolUseFailure is recorded like PostToolUse;
 * only a Bash command's missing exit code differs (null, not 0).
 */
export function buildFact(event, cwd, cfg = {}) {
  const name = event.hook_event_name;
  const tool = event.tool_name || "";
  const ti = event.tool_input || {};
  const isPost = name === "PostToolUse" || name === "PostToolUseFailure";

  if (isPost && EDIT_TOOLS.has(tool)) {
    const files = editFiles(ti, tool).map((p) => relPath(cwd, p));
    // The gate's change-set is code files only: docs, images, logs and
    // lockfiles are recorded in `files` but excluded from `code`.
    return {
      phase: "post",
      fact: { kind: "edit", files, deleted: [], code: files.filter(isCodeFile) },
    };
  }

  if (isPost && tool === "Bash") {
    const command = String(ti.command ?? "");
    const tr = event.tool_response || {};
    const exitCode = Number.isFinite(Number(tr.exit_code))
      ? Number(tr.exit_code)
      : name === "PostToolUseFailure"
        ? null
        : 0;
    const stdout = String(tr.stdout ?? "");
    return {
      phase: "post",
      fact: {
        kind: "command",
        command,
        exitCode,
        verify: isVerify(command, cfg.verifyPatterns || []),
        fingerprint: hash16(command + "\n" + stdout),
        summary: lastLine(stdout),
        code: commandCodeFiles(command, cwd),
      },
    };
  }

  if (name === "Stop") {
    return {
      phase: "stop",
      fact: {
        kind: "stop",
        stopHookActive: event.stop_hook_active === true,
        messageHash: hash16(String(event.last_assistant_message ?? "")),
      },
    };
  }

  return null;
}
