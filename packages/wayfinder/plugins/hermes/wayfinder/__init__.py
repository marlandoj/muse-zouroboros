"""Hermes plugin: forwards each turn's user message to the Wayfinder hook (harness "hermes").

The hook's stdout, if any, is returned as {"context": ...}, which Hermes appends to the
current user message for this API call only. Any failure returns None.
"""
import json
import os
import subprocess
from pathlib import Path

HOOK = os.environ.get('WAYFINDER_HOOK', str(Path(__file__).resolve().parents[3] / 'scripts' / 'wayfinder-hook.sh'))


def _pre_llm_call(session_id=None, user_message=None, **_):
    if not isinstance(user_message, str) or not user_message.strip():
        return None
    try:
        payload = json.dumps({'prompt': user_message, 'session_id': session_id or '', 'cwd': os.getcwd()})
        out = subprocess.run(['bash', HOOK, 'hermes'], input=payload, capture_output=True, text=True,
                             timeout=float(os.environ.get('WAYFINDER_TIMEOUT', '4')) + 1).stdout.strip()
    except Exception:
        return None
    return {'context': out} if out else None


def register(ctx):
    ctx.register_hook('pre_llm_call', _pre_llm_call)
