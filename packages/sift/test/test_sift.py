import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sift.core import FORMATS, MARKER, analyze, archive_text, collect, digest, encoded
from sift.runtime import process

spec = importlib.util.spec_from_file_location("installer", ROOT / "scripts/install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def history(fmt="hermes", body="read content\n" * 8000, changed=False, failed=False):
    messages = [{"role": "system", "content": "Keep instructions."}, {"role": "user", "content": "Keep every error."}]
    for k in range(2):
        ident = "c" + str(k)
        text = body + ("changed" if changed and k else "")
        if fmt in ("hermes", "kimi"):
            messages.extend([{"role": "assistant", "tool_calls": [{"id": ident, "type": "function", "function": {"name": "read_file", "arguments": '{"path":"/repo/a.py"}'}}]},
                             {"role": "tool", "tool_call_id": ident, "content": text, "is_error": failed}])
        elif fmt == "claude":
            messages.extend([{"role": "assistant", "content": [{"type": "tool_use", "id": ident, "name": "Read", "input": {"file_path": "/repo/a.py"}}]},
                             {"role": "user", "content": [{"type": "tool_result", "tool_use_id": ident, "content": text, "is_error": failed}]}])
        elif fmt == "codex":
            messages.extend([{"type": "response_item", "payload": {"type": "function_call", "call_id": ident, "name": "read_file", "arguments": '{"path":"/repo/a.py"}'}},
                             {"type": "response_item", "payload": {"type": "function_call_output", "call_id": ident, "output": text}}])
        elif fmt == "pi":
            messages.extend([{"role": "assistant", "content": [{"type": "toolCall", "id": ident, "name": "read", "arguments": {"path": "/repo/a.py"}}]},
                             {"role": "toolResult", "toolCallId": ident, "content": [{"type": "text", "text": text}], "isError": failed}])
        elif fmt == "opencode":
            messages.append({"info": {"role": "assistant", "sessionID": "fixture"}, "parts": [{"type": "tool", "callID": ident, "tool": "read", "state": {"input": {"filePath": "/repo/a.py"}, "status": "error" if failed else "completed", "output": text}}]})
        elif fmt == "gemini":
            messages.extend([{"role": "model", "parts": [{"functionCall": {"id": ident, "name": "read_file", "args": {"file_path": "/repo/a.py"}}}]},
                             {"role": "user", "parts": [{"functionResponse": {"id": ident, "name": "read_file", "response": {"output": text, "error": "bad" if failed else None}}}]}])
    messages.extend({"role": "assistant", "content": "recent " + str(i)} for i in range(9))
    return messages


class EngineTests(unittest.TestCase):
    def test_all_seven_formats(self):
        for fmt in FORMATS:
            with self.subTest(fmt=fmt):
                value = history(fmt)
                original = copy.deepcopy(value)
                result = analyze(value, fmt)
                self.assertEqual(value, original)
                self.assertEqual(result["stats"]["changed_results"], 1)
                self.assertEqual(result["messages"][:2], value[:2])
                self.assertEqual(result["messages"][-8:], value[-8:])
                self.assertEqual(len(collect(result["messages"], fmt)), 2)

    def test_changed_reads_kept(self):
        for fmt in FORMATS:
            self.assertEqual(analyze(history(fmt, changed=True), fmt)["stats"]["changed_results"], 0)

    def test_failed_reads_kept(self):
        for fmt in ("claude", "kimi", "gemini", "opencode", "pi", "hermes"):
            self.assertEqual(analyze(history(fmt, failed=True), fmt)["stats"]["changed_results"], 0)

    def test_text_errors_kept(self):
        for text in ("Error: failed\n", "Traceback (most recent call last):\n", "3 failed\n", "Permission denied\n"):
            self.assertEqual(analyze(history(body=text * 1000), "hermes")["stats"]["changed_results"], 0)

    def test_orphan_and_duplicate_ids_preserved(self):
        for mutation in ("orphan", "duplicate"):
            h = history()
            if mutation == "orphan":
                del h[2]["tool_calls"]
            else:
                h[2]["tool_calls"].append(copy.deepcopy(h[2]["tool_calls"][0]))
            self.assertEqual(analyze(h, "hermes")["messages"], h)

    def test_mixed_media_not_replaced(self):
        h = history("pi")
        for i in (3, 5):
            h[i]["content"].append({"type": "image", "data": "sensitive image", "mimeType": "image/png"})
        self.assertEqual(analyze(h, "pi")["messages"], h)

    def test_unknown_tools_kept(self):
        h = history()
        for i in (2, 4):
            h[i]["tool_calls"][0]["function"]["name"] = "execute_payment"
        self.assertEqual(analyze(h, "hermes")["messages"], h)

    def test_structured_failure_preserved(self):
        for body in ({"error": "failed", "output": "x" * 16000}, {"exit_code": 1, "stdout": "x" * 16000}, {"stdout": "Error: failed\n" + "x" * 16000}):
            h = history(body=json.dumps(body))
            self.assertEqual(analyze(h, "hermes")["messages"], h)

    def test_system_tool_shaped_content_preserved(self):
        h = history("claude")
        h[3]["role"] = "system"
        self.assertEqual(analyze(h, "claude")["messages"], h)

    def test_non_object_arguments_preserved(self):
        h = history()
        h[2]["tool_calls"][0]["function"]["arguments"] = "[]"
        self.assertEqual(analyze(h, "hermes")["messages"], h)

    def test_archive_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = history()
            objects = Path(tmp) / "objects"
            objects.mkdir()
            target = objects / (digest(h[3]["content"].encode()) + ".txt")
            target.symlink_to(Path(tmp) / "missing")
            with self.assertRaises(ValueError):
                analyze(h, "hermes", tmp)
            self.assertFalse((Path(tmp) / "missing").exists())

    def test_recent_pair_kept(self):
        h = history()[:6]
        self.assertEqual(analyze(h, "hermes")["messages"], h)

    def test_first_pair_kept(self):
        h = history()[2:]
        self.assertEqual(analyze(h, "hermes")["messages"], h)

    def test_diff_arguments_kept(self):
        h = history()
        h[4]["tool_calls"][0]["function"]["arguments"] = '{"path":"/other/a.py"}'
        self.assertEqual(analyze(h, "hermes")["messages"], h)

    def test_single_text_and_metadata_retained(self):
        h = history("claude")
        h[2]["content"].insert(0, {"type": "thinking", "thinking": "reason", "signature": "signed"})
        h[3]["content"][0]["content"] = [{"type": "text", "text": h[3]["content"][0]["content"]}]
        out = analyze(h, "claude")["messages"]
        self.assertEqual(out[2], h[2])
        self.assertEqual(out[3]["content"][0]["tool_use_id"], "c0")
        self.assertIn(MARKER, out[3]["content"][0]["content"][0]["text"])

    def test_passing_check_requires_explicit_exit(self):
        for code, expected in ((None, 0), (1, 0), (0, 2)):
            h = history()
            for i in (2, 4):
                h[i]["tool_calls"][0]["function"] = {"name": "Bash", "arguments": '{"command":"npm test"}'}
                h[i + 1]["content"] = json.dumps({"stdout": "OK\n" * 6000, "exit_code": code})
            self.assertEqual(analyze(h, "hermes")["stats"]["changed_results"], expected)

    def test_masked_and_mutating_commands_kept(self):
        for cmd in ("npm test | tail", "npm test; true", "npm test -- --updateSnapshot", "curl url", "rm -rf x", "echo success"):
            h = history()
            for i in (2, 4):
                h[i]["tool_calls"][0]["function"] = {"name": "Bash", "arguments": json.dumps({"command": cmd})}
                h[i + 1]["content"] = json.dumps({"stdout": "OK\n" * 6000, "exit_code": 0})
            self.assertEqual(analyze(h, "hermes")["messages"], h)

    def test_archive_integrity_and_idempotence(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = history()
            out = analyze(h, "hermes", tmp)
            sha = out["decisions"][0]["sha256"]
            path = Path(tmp) / "objects" / (sha + ".txt")
            self.assertEqual(path.read_text(), h[3]["content"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(analyze(out["messages"], "hermes", tmp)["messages"], out["messages"])
            path.write_text("corrupt")
            with self.assertRaises(ValueError):
                analyze(h, "hermes", tmp)

    def test_archive_failure_retains_request(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"SIFT_HOME": tmp, "SIFT_MODE": "live"}):
            data = history("pi")
            with patch("sift.core.archive_text", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    process("pi", {"messages": data})
            self.assertEqual(data, history("pi"))

    def test_small_result_not_replaced(self):
        h = history(body="short")
        self.assertEqual(analyze(h, "hermes")["messages"], h)

    def test_shadow_has_no_archive_or_raw_logs(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"SIFT_HOME": tmp, "SIFT_MODE": "shadow"}):
            self.assertEqual(process("pi", {"messages": history("pi")}), {})
            self.assertFalse((Path(tmp) / "objects").exists())
            self.assertNotIn("read content", (Path(tmp) / "receipts.jsonl").read_text())

    def test_live_only_supported_and_threshold(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"SIFT_HOME": tmp, "SIFT_MODE": "live"}):
            for fmt in FORMATS:
                out = process(fmt, {"messages": history(fmt)})
                self.assertEqual(bool(out.get("applied")), fmt in ("pi", "opencode", "hermes"))
            self.assertEqual(process("pi", {"messages": history("pi", body="OK" * 1000)}), {})

    def test_disabled_does_no_work(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"SIFT_HOME": tmp, "SIFT": "0"}):
            self.assertEqual(process("pi", {}), {})
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_bad_config_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "config.json").write_text("broken")
            out = subprocess.run([sys.executable, str(ROOT / "scripts/sift.py"), "request", "pi"],
                                 input=json.dumps({"messages": history("pi")}), text=True, capture_output=True,
                                 env={**os.environ, "SIFT_HOME": tmp})
            self.assertEqual(out.returncode, 0)
            self.assertEqual(json.loads(out.stdout), {})

    def test_export_source_unchanged_and_recover(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / "source.json", Path(tmp) / "output.json"
            source.write_text(json.dumps(history()))
            before = source.read_bytes()
            env = {**os.environ, "SIFT_HOME": str(Path(tmp) / "state")}
            cli = [sys.executable, str(ROOT / "scripts/sift.py")]
            cmd = cli + ["export", "--format", "hermes", "--input", str(source), "--output", str(target)]
            run = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            receipt = json.loads(run.stdout)
            recovered = subprocess.check_output(cli + ["recover", receipt["decisions"][0]["sha256"]], env=env)
            self.assertEqual(recovered.decode(), history()[3]["content"])
            self.assertEqual(source.read_bytes(), before)
            self.assertNotEqual(subprocess.run(cmd, env=env, capture_output=True).returncode, 0)

    def test_review_is_explicit_advice_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, reviewer = Path(tmp) / "source.json", Path(tmp) / "reviewer"
            source.write_text(json.dumps(history()))
            before = source.read_bytes()
            reviewer.write_text('#!/usr/bin/env python3\nimport json,sys\np=json.load(sys.stdin)\nprint("keep all ambiguous evidence")\n')
            reviewer.chmod(0o700)
            out = subprocess.run([sys.executable, str(ROOT / "scripts/sift.py"), "review", "--input", str(source), "--format", "hermes", "--reviewer", str(reviewer)], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertFalse(json.loads(out.stdout)["applied"])
            self.assertEqual(source.read_bytes(), before)


class InstallerTests(unittest.TestCase):
    def test_yaml_variants(self):
        import yaml
        for txt in ("", "plugins:\n  enabled: []\n", "plugins:\n  enabled: [wayfinder] # keep\n", "plugins:\n  enabled:\n  - wayfinder\n", "plugins:\n  enabled:\n    - wayfinder\n"):
            new = installer.enable_yaml(txt)
            self.assertIn("sift", yaml.safe_load(new)["plugins"]["enabled"])
            self.assertEqual(installer.enable_yaml(new), new)

    def test_installer_preservation_and_idempotence(self):
        with tempfile.TemporaryDirectory(prefix="sift paths ") as tmp:
            root = Path(tmp)
            (root / ".claude").mkdir()
            original = {"unrelated": 1, "hooks": {"PreCompact": [{"hooks": [{"command": "existing-guard", "type": "command"}]}]}}
            (root / ".claude/settings.json").write_text(json.dumps(original))
            (root / ".kimi-code").mkdir()
            (root / ".kimi-code/config.toml").write_text('model = "keep"\n')
            cmd = [sys.executable, str(ROOT / "scripts/install.py"), "--home", tmp, "--project", tmp]
            env = {**os.environ, "SIFT_HOME": str(root / ".sift")}
            self.assertEqual(subprocess.run(cmd + ["--dry-run"], env=env, capture_output=True).returncode, 0)
            self.assertFalse((root / ".sift").exists())
            run = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            a = json.loads((root / ".claude/settings.json").read_text())
            self.assertEqual(a["unrelated"], 1)
            self.assertEqual(a["hooks"]["PreCompact"][0], original["hooks"]["PreCompact"][0])
            snapshot = {str(p): p.read_bytes() for p in root.rglob("*") if p.is_file() and not p.is_symlink() and ".hermes/plugins" not in str(p)}
            self.assertEqual(subprocess.run(cmd, env=env, capture_output=True).returncode, 0)
            self.assertEqual(snapshot, {str(p): p.read_bytes() for p in root.rglob("*") if p.is_file() and not p.is_symlink() and ".hermes/plugins" not in str(p)})

    def test_invalid_selection_mutates_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = subprocess.run([sys.executable, str(ROOT / "scripts/install.py"), "--project", tmp, "--home", tmp, "--harness", "pi,bogus"], capture_output=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_plugin_conflict_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / ".pi/agent/extensions/sift.ts"
            target.parent.mkdir(parents=True)
            target.write_text("owned")
            with self.assertRaises(ValueError):
                installer.prepare(root, root, ["claude", "pi"])
            self.assertFalse((root / ".claude").exists())


if __name__ == "__main__":
    unittest.main()
