"""Private, nonprivileged process tests; no harness/model/network invocation."""
import importlib.util
import copy
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('hermes_execution_supervisor', HERE / 'hermes-execution-supervisor.py')
supervisor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(supervisor)

# The driver is root-owned and explicitly synthetic. It invokes the actual
# journal/runner consumer with only the model transport replaced. Production
# execute_once has no such driver or callback parameter.
DRIVER = r'''
import { readSync,writeSync,appendFileSync } from "node:fs";
import { canonicalize } from REPLACE_CONTRACT;
const frame=()=>{let b=Buffer.alloc(1),s="";while(readSync(0,b,0,1,null)===1){if(b[0]===10)return JSON.parse(s);s+=b.toString();}throw Error("EOF");};
const send=x=>writeSync(1,canonicalize(x)+"\n");
const p=frame();
process.env.FACTORY_STATE_MODE="test";
process.env.FACTORY_STATE_DIR=p.workdir;
const {runHermesExecutionFixture}=await import(REPLACE_MODULE);
const result=await runHermesExecutionFixture(p,{
 now:()=>Date.now(),
 fence(stage,binding){send({schema:"hermes-execution-fence/v1",stage,binding});const grant=frame();if(grant.stage!==stage||grant.binding!==binding)throw Error("grant");},
 healthProbe:async()=>({healthy:true,message:"synthetic"}),
 harnessRun:async id=>{appendFileSync(p.workdir+"/launches",JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups()})+"\n");
   if(p.execution_id==="exec-uncertain")throw Error("synthetic transport loss");
   return {success:true,output:"synthetic output",durationMs:1,executorId:id};}
});
send({schema:"hermes-execution-terminal/v1",result});
'''


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'requires private root fixture')
class ExecutionSupervisorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The worker must not depend on traversing a CI runner's private home.
        # Bundle the actual consumer before dropping privileges, then execute
        # only the root-owned synthetic driver from this disposable directory.
        cls.bundle_temporary = tempfile.TemporaryDirectory(prefix='zo-task-hermes-execution-source-', dir='/tmp')
        cls.addClassCleanup(cls.bundle_temporary.cleanup)
        cls.bundle_root = Path(cls.bundle_temporary.name)
        cls.bundle_root.chmod(0o755)
        configured = os.environ.get('FACTORY_FIXTURE_BUN', '')
        if not configured or not Path(configured).is_absolute() or not Path(configured).is_file():
            raise AssertionError('absolute pinned fixture Bun required')
        cls.fixture_bun = cls.bundle_root / 'bun'
        shutil.copyfile(configured, cls.fixture_bun)
        cls.fixture_bun.chmod(0o755)
        inputs = {
            'driver': DRIVER.replace('REPLACE_MODULE', json.dumps(str(HERE / 'hermes-execution.ts')))
                .replace('REPLACE_CONTRACT', json.dumps(str(HERE / 'run-receipt-contract.ts'))),
            'initialize': 'import {writeFileSync} from "node:fs";import {OperationJournal} from '
                + json.dumps(str(HERE / 'run-operation-journal.ts'))
                + ';if(process.argv[3]==="reset")writeFileSync(process.argv[2],new Uint8Array());'
                + 'new OperationJournal(process.argv[2]).close();',
        }
        cls.bundles = {}
        for name, source in inputs.items():
            entry = cls.bundle_root / (name + '.ts')
            output = cls.bundle_root / (name + '.js')
            entry.write_text(source)
            compiled = subprocess.run([str(cls.fixture_bun), 'build', str(entry), '--target=bun', '--outfile', str(output)],
                capture_output=True, text=True, timeout=60)
            if compiled.returncode != 0:
                raise AssertionError(compiled.stderr)
            output.chmod(0o644)
            cls.bundles[name] = output.read_bytes()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='zo-task-hermes-execution-', dir='/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name); self.root.chmod(0o755)
        self.worker = self.root / 'worker'; self.worker.mkdir(); os.chown(self.worker, 1004, 1004); self.worker.chmod(0o700)
        self.home = self.root / 'home'; self.home.mkdir(); os.chown(self.home, 1004, 1004); self.home.chmod(0o700)
        configured = os.environ.get('FACTORY_FIXTURE_BUN', '')
        if not configured or not Path(configured).is_absolute() or not Path(configured).is_file():
            self.fail('absolute pinned fixture Bun required')
        self.bun = self.root / 'bun'; shutil.copyfile(configured, self.bun); self.bun.chmod(0o755)
        self.source = self.root / 'source'; child = self.source / supervisor.CHILD; child.parent.mkdir(parents=True)
        for directory in (child.parent, *child.parent.parents):
            if directory == self.root:
                break
            directory.chmod(0o755)
        child.write_bytes(self.bundles['driver'])
        child.chmod(0o644)
        initialize = self.root / 'initialize.js'
        initialize.write_bytes(self.bundles['initialize'])
        initialize.chmod(0o644)
        self.journal = self.worker / 'execution.sqlite'
        def drop():
            os.setgroups([]); os.setgid(1004); os.setuid(1004)
        initialized = subprocess.run([str(self.bun), str(initialize), str(self.journal)], check=False,
            cwd=self.root, timeout=10, preexec_fn=drop,
            env={'PATH': '/usr/bin:/bin', 'FACTORY_STATE_MODE': 'test', 'FACTORY_STATE_DIR': str(self.worker)},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.assertEqual(initialized.returncode, 0, initialized.stderr.decode('utf-8', errors='replace'))
        digest = lambda value: supervisor.publisher.digest(supervisor.publisher.canonical(value))
        now = supervisor._now()
        work_id = 'fw_' + supervisor.publisher.digest(b'hermes\0software-factory\0task-one')
        work = dict(schema='factory-work/v1', factory_work_id=work_id, source='hermes',
            external_references={'hermes_board': 'software-factory', 'hermes_task_id': 'task-one'},
            title='Synthetic process', description='one bounded task', source_status='ready', dispatch_eligible=False)
        receipt = dict(schema='factory-claim-receipt/v2', transition='acquire', request_id='one',
            key='fc2_' + supervisor.publisher.digest(('factory-claim-subject/v2\0hermes\0' + work_id).encode()),
            provider='hermes', factory_work_id=work_id, generation=1, owner='fixture',
            reader_admission_proof={'schema': 'factory-reader-admission-proof/v1', 'opaque_sha256': 'b'*64},
            lease_started_ms=now, lease_expires_ms=now+60_000, requested_lease_ms=60_000, transition_sequence=1, recorded_at_ms=now)
        retained = dict(schema='held-claim-selected-work/v1', work=work, work_sha256=digest(work), authority_artifact_sha256='c'*64,
            reader_proof_sha256='b'*64, claim_receipt_sha256=digest(receipt), snapshot_sha256='d'*64,
            receipt_sha256='e'*64, board_identity_sha256='f'*64, high_water_sha256='1'*64, claim_eligible=False, dispatch_eligible=False)
        st = self.journal.stat()
        self.plan = dict(source_head='a'*40, execution_id='exec-process', worker_uid=1004, worker_gid=1004,
            journal_path=str(self.journal), journal_identity=[st.st_dev, st.st_ino], workdir=str(self.worker), home=str(self.home),
            state_root=str(self.worker), source_root=str(self.source), bun={'path': str(self.bun), 'sha256': supervisor.publisher.digest(self.bun.read_bytes())},
            harness='codex', model='gpt-6-astra', timeout_ms=1000, approved_at_ms=now-1000, expires_at_ms=now+60_000)
        self.packet = supervisor._packet(self.plan, 'a'*64, {'receipt': receipt, 'retained_work': retained})
        self.issuer = self.root / 'issuer'; self.issuer.mkdir(mode=0o700)

    def test_separate_uid_actual_journal_runner_and_restart_without_launch(self):
        phases = []
        result = supervisor._run_child(self.plan, self.packet, phases.append)
        self.assertEqual(phases, ['reserve', 'launch'])
        self.assertEqual(result['status'], 'held')
        launched = (self.worker / 'launches').read_text().splitlines()
        self.assertEqual([json.loads(line) for line in launched], [{'uid': 1004, 'gid': 1004, 'groups': []}])
        phases.clear()
        replay = supervisor._run_child(self.plan, self.packet, phases.append)
        self.assertEqual(replay, dict(result, replay=True))
        self.assertEqual(phases, [])
        self.assertEqual((self.worker / 'launches').read_text().splitlines(), launched)

    def test_fence_denial_after_dispatch_reservation_never_calls_harness(self):
        def fence(stage):
            if stage == 'launch':
                raise ValueError('synthetic revocation')
        with self.assertRaisesRegex(ValueError, 'revocation'):
            supervisor._run_child(self.plan, self.packet, fence)
        self.assertFalse((self.worker / 'launches').exists())
        replay = supervisor._run_child(self.plan, self.packet, lambda _: self.fail('no replacement'))
        self.assertTrue(replay['replay'])
        self.assertIsNone(replay['receipt_sha256'])

    def test_uncertain_terminal_receipt_exact_restart(self):
        self.plan['execution_id'] = self.packet['execution_id'] = 'exec-uncertain'
        first = supervisor._run_child(self.plan, self.packet, lambda _: None)
        self.assertIsNotNone(first['receipt_sha256'])
        second = supervisor._run_child(self.plan, self.packet, lambda _: self.fail('no second launch'))
        self.assertEqual(second, dict(first, replay=True))
        self.assertEqual(len((self.worker / 'launches').read_text().splitlines()), 1)

    def test_production_entrypoint_rejects_fixture_mode_before_authority_access(self):
        saved = os.environ.get('FACTORY_STATE_MODE'); os.environ['FACTORY_STATE_MODE'] = 'test'
        try:
            with self.assertRaisesRegex(ValueError, 'production execution supervisor identity'):
                supervisor.execute_once(approved_execution_sha256='a'*64)
        finally:
            if saved is None:
                os.environ.pop('FACTORY_STATE_MODE', None)
            else:
                os.environ['FACTORY_STATE_MODE'] = saved

    def test_actual_signed_reader_artifact_reauthenticates_for_consumer(self):
        # Reuse the actual separate-reader/key/claim namespace fixture. This
        # runs the new read-only consumer while the original issuer context is
        # still owned; no fabricated boolean stands in for root authority.
        from test_held_coordinator import connected_scenario
        original = supervisor.claims._commit
        reentrant = [False]
        def commit(*args, **kwargs):
            result = original(*args, **kwargs)
            if kwargs.get('journal') is not None and not reentrant[0]:
                reentrant[0] = True
                try:
                    live = args[0]
                    retained = result['retained_work']
                    plan = {key: retained[key] for key in ('claim_receipt_sha256', 'authority_artifact_sha256')}
                    observed = supervisor._retained(live.authority, live, live.config, plan)
                    if observed != {key: result[key] for key in ('receipt', 'retained_work')}:
                        raise ValueError('consumer changed retained claim')
                    bad = dict(plan, authority_artifact_sha256='0'*64)
                    try:
                        supervisor._retained(live.authority, live, live.config, bad)
                    except ValueError as error:
                        if str(error) != 'execution independently selected claim mismatch':
                            raise
                    else:
                        raise ValueError('consumer accepted wrong artifact')
                finally:
                    reentrant[0] = False
            return result
        with patch.object(supervisor.claims, '_commit', commit):
            connected_scenario('success')

    def test_subscription_status_is_nonprivileged_clean_and_rejects_api_auth(self):
        binary = self.root / 'fake-native'
        self.plan['harness_executable'] = {'path': str(binary), 'sha256': 'a'*64}
        recorded = self.worker / 'status-uid'
        def install(stdout):
            binary.write_text('#!/bin/sh\n[ -z "${OPENAI_API_KEY+x}" ] || exit 8\n'
                + '/usr/bin/id -u > ' + str(recorded) + '\n'
                + 'printf \'%s\\n\' \'' + stdout + '\'\n')
            binary.chmod(0o755)
        install('Logged in using ChatGPT')
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'synthetic-must-not-inherit'}):
            supervisor._subscription(self.plan)
        self.assertEqual(recorded.read_text().strip(), '1004')
        install('Logged in using an API key')
        with self.assertRaisesRegex(ValueError, 'ChatGPT subscription required'):
            supervisor._subscription(self.plan)
        self.plan['harness'] = 'claude-code'
        install('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}')
        supervisor._subscription(self.plan)
        install('{"loggedIn":true,"authMethod":"api-key","apiProvider":"firstParty"}')
        with self.assertRaisesRegex(ValueError, 'Claude subscription required'):
            supervisor._subscription(self.plan)

    def test_exact_plan_pin_and_identity_fields_fail_closed(self):
        child = self.source / supervisor.CHILD
        value = dict(self.plan, schema='hermes-contained-execution-plan/v1', coordinator_sha256='b'*64,
            source_files=[{'path': supervisor.CHILD, 'sha256': supervisor.publisher.digest(child.read_bytes())}],
            source_links=[], runtime_attestation={'path': '/opt/qualified/runtime-attestation.json', 'sha256': 'a'*64},
            profile_files=[{'path': 'auth-only', 'sha256': 'a'*64}],
            harness_executable={'path': '/opt/qualified/codex', 'sha256': 'a'*64},
            claim_receipt_sha256='c'*64, authority_artifact_sha256='d'*64, subscriptions_only=True, maximum_launches=1)
        raw = supervisor.publisher.canonical(value)
        self.assertEqual(supervisor._config(raw, supervisor.publisher.digest(raw)), value)
        for key, bad in [('worker_uid', 0), ('maximum_launches', 2), ('subscriptions_only', False),
                         ('model', 'model;command'), ('coordinator_sha256', 'invalid')]:
            with self.subTest(key=key):
                edited = supervisor.publisher.canonical(dict(value, **{key: bad}))
                with self.assertRaises(ValueError):
                    supervisor._config(edited, supervisor.publisher.digest(edited))
        with self.assertRaises(ValueError):
            supervisor._config(raw, '0'*64)

    def test_root_journal_identity_check_does_not_open_or_create_worker_wal(self):
        before = sorted(path.name for path in self.worker.iterdir())
        supervisor._journal_identity(self.plan)
        self.assertEqual(sorted(path.name for path in self.worker.iterdir()), before)
        self.assertFalse(Path(str(self.journal) + '-wal').exists())
        self.assertFalse(Path(str(self.journal) + '-shm').exists())
        with self.assertRaises(ValueError):
            supervisor._journal_identity(dict(self.plan, journal_identity=[0, 0]))

    def test_nonreading_unprivileged_child_has_bounded_large_packet_send(self):
        child_path = self.source / supervisor.CHILD
        child_path.write_text('import{writeFileSync}from"node:fs";writeFileSync('
            + json.dumps(str(self.worker / 'stalled-pid')) + ',String(process.pid));setInterval(()=>{},1000);')
        self.plan['timeout_ms'] = self.packet['timeout_ms'] = 1
        work = self.packet['claim']['retained_work']['work']
        work['description'] = 'x'*65_536
        self.packet['claim']['retained_work']['work_sha256'] = supervisor.publisher.digest(supervisor.publisher.canonical(work))
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, 'send timeout'):
            supervisor._run_child(self.plan, self.packet, lambda _: self.fail('nonreading child cannot fence'))
        self.assertLess(time.monotonic()-started, 18)
        pid = int((self.worker / 'stalled-pid').read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_complete_source_inventory_and_materialization_head_binding(self):
        source = self.source
        for name in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'executor-runner.ts'):
            (source / name).write_text('fixture '+name)
        files = sorted([{'path': str(path.relative_to(source)), 'sha256': supervisor.publisher.digest(path.read_bytes())}
                        for path in source.rglob('*') if path.is_file()], key=lambda item: item['path'])
        hashes = {item['path']: item['sha256'] for item in files}
        attestation = dict(version=1, candidate_root='/source', merge_commit='a'*40, merge_tree='b'*40, tracked_clean=True,
            install_flags=['--offline', '--frozen-lockfile', '--ignore-scripts'], dependency_link_count=0,
            package_json_sha256=hashes['package.json'], pnpm_lock_sha256=hashes['pnpm-lock.yaml'],
            pnpm_workspace_sha256=hashes['pnpm-workspace.yaml'], normalized_dependency_graph_sha256='c'*64, runtime_key_sha256='d'*64)
        raw = supervisor.publisher.canonical(attestation)
        (self.root / 'attestation.json').write_bytes(raw)
        plan = dict(source_root='/source', source_files=files, source_links=[], source_head='a'*40,
            runtime_attestation={'path': '/attestation.json', 'sha256': supervisor.publisher.digest(raw)})
        pid = os.fork()
        if pid == 0:
            try:
                os.chroot(self.root); os.chdir('/')
                supervisor._source_inventory(plan)
                for changed in (dict(plan, source_files=files[:-1]), dict(plan, source_head='0'*40)):
                    try:
                        supervisor._source_inventory(changed)
                    except ValueError:
                        pass
                    else:
                        os._exit(82)
                os._exit(0)
            except BaseException:
                os._exit(83)
        self.assertEqual(os.waitpid(pid, 0)[1], 0)

    def test_root_consumption_blocks_same_inode_worker_journal_reset(self):
        fd = os.open(self.issuer, os.O_RDONLY | os.O_DIRECTORY)
        try:
            cap = supervisor._RootCap(fd, self.packet)
            first = supervisor._run_child(self.plan, self.packet, cap.admit)
            self.assertFalse(first['replay'])
            original = (self.issuer / supervisor.CONSUMED).read_bytes()
            original_inode = self.journal.stat().st_ino
            # A tool-capable worker can recreate schema in the same inode.
            # Demonstrate that this does not regain the independent root cap.
            reset = subprocess.run([str(self.bun), str(self.root / 'initialize.js'), str(self.journal), 'reset'],
                check=False, cwd=self.root, timeout=10, preexec_fn=lambda: supervisor._drop(self.plan),
                env={'PATH': '/usr/bin:/bin', 'FACTORY_STATE_MODE': 'test', 'FACTORY_STATE_DIR': str(self.worker)},
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            self.assertEqual(reset.returncode, 0, reset.stderr.decode('utf-8', errors='replace'))
            self.assertEqual(self.journal.stat().st_ino, original_inode)
            replay_cap = supervisor._RootCap(fd, self.packet)
            with self.assertRaisesRegex(ValueError, 'recovery-only'):
                supervisor._run_child(self.plan, self.packet, replay_cap.admit)
            self.assertEqual(len((self.worker / 'launches').read_text().splitlines()), 1)
            self.assertEqual((self.issuer / supervisor.CONSUMED).read_bytes(), original)
        finally:
            os.close(fd)

    def test_cap_fsync_then_crash_before_child_reserve_burns_capacity(self):
        fd = os.open(self.issuer, os.O_RDONLY | os.O_DIRECTORY)
        try:
            pid = os.fork()
            if pid == 0:
                supervisor._RootCap(fd, self.packet).admit('reserve')
                os._exit(75)
            self.assertEqual(os.waitpid(pid, 0)[1], 75 << 8)
            cap = supervisor._RootCap(fd, self.packet)
            for phase in ('reserve', 'launch'):
                with self.assertRaises(ValueError):
                    cap.admit(phase)
            self.assertFalse((self.worker / 'launches').exists())
            self.assertIsNotNone(supervisor._cap_read(fd, self.packet))
        finally:
            os.close(fd)

    def test_cap_requires_file_and_directory_fsync_and_owned_single_launch(self):
        fd = os.open(self.issuer, os.O_RDONLY | os.O_DIRECTORY)
        try:
            actual = os.fsync; observed = []
            def sync(target):
                observed.append(('directory' if os.path.isdir('/proc/self/fd/' + str(target)) else 'file'))
                actual(target)
            with patch.object(supervisor.os, 'fsync', sync):
                cap = supervisor._RootCap(fd, self.packet); cap.admit('reserve')
            self.assertEqual(observed, ['file', 'directory'])
            cap.admit('launch')
            with self.assertRaises(ValueError):
                cap.admit('launch')
            edited = dict(self.packet, execution_id='exec-replacement')
            with self.assertRaisesRegex(ValueError, 'conflicting or uncertain'):
                supervisor._RootCap(fd, edited)
        finally:
            os.close(fd)

    def test_partial_or_symlinked_cap_never_reopens_capacity(self):
        fd = os.open(self.issuer, os.O_RDONLY | os.O_DIRECTORY)
        try:
            path = self.issuer / supervisor.CONSUMED
            path.write_bytes(b'{'); path.chmod(0o600)
            with self.assertRaises(ValueError):
                supervisor._RootCap(fd, self.packet)
            self.assertEqual(path.read_bytes(), b'{')
            # Fixture cleanup alone changes this deliberately broken case.
            path.unlink(); path.symlink_to(self.journal)
            with self.assertRaises(OSError):
                supervisor._RootCap(fd, self.packet)
            self.assertTrue(path.is_symlink())
        finally:
            os.close(fd)


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'root source inventory fixtures')
class ExecutionSourceInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='zo-task-source-inventory-', dir='/root')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'; self.source.mkdir()
        self.git_env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.root), 'LC_ALL': 'C',
                        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        def git(*args):
            return subprocess.run(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', *args],
                cwd=self.source, env=self.git_env, check=True, capture_output=True, timeout=5).stdout
        self.git = git
        (self.source / 'package.json').write_bytes(b'{"private":true}')
        (self.source / 'pnpm-lock.yaml').write_bytes(b"lockfileVersion: '6.0'\n")
        self.workspace = b"packages:\n  - 'packages/*'\n  - 'cli'\n  - 'plugins/*'\n  - 'tui'\n  - 'Projects/software-template-library'\n"
        (self.source / 'pnpm-workspace.yaml').write_bytes(self.workspace)
        for name, (target, _) in supervisor.INERT_SOURCE_ALIASES.items():
            link = self.source / name; link.parent.mkdir(parents=True, exist_ok=True); link.symlink_to(target)
        (self.source / 'packages/pkg').mkdir(parents=True)
        (self.source / 'packages/pkg/package.json').write_bytes(b'{"name":"fixture"}')
        (self.source / 'node_modules').mkdir()
        (self.source / 'node_modules/pkg').symlink_to('../packages/pkg')
        git('init', '--quiet', '--template=', '.')
        git('add', '.')
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'actual Git source records')
        first = git('rev-parse', 'HEAD').decode().strip()
        git('update-index', '--add', '--cacheinfo', '160000,'+first+',legacy-submodule')
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'uninitialized gitlink')
        self.gitlink = self.source / 'legacy-submodule'; self.gitlink.mkdir()
        head = git('rev-parse', 'HEAD').decode().strip()
        self.records = {}
        for record in git('ls-tree', '-rz', '--full-tree', head).decode().split('\0'):
            if record:
                header, name = record.split('\t', 1); self.records[name] = header.split(' ')
        files, links = [], []
        for current, directories, filenames in os.walk(self.source, followlinks=False):
            if Path(current) == self.source: directories.remove('.git')
            for name in [*directories, *filenames]:
                path = Path(current) / name; relative = str(path.relative_to(self.source))
                if path.is_symlink(): links.append({'path': relative, 'target': os.readlink(path)})
                elif name in filenames: files.append({'path': relative, 'sha256': supervisor.publisher.digest(path.read_bytes())})
        files.sort(key=lambda item: item['path']); links.sort(key=lambda item: item['path'])
        pins = {item['path']: item['sha256'] for item in files}
        self.attestation = dict(version=1, candidate_root=str(self.source), merge_commit=head,
            merge_tree=git('rev-parse', 'HEAD^{tree}').decode().strip(), tracked_clean=True,
            install_flags=['--offline', '--frozen-lockfile', '--ignore-scripts'], dependency_link_count=len(links),
            package_json_sha256=pins['package.json'], pnpm_lock_sha256=pins['pnpm-lock.yaml'],
            pnpm_workspace_sha256=pins['pnpm-workspace.yaml'], normalized_dependency_graph_sha256='c'*64,
            runtime_key_sha256='d'*64)
        self.plan = dict(source_root=str(self.source), source_files=files, source_links=links, source_head=head)
        self.write_attestation()

    def write_attestation(self):
        path = self.root / 'attestation.json'; raw = supervisor.publisher.canonical(self.attestation)
        path.write_bytes(raw)
        self.plan['runtime_attestation'] = {'path': str(path), 'sha256': supervisor.publisher.digest(raw)}

    def test_actual_git_records_feed_complete_inventory_without_dereferencing_inert_aliases(self):
        for name, (target, blob) in supervisor.INERT_SOURCE_ALIASES.items():
            self.assertEqual(self.records[name], ['120000', 'blob', blob])
            self.assertEqual(supervisor._git_blob(target.encode()), blob)
        self.assertEqual(self.records['legacy-submodule'][0], '160000')
        self.assertEqual(supervisor._git_blob(self.workspace), supervisor.INERT_ALIAS_WORKSPACE_BLOB)
        self.assertEqual(self.attestation['dependency_link_count'], 6)
        real_resolve, real_scandir = Path.resolve, os.scandir
        inert = {self.source / name for name in supervisor.INERT_SOURCE_ALIASES}
        inspected, resolved = set(), set()
        def resolve(path, *args, **kwargs):
            if path in inert: raise AssertionError('inert target was dereferenced')
            resolved.add(path)
            return real_resolve(path, *args, **kwargs)
        class GuardedEntry:
            def __init__(entry_self, entry): entry_self.entry = entry
            def __getattr__(entry_self, name): return getattr(entry_self.entry, name)
            def check(entry_self, follow_symlinks):
                path = Path(entry_self.entry.path)
                if path in inert and follow_symlinks:
                    raise AssertionError('inert target metadata was followed')
                if path in inert: inspected.add(path)
            def stat(entry_self, *, follow_symlinks=True):
                if Path(entry_self.entry.path) == self.source / '.git':
                    raise AssertionError('root Git metadata was inspected')
                entry_self.check(follow_symlinks)
                return entry_self.entry.stat(follow_symlinks=follow_symlinks)
            def is_dir(entry_self, *, follow_symlinks=True):
                entry_self.check(follow_symlinks)
                return entry_self.entry.is_dir(follow_symlinks=follow_symlinks)
            def is_file(entry_self, *, follow_symlinks=True):
                entry_self.check(follow_symlinks)
                return entry_self.entry.is_file(follow_symlinks=follow_symlinks)
        class GuardedScan:
            def __init__(scan_self, path): scan_self.entries = real_scandir(path)
            def __enter__(scan_self): return scan_self
            def __exit__(scan_self, *args): return scan_self.entries.__exit__(*args)
            def __iter__(scan_self): return scan_self
            def __next__(scan_self): return GuardedEntry(next(scan_self.entries))
        with patch.object(Path, 'resolve', resolve), patch.object(os, 'scandir', GuardedScan):
            supervisor._source_inventory(self.plan)
        self.assertEqual(inspected, inert)
        self.assertIn(self.source / 'node_modules/pkg', resolved)

    def test_inert_alias_target_mode_owner_and_independent_inventory_changes_fail(self):
        for name in ('evaluations/bench', 'AVATAR-USER.md'):
            link = self.source / name
            original = os.readlink(link)
            link.unlink(); link.symlink_to('/tmp/unreviewed')
            with self.assertRaisesRegex(ValueError, 'inert source'): supervisor._source_inventory(self.plan)
            link.unlink(); link.write_bytes(original.encode())
            with self.assertRaisesRegex(ValueError, 'incomplete inventory'): supervisor._source_inventory(self.plan)
            link.unlink(); link.symlink_to(original)
            os.chown(link, 65534, 65534, follow_symlinks=False)
            with self.assertRaisesRegex(ValueError, 'inert source'): supervisor._source_inventory(self.plan)
            os.chown(link, 0, 0, follow_symlinks=False)
            changed = copy.deepcopy(self.plan); changed['source_links'] = [item for item in changed['source_links'] if item['path'] != name]
            with self.assertRaisesRegex(ValueError, 'inert source'): supervisor._source_inventory(changed)
        foreign = self.source / 'evaluations/unknown'; foreign.symlink_to('/root')
        with self.assertRaisesRegex(ValueError, 'external dependency'): supervisor._source_inventory(self.plan)
        foreign.unlink()
        supervisor._source_inventory(self.plan)

    def test_workspace_commit_and_complete_link_count_bind_the_prior_attestation(self):
        workspace = self.source / 'pnpm-workspace.yaml'; workspace.write_bytes(b"packages:\n  - '**'\n")
        changed_pin = supervisor.publisher.digest(workspace.read_bytes())
        for item in self.plan['source_files']:
            if item['path'] == 'pnpm-workspace.yaml': item['sha256'] = changed_pin
        self.attestation['pnpm_workspace_sha256'] = changed_pin; self.write_attestation()
        with self.assertRaisesRegex(ValueError, 'inert workspace'): supervisor._source_inventory(self.plan)
        workspace.write_bytes(self.workspace)
        for item in self.plan['source_files']:
            if item['path'] == 'pnpm-workspace.yaml': item['sha256'] = supervisor.publisher.digest(self.workspace)
        self.attestation['pnpm_workspace_sha256'] = supervisor.publisher.digest(self.workspace)
        saved = dict(self.attestation)
        for key, value in [('dependency_link_count', 4), ('merge_commit', 'f'*40), ('tracked_clean', False)]:
            self.attestation = dict(saved, **{key:value}); self.write_attestation()
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'materialization binding'):
                supervisor._source_inventory(self.plan)
        self.attestation = saved; self.write_attestation()
        supervisor._source_inventory(self.plan)

    def test_populated_gitlink_and_mutable_directory_fail_complete_runtime_inventory(self):
        addition = self.gitlink / 'unapproved'; addition.write_bytes(b'extra'); addition.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'incomplete inventory'): supervisor._source_inventory(self.plan)
        addition.unlink(); addition.symlink_to('../packages/pkg')
        with self.assertRaisesRegex(ValueError, 'incomplete inventory'): supervisor._source_inventory(self.plan)
        addition.unlink()
        self.gitlink.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'directory ownership'): supervisor._source_inventory(self.plan)
        self.gitlink.chmod(0o755); os.chown(self.gitlink, 65534, 65534)
        with self.assertRaisesRegex(ValueError, 'directory ownership'): supervisor._source_inventory(self.plan)
        os.chown(self.gitlink, 0, 65534)
        with self.assertRaisesRegex(ValueError, 'directory ownership'): supervisor._source_inventory(self.plan)
        os.chown(self.gitlink, 0, 0)
        supervisor._source_inventory(self.plan)


class ExecutionAuthorityFreshnessTests(unittest.TestCase):
    """Real authority expiry checks with a clock-driven slow inventory, no I/O."""
    def exercise(self, *, remote_delay=1, bad_remote_at=None, expires=600_000, rollback=False):
        clock = [100_000]
        observations, grants, entered = [], [], [False]
        plan = {'coordinator_sha256': 'b'*64, 'approved_at_ms': 1_000,
                'expires_at_ms': expires, 'timeout_ms': 5_000}
        config = {'bootstrap': {}, 'approved_at_ms': 1_000, 'expires_at_ms': expires,
                  'witness_max_age_ms': 10_000, 'root_inputs_sha256': 'c'*64,
                  'reader_inputs_sha256': 'd'*64}
        high = {'issuer_epoch': 1, 'board_generation': 1, 'db_generation': 1}
        raw_high = supervisor.publisher.canonical(high)
        class Authority:
            issuer_fd = 123
            high_raw = raw_high
            pins = {'approved_publication_core_sha256': 'e'*64}
            def recheck(inner):
                if not entered[0]: raise AssertionError('issuer authority lock lost')
            check_local_publication = recheck
            check_lineage = recheck
            measure_stopped = recheck
            def observe_genesis(inner):
                inner.recheck()
                clock[0] += remote_delay
                observations.append(clock[0])
                record = dict(high)
                if len(observations) == bad_remote_at: record['issuer_epoch'] = 2
                return SimpleNamespace(record_raw=supervisor.publisher.canonical({
                    'high_water': record, 'publication_sha256': 'e'*64}))
        authority = Authority()
        authority.high = SimpleNamespace(**high)
        @contextmanager
        def locked(**kwargs):
            self.assertEqual(kwargs, {'coordinated': True})
            entered[0] = True
            try: yield authority
            finally: entered[0] = False
        @contextmanager
        def roots(): yield (123, None, None)
        scans = [0]
        def inventory(_):
            scans[0] += 1
            clock[0] += -100 if rollback and scans[0] == 3 else 20_000
        claim = {'receipt': {'lease_expires_ms': expires}, 'retained_work': {}}
        def retained(owned, live, cfg, selected):
            self.assertIs(owned, authority)
            self.assertIs(live.authority, authority)
            self.assertIs(cfg, config)
            self.assertIs(selected, plan)
            live.inspect()  # Actual coordinator freshness/publication checks.
            return claim
        def child(selected, packet, fence):
            self.assertTrue(entered[0])
            fence('reserve')
            fence('launch')
            return 'synthetic terminal'
        root_inputs = SimpleNamespace(raw_sha256='c'*64, minimum_epoch=1,
                                      minimum_board_generation=1, minimum_db_generation=1)
        reader_inputs = SimpleNamespace(raw_sha256='d'*64)
        self.observations, self.grants = observations, grants
        with ExitStack() as stack:
            def mocked(obj, name, **kwargs): stack.enter_context(patch.object(obj, name, **kwargs))
            stack.enter_context(patch.dict(os.environ, {'FACTORY_STATE_MODE':'production'}))
            mocked(os, 'geteuid', return_value=0); mocked(os, 'getegid', return_value=0)
            mocked(supervisor.time, 'monotonic', side_effect=lambda: clock[0]/1000)
            mocked(supervisor.time, 'time_ns', side_effect=lambda: clock[0]*1_000_000)
            mocked(supervisor.publisher, '_locked_roots', side_effect=roots)
            mocked(supervisor.publisher, '_read', return_value=b'fixed')
            mocked(supervisor, '_config', return_value=plan)
            mocked(supervisor.coordinator, '_config', return_value=config)
            mocked(supervisor, 'locked_bootstrap_authority', side_effect=locked)
            mocked(supervisor, '_installation', side_effect=inventory)
            mocked(supervisor, '_subscription', return_value=None)
            mocked(supervisor, '_retained', side_effect=retained)
            mocked(supervisor, '_packet', return_value={})
            mocked(supervisor, '_RootCap', return_value=SimpleNamespace(admit=grants.append))
            mocked(supervisor, '_run_child', side_effect=child)
            mocked(supervisor.coordinator._LiveAuthority, 'files', return_value=None)
            mocked(supervisor.coordinator, 'load_root_peer_inputs', return_value=root_inputs)
            mocked(supervisor.coordinator, 'load_reader_command_inputs_for_root', return_value=reader_inputs)
            mocked(supervisor.coordinator, 'compare_root_reader_declarations', return_value=None)
            result = supervisor.execute_once(approved_execution_sha256='a'*64)
        self.assertFalse(entered[0])
        return result

    def test_slow_inventories_obtain_fresh_authority_before_each_grant(self):
        self.assertEqual(self.exercise(), 'synthetic terminal')
        self.assertEqual(self.grants, ['reserve', 'launch'])
        self.assertEqual(len(self.observations), 3)
        self.assertGreater(self.observations[-1]-self.observations[0], 40_000)

    def test_remote_read_itself_cannot_exceed_existing_witness_age(self):
        with self.assertRaisesRegex(ValueError, 'authority expired'):
            self.exercise(remote_delay=10_001)
        self.assertEqual(self.grants, [])

    def test_changed_floor_before_launch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'fresh floor publication mismatch'):
            self.exercise(bad_remote_at=3)
        self.assertEqual(self.grants, ['reserve'])

    def test_new_witness_does_not_extend_original_expiry(self):
        with self.assertRaisesRegex(ValueError, 'authority expired'):
            self.exercise(expires=170_000)
        self.assertEqual(self.grants, ['reserve'])

    def test_clock_rollback_during_inventory_still_denies_grant(self):
        with self.assertRaisesRegex(ValueError, 'approval/claim lifetime'):
            self.exercise(rollback=True)
        self.assertEqual(self.grants, [])


if __name__ == '__main__':
    unittest.main()
