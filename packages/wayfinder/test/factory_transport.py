#!/usr/bin/env python3
"""Cross-language contract test between the Wayfinder engine and the ACP transport.

The engine and the Software Factory's ACP transport are two code bases in two
repositories that must agree on a file layout without either being able to import
the other. This test pins that agreement mechanically: it asks the transport's own
``wayfinderRankScript`` -- the literal program it runs detached -- to rank a prompt
against a temp catalog, then asserts the row lands exactly where the label step
later looks for it.

The transport is TypeScript, so the driver is executed by ``bun`` rather than
evaluated as text. Point ``SWARM_TRANSPORT`` at the module when the checkout lives
somewhere else; the whole file skips when it is not present.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'engine' / 'run.py'
TRANSPORT = Path(os.environ.get('SWARM_TRANSPORT',
                                '/home/workspace/zouroboros/packages/swarm/src/transport/acp-transport.ts'))

failures = []


def check(label, expected, actual):
    if actual == expected:
        print(f'ok    {label}')
    else:
        failures.append(label)
        print(f'FAIL  {label}: expected {expected!r} got {actual!r}')


def build_catalog(root: Path) -> None:
    for name, description in (
        ('fal-media', 'Generate or edit images and videos, posters, thumbnails.'),
        ('email-send', 'Send or reply to email threads through a mailbox.'),
        ('video-subtitles', 'Transcribe audio and video to captions and subtitles.'),
    ):
        directory = root / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'SKILL.md').write_text(
            f'---\nname: {name}\ndescription: {description}\n---\n', encoding='utf-8')


def run_transport_script(tmp: Path, home: Path, roots: Path, cwd: Path, invocation_id: str, prompt: str):
    """Execute the transport's own script builder, then run the script it emits."""
    driver = tmp / 'drive.ts'
    driver.write_text(
        f'import {{ wayfinderRankScript }} from {json.dumps(str(TRANSPORT))};\n'
        "const script = wayfinderRankScript({\n"
        f"  entrypoint: {json.dumps(str(ENGINE))},\n"
        "  harness: 'factory',\n"
        f"  stateHome: {json.dumps(str(home))},\n"
        f"  roots: {json.dumps(str(roots))},\n"
        f"  cwd: {json.dumps(str(cwd))},\n"
        "  timeoutMs: 20000,\n"
        f"  invocationId: {json.dumps(invocation_id)},\n"
        "  event: { prompt: "
        f"{json.dumps(prompt)}, session_id: 'task-1', cwd: {json.dumps(str(cwd))} }},\n"
        "});\n"
        "await Bun.write(process.argv[2], script);\n",
        encoding='utf-8')
    script_path = tmp / 'rank.sh'
    built = subprocess.run(['bun', str(driver), str(script_path)], capture_output=True, text=True)
    if built.returncode != 0:
        raise AssertionError(f'driver failed: {built.stderr.strip()}')
    return subprocess.run(['bash', str(script_path)], capture_output=True, text=True,
                          stdin=subprocess.DEVNULL, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})


def row_for(home: Path, invocation_id: str):
    path = home / 'invocations' / invocation_id / 'shadow.jsonl'
    if not path.exists():
        return None
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip():
            return json.loads(line)
    return None


def main() -> int:
    if not TRANSPORT.exists():
        print(f'skip: transport not found at {TRANSPORT} (set SWARM_TRANSPORT)')
        return 0
    if shutil.which('bun') is None:
        print('skip: bun not on PATH')
        return 0

    tmp = Path(tempfile.mkdtemp(prefix='wf-factory-'))
    try:
        home, roots, cwd = tmp / 'state', tmp / 'skills', tmp / 'work'
        cwd.mkdir(parents=True, exist_ok=True)
        build_catalog(roots)

        prompt = 'generate a product poster image for the launch'
        invocation_id = 'inv-abc123'
        run = run_transport_script(tmp, home, roots, cwd, invocation_id, prompt)
        check('transport script exits clean', 0, run.returncode)
        check('transport script prints nothing', '', run.stdout)

        row = None
        for _ in range(50):
            row = row_for(home, invocation_id)
            if row:
                break
            time.sleep(0.1)
        if row is None:
            check('shadow row written for the invocation', 'a row', 'no row')
            return report()
        check('row carries the invocation id', invocation_id, row.get('invocation_id'))
        check('row is shadow', 'shadow', row.get('mode'))
        check('row is labelled factory', 'factory', row.get('harness'))
        check('pick resolves to a real catalog path',
              str(roots / 'fal-media' / 'SKILL.md'), row.get('pick_path'))
        check('catalog loaded from the configured root', 3, row.get('catalog_size'))
        check('row records no prompt text', False, prompt in json.dumps(row))
        check('row records a prompt hash', 64, len(row.get('prompt_sha256') or ''))

        shared = home / 'suggestions.jsonl'
        check('factory rows stay out of the shared log', False, shared.exists())

        # Keeping factory rows out of suggestions.jsonl is what stops concurrent
        # detached rankings from interleaving, but it also hides them from
        # `report`. A report that cannot see the factory is a shadow log nobody
        # can learn from, so the per-invocation rows are folded back in here.
        subprocess.run([sys.executable, str(ENGINE), 'outcome', '--harness', 'factory',
                        '--session', 'task-1', '--pick', row['pick'], '--used', '1'],
                       capture_output=True, text=True,
                       env={**os.environ, 'WAYFINDER_HOME': str(home)})
        reported = json.loads(subprocess.run(
            [sys.executable, str(ENGINE), 'report'], capture_output=True, text=True,
            env={**os.environ, 'WAYFINDER_HOME': str(home)}).stdout)
        check('report counts the factory prompt', 1, reported['overall']['prompts'])
        check('report attributes it to factory', 1,
              reported['by_harness'].get('factory', {}).get('prompts'))
        check('report records no injection in shadow', 0, reported['overall']['injected'])
        check('report sees the adoption label', 1, reported['outcomes']['used'])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return report()


def report() -> int:
    print(f'{"FAILED" if failures else "ok"}: {len(failures)} failure(s)')
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
