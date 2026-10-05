#!/usr/bin/env python3
"""Explicit one-time model download. Prompt hooks never download model files."""
import os
from pathlib import Path
from flashrank import Ranker

cache = os.environ.get('FLASHRANK_CACHE_DIR', str(Path.home() / '.cache' / 'wayfinder'))
Ranker(model_name='ms-marco-MiniLM-L-12-v2', cache_dir=cache)
print(str(Path(cache).resolve()))
