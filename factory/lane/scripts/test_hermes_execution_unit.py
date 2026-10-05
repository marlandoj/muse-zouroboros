"""Exact unit policy and identity negatives; not an installed-manager claim."""
import copy
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import hermes_execution_unit as unit


def fixture():
    inputs = dict(schema='hermes-executor-unit/v1', execution_sha256='1'*64,
        source_root='/opt/zouroboros/software-factory/execution-runtime', wrapper_sha256='2'*64,
        supervisor_sha256='3'*64, python={'path': '/usr/bin/python3.13', 'sha256': '4'*64},
        systemctl={'path': '/usr/bin/systemctl', 'sha256': '5'*64},
        bwrap={'path':'/usr/bin/bwrap','sha256':'7'*64},
        python_runtime_files=[{'path': '/usr/lib/python3.13/os.py', 'sha256': '6'*64}], runtime_ms=300_000,managed_boundary={})
    plan = dict(source_root=inputs['source_root'], timeout_ms=120_000,
        home='/var/lib/zouroboros/factory-execution/home', state_root='/var/lib/zouroboros/factory-execution/state',
        workdir='/var/lib/zouroboros/factory-execution/work')
    return inputs, plan


def observation():
    return dict(Id=unit.UNIT, LoadState='loaded', ActiveState='active', SubState='running', MainPID='123', ControlPID='0',
        User='', Group='root', FragmentPath='/etc/systemd/system/'+unit.UNIT, DropInPaths='', SourcePath='',
        NeedDaemonReload='no', Transient='no', Delegate='no', KillMode='control-group', KillSignal='15', FinalKillSignal='9',
        SendSIGKILL='yes', Restart='no', Type='exec', RemainAfterExit='no', RuntimeMaxUSec='5min', TimeoutStopUSec='3s',
        NoNewPrivileges='yes', ProtectControlGroups='yes', ProtectSystem='strict', PrivateUsers='no', RestrictNamespaces='ipc mnt pid user uts',
        ProtectKernelTunables='no', ProtectKernelLogs='no', ProtectKernelModules='yes', PrivateDevices='yes',
        BindReadOnlyPaths='/sys:/sys:rbind', SystemCallFilter='~syslog',
        TasksMax='256', MemoryMax='12884901888', ControlGroup='/system.slice/'+unit.UNIT, InvocationID='a'*32)


class ExecutorUnitTests(unittest.TestCase):
    def test_public_worker_projection_must_match_independent_core_and_plan(self):
        inputs,plan=fixture();root=inputs['source_root'];native=root+'/node_modules/.factory-native/bin/'
        pin=lambda path:{'path':path,'sha256':'a'*64}
        plan.update(source_head='b'*40,worker_uid=1004,worker_gid=1004,harness='codex',model='gpt-5.4',
            approved_at_ms=1000,expires_at_ms=301000,bun=pin('/opt/factory/bun'),
            profile_files=[{'path':'.codex/auth.json','sha256':'c'*64}],harness_executable=pin(native+'codex'))
        core={key:plan[key] for key in ('source_root','source_head','worker_uid','worker_gid','workdir','home','state_root',
            'harness','model','timeout_ms','approved_at_ms','expires_at_ms','profile_files','bun')}
        core.update(schema='factory-managed-systemd-boundary/v1',execution_sha256=inputs['execution_sha256'],
            registry_sha256='d'*64,runtime_ms=inputs['runtime_ms'],adapter={**pin(native+'codex-acp-swarm'),'name':'codex-acp-swarm','args':[]},
            native=plan['harness_executable'],node=pin(native+'node'),**{key:inputs[key] for key in ('python','systemctl','bwrap')},
            runtime_files=[pin(name) for name in ('/usr/bin/nice','/usr/bin/taskset','/usr/lib/x86_64-linux-gnu/libc.so.6')])
        inputs['managed_boundary']=core
        plan['source_files']=[{'path':'packages/swarm/src/executor/registry/executor-registry.json','sha256':'d'*64}]+[
            {'path':str(Path(core[key]['path']).relative_to(root)),'sha256':core[key]['sha256']} for key in ('adapter','native','node')]
        digest='e'*64
        expected=unit.canonical({**core,'unit_inputs_sha256':digest,'unit_fragment_sha256':hashlib.sha256(unit.unit_fragment(inputs,plan,digest)).hexdigest()})
        def read(path,**kwargs):return expected if str(path)==unit.BOUNDARY else b'qualified by fake read callback'
        with patch.object(unit,'_read',side_effect=read):
            self.assertEqual(unit._boundary(inputs,plan,digest),expected)
            for key,value in [('model','unapproved'),('worker_uid',999),('source_head','f'*40),('harness','claude-code')]:
                changed=copy.deepcopy(inputs);changed['managed_boundary'][key]=value
                with self.subTest(key=key),self.assertRaisesRegex(ValueError,'core/plan'):
                    unit._boundary(changed,plan,digest)
            bad=copy.deepcopy(inputs);bad['managed_boundary']['adapter']['args']=['--fallback']
            with self.assertRaisesRegex(ValueError,'ACP invocation'):unit._boundary(bad,plan,digest)
            bad=copy.deepcopy(plan);bad['source_files'][1]['sha256']='f'*64
            with self.assertRaisesRegex(ValueError,'materialization'):unit._boundary(inputs,bad,digest)
        with patch.object(unit,'_read',return_value=b'{}'),self.assertRaisesRegex(ValueError,'public projection'):
            unit._boundary(inputs,plan,digest)
        resolved=copy.deepcopy(inputs)
        resolved['managed_boundary']['runtime_files']=sorted([
            pin(native+'nice') if item['path']=='/usr/bin/nice' else item
            for item in core['runtime_files']],key=lambda item:item['path'])
        expected=unit.canonical({**resolved['managed_boundary'],'unit_inputs_sha256':digest,
            'unit_fragment_sha256':hashlib.sha256(unit.unit_fragment(resolved,plan,digest)).hexdigest()})
        with patch.object(unit,'_read',side_effect=read):
            with self.assertRaisesRegex(ValueError,'staged nice source binding'):unit._boundary(resolved,plan,digest)
            plan['source_files'].append({'path':str(Path(native+'nice').relative_to(root)),'sha256':'a'*64})
            self.assertEqual(unit._boundary(resolved,plan,digest),expected)
            resolved['managed_boundary']['runtime_files'].insert(0,pin('/usr/bin/nice'))
            with self.assertRaisesRegex(ValueError,'runtime closure'):unit._boundary(resolved,plan,digest)

    def test_canonical_independent_plan_and_exact_handoff(self):
        inputs, plan = fixture(); raw = unit.canonical(inputs); pin = hashlib.sha256(raw).hexdigest()
        self.assertEqual(unit.parse_inputs(raw, pin), inputs)
        fragment = unit.unit_fragment(inputs, plan, pin).decode()
        self.assertIn('--approved-unit-inputs-sha256 '+pin, fragment)
        self.assertIn('KillMode=control-group\n', fragment)
        self.assertIn('Delegate=no\n', fragment)
        self.assertIn('RuntimeMaxSec=300\n', fragment)
        self.assertIn('RestrictNamespaces=user mnt pid uts ipc\n', fragment)
        self.assertNotIn('[Install]', fragment)
        self.assertNotIn('User=', fragment)
        self.assertIn('Group=root\n', fragment)
        self.assertNotIn('Restart=always', fragment)
        self.assertIn(unit.CAPS, fragment)
        for setting in ('ProtectKernelTunables=no', 'ProtectKernelLogs=no', 'ProtectKernelModules=yes',
                        'PrivateDevices=yes', 'BindReadOnlyPaths=/sys', 'SystemCallFilter=~syslog'):
            self.assertIn(setting+'\n', fragment)

    def test_actual_root_capabilities_required_even_with_implicit_user(self):
        good = b'Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t\nNoNewPrivs:\t1\n' + b''.join(
            key+b':\t00000000000800e4\n' for key in (b'CapPrm',b'CapEff',b'CapBnd')) + b'CapInh:\t0000000000000000\nCapAmb:\t0000000000000000\n'
        unit.validate_root_status(good)
        for old, new in [(b'CapEff:\t00000000000800e4',b'CapEff:\t0000000000080064'),
                         (b'Uid:\t0\t0\t0\t0',b'Uid:\t0\t999\t0\t0'),(b'Groups:\t\n',b'Groups:\t999\n'),
                         (b'CapAmb:\t0000000000000000',b'CapAmb:\t0000000000000080')]:
            with self.subTest(new=new), self.assertRaisesRegex(ValueError,'actual root'):
                unit.validate_root_status(good.replace(old,new))

    def test_ambiguous_inputs_paths_or_lifetimes_rejected(self):
        original, plan = fixture()
        for change in ({'runtime_ms': True}, {'runtime_ms': 299_999}, {'runtime_ms': 660_000},
                       {'source_root': '/opt/%i'}, {'source_root': '/opt/a/../b'}, {'unknown': 1},
                       {'python_runtime_files': []}, {'execution_sha256': 'invalid'}):
            with self.subTest(change=change):
                value = {**original, **change}; raw = unit.canonical(value)
                with self.assertRaises(ValueError):
                    unit.parse_inputs(raw, hashlib.sha256(raw).hexdigest())
        with self.assertRaises(ValueError):
            unit.parse_inputs(unit.canonical(original)+b'\n', hashlib.sha256(unit.canonical(original)+b'\n').hexdigest())
        for key, value in [('workdir', original['source_root']), ('state_root', '/opt'), ('home', plan['workdir']),
                           ('workdir',str(Path(plan['state_root']).parent)),('home',plan['workdir']+'/profile')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                unit.unit_fragment(original, {**plan, key:value}, 'a'*64)

    def test_every_effective_containment_or_identity_change_holds(self):
        inputs, _ = fixture(); good = observation(); cgroup = ('0::/system.slice/'+unit.UNIT+'\n').encode()
        self.assertEqual(unit.validate_observation(good, inputs, pid=123, cgroup=cgroup), 'a'*32)
        for name in good:
            with self.subTest(name=name), self.assertRaises(ValueError):
                unit.validate_observation({**good, name:'unexpected'}, inputs, pid=123, cgroup=cgroup)
        with self.assertRaises(ValueError):
            unit.validate_observation({**good, 'Future': 'ignored'}, inputs, pid=123, cgroup=cgroup)
        for actual in (b'0::/user.slice/fake.scope\n', b'0::/system.slice/'+unit.UNIT.encode()+b'/child\n', cgroup+b'1:name=systemd:/\n'):
            with self.subTest(actual=actual), self.assertRaises(ValueError):
                unit.validate_observation(good, inputs, pid=123, cgroup=actual)

    def test_duplicate_manager_values_and_fixture_entry_are_rejected(self):
        with self.assertRaises(ValueError):
            unit._loaded(b'Delegate=no\nDelegate=yes\n')
        with patch.dict(os.environ, {'FACTORY_STATE_MODE':'test'}), self.assertRaisesRegex(ValueError, 'production'):
            unit.run_installed(approved_unit_inputs_sha256='a'*64)

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'private root file tests')
    def test_read_rejects_mutable_ancestors_and_links(self):
        with tempfile.TemporaryDirectory(prefix='zo-task-executor-unit-',dir='/tmp') as temp:
            path = Path(temp)/'input'; path.write_bytes(b'pinned'); path.chmod(0o600)
            # /tmp itself is writable, so production enrollment cannot be here.
            with self.assertRaisesRegex(ValueError, 'root-controlled'):
                unit._read(path)

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'private root FIFO test')
    def test_fifo_rejects_without_blocking_and_ancestor_swap_rejects(self):
        with tempfile.TemporaryDirectory(prefix='zo-task-executor-unit-',dir='/root') as temp:
            root=Path(temp);fifo=root/'fifo';os.mkfifo(fifo,0o600)
            code='import hermes_execution_unit as u\ntry:u._read('+repr(str(fifo))+')\nexcept ValueError:raise SystemExit(0)\nraise SystemExit(1)'
            result=subprocess.run([sys.executable,'-B','-c',code],cwd=Path(__file__).resolve().parent,timeout=2)
            self.assertEqual(result.returncode,0)
            parent=root/'parent';parent.mkdir();(parent/'input').write_bytes(b'pinned')
            real_read=os.read;swapped=False
            def replace_parent(fd,size):
                nonlocal swapped
                block=real_read(fd,size)
                if block and not swapped:
                    parent.rename(root/'old-parent');parent.mkdir();(parent/'input').write_bytes(b'pinned');swapped=True
                return block
            with patch.object(os,'read',side_effect=replace_parent),self.assertRaisesRegex(ValueError,'ancestor changed'):
                unit._read(parent/'input')

    def test_python_closure_rejects_missing_actual_imports(self):
        inputs, _ = fixture()
        with patch.object(unit, '_read', return_value=b''):
            with self.assertRaisesRegex(ValueError, 'unpinned'):
                unit._python_runtime(inputs)

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'private root import-order fixtures')
    def test_project_dependencies_are_authenticated_before_import(self):
        with tempfile.TemporaryDirectory(prefix='zo-task-executor-import-',dir='/root') as temp:
            root=Path(temp);scripts=root/unit.RELATIVE;hermes=root/'Projects/zouroboros-software-factory/hermes'
            scripts.mkdir(parents=True);hermes.mkdir();marker=root/'imported'
            (root/unit.WRAPPER).write_bytes(b'# fixture wrapper\n')
            (root/unit.SUPERVISOR).write_text('from pathlib import Path\nPath('+repr(str(marker))+').write_text("imported")\n')
            dependency=hermes/'dependency.py';dependency.write_bytes(b'# authenticated before any import\n')
            records=sorted(({'path':str(p.relative_to(root)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in root.rglob('*.py')),key=lambda p:p['path'])
            plan={'schema':'hermes-contained-execution-plan/v1','source_root':str(root),'source_files':records}
            raw=unit.canonical(plan);inputs={'source_root':str(root),'execution_sha256':hashlib.sha256(raw).hexdigest(),
                'wrapper_sha256':hashlib.sha256((root/unit.WRAPPER).read_bytes()).hexdigest(),
                'supervisor_sha256':hashlib.sha256((root/unit.SUPERVISOR).read_bytes()).hexdigest()}
            dependency.write_bytes(b'# changed without repinning\n')
            with self.assertRaisesRegex(ValueError,'file pin'):
                unit._load_supervisor(inputs,raw)
            self.assertFalse(marker.exists())
            dependency.write_bytes(b'# authenticated before any import\n')
            extra=hermes/'extra.py';extra.write_bytes(b'# unlisted dependency\n')
            with self.assertRaisesRegex(ValueError,'incomplete Python'):
                unit._load_supervisor(inputs,raw)
            self.assertFalse(marker.exists());extra.unlink()
            for name in ('dependency.pyc','dependency.so'):
                extra=hermes/name;extra.write_bytes(b'unpinned import shadow')
                with self.assertRaisesRegex(ValueError,'incomplete Python'):
                    unit._load_supervisor(inputs,raw)
                self.assertFalse(marker.exists());extra.unlink()
            unit._load_supervisor(inputs,raw)
            self.assertEqual(marker.read_text(),'imported')

    @unittest.skipUnless(os.name == 'posix' and Path('/usr/bin/systemd-analyze').is_file(), 'systemd syntax verifier')
    def test_real_systemd_verifier_accepts_generated_fragment(self):
        inputs, plan = fixture(); inputs['python']['path']='/usr/bin/python3'
        with tempfile.TemporaryDirectory(prefix='zo-task-executor-unit-') as temp:
            path=Path(temp)/unit.UNIT
            path.write_bytes(unit.unit_fragment(inputs, plan, 'a'*64))
            completed=subprocess.run(['/usr/bin/systemd-analyze','verify','--man=no',str(path)],
                env={'PATH':'/usr/bin:/bin','LC_ALL':'C'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE,timeout=10)
            self.assertEqual(completed.returncode,0,completed.stderr.decode())


if __name__ == '__main__':
    unittest.main()
