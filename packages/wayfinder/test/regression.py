import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'engine'))
import local_rank


class Regression(unittest.TestCase):
    def test_missing_model_never_downloads(self):
        from flashrank import Ranker
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'FLASHRANK_CACHE_DIR': tmp}):
            local_rank._ranker = None
            with patch.object(Ranker, '_download_model_files', side_effect=AssertionError('network attempted')) as download:
                with self.assertRaises(FileNotFoundError):
                    local_rank.cross_scores('poster', ['make a poster'], [0])
                download.assert_not_called()

    def test_portable_plugins_and_quoted_install(self):
        with tempfile.TemporaryDirectory(prefix='zo-task-') as tmp:
            base = Path(tmp)
            repo = base / 'repo with spaces'
            shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns('.git', '__pycache__', 'assets'))
            home, project = base / 'home', base / 'project'
            home.mkdir()
            project.mkdir()
            engine = base / 'stub.py'
            engine.write_text('import sys; sys.stdin.read(); print("PORTABLE")')
            env = {**os.environ, 'HOME': str(home), 'WAYFINDER_HOME': str(base / 'state'),
                   'WAYFINDER_MODE': 'live', 'WAYFINDER_ENGINE': str(engine)}
            env.pop('WAYFINDER_HOOK', None)
            env.pop('WAYFINDER', None)
            install = subprocess.run(['bash', str(repo / 'scripts/install.sh'), '--project', str(project)],
                                     env=env, capture_output=True, text=True)
            self.assertEqual(install.returncode, 0, install.stderr)
            conf = json.loads((project / '.codex/hooks.json').read_text())
            command = conf['hooks']['UserPromptSubmit'][0]['hooks'][0]['command']
            self.assertEqual(shlex.split(command), ['bash', str(repo / 'scripts/wayfinder-hook.sh'), 'codex'])
            result = subprocess.run(shlex.split(command), input='{"prompt":"make a poster"}',
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.stdout, 'PORTABLE')
            import tomllib
            toml = tomllib.loads((home / '.kimi-code/config.toml').read_text())
            self.assertEqual(shlex.split(toml['hooks'][0]['command'])[1], str(repo / 'scripts/wayfinder-hook.sh'))
            js = f'''
const {{ Wayfinder }} = await import({json.dumps((home / '.config/opencode/plugin/wayfinder.js').as_uri())});
const hooks = await Wayfinder({{directory: '/p'}});
const out = {{message: {{id: 'msg_test'}}, parts: [{{type:'text',text:'make a poster'}}]}};
await hooks['chat.message']({{sessionID:'session_test'}},out);
console.log(JSON.stringify(out.parts[1]));
'''
            out = subprocess.run(['node', '--input-type=module', '-e', js], env=env, capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            part = json.loads(out.stdout)
            self.assertEqual(part['text'], 'PORTABLE')
            self.assertEqual(part['sessionID'], 'session_test')
            self.assertEqual(part['messageID'], 'msg_test')
            self.assertTrue(part['id'].startswith('prt_'))
            code = f'''
import sys
sys.path.insert(0, {str(home / '.hermes/plugins')!r})
import wayfinder
print(wayfinder._pre_llm_call(user_message='make a poster')['context'])
'''
            out = subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(out.stdout.strip(), 'PORTABLE')


if __name__ == '__main__':
    unittest.main()
