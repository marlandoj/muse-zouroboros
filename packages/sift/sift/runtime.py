import fcntl
import json
import os
import time
from pathlib import Path

from .core import FORMATS, analyze, digest, encoded, private_dir

LIVE = {"opencode", "pi", "hermes"}


def home():
    return Path(os.environ.get("SIFT_HOME", str(Path.home() / ".sift"))).absolute()


def config():
    path = home() / "config.json"
    value = json.loads(path.read_text()) if path.exists() else {"mode": "shadow", "harnesses": {}}
    if value.get("mode") not in ("shadow", "live") or not isinstance(value.get("harnesses", {}), dict):
        raise ValueError("invalid Sift config")
    return value


def mode(harness):
    if harness not in FORMATS:
        raise ValueError("unknown harness")
    if os.environ.get("SIFT") == "0" or (home() / "disabled").exists():
        return "off"
    c = config()
    value = os.environ.get("SIFT_MODE", c.get("harnesses", {}).get(harness, c["mode"]))
    if value not in ("live", "shadow"):
        raise ValueError("invalid Sift mode")
    return value


def append(path, row):
    private_dir(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(row, separators=(",", ":")) + "\n")
        stream.flush()


def process(harness, payload, native=True):
    start = time.monotonic()
    current = mode(harness)
    if current == "off":
        return {}
    messages = payload.get("messages")
    if not isinstance(messages, list):
        raise ValueError("messages must be an array")
    if len(encoded(messages)) > 16 * 1024 * 1024:
        raise ValueError("history exceeds 16 MiB processing bound")
    fmt = payload.get("format", harness)
    proposal = analyze(messages, fmt)
    applicable = (harness in LIVE or not native)
    apply = current == "live" and applicable and proposal["stats"]["changed_results"] > 0
    if native and proposal["stats"]["input_bytes"] < 64000:
        apply = False
    if apply:
        proposal = analyze(messages, fmt, private_dir(home()))
    row = {"time": time.time(), "harness": harness, "mode": current, "applied": apply,
           "native_editable": harness in LIVE, "session_sha256": digest(str(payload.get("session_id", "")).encode()),
           "stats": proposal["stats"], "decisions": proposal["decisions"],
           "duration_ms": round((time.monotonic() - start) * 1000, 2)}
    append(home() / "receipts.jsonl", row)
    return {"messages": proposal["messages"], "applied": True} if apply else {}
