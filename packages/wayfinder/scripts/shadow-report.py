#!/usr/bin/env python3
"""Score the ranker against a small operator-labeled case set.

This is the evidence the shadow -> live promotion decision needs. It reports what the
current thresholds actually do, and where they miss, without changing them.

  python3 scripts/shadow-report.py             # report at the shipped thresholds
  python3 scripts/shadow-report.py --sweep     # score distribution, for re-tuning

A case is a hit when the pick is in that case's `want` set. `want` holds every skill a
reasonable operator would accept, not just the single best one.
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))

import catalog
import local_rank

ROOTS = ['/home/workspace/Skills', os.path.expanduser('~/.agents/skills')]

CASES = [
    {'q': 'add a REST endpoint to the software factory swarm API and run the 32-case test suite',
     'want': ['compile-build-spec', 'zo-swarm-executors', 'zo-swarm-orchestrator'],
     'why': 'turn a free-form build request into a swarm spec'},
    {'q': 'run the swarm for this seed yaml and manage the waves',
     'want': ['zo-swarm-orchestrator'], 'why': 'execute a swarm DAG'},
    {'q': 'execute this wave in parallel across the worker pool',
     'want': ['zo-swarm-executors'], 'why': 'fan out swarm tasks'},
    {'q': 'research the last 24 hours of premarket movers and rank by gap percent',
     'want': ['jhf-daily-top5', 'smart-money'], 'why': 'premarket screener run'},
    {'q': 'make a new avatar portrait for the persona',
     'want': ['heygen-avatar', 'ai-character-builder'], 'why': 'persona avatar'},
    {'q': 'audit the governance policy and produce a post-flight evidence report',
     'want': ['zouroboros-governance', 'plan-closeout'], 'why': 'governance gate + report'},
    {'q': 'this turn was interrupted mid-run, recover the checkpoint and finish the contract',
     'want': ['automation-resilience'], 'why': 'checkpointed automation recovery'},
    {'q': 'search the workspace memory for prior decisions about this project',
     'want': ['zo-memory-system'], 'why': 'memory retrieval'},
    {'q': 'which tier is this task and what model should answer it',
     'want': ['tier-resolver'], 'why': 'model/tier routing'},
    {'q': 'screenshot the running site and check the layout against the UX rules',
     'want': ['visual-verifier', 'ux-laws'], 'why': 'visual + UX review'},
    {'q': 'churn looks high on the adapter, diagnose the cause before we change code',
     'want': ['ponytail-audit', 'deep-research'], 'why': 'diagnose first'},
    {'q': 'generate a product launch video with voiceover and captions',
     'want': ['product-launch-video', 'academy-video-pipeline', 'faceless-explainer',
              'hyperframes', 'embedded-captions'], 'why': 'launch video pipeline'},
]


def evaluate(cfg=None):
    items = catalog.load(ROOTS)
    rows = []
    for case in CASES:
        scored, order = local_rank.rank(case['q'], items, cfg)
        pick, scored, order = local_rank.choose(case['q'], items, cfg)
        chosen = items[pick]['id'] if pick is not None else None
        top = [(items[i]['id'], scored[i]['cross'], scored[i]['lexical']) for i in order[:3]]
        rows.append({'q': case['q'], 'want': case['want'], 'why': case['why'],
                     'pick': chosen, 'hit': chosen in case['want'] if chosen else False,
                     'top': top})
    hits = sum(r['hit'] for r in rows)
    return items, rows, hits


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--sweep', action='store_true',
                   help='print the score distribution instead of the per-case verdict')
    p.add_argument('--json', action='store_true', help='machine-readable output')
    args = p.parse_args()

    if args.sweep:
        items = catalog.load(ROOTS)
        out = []
        for case in CASES:
            scored, _ = local_rank.rank(case['q'], items)
            for c in scored:
                if c['cross'] is not None:
                    out.append(c['cross'])
        out.sort()
        n = len(out)
        print(json.dumps({'cross_scores_n': n,
                          'p50': out[n // 2], 'p90': out[int(n * 0.9)], 'p99': out[int(n * 0.99)],
                          'max': out[-1],
                          'above_0.0004': sum(1 for v in out if v >= 0.0004),
                          'above_0.001': sum(1 for v in out if v >= 0.001)}, indent=2))
        return 0

    items, rows, hits = evaluate()
    summary = {'catalog_size': len(items), 'cases': len(rows), 'hits': hits,
               'hit_rate': round(hits / len(rows), 3),
               'abstain_rate': round(sum(1 for r in rows if r['pick'] is None) / len(rows), 3),
               'thresholds': local_rank.DEFAULTS}
    if args.json:
        print(json.dumps({'summary': summary, 'cases': rows}, indent=2))
        return 0

    print(f"catalog {summary['catalog_size']} skills | {summary['hits']}/{summary['cases']} hits "
          f"({summary['hit_rate']}) | abstained {summary['abstain_rate']} | "
          f"cross_floor={summary['thresholds']['cross_floor']} lexical_floor={summary['thresholds']['lexical_floor']}")
    for r in rows:
        mark = 'HIT ' if r['hit'] else ('SKIP' if r['pick'] is None else 'MISS')
        print(f"\n{mark} {r['q']}")
        print(f"     want: {', '.join(r['want'])}  ({r['why']})")
        print(f"     pick: {r['pick']}")
        for i, (skill, cross, lex) in enumerate(r['top'], 1):
            print(f"       {i}. {skill:<28} cross={cross} lexical={lex}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
