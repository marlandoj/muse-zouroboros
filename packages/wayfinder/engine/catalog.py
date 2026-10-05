"""Skill catalog: SKILL.md frontmatter (name, description) from one or more roots.

Roots are scanned two levels deep so category layouts (root/category/skill/SKILL.md) work.
The first root to define a skill name wins, so list the canonical root first.
"""
import glob
import os
from pathlib import Path
import re

_parent = Path(__file__).resolve().parents[2]
DEFAULT_ROOTS = [str(_parent) if _parent.name == 'Skills' else '~/.agents/skills']
# Skills each harness already loads natively. Opt-in (WAYFINDER_NATIVE_SKILLS=1): the harness
# advertises these itself, and on 2026-09-23 adding them displaced better shared-catalog picks.
NATIVE_ROOTS = {
    'claude': ['~/.claude/skills'],
    'codex': ['~/.codex/skills', '~/.agents/skills'],
    'kimi': ['~/.kimi-code/skills', '~/.agents/skills'],
    'gemini': ['~/.gemini/skills', '~/.agents/skills'],
    'opencode': ['~/.config/opencode/skills', '~/.claude/skills', '~/.agents/skills'],
    'pi': ['~/.pi/agent/skills'],
    'hermes': ['~/.hermes/skills'],
}


def frontmatter_value(block, key):
    match = re.search(r'^' + key + r':\s*(?:[>|][-+]?\s*\n)?(.+?)(?=\n[A-Za-z_-]+:|\Z)', block, re.M | re.S)
    return re.sub(r'\s+', ' ', match.group(1)).strip().strip('"\'') if match else None


def roots_for(harness=None, env=None):
    env = os.environ if env is None else env
    roots = [r for r in (env.get('WAYFINDER_SKILLS_ROOTS') or '').split(':') if r.strip()] or list(DEFAULT_ROOTS)
    if harness and env.get('WAYFINDER_NATIVE_SKILLS', '0') == '1':
        roots += NATIVE_ROOTS.get(harness, [])
    return [os.path.expanduser(r) for r in roots]


def load(roots):
    items, seen = [], set()
    for root in roots:
        paths = sorted(glob.glob(str(Path(root) / '*' / 'SKILL.md')) + glob.glob(str(Path(root) / '*' / '*' / 'SKILL.md')))
        for path in paths:
            if '/_' in path[len(str(root)):] or '/node_modules/' in path:
                continue
            try:
                text = Path(path).read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            match = re.match(r'---\n(.*?)\n---', text, re.S)
            if not match:
                continue
            name, description = frontmatter_value(match.group(1), 'name'), frontmatter_value(match.group(1), 'description')
            if name and description and name not in seen:
                seen.add(name)
                items.append({'id': name, 'description': description, 'source': path})
    return items
