#!/usr/bin/env python3
"""Local applicability ranking: BM25 lexical scores fused with a FlashRank cross-encoder.

No network call and no provider credential. FlashRank scores are sigmoid outputs of an
MS MARCO passage model; they rank well but are not calibrated probabilities, so selection
uses a fused rule rather than treating a score as confidence.
"""
import collections
import math
import os
import re
from pathlib import Path

ENGINE = 'local:bm25+ms-marco-MiniLM-L-12-v2/fusion-v1'  # must equal jev-skill-advisor decision.LOCAL_ENGINE
CROSS_ENCODER = 'ms-marco-MiniLM-L-12-v2'
# Tuned on the 2026-09-23 author-written skill-selection diagnostic (even cases), checked on
# the odd cases. Not a production holdout; see references/evaluation.md.
DEFAULTS = {'cross_floor': 0.0004, 'lexical_floor': 5.0, 'shortlist': 20, 'agree_top': 3}
STOP = frozenset('a an and are as at be by do for from i in is it me my not of on or the this that to use when with your'.split())
_ranker = None


def stem(word):
    for suffix in ('ing', 'ed', 'es', 's'):
        if len(word) > len(suffix) + 3 and word.endswith(suffix):
            return word[:-len(suffix)]
    return word


def tokens(text):
    return [w for w in re.findall(r'[a-z0-9]+', text.lower()) if w not in STOP]


def passage(item):
    parts = [item['id'].replace('-', ' ').replace('_', ' ') + ': ' + item['description'][:500]]
    if item.get('applies_when'):
        parts.append('Applies when: ' + '; '.join(item['applies_when']))
    return ' '.join(parts)[:1200]


def bm25(query, texts, k1=1.2, b=0.75):
    docs = [tokens(t) for t in texts]
    n = len(docs)
    if not n:
        return []
    avg = sum(map(len, docs)) / n or 1.0
    df = collections.Counter(w for d in docs for w in set(d))
    terms = tokens(query)
    scores = []
    for d in docs:
        tf = collections.Counter(d)
        s = 0.0
        for w in terms:
            if w in tf:
                idf = math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5))
                s += idf * tf[w] * (k1 + 1) / (tf[w] + k1 * (1 - b + b * len(d) / avg))
        scores.append(s)
    return scores


def cross_scores(query, texts, indices):
    global _ranker
    if not indices:
        return {}
    from flashrank import Ranker, RerankRequest
    if _ranker is None:
        class OfflineRanker(Ranker):
            def _prepare_model_dir(self, model_name):
                if not self.model_dir.is_dir():
                    raise FileNotFoundError('Run scripts/setup_model.py before using Wayfinder')

        cache = os.environ.get('FLASHRANK_CACHE_DIR', str(Path.home() / '.cache' / 'wayfinder'))
        _ranker = OfflineRanker(model_name=CROSS_ENCODER, cache_dir=cache)
    results = _ranker.rerank(RerankRequest(query=query, passages=[{'id': i, 'text': texts[i]} for i in indices]))
    return {int(r['id']): float(r['score']) for r in results}


def suppressed(query, item):
    """does_not_apply_when examples veto only on a near-exact lexical match."""
    q = {stem(w) for w in tokens(query)}
    for example in item.get('does_not_apply_when', []):
        e = {stem(w) for w in tokens(example)}
        if e and len(q & e) / len(e) >= 0.8:
            return True
    return False


def rank(query, items, config=None):
    """Score every item; return per-item dicts in input order plus the fused ordering."""
    cfg = {**DEFAULTS, **(config or {})}
    texts = [passage(i) for i in items]
    lexical = bm25(query, texts)
    shortlist = sorted(range(len(items)), key=lambda i: -lexical[i])[:cfg['shortlist']]
    cross = cross_scores(query, texts, shortlist)
    order = sorted(range(len(items)), key=lambda i: (-cross.get(i, -1.0), -lexical[i]))
    top = set(order[:cfg['agree_top']])
    scored = []
    for i, item in enumerate(items):
        c = cross.get(i)
        by_cross = c is not None and c >= cfg['cross_floor']
        by_lexical = lexical[i] >= cfg['lexical_floor'] and i in top
        veto = suppressed(query, item)
        scored.append({'selected': (by_cross or by_lexical) and not veto,
                       'basis': 'veto' if veto else 'cross' if by_cross else 'lexical' if by_lexical else None,
                       'cross': None if c is None else round(c, 6), 'lexical': round(lexical[i], 4)})
    return scored, order


def choose(query, items, config=None):
    """Single best applicable item, or None. Cross-encoder pick first, then lexical agreement."""
    scored, order = rank(query, items, config)
    picks = [i for i in order if scored[i]['selected'] and scored[i]['basis'] == 'cross']
    if not picks:
        picks = sorted((i for i in order if scored[i]['selected']), key=lambda i: -scored[i]['lexical'])
    return (picks[0] if picks else None), scored, order
