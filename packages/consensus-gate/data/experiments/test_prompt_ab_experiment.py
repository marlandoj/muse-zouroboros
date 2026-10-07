#!/usr/bin/env python3
import argparse
import importlib.util
import json
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent.parent / "scripts" / "prompt-ab.py"
FIXTURE = HERE / "fixtures" / "offline-paired" / "manifest.json"


def load_module():
    spec = importlib.util.spec_from_file_location("prompt_ab", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_deterministic_replay(module):
    with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
        one = module.run_experiment(FIXTURE, first)
        two = module.run_experiment(FIXTURE, second)
        assert one["aggregate"] == two["aggregate"]
        comparison = one["aggregate"]["comparisons"][0]
        assert comparison["sampleAssessment"] == "insufficient"
        assert comparison["significant"] is False
        assert comparison["promotion"] == "operator-approval-required"
        rows = [json.loads(line) for line in Path(one["caseEvidence"]).read_text().splitlines()]
        assert len(rows) == 8
        assert all(row["toolsEnabled"] is False for row in rows)
        assert all({"variantId", "dataset", "evaluator", "model", "promptVersion", "toolVersion", "startedAt", "raw"}.issubset(row) for row in rows)


def test_invalid_and_missing_evaluator(module):
    raw = json.loads(FIXTURE.read_text())
    broken = dict(raw)
    broken["unexpected"] = True
    try:
        module.validate_experiment_manifest(broken)
        assert False, "expected unknown field failure"
    except module.ExperimentError:
        pass
    broken = dict(raw)
    broken.pop("evaluator")
    try:
        module.validate_experiment_manifest(broken)
        assert False, "expected missing evaluator failure"
    except module.ExperimentError:
        pass


def test_budget_exhaustion_is_durable(module):
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        raw = json.loads(FIXTURE.read_text())
        raw["budgets"]["maxWallMs"] = 0
        (root / "cases.json").write_text((FIXTURE.parent / "cases.json").read_text())
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps(raw))
        output = root / "runs"
        try:
            module.run_experiment(manifest, output)
            assert False, "expected budget exhaustion"
        except module.ExperimentError as error:
            assert "budget exhausted" in str(error)
        state = next(output.glob("*/*/state.json"))
        assert json.loads(state.read_text())["status"] == "BUDGET_EXHAUSTED"


def test_interrupted_run_requires_resume(module):
    with tempfile.TemporaryDirectory() as temp:
        first = module.run_experiment(FIXTURE, temp)
        state_path = Path(first["caseEvidence"]).parent / "state.json"
        state = json.loads(state_path.read_text())
        state["status"] = "RUNNING"
        state_path.write_text(json.dumps(state))
        try:
            module.run_experiment(FIXTURE, temp)
            assert False, "expected explicit resume requirement"
        except module.ExperimentError as error:
            assert "pass --resume" in str(error)
        resumed = module.run_experiment(FIXTURE, temp, resume=True)
        assert resumed["status"] == "COMPLETE"


def main():
    argparse.ArgumentParser(description="Tests for versioned prompt experiments.").parse_args()
    module = load_module()
    tests = [test_deterministic_replay, test_invalid_and_missing_evaluator, test_budget_exhaustion_is_durable, test_interrupted_run_requires_resume]
    failed = 0
    for test in tests:
        try:
            test(module)
            print(f"PASS {test.__name__}")
        except Exception as error:
            failed += 1
            print(f"FAIL {test.__name__}: {error}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
