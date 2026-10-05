import copy
import hashlib
import json
import os
import re
import shlex
import tempfile
from dataclasses import dataclass
from pathlib import Path

READS = {"Read", "read", "read_file", "read_many_files"}
SHELLS = {"Bash", "bash", "terminal", "run_shell_command", "exec_command", "functions.exec_command"}
ERROR = re.compile(r"(?im)(?:^|\n)\s*(?:error\b|fatal\b|traceback\b|permission denied|FAIL(?:ED)?\b)|\b[1-9]\d* (?:failed|failures)\b")
MARKER = "[Sift archive "
FORMATS = ("claude", "codex", "kimi", "gemini", "opencode", "pi", "hermes")


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def text_path(value, path):
    if isinstance(value, str):
        return path, value
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict):
        part = value[0]
        if part.get("type") in ("text", "output_text") and isinstance(part.get("text"), str):
            return path + (0, "text"), part["text"]
    return None


def args(value):
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except ValueError:
            return None
    return value if isinstance(value, dict) else None


@dataclass
class Result:
    identity: str
    tool: str
    arguments: dict
    call_index: int
    index: int
    path: tuple
    text: str
    failed: bool
    exit_code: object = None


def collect(messages, fmt):
    if fmt not in FORMATS or not isinstance(messages, list):
        raise ValueError("unsupported history format")
    calls, outputs = {}, []

    def call(identity, name, arguments, i):
        if not isinstance(identity, str) or not identity:
            return
        calls.setdefault(identity, []).append((name, args(arguments), i))

    def output(identity, value, path, i, failed=False, exit_code=None):
        slot = text_path(value, path)
        if slot and isinstance(identity, str):
            outputs.append((identity, slot, i, failed, exit_code))

    for i, raw in enumerate(messages):
        if not isinstance(raw, dict):
            continue
        m, prefix = raw, (i,)
        if fmt == "codex" and raw.get("type") == "response_item":
            m, prefix = raw.get("payload", {}), (i, "payload")
        elif "message" in raw and isinstance(raw["message"], dict):
            m, prefix = raw["message"], (i, "message")
        if not isinstance(m, dict) or m.get("role") in ("system", "developer") or (m.get("info") or {}).get("role") in ("system", "developer"):
            continue
        if m.get("type") in ("function_call", "custom_tool_call"):
            call(m.get("call_id"), m.get("name"), m.get("arguments", m.get("input")), i)
        if m.get("type") in ("function_call_output", "custom_tool_call_output"):
            output(m.get("call_id"), m.get("output"), prefix + ("output",), i)
        for tc in m.get("tool_calls", []) or []:
            if isinstance(tc, dict):
                f = tc.get("function", {})
                call(tc.get("id"), f.get("name"), f.get("arguments"), i)
        if m.get("role") in ("tool", "toolResult"):
            output(m.get("tool_call_id", m.get("toolCallId")), m.get("content"), prefix + ("content",), i,
                   m.get("isError", m.get("is_error", False)), (m.get("details") or {}).get("exitCode"))
        field = "parts" if isinstance(m.get("parts"), list) else "content"
        parts = m.get(field)
        if not isinstance(parts, list):
            continue
        for j, p in enumerate(parts):
            if not isinstance(p, dict):
                continue
            base = prefix + (field, j)
            if p.get("type") in ("tool_use", "toolCall"):
                call(p.get("id"), p.get("name"), p.get("input", p.get("arguments")), i)
            elif p.get("type") == "tool_result":
                output(p.get("tool_use_id"), p.get("content"), base + ("content",), i, p.get("is_error", False))
            elif fmt == "opencode" and p.get("type") == "tool":
                s = p.get("state", {})
                identity = p.get("callID")
                call(identity, p.get("tool"), s.get("input"), i)
                if s.get("status") in ("completed", "error"):
                    output(identity, s.get("output"), base + ("state", "output"), i,
                           s.get("status") == "error", (s.get("metadata") or {}).get("exit"))
            elif fmt == "gemini" and isinstance(p.get("functionCall"), dict):
                f = p["functionCall"]
                call(f.get("id"), f.get("name"), f.get("args"), i)
            elif fmt == "gemini" and isinstance(p.get("functionResponse"), dict):
                f = p["functionResponse"]
                response = f.get("response", {})
                if isinstance(response, dict):
                    output(f.get("id"), response.get("output"), base + ("functionResponse", "response", "output"),
                           i, bool(response.get("error")), response.get("exit_code"))
    counts = {}
    for identity, *_ in outputs:
        counts[identity] = counts.get(identity, 0) + 1
    result = []
    for identity, (path, text), i, failed, exit_code in outputs:
        matches = calls.get(identity, [])
        if len(matches) != 1 or counts[identity] != 1:
            continue
        name, arguments, ci = matches[0]
        if not isinstance(name, str) or arguments is None or ci > i:
            continue
        result.append(Result(identity, name, arguments, ci, i, path, text, bool(failed), exit_code))
    return result


def has_failure(r):
    if r.failed or ERROR.search(r.text):
        return True
    if type(r.exit_code) is int and r.exit_code != 0:
        return True
    try:
        obj = json.loads(r.text)
    except ValueError:
        return False
    if isinstance(obj, dict):
        if obj.get("error") or obj.get("is_error") or obj.get("isError"):
            return True
        for key in ("exit_code", "exitCode"):
            if key in obj and obj[key] not in (None, 0):
                return True
        return any(isinstance(obj.get(key), str) and ERROR.search(obj[key]) for key in ("stdout", "stderr", "output"))
    return False


def successful_check(r):
    if r.tool not in SHELLS:
        return False
    command = r.arguments.get("command", r.arguments.get("cmd"))
    if not isinstance(command, str) or re.search(r"[|;&<>`$\n]", command):
        return False
    try:
        words = shlex.split(command)
    except ValueError:
        return False
    if any(w in ("-u", "--update", "--updateSnapshot", "--fix") for w in words):
        return False
    allowed = (words[:2] in (["npm", "test"], ["bun", "test"], ["pnpm", "test"], ["cargo", "test"], ["go", "test"])
               or words[:3] in (["npm", "run", "typecheck"], ["bun", "run", "typecheck"], ["python3", "-m", "pytest"])
               or words[:2] == ["tsc", "--noEmit"] or words[:1] == ["pytest"])
    code = r.exit_code
    if code is None:
        try:
            obj = json.loads(r.text)
            if isinstance(obj, dict):
                code = obj.get("exit_code", obj.get("exitCode"))
        except ValueError:
            pass
    if code is None:
        codes = re.findall(r"(?im)^(?:Process exited with code|Exit [Cc]ode:)\s*(-?\d+)\s*$", r.text)
        if codes:
            if any(int(c) != 0 for c in codes):
                return False
            code = int(codes[-1])
    return bool(allowed and type(code) is int and code == 0)


def private_dir(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise ValueError("archive directory must be owned and not a symlink")
    os.chmod(path, 0o700)
    return path


def archive_text(root, text):
    raw = text.encode()
    key = digest(raw)
    directory = private_dir(Path(root) / "objects")
    target = directory / (key + ".txt")
    if target.exists():
        if target.is_symlink() or target.read_bytes() != raw:
            raise ValueError("archive integrity conflict")
        os.chmod(target, 0o600)
        return target
    fd, tmp = tempfile.mkstemp(prefix=".pending-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(tmp, target)
        except FileExistsError:
            if target.is_symlink() or target.read_bytes() != raw:
                raise ValueError("archive integrity conflict")
        if target.read_bytes() != raw:
            raise ValueError("archive verification failed")
    finally:
        os.unlink(tmp)
    return target


def set_path(obj, path, value):
    for key in path[:-1]:
        obj = obj[key]
    obj[path[-1]] = value


def analyze(messages, fmt, archive_root=None, recent=8, threshold=12000, minimum=1200):
    if recent < 2 or threshold < 2000 or minimum < 500:
        raise ValueError("unsafe pruning limits")
    original = encoded(messages)
    records = collect(messages, fmt)
    by_read = {}
    for r in records:
        if r.tool in READS and not has_failure(r) and MARKER not in r.text:
            by_read.setdefault(digest(encoded([r.tool, r.arguments, r.text])), []).append(r)
    plans = []
    protected = max(2, len(messages) - recent)
    for r in records:
        if has_failure(r) or r.call_index < 2 or r.index >= protected or MARKER in r.text:
            continue
        reason = None
        if r.tool in READS and len(r.text) >= minimum:
            peers = by_read.get(digest(encoded([r.tool, r.arguments, r.text])), [])
            if peers and peers[-1].index > r.index:
                reason = "exact_duplicate_read"
        if len(r.text) >= threshold and successful_check(r):
            reason = "explicitly_successful_check"
        if reason:
            plans.append((r, reason))
    output = copy.deepcopy(messages)
    decisions = []
    for r, reason in plans:
        sha = digest(r.text.encode())
        note = f"{MARKER}{sha}; {len(r.text.encode())} bytes; {reason}; historical output, not current verification."
        path = archive_text(archive_root, r.text) if archive_root is not None else None
        note += f" Recover: {path}]" if path else " Recovery object required before live replacement.]"
        replacement = note
        if reason == "explicitly_successful_check":
            replacement = r.text[:400] + "\n" + note + "\n" + r.text[-400:]
        if len(replacement) >= len(r.text):
            continue
        set_path(output, r.path, replacement)
        decisions.append({"call_sha256": digest(r.identity.encode()), "reason": reason, "sha256": sha,
                          "before_chars": len(r.text), "after_chars": len(replacement)})
    return {"messages": output, "decisions": decisions,
            "stats": {"input_sha256": digest(original), "input_bytes": len(original),
                      "output_bytes": len(encoded(output)), "changed_results": len(decisions),
                      "paired_results": len(records)}, "recoverable": archive_root is not None}
