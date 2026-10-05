#!/usr/bin/env python3
"""Print a Hermes config.yaml with 'wayfinder' added to plugins.enabled, preserving every other line.

Handles `enabled: []`, flow lists `enabled: [a, b]` and block lists. Exits 1 on any other shape.
"""
import re
import sys

NAME = 'wayfinder'


def enable(text):
    lines = text.splitlines(keepends=True)
    try:
        start = next(i for i, l in enumerate(lines) if re.match(r'^plugins:\s*$', l))
    except StopIteration:
        return text.rstrip('\n') + f'\nplugins:\n  enabled: [{NAME}]\n'
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line.strip() and not line.startswith((' ', '\t')):
            break
        m = re.match(r'^(\s+)enabled:\s*(.*?)\s*$', line)
        if not m:
            continue
        indent, value = m.groups()
        if value.startswith('['):
            items = [x.strip().strip('"\'') for x in value.strip('[]').split(',') if x.strip()]
            if NAME not in items:
                items.append(NAME)
            lines[i] = f'{indent}enabled: [{", ".join(items)}]\n'
            return ''.join(lines)
        if value == '':
            j, items = i + 1, []
            while j < len(lines) and re.match(r'^\s*-\s+', lines[j]):
                items.append(re.sub(r'^\s*-\s+', '', lines[j]).strip().strip('"\''))
                j += 1
            if NAME in items:
                return text
            item_indent = re.match(r'^(\s*)-', lines[i + 1]).group(1) if j > i + 1 else indent + '  '
            lines.insert(j, f'{item_indent}- {NAME}\n')
            return ''.join(lines)
        raise ValueError('unrecognized plugins.enabled value')
    raise ValueError('plugins block has no enabled key')


if __name__ == '__main__':
    try:
        sys.stdout.write(enable(open(sys.argv[1], encoding='utf-8').read()))
    except (OSError, ValueError, IndexError) as exc:
        sys.stderr.write(f'{exc}\n')
        raise SystemExit(1)
