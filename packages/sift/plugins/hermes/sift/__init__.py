import json
import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "sift.py"


def request_middleware(request=None, session_id="", **_):
    if not isinstance(request, dict):
        return None
    field = "messages" if isinstance(request.get("messages"), list) else "input"
    messages = request.get(field)
    if not isinstance(messages, list):
        return None
    try:
        payload = json.dumps({"messages": messages, "session_id": session_id,
                              "format": "hermes" if field == "messages" else "codex"})
        if len(payload.encode()) > 16 * 1024 * 1024:
            return None
        result = subprocess.run(["python3", str(SCRIPT), "request", "hermes"], input=payload,
                                capture_output=True, text=True, timeout=3)
        if result.returncode:
            return None
        value = json.loads(result.stdout)
        if value.get("applied") is True and isinstance(value.get("messages"), list):
            return {"request": {**request, field: value["messages"]}, "plugin": "sift"}
    except Exception:
        pass
    return None


def register(ctx):
    ctx.register_middleware("llm_request", request_middleware)
