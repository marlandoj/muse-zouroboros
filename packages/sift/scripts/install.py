#!/usr/bin/env python3
import argparse
import copy
import hashlib
import json
import os
import re
import shlex
import tempfile
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALL = ("claude", "codex", "kimi", "gemini", "opencode", "pi", "hermes")


def enable_yaml(text):
    import yaml
    before = yaml.safe_load(text) or {}
    after = copy.deepcopy(before)
    plugins = after.setdefault("plugins", {})
    enabled = plugins.setdefault("enabled", [])
    if not isinstance(enabled, list):
        raise ValueError("plugins.enabled must be a list")
    if "sift" in enabled:
        return text
    enabled.append("sift")
    lines = text.splitlines(keepends=True)
    start = next((i for i, l in enumerate(lines) if re.match(r"^plugins:\s*(?:#.*)?$", l)), None)
    if start is None:
        if "plugins" in before:
            raise ValueError("unsupported YAML plugins style")
        result = text.rstrip("\n") + "\nplugins:\n  enabled: [sift]\n"
    else:
        end = next((i for i in range(start + 1, len(lines)) if lines[i].strip() and not lines[i].startswith((" ", "\t", "#"))), len(lines))
        at = next((i for i in range(start + 1, end) if re.match(r"^  enabled:", lines[i])), None)
        if at is None:
            if "enabled" in before.get("plugins", {}):
                raise ValueError("unsupported enabled indentation")
            lines.insert(start + 1, "  enabled: [sift]\n")
        else:
            value = lines[at].split(":", 1)[1].strip()
            if value.startswith("["):
                comment = " #" + value.split("#", 1)[1] if "#" in value else ""
                lines[at] = "  enabled: " + json.dumps(enabled) + comment + "\n"
            elif not value or value.startswith("#"):
                indent = "    "
                if at + 1 < end and re.match(r"^\s+-", lines[at + 1]):
                    indent = re.match(r"^(\s*)-", lines[at + 1]).group(1)
                insert = at + 1
                while insert < end and re.match(r"^\s+-", lines[insert]):
                    insert += 1
                lines.insert(insert, indent + "- sift\n")
            else:
                raise ValueError("unsupported enabled style")
        result = "".join(lines)
    if yaml.safe_load(result) != after:
        raise ValueError("YAML preservation check failed")
    return result


def prepare(project, user, selected):
    operations = []
    for harness in selected:
        command = shlex.join(["bash", str(ROOT / "scripts" / "hook.sh"), harness])
        if harness in ("claude", "codex", "gemini"):
            paths = {"claude": project / ".claude/settings.json", "codex": project / ".codex/hooks.json", "gemini": user / ".gemini/settings.json"}
            path = paths[harness]
            text = path.read_text() if path.exists() else "{}"
            data = json.loads(text)
            before = copy.deepcopy(data)
            events = ("AfterTool", "PreCompress") if harness == "gemini" else ("PostToolUse", "PreCompact")
            if harness == "claude":
                events += ("PostToolUseFailure",)
            for event in events:
                groups = data.setdefault("hooks", {}).setdefault(event, [])
                if not any(h.get("command") == command for g in groups for h in g.get("hooks", [])):
                    groups.append({"hooks": [{"type": "command", "command": command,
                                             "timeout": 4000 if harness == "gemini" else 4}]})
            operations.append((path, None if data == before else json.dumps(data, indent=2) + "\n", False))
        elif harness == "kimi":
            path = user / ".kimi-code/config.toml"
            text = path.read_text() if path.exists() else ""
            data = tomllib.loads(text)
            extra = ""
            for event in ("PostToolUse", "PostToolUseFailure", "PreCompact"):
                if not any(h.get("command") == command and h.get("event") == event for h in data.get("hooks", [])):
                    extra += f"\n[[hooks]]\nevent = {json.dumps(event)}\ncommand = {json.dumps(command)}\ntimeout = 4\n"
            tomllib.loads(text + extra)
            operations.append((path, text + extra if extra else None, False))
        else:
            targets = {"opencode": (ROOT / "plugins/opencode/sift.js", user / ".config/opencode/plugin/sift.js"),
                       "pi": (ROOT / "plugins/pi/sift.ts", user / ".pi/agent/extensions/sift.ts"),
                       "hermes": (ROOT / "plugins/hermes/sift", user / ".hermes/plugins/sift")}
            source, target = targets[harness]
            if target.is_symlink() and target.resolve() == source:
                operations.append((target, None, True))
            elif target.exists() or target.is_symlink():
                raise ValueError("refusing to replace existing plugin: " + str(target))
            else:
                operations.append((target, str(source), True))
            if harness == "hermes":
                path = user / ".hermes/config.yaml"
                text = path.read_text() if path.exists() else ""
                new = enable_yaml(text)
                operations.append((path, new if new != text else None, False))
    return operations


def main():
    p = argparse.ArgumentParser(description="Install Sift shadow observers/plugins, preserving other settings")
    p.add_argument("--project", type=Path, required=True)
    p.add_argument("--home", type=Path, default=Path.home())
    p.add_argument("--harness", default=",".join(ALL))
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    selected = a.harness.split(",")
    if not selected or any(h not in ALL for h in selected):
        p.error("unknown harness")
    if not a.project.is_absolute() or not a.home.is_absolute() or not a.project.is_dir():
        p.error("use absolute paths and an existing project")
    operations = prepare(a.project, a.home, selected)
    if any(path.is_symlink() for path, value, link in operations if value is not None and not link):
        raise ValueError("refusing to replace a symlinked config; install through its owning configuration")
    backup = Path(os.environ.get("SIFT_HOME", str(a.home / ".sift"))) / "backups"
    for path, value, link in operations:
        if value is None:
            print("already wired " + str(path))
            continue
        if a.dry_run:
            print("would wire " + str(path))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if link:
            path.symlink_to(value)
        else:
            if path.exists():
                backup.mkdir(parents=True, exist_ok=True, mode=0o700)
                original = path.read_bytes()
                key = hashlib.sha256(str(path).encode() + original).hexdigest()
                target = backup / (key + ".bak")
                if not target.exists():
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "wb") as f:
                        f.write(original)
                if target.read_bytes() != original:
                    raise ValueError("backup integrity mismatch")
                manifest = {"source": str(path), "backup": str(target),
                            "original_sha256": hashlib.sha256(original).hexdigest(),
                            "installed_sha256": hashlib.sha256(value.encode()).hexdigest()}
                metadata = backup / (key + ".json")
                if not metadata.exists():
                    fd = os.open(metadata, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "w") as f:
                        json.dump(manifest, f, indent=2)
            fd, tmp = tempfile.mkstemp(prefix=".sift-", dir=path.parent)
            try:
                with os.fdopen(fd, "w") as f:
                    f.write(value)
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            if path.read_text() != value:
                raise ValueError("installed config verification failed")
        print("wired " + str(path))
    print("New installs default to shadow. Existing modes are preserved. Restart harnesses to load plugins/hooks.")
    if "codex" in selected:
        print("Codex requires operator hook trust through /hooks; no trust hashes are installed.")


if __name__ == "__main__":
    main()
