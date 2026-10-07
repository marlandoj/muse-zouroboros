#!/usr/bin/env python3
"""
Judge Calibration Suite (Project 5)
Runs consensus gate against labeled test cases. Emits per-judge accuracy,
bias, leniency, F1 scores, and calibration recommendations.

Usage:
  python3 judge-calibration.py              # Full run
  python3 judge-calibration.py --quick       # 5-case sanity check  
  python3 judge-calibration.py --report     # Only generate report from last run
"""
import json, sys, os, time, subprocess
from pathlib import Path
from collections import defaultdict
from statistics import mean, stdev

# Paths resolve relative to this script so the package works from any checkout.
SKILL_DIR = Path(__file__).resolve().parent.parent
TEST_FILE = SKILL_DIR / "data" / "calibration" / "test-cases.json"
LAST_RUN = SKILL_DIR / "data" / "calibration" / "last-run.json"

def load_test_cases():
    with open(TEST_FILE) as f:
        data = json.load(f)
    return data["cases"]

def run_consensus_gate(code: str, criteria: str, label: str):
    """Run the consensus gate CLI and return parsed verdicts."""
    cmd = [
        "bun", "run", str(SKILL_DIR / "scripts" / "consensus-gate.ts"),
        "validate",
        "--code", code,
        "--criteria", criteria,
        "--label", label,
        "--json",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, cwd=str(SKILL_DIR))
        if result.returncode != 0:
            print(f"    gate exit {result.returncode}: {result.stderr.strip()[:200]}")
            return None
        # validate prints decorative human output, then a sentinel-prefixed JSON line.
        marker = "__CG_JSON__"
        idx = result.stdout.rfind(marker)
        if idx == -1:
            print("    no JSON sentinel in gate output")
            return None
        return json.loads(result.stdout[idx + len(marker):])
    except Exception as e:
        print(f"  Error running gate: {e}")
        return None

def compute_stats(results: list) -> dict:
    """Compute per-judge accuracy, bias, leniency metrics."""
    judge_stats = defaultdict(lambda: {
        "correct": 0, "wrong": 0, "no_verdict": 0,
        "true_positives": 0, "false_positives": 0,
        "true_negatives": 0, "false_negatives": 0,
        "latencies": [], "confidences": [],
    })

    for r in results:
        expected = r["expected_pass"]
        verdicts = r.get("verdicts", [])
        for v in verdicts:
            model = v.get("model", "unknown")
            js = judge_stats[model]
            if v.get("abstained"):
                js["no_verdict"] += 1
                continue
            
            predicted = v.get("pass", True)
            js["latencies"].append(v.get("latencyMs", 0))
            js["confidences"].append(v.get("confidence", 0))
            
            if predicted == expected:
                js["correct"] += 1
                if expected == False:
                    js["true_positives"] += 1
                else:
                    js["true_negatives"] += 1
            else:
                js["wrong"] += 1
                if expected == False:
                    js["false_negatives"] += 1
                else:
                    js["false_positives"] += 1

    # Compute derived metrics
    report = {}
    for model, js in judge_stats.items():
        total = js["correct"] + js["wrong"]
        if total == 0:
            report[model] = {"accuracy": None, "error": "no valid verdicts"}
            continue
        
        accuracy = js["correct"] / total * 100
        tp, fp = js["true_positives"], js["false_positives"]
        tn, fn = js["true_negatives"], js["false_negatives"]
        
        precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 1.0
        f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
        
        # Leniency: how often judge says PASS when should FAIL
        fail_count = tp + fn
        false_pass_rate = (fn / fail_count * 100) if fail_count > 0 else 0
        
        # Strictness: how often judge says FAIL when should PASS
        pass_count = tn + fp
        false_fail_rate = (fp / pass_count * 100) if pass_count > 0 else 0
        
        avg_latency = mean(js["latencies"]) if js["latencies"] else 0
        avg_confidence = mean(js["confidences"]) if js["confidences"] else 0
        
        report[model] = {
            "accuracy_pct": round(accuracy, 1),
            "precision_pct": round(precision * 100, 1),
            "recall_pct": round(recall * 100, 1),
            "f1": round(f1, 2),
            "leniency_false_pass_rate": round(false_pass_rate, 1),
            "strictness_false_fail_rate": round(false_fail_rate, 1),
            "total_verdicts": total,
            "abstentions": js["no_verdict"],
            "avg_latency_ms": round(avg_latency),
            "avg_confidence": round(avg_confidence, 2),
            "calibration_delta": None,  # computed below
        }
    
    return report

def compute_ensemble(results: list) -> dict:
    """Score the actual consensus VERDICT (not individual judges) against human truth.
    This is the number that matters: does the gate as a whole decide correctly?"""
    total = correct = escalate = 0
    fail_total = fail_caught = pass_total = pass_ok = 0
    for r in results:
        exp = r.get("expected_pass")
        cons = r.get("consensus") or {}
        cpass = cons.get("pass")
        status = r.get("status")
        if status == "escalate" or cpass is None:
            escalate += 1
        total += 1
        if cpass is not None and cpass == exp:
            correct += 1
        if exp is False:
            fail_total += 1
            if cpass is False:
                fail_caught += 1
        else:
            pass_total += 1
            if cpass is True:
                pass_ok += 1
    return {
        "n": total,
        "accuracy_pct": round(correct / total * 100, 1) if total else 0,
        "defect_recall_pct": round(fail_caught / fail_total * 100) if fail_total else None,
        "clean_pass_pct": round(pass_ok / pass_total * 100) if pass_total else None,
        "escalations": escalate,
        "false_fail_clean": pass_total - pass_ok,
        "missed_defects": fail_total - fail_caught,
    }


def calibrate(reports: dict) -> list:
    if not reports:
        return [{"type": "WARNING", "message": "No judge results available — cannot calibrate. Check API connectivity."}]
    recommendations = []
    
    # Most lenient: highest false pass rate
    lenient = max(reports.items(), key=lambda x: x[1].get("leniency_false_pass_rate", 0))
    if lenient[1].get("leniency_false_pass_rate", 0) > 20:
        recommendations.append({
            "judge": lenient[0],
            "issue": "Too lenient",
            "metric": f"{lenient[1]['leniency_false_pass_rate']}% false pass rate",
            "action": f"Lower {lenient[0]} threshold by 0.1 OR increase weight of dissenting votes against {lenient[0]}",
        })
    
    # Most strict: highest false fail rate
    strict = max(reports.items(), key=lambda x: x[1].get("strictness_false_fail_rate", 0))
    if strict[1].get("strictness_false_fail_rate", 0) > 20:
        recommendations.append({
            "judge": strict[0],
            "issue": "Too strict",
            "metric": f"{strict[1]['strictness_false_fail_rate']}% false fail rate",
            "action": f"Raise {strict[0]} threshold by 0.1 OR reduce weight of {strict[0]} in consensus",
        })
    
    # Check for model that could be dropped
    for model, stats in reports.items():
        if stats.get("accuracy_pct", 0) < 50:
            recommendations.append({
                "judge": model,
                "issue": "Below-random accuracy",
                "metric": f"{stats['accuracy_pct']}% accuracy",
                "action": f"Consider removing {model} from the panel or running with --skip {model}",
            })
    
    return recommendations

def save_run(results, stats, recommendations, ensemble=None):
    LAST_RUN.parent.mkdir(parents=True, exist_ok=True)
    run_data = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "test_cases": len(results),
        "ensemble": ensemble,
        "stats": stats,
        "recommendations": recommendations,
        "raw_results": results,
    }
    with open(LAST_RUN, "w") as f:
        json.dump(run_data, f, indent=2)
    return run_data

def main():
    import sys
    args = sys.argv[1:]
    quick = "--quick" in args or "-q" in args
    mock = "--mock" in args or "-m" in args
    single = None
    for a in args:
        if a.startswith("-"):
            single = a
            break
    
    report_only = "--report" in args
    recompute = "--recompute" in args

    if recompute:
        # Re-derive stats from saved raw verdicts without re-billing the gate.
        if not LAST_RUN.exists():
            print("No previous run to recompute.")
            return
        with open(LAST_RUN) as f:
            run = json.load(f)
        results = run["raw_results"]
        stats = compute_stats(results)
        ensemble = compute_ensemble(results)
        recommendations = calibrate(stats)
        save_run(results, stats, recommendations, ensemble)
        print_report(stats, recommendations, len(results), ensemble)
        return

    if report_only:
        if LAST_RUN.exists():
            with open(LAST_RUN) as f:
                run = json.load(f)
            print_report(run["stats"], run["recommendations"], run["test_cases"], run.get("ensemble"))
        else:
            print("No previous run found.")
        return
    
    cases = load_test_cases()
    if quick:
        cases = cases[:5]
    
    print(f"Running calibration on {len(cases)} test cases...")
    
    results = []
    if mock:
        import random, hashlib
        random.seed(42)
        # Synthesize realistic per-judge behavior:
        #   GLM: lenient (mostly passes)
        #   Kimi: strict (often fails)
        #   Grok: moderate (mixed)
        #   Arbitr: arbitrary (random)
        for case in cases:
            label = f"cal-{case['id']}"
            gate_result = {
                "expected_pass": case["expected_pass"],
                "category": case.get("category", "unknown"),
                "difficulty": case.get("difficulty", "unknown"),
                "verdicts": [],
            }
            # Mock verdicts based on model name and expected pass
            for model in ["GLM", "Kimi", "Grok", "Arbitr"]:
                verdict = {
                    "model": model,
                    "pass": random.random() < (0.7 if model == "GLM" else 0.85 if model == "Kimi" else 0.8 if model == "Grok" else 0.5),
                    "abstained": False,
                    "latencyMs": random.randint(100, 500),
                    "confidence": random.uniform(0.5, 0.95),
                }
                gate_result["verdicts"].append(verdict)
            results.append(gate_result)
            vc = len(gate_result.get("verdicts", []))
            print(f"    {vc} verdicts received")
    else:
        for i, case in enumerate(cases):
            label = f"cal-{case['id']}"
            print(f"  [{i+1}/{len(cases)}] {label}: {case['label'][:60]}...")
            
            gate_result = run_consensus_gate(case["code"], case["criteria"], label)
            if gate_result:
                gate_result["expected_pass"] = case["expected_pass"]
                gate_result["category"] = case.get("category", "unknown")
                gate_result["difficulty"] = case.get("difficulty", "unknown")
                results.append(gate_result)
                vc = len(gate_result.get("verdicts", []))
                print(f"    {vc} verdicts received")
            else:
                results.append({
                    "expected_pass": case["expected_pass"],
                    "verdicts": [],
                    "error": "gate_failed",
                })
                print("    FAILED")
    
    if not results:
        print("No results collected.")
        return
    
    stats = compute_stats(results)
    ensemble = compute_ensemble(results)
    recommendations = calibrate(stats)
    run_data = save_run(results, stats, recommendations, ensemble)

    print_report(stats, recommendations, len(results), ensemble)

def print_report(stats, recommendations, n_cases, ensemble=None):
    print("\n" + "=" * 60)
    print("  JUDGE CALIBRATION REPORT")
    print("=" * 60)
    print(f"\nTest cases: {n_cases}")
    if ensemble:
        print(f"\n{'-'*60}")
        print("  ENSEMBLE (the gate's actual verdict vs human truth)")
        print("-" * 60)
        dr = ensemble.get("defect_recall_pct")
        cp = ensemble.get("clean_pass_pct")
        print(f"  Overall accuracy:     {ensemble['accuracy_pct']:>5.1f}%  ({ensemble['n']} cases)")
        print(f"  Defect recall:        {dr if dr is None else f'{dr:>5.0f}%'}  (real defects blocked; {ensemble['missed_defects']} missed)")
        print(f"  Clean-code pass rate: {cp if cp is None else f'{cp:>5.0f}%'}  ({ensemble['false_fail_clean']} clean cases wrongly blocked)")
        print(f"  Escalations:          {ensemble['escalations']:>5}")
    print(f"\n{'Judge':<25} {'Acc':>6} {'Prec':>6} {'Rec':>6}  {'F1':>5}  {'LenFX':>6} {'StrFX':>6} {'Abstain':>7}")
    print("-" * 85)
    
    for model, s in sorted(stats.items()):
        if s.get("accuracy_pct") is None:
            print(f"{model:<25}  {'N/A':>6}")
            continue
        print(f"{model:<25} {s['accuracy_pct']:>5.1f}% {s['precision_pct']:>5.1f}% {s['recall_pct']:>5.1f}% {s['f1']:>5.2f} {s['leniency_false_pass_rate']:>5.1f}% {s['strictness_false_fail_rate']:>5.1f}% {s['abstentions']:>6}")
    
    if recommendations:
        print(f"\n{'='*60}")
        print("  CALIBRATION RECOMMENDATIONS")
        print("=" * 60)
        for i, r in enumerate(recommendations, 1):
            if "judge" not in r:
                print(f"\n  {i}. [{r.get('type', 'NOTE')}] {r.get('message', '')}")
                continue
            print(f"\n  {i}. [{r['judge']}] {r['issue']}")
            print(f"     Metric: {r['metric']}")
            print(f"     Action: {r['action']}")
    else:
        print("\n  All judges within calibration tolerances.")

if __name__ == "__main__":
    main()
