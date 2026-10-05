import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_sift import ROOT, history

spec = importlib.util.spec_from_file_location("hermes_sift", ROOT / "plugins/hermes/sift/__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class PluginTests(unittest.TestCase):
    def test_hermes_registration(self):
        class Registry:
            def register_middleware(self, name, callback):
                self.name, self.callback = name, callback
        registry = Registry()
        plugin.register(registry)
        self.assertEqual(registry.name, "llm_request")
        self.assertIs(registry.callback, plugin.request_middleware)

    def test_hermes_both_protocols_shadow_and_live(self):
        with tempfile.TemporaryDirectory() as tmp:
            for field, fmt in (("messages", "hermes"), ("input", "codex")):
                for mode in ("shadow", "live"):
                    with patch.dict(os.environ, {"SIFT_HOME": tmp, "SIFT_MODE": mode}):
                        original = {field: history(fmt), "model": "fixture", "temperature": 0.2}
                        before = json.dumps(original)
                        result = plugin.request_middleware(request=original, session_id="fixture")
                        self.assertEqual(json.dumps(original), before)
                        if mode == "shadow":
                            self.assertIsNone(result)
                        else:
                            self.assertEqual(result["request"]["model"], "fixture")
                            self.assertEqual(result["request"]["temperature"], 0.2)
                            self.assertNotEqual(result["request"][field], original[field])

    def test_hermes_failure_returns_original(self):
        with patch.object(plugin.subprocess, "run", side_effect=subprocess.TimeoutExpired("fixture", 3)):
            self.assertIsNone(plugin.request_middleware(request={"messages": history()}))

    def test_command_hooks_neutral_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            for h in ("claude", "codex", "kimi", "gemini"):
                event = {"session_id": "fixture", "hook_event_name": "AfterTool" if h == "gemini" else "PostToolUse",
                         "tool_name": "Read", "tool_input": {"path": "/fixture"}, "tool_response": "private content"}
                r = subprocess.run(["bash", str(ROOT / "scripts/hook.sh"), h], input=json.dumps(event),
                                   text=True, capture_output=True, env={**os.environ, "SIFT_HOME": tmp})
                self.assertEqual(r.returncode, 0)
                self.assertEqual(r.stdout.strip(), "" if h == "kimi" else "{}")
            text = (Path(tmp) / "observations.jsonl").read_text()
            self.assertEqual(len(text.splitlines()), 4)
            self.assertNotIn("private content", text)

    def test_precompact_real_wire_serialization(self):
        with tempfile.TemporaryDirectory() as tmp:
            for h in ("claude", "codex"):
                path = Path(tmp) / (h + ".jsonl")
                values = history(h)
                if h == "claude":
                    values = [{"type": m.get("role"), "message": m} for m in values]
                path.write_text("\n".join(json.dumps(v) for v in values))
                event = {"session_id": "fixture", "hook_event_name": "PreCompact", "transcript_path": str(path)}
                r = subprocess.run(["bash", str(ROOT / "scripts/hook.sh"), h], input=json.dumps(event),
                                   text=True, capture_output=True, env={**os.environ, "SIFT_HOME": tmp})
                self.assertEqual(json.loads(r.stdout), {})
            rows = [json.loads(l) for l in (Path(tmp) / "receipts.jsonl").read_text().splitlines()]
            self.assertTrue(all(r["stats"]["changed_results"] == 1 for r in rows))
            self.assertTrue(all(not r["applied"] for r in rows))


if __name__ == "__main__":
    unittest.main()
