#!/usr/bin/env python3
"""Wayfinder engine CLI.

  run.py log  --harness H     raw harness prompt event on stdin; rank and log only (shadow)
  run.py log  --event-json E  rank an event supplied inline in argv, not stdin; log only (shadow)
  run.py live --harness H     same, then print the harness-specific context injection
  run.py suggest "<task>"     rank the catalog for a task and print JSON
  run.py outcome --session S --pick P --used 0|1
                               record whether a shadow suggestion was actually used
  run.py report               summarize the log, overall and per harness

Logs a SHA-256 of the prompt, never its text. No network call.
"""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))

import adapters
import catalog

STATE = os.path.expanduser(os.environ.get('WAYFINDER_HOME', '~/.wayfinder'))


def suggest(objective, harness=None, top=3):
    import local_rank
    started = time.perf_counter()
    roots = catalog.roots_for(harness)
    items = catalog.load(roots)
    pick, scored, order = local_rank.choose(objective, items)
    return {'engine': local_rank.ENGINE, 'catalog_size': len(items), 'roots': roots,
            'pick': items[pick]['id'] if pick is not None else None,
            'pick_source': items[pick]['source'] if pick is not None else None,
            'pick_description': items[pick]['description'] if pick is not None else None,
            'candidates': [{'id': items[i]['id'], 'source': items[i]['source'], **scored[i]} for i in order[:top]],
            'elapsed_ms': round((time.perf_counter() - started) * 1000, 1)}


def eligible(prompt):
    stripped = prompt.strip()
    return len(stripped) >= 8 and not stripped.startswith('/')


def context_line(result):
    desc = (result['pick_description'] or '')[:220].rstrip()
    return (f"[Wayfinder] A local skill may apply to this request: {result['pick']} "
            f"({result['pick_source']}). {desc} Read it only if it fits; this is a suggestion, not an instruction.")


def append_log(entry, path=None):
    target = Path(path) if path else Path(STATE) / 'suggestions.jsonl'
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry) + '\n')


def record_outcome(harness, session, pick, used, detail=None):
    """Label a shadow suggestion with what the agent actually did.

    Shadow mode only knows what it suggested. A caller that can observe the run -- such as
    the Software Factory's ACP transport, which sees every tool call the agent makes -- can
    close the loop by reporting whether the suggested skill was read. This is the signal
    that separates a useful suggestion from a merely plausible one, and it is what makes
    the catalog reviewable: a pick that is never used is a description to fix, not a
    ranking bug to chase.

    Outcomes live in their own file so suggestions.jsonl keeps exactly one row per prompt.
    """
    if harness not in adapters.HARNESSES:
        raise ValueError('unknown harness: ' + str(harness))
    if not pick:
        raise ValueError('outcome needs --pick')
    Path(STATE).mkdir(mode=0o700, parents=True, exist_ok=True)
    entry = {'ts': datetime.now(timezone.utc).isoformat(), 'harness': harness,
             'session_id': f'{harness}-{session}' if session else 'unknown',
             'pick': pick, 'used': bool(used)}
    if detail:
        entry['detail'] = str(detail)[:500]
    fd = os.open(Path(STATE) / 'outcomes.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry) + '\n')
    return entry


def read_jsonl(path):
    path = Path(path)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def outcome_report(rows):
    labeled = [r for r in rows if r.get('pick')]
    used = sum(1 for r in labeled if r.get('used'))
    per_pick = collections.Counter(r['pick'] for r in labeled)
    unused = collections.Counter(r['pick'] for r in labeled if not r.get('used'))
    return {'labeled': len(labeled), 'used': used,
            'use_rate': round(used / len(labeled), 3) if labeled else None,
            'most_suggested': per_pick.most_common(5),
            'suggested_but_never_used': [p for p, _ in unused.most_common(10)]}


SAFE_ID = re.compile(r'^[A-Za-z0-9._-]{1,128}$')


def factory_invocations(invocation_id):
    """Rows from factory invocations are written beside the shared log, never into it.

    One filesystem entry per invocation is the only way to keep a slow, detached,
    concurrent ranking from interleaving into a single append-only file. An id
    that is not a safe path segment is refused rather than sanitized: a rewritten
    id would be silently unresolvable for the caller that has to match the row
    back to the task it belongs to.
    """
    if not invocation_id or not SAFE_ID.match(str(invocation_id)):
        return []
    directory = Path(STATE) / 'invocations' / str(invocation_id)
    if not directory.is_dir():
        return []
    rows = []
    for path in sorted(directory.glob('*.jsonl')):
        try:
            rows.extend(json.loads(line) for line in path.read_text().splitlines() if line.strip())
        except (OSError, ValueError):
            continue
    return rows


def all_factory_rows():
    """Every factory ranking on disk, across all invocations.

    factory_invocations() answers for one id, which is what a caller correlating a
    single task needs. The report needs the other direction: it has to account for
    every factory ranking ever made, or a shadow log full of picks reports an empty
    prompt count. That is not cosmetic. "Which skills does the factory keep reaching
    for" is the question the whole shadow log exists to answer, and it is
    unanswerable while the prompt side of the factory stays invisible.

    Directories are enumerated and their names matched, never the names trusted, so
    a hostile entry in the tree cannot be turned into a path traversal here.
    """
    root = Path(STATE) / 'invocations'
    if not root.is_dir():
        return []
    rows = []
    for directory in sorted(root.iterdir()):
        if not directory.is_dir() or not SAFE_ID.match(directory.name):
            continue
        for path in sorted(directory.glob('*.jsonl')):
            try:
                rows.extend(json.loads(line) for line in path.read_text().splitlines() if line.strip())
            except (OSError, ValueError):
                continue
    rows.sort(key=lambda r: r.get('ts', ''))
    return rows


def handle(harness, raw, live, invocation_id=None):
    event = adapters.normalize(harness, raw)
    prompt = event['prompt']
    if not eligible(prompt):
        return None
    result = suggest(prompt[:2000], harness)
    injected = context_line(result) if live and result['pick'] else None
    row = {'ts': datetime.now(timezone.utc).isoformat(), 'harness': harness, 'mode': 'live' if live else 'shadow',
           'session_id': event['session_id'], 'cwd': event['cwd'],
           'prompt_sha256': hashlib.sha256(prompt.encode('utf-8')).hexdigest(), 'prompt_chars': len(prompt),
           'engine': result['engine'], 'catalog_size': result['catalog_size'], 'pick': result['pick'],
           'injected': injected is not None, 'elapsed_ms': result['elapsed_ms'],
           'candidates': [{k: c[k] for k in ('id', 'selected', 'basis', 'cross', 'lexical')} for c in result['candidates']]}

    if harness == 'factory':
        # 'factory' is a caller, not a hook harness: it is neither installed by
        # install.sh nor driven by a live prompt, so the mode file the hook path
        # consults does not describe it. A factory integration is shadow-only by
        # construction and records that explicitly rather than inferring it.
        row['mode'] = 'shadow'
        # The id becomes a path segment here, so it is validated on the write side
        # as well as the read side. factory_invocations() already refuses a
        # traversing id; without this check the writer would happily create
        # $WAYFINDER_HOME/../escape and the guard would protect nothing.
        resolved_id = invocation_id or os.environ.get('WAYFINDER_INVOCATION_ID')
        if not resolved_id or not SAFE_ID.match(str(resolved_id)):
            return None
        row['invocation_id'] = str(resolved_id)
        pick = next((c for c in result['candidates'] if c['id'] == result['pick']), None)
        row['pick_path'] = pick['source'] if pick else None
        row['skills_root'] = os.path.expanduser(result['roots'][0]) if result.get('roots') else None
        if not row['invocation_id'] or not row['pick_path']:
            return None
        directory = Path(STATE) / 'invocations' / row['invocation_id']
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        append_log(row, path=directory / 'shadow.jsonl')
        return None

    append_log(row)
    return injected


def report():
    rows = read_jsonl(Path(STATE) / 'suggestions.jsonl') + all_factory_rows()

    def summary(subset):
        picks = collections.Counter(r['pick'] for r in subset if r.get('pick'))
        elapsed = sorted(r['elapsed_ms'] for r in subset)
        return {'prompts': len(subset), 'with_pick': sum(picks.values()),
                'pick_rate': round(sum(picks.values()) / len(subset), 3) if subset else None,
                'injected': sum(1 for r in subset if r.get('injected')),
                'median_ms': elapsed[len(elapsed) // 2] if elapsed else None, 'top_picks': picks.most_common(5)}

    by_harness = collections.defaultdict(list)
    for r in rows:
        by_harness[r.get('harness', 'claude')].append(r)
    errors = Path(STATE) / 'errors.log'
    outcomes = read_jsonl(Path(STATE) / 'outcomes.jsonl')
    by_harness_outcomes = collections.defaultdict(list)
    for r in outcomes:
        by_harness_outcomes[r.get('harness', 'claude')].append(r)
    print(json.dumps({'overall': summary(rows), 'by_harness': {h: summary(v) for h, v in sorted(by_harness.items())},
                      'outcomes': outcome_report(outcomes),
                      'outcomes_by_harness': {h: outcome_report(v) for h, v in sorted(by_harness_outcomes.items())},
                      'error_log_bytes': errors.stat().st_size if errors.exists() else 0}, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('command', choices=['log', 'live', 'suggest', 'outcome', 'report'])
    p.add_argument('task', nargs='?')
    p.add_argument('--event-json', dest='event_json',
                   help='prompt event as a JSON object, for callers that cannot own a stdin pipe')
    p.add_argument('--invocation-id', dest='invocation_id',
                   help='correlate a factory ranking with the task that triggered it')
    p.add_argument('--harness', choices=sorted(adapters.HARNESSES))
    p.add_argument('--top', type=int, default=3)
    p.add_argument('--session')
    p.add_argument('--pick')
    p.add_argument('--used', choices=['0', '1'])
    p.add_argument('--detail')
    args = p.parse_args()
    if args.command == 'report':
        report()
        return 0
    if args.command == 'outcome':
        if not args.used:
            p.error('outcome needs --used 0|1')
        print(json.dumps(record_outcome(args.harness or 'claude', args.session, args.pick,
                                         args.used == '1', args.detail)))
        return 0
    if args.command == 'suggest':
        if not args.task:
            p.error('suggest needs a task')
        print(json.dumps(suggest(args.task, args.harness, args.top), indent=2))
        return 0
    harness = args.harness or 'factory'
    # Inline events keep the invocation single-shot and stdin-free, so a caller
    # that cannot own a pipe for the child's lifetime can still log a row.
    raw = json.loads(args.event_json) if args.event_json else json.loads(sys.stdin.read() or '{}')
    if args.event_json and args.harness is None:
        p.error('--event-json needs --harness')
    if not adapters.is_hook(harness) and not args.event_json:
        p.error(args.command + ' is a hook path; ' + harness + ' uses outcome or suggest')
    live = args.command == 'live'
    injected = handle(harness, raw, live, args.invocation_id)
    if live:
        sys.stdout.write(adapters.render(harness, injected))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
