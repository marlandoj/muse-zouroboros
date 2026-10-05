"""Exact installed systemd boundary for the contained execution supervisor.

The independent unit-input digest is an ExecStart argument. Its canonical unit
bytes bind that argument without a circular fragment hash. This module does not
install/start units, initialize journals, or authorize a successful result.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

UNIT = 'zouroboros-factory-execution.service'
ISSUER = '/etc/zouroboros/hermes-issuer'
INPUTS = ISSUER + '/execution-unit-inputs.json'
EXECUTION = ISSUER + '/execution-inputs.json'
BOUNDARY = '/etc/zouroboros-factory-executor-boundary.json'
RELATIVE = 'Projects/zouroboros-software-factory/scripts/'
WRAPPER = RELATIVE + 'hermes_execution_unit.py'
SUPERVISOR = RELATIVE + 'hermes-execution-supervisor.py'
HEX = re.compile('[a-f0-9]{64}\\Z')
SAFE_PATH = re.compile('/[A-Za-z0-9_./-]+\\Z')
CAPS = 'CAP_DAC_READ_SEARCH CAP_KILL CAP_SETGID CAP_SETUID CAP_SYS_PTRACE'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
LIMIT = 2_000_000


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def _path(value):
    if (type(value) is not str or SAFE_PATH.fullmatch(value) is None
            or str(Path(value)) != value or '..' in Path(value).parts):
        raise ValueError('executor unit absolute literal path')
    return value


def _read(path, *, expected=None, maximum=LIMIT):
    path = Path(_path(str(path)))
    directories = [os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)]
    names = path.parts[1:]
    fd = None
    try:
        for name in names[:-1]:
            directories.append(os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directories[-1]))
        def lineage():
            for index, directory in enumerate(directories):
                info = os.fstat(directory)
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                    raise ValueError('executor unit root-controlled path')
                if index:
                    named = os.stat(names[index-1], dir_fd=directories[index-1], follow_symlinks=False)
                    if (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid) != (named.st_dev, named.st_ino, named.st_mode, named.st_uid, named.st_gid):
                        raise ValueError('executor unit ancestor changed')
        lineage()
        fd = os.open(names[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directories[-1])
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022
                or before.st_nlink != 1 or before.st_size > maximum):
            raise ValueError('executor unit file shape')
        chunks, length = [], 0
        while chunk := os.read(fd, 65536):
            length += len(chunk)
            if length > maximum:
                raise ValueError('executor unit file bound')
            chunks.append(chunk)
        raw = b''.join(chunks)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns,
                              s.st_uid, s.st_gid, s.st_mode, s.st_nlink)
        if identity(before) != identity(os.fstat(fd)) or identity(before) != identity(os.stat(names[-1],dir_fd=directories[-1],follow_symlinks=False)):
            raise ValueError('executor unit changed file')
        lineage()
        if expected is not None and hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError('executor unit file pin')
        return raw
    finally:
        if fd is not None:
            os.close(fd)
        for directory in reversed(directories):
            os.close(directory)


def parse_inputs(raw, digest):
    if type(digest) is not str or HEX.fullmatch(digest) is None or hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('independent executor unit input digest')
    value = json.loads(raw)
    fields = {'schema', 'execution_sha256', 'source_root', 'wrapper_sha256', 'supervisor_sha256',
              'python', 'systemctl', 'bwrap', 'python_runtime_files', 'runtime_ms', 'managed_boundary'}
    if (type(value) is not dict or set(value) != fields or canonical(value) != raw
            or value['schema'] != 'hermes-executor-unit/v1'
            or any(type(value[k]) is not str or HEX.fullmatch(value[k]) is None
                   for k in ('execution_sha256', 'wrapper_sha256', 'supervisor_sha256'))
            or type(value['runtime_ms']) is not int or not 180_000 <= value['runtime_ms'] <= 600_000
            or value['runtime_ms'] % 60_000):
        raise ValueError('executor unit input shape')
    if type(value['managed_boundary']) is not dict:
        raise ValueError('executor managed boundary core')
    _path(value['source_root'])
    for key in ('python', 'systemctl', 'bwrap'):
        pin = value[key]
        if type(pin) is not dict or set(pin) != {'path', 'sha256'} or type(pin['sha256']) is not str or HEX.fullmatch(pin['sha256']) is None:
            raise ValueError('executor unit tool binding')
        _path(pin['path'])
    if value['bwrap']['path']!='/usr/bin/bwrap':
        raise ValueError('executor fixed filesystem boundary binary')
    files = value['python_runtime_files']
    if type(files) is not list or not 1 <= len(files) <= 2048:
        raise ValueError('executor Python runtime closure')
    names = []
    for item in files:
        if type(item) is not dict or set(item) != {'path', 'sha256'} or type(item['sha256']) is not str or HEX.fullmatch(item['sha256']) is None:
            raise ValueError('executor Python runtime file')
        names.append(_path(item['path']))
    if names != sorted(set(names)):
        raise ValueError('executor Python runtime inventory order')
    return value


def unit_fragment(inputs, plan, digest):
    """Reviewable exact fragment, with no [Install] or automatic retry."""
    root = _path(inputs['source_root'])
    if plan['source_root'] != root or plan['timeout_ms'] + 60_000 > inputs['runtime_ms']:
        raise ValueError('executor unit plan/lifetime binding')
    writable = [ISSUER, *[_path(plan[k]) for k in ('home', 'state_root', 'workdir')]]
    if (len(set(writable)) != 4 or any(Path(p).is_relative_to(root) or Path(root).is_relative_to(p) for p in writable)
            or any(Path(left).is_relative_to(right) or Path(right).is_relative_to(left)
                   for index,left in enumerate(writable) for right in writable[index+1:])):
        raise ValueError('executor unit mutable/runtime separation')
    lines = [
        '[Unit]', 'Description=Bounded standalone Factory execution', 'After=local-fs.target', '',
        # Default root preserves CAP_SETUID through systemd's NNP/seccomp setup.
        # An explicit User=root causes systemd 259 to remove that capability.
        '[Service]', 'Type=exec', 'Group=root', 'SupplementaryGroups=',
        'ExecStart=' + _path(inputs['python']['path']) + ' -I -S -B ' + root + '/' + WRAPPER +
            ' --approved-unit-inputs-sha256 ' + digest,
        'WorkingDirectory=' + root, 'Restart=no', 'RemainAfterExit=no',
        'RuntimeMaxSec=' + str(inputs['runtime_ms'] // 1000), 'TimeoutStartSec=15', 'TimeoutStopSec=3',
        'KillMode=control-group', 'KillSignal=SIGTERM', 'FinalKillSignal=SIGKILL', 'SendSIGKILL=yes',
        'Delegate=no', 'NoNewPrivileges=yes', 'ProtectControlGroups=yes',
        'RestrictNamespaces=user mnt pid uts ipc', 'ProtectSystem=strict', 'ProtectHome=yes',
        'PrivateTmp=yes', 'PrivateDevices=yes', 'PrivateUsers=no',
        # A masked outer proc prevents bwrap's nested PID proc mount. Only the
        # authenticated bootstrap runs here; bwrap protects its private proc
        # before executing the adapter. BindReadOnlyPaths overrides systemd's
        # ProtectSystem=strict implicit writable /sys exception.
        'ProtectKernelTunables=no', 'ProtectKernelModules=yes', 'ProtectKernelLogs=no',
        'BindReadOnlyPaths=/sys', 'SystemCallFilter=~syslog',
        'RestrictSUIDSGID=yes', 'LockPersonality=yes',
        'CapabilityBoundingSet=' + CAPS, 'AmbientCapabilities=',
        'ReadWritePaths=' + ' '.join(writable), 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
        'Environment=PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C', 'PassEnvironment=',
        'UnsetEnvironment=FACTORY_STATE_MODE PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH',
        'SetLoginEnvironment=no', 'UMask=0077', 'TasksMax=256', 'MemoryMax=12G',
        'LimitCORE=0', 'LimitNOFILE=1024', 'StandardInput=null', 'StandardOutput=journal', 'StandardError=journal', '']
    return '\n'.join(lines).encode()


def _loaded(raw):
    if type(raw) is not bytes or len(raw) > 32768:
        raise ValueError('executor unit observation bound')
    values = {}
    for line in raw.decode().splitlines():
        if '=' not in line:
            raise ValueError('executor unit observation shape')
        key, value = line.split('=', 1)
        if key in values:
            raise ValueError('executor unit duplicate property')
        values[key] = value
    return values


def validate_observation(values, inputs, *, pid, cgroup):
    expected = {
        'Id': UNIT, 'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running',
        'MainPID': str(pid), 'ControlPID': '0', 'User': '', 'Group': 'root',
        'FragmentPath': '/etc/systemd/system/' + UNIT, 'DropInPaths': '', 'SourcePath': '',
        'NeedDaemonReload': 'no', 'Transient': 'no', 'Delegate': 'no',
        'KillMode': 'control-group', 'KillSignal': '15', 'FinalKillSignal': '9', 'SendSIGKILL': 'yes',
        'Restart': 'no', 'Type': 'exec', 'RemainAfterExit': 'no',
        'RuntimeMaxUSec': str(inputs['runtime_ms'] * 1000), 'TimeoutStopUSec': '3000000',
        'NoNewPrivileges': 'yes', 'ProtectControlGroups': 'yes', 'ProtectSystem': 'strict',
        'ProtectKernelTunables': 'no', 'ProtectKernelLogs': 'no', 'ProtectKernelModules': 'yes',
        'PrivateDevices': 'yes', 'BindReadOnlyPaths': '/sys:/sys:rbind', 'SystemCallFilter': '~syslog',
        'PrivateUsers': 'no', 'RestrictNamespaces': 'ipc mnt pid user uts', 'TasksMax': '256', 'MemoryMax': '12884901888',
        'ControlGroup': '/system.slice/' + UNIT,
    }
    # `systemctl show --value` durations are human-formatted on supported hosts.
    for name, formatted in [('RuntimeMaxUSec', str(inputs['runtime_ms'] // 60_000) + 'min' if inputs['runtime_ms'] % 60_000 == 0 else None),
                            ('TimeoutStopUSec', '3s')]:
        if formatted is not None and values.get(name) == formatted:
            values = dict(values, **{name: expected[name]})
    if any(values.get(key) != value for key, value in expected.items()):
        raise ValueError('executor installed cgroup/unit contract')
    if re.fullmatch('[a-f0-9]{32}', values.get('InvocationID', '')) is None or set(values) != set(expected) | {'InvocationID'}:
        raise ValueError('executor invocation binding')
    if cgroup != ('0::' + expected['ControlGroup'] + '\n').encode():
        raise ValueError('executor actual unified cgroup')
    return values['InvocationID']


def validate_root_status(raw):
    values = {}
    for row in raw.decode().splitlines():
        if ':' not in row: raise ValueError('executor root status shape')
        key, value = row.split(':', 1)
        if key in values: raise ValueError('executor root duplicate status')
        values[key] = value.strip()
    if (values.get('Uid') != '0\t0\t0\t0' or values.get('Gid') != '0\t0\t0\t0'
            or values.get('Groups') not in ('', '0') or values.get('NoNewPrivs') != '1'
            or any(values.get(key) != '00000000000800e4' for key in ('CapPrm', 'CapEff', 'CapBnd'))
            or any(values.get(key) != '0000000000000000' for key in ('CapInh', 'CapAmb'))):
        raise ValueError('executor actual root identity/capabilities')


def _measure_unit(inputs, plan, digest):
    validate_root_status(Path('/proc/self/status').read_bytes())
    fragment = unit_fragment(inputs, plan, digest)
    if _read('/etc/systemd/system/' + UNIT) != fragment:
        raise ValueError('executor exact installed fragment')
    properties = ('Id LoadState ActiveState SubState MainPID ControlPID User Group FragmentPath DropInPaths SourcePath '
        'NeedDaemonReload Transient Delegate KillMode KillSignal FinalKillSignal SendSIGKILL Restart Type RemainAfterExit '
        'RuntimeMaxUSec TimeoutStopUSec NoNewPrivileges ProtectControlGroups ProtectSystem PrivateUsers RestrictNamespaces '
        'ProtectKernelTunables ProtectKernelLogs ProtectKernelModules PrivateDevices BindReadOnlyPaths SystemCallFilter '
        'TasksMax MemoryMax ControlGroup InvocationID')
    result = subprocess.run([inputs['systemctl']['path'], 'show', UNIT, '--no-pager', '--property=' + properties.replace(' ', ',')],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV, timeout=5, check=True)
    invocation = validate_observation(_loaded(result.stdout), inputs, pid=os.getpid(), cgroup=Path('/proc/self/cgroup').read_bytes())
    if any(not os.statvfs(path).f_flag & os.ST_RDONLY for path in ('/sys', '/sys/fs/cgroup')):
        raise ValueError('executor sysfs/cgroup mounts must be read-only')
    cgroup = Path('/sys/fs/cgroup/system.slice') / UNIT
    if (cgroup.stat().st_uid != 0 or cgroup.stat().st_gid != 0
            or (cgroup / 'cgroup.type').read_bytes() != b'domain\n'
            or (cgroup / 'memory.max').read_bytes() != b'12884901888\n'
            or (cgroup / 'pids.max').read_bytes() != b'256\n'):
        raise ValueError('executor actual kernel cgroup limits')
    validate_root_status(Path('/proc/self/status').read_bytes())
    return invocation


def _python_runtime(inputs):
    declared = {entry['path']: entry['sha256'] for entry in inputs['python_runtime_files']}
    for path, digest in declared.items():
        _read(path, expected=digest, maximum=200_000_000)
    observed = set()
    source = Path(inputs['source_root'])
    for module in tuple(sys.modules.values()):
        path = getattr(module, '__file__', None)
        if path and not str(path).startswith('<'):
            actual = str(Path(path).resolve(strict=True))
            if not Path(actual).is_relative_to(source):
                observed.add(actual)
    for line in Path('/proc/self/maps').read_text().splitlines():
        fields = line.split(None, 5)
        if len(fields) == 6 and fields[5].startswith('/'):
            observed.add(fields[5])
    if not observed.issubset(declared):
        raise ValueError('executor unpinned Python module/mapped runtime')


def _load_supervisor(inputs, execution_raw):
    """Authenticate project Python before running any project import code."""
    if hashlib.sha256(execution_raw).hexdigest() != inputs['execution_sha256']:
        raise ValueError('executor pre-import execution digest')
    def unique(pairs):
        value={}
        for key,item in pairs:
            if key in value:
                raise ValueError('executor pre-import duplicate key')
            value[key]=item
        return value
    plan=json.loads(execution_raw,object_pairs_hook=unique)
    root=Path(inputs['source_root'])
    if (type(plan) is not dict or plan.get('source_root')!=str(root)
            or plan.get('schema')!='hermes-contained-execution-plan/v1'
            or type(plan.get('source_files')) is not list or not 1<=len(plan['source_files'])<=50_000):
        raise ValueError('executor pre-import source inventory')
    declared={}
    prefixes=('Projects/zouroboros-software-factory/hermes/','Projects/zouroboros-software-factory/scripts/')
    names=[]
    for item in plan['source_files']:
        if (type(item) is not dict or set(item)!={'path','sha256'} or type(item['path']) is not str
                or item['path'].startswith('/') or '..' in Path(item['path']).parts
                or str(Path(item['path']))!=item['path'] or type(item['sha256']) is not str or HEX.fullmatch(item['sha256']) is None):
            raise ValueError('executor pre-import file declaration')
        names.append(item['path'])
        if item['path'].startswith(prefixes) and item['path'].endswith(('.py','.pyc','.pyo','.so')):
            declared[item['path']]=item['sha256']
    if names!=sorted(set(names)) or declared.get(WRAPPER)!=inputs['wrapper_sha256'] or declared.get(SUPERVISOR)!=inputs['supervisor_sha256']:
        raise ValueError('executor pre-import source binding')
    observed=[]
    for prefix in prefixes:
        for current,dirs,files in os.walk(root/prefix,followlinks=False):
            here=Path(current);info=here.stat(follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
                raise ValueError('executor pre-import directory ownership')
            if any((here/name).is_symlink() for name in dirs):
                raise ValueError('executor pre-import directory link')
            for name in files:
                if name.endswith(('.py','.pyc','.pyo','.so')):
                    observed.append(str((here/name).relative_to(root)))
            if len(observed)>2048:
                raise ValueError('executor pre-import Python closure bound')
    if sorted(observed)!=sorted(declared):
        raise ValueError('executor pre-import incomplete Python inventory')
    for name,digest in declared.items():
        _read(root/name,expected=digest)
    spec=importlib.util.spec_from_file_location('factory_execution_supervisor',root/SUPERVISOR)
    supervisor=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)
    return supervisor


def _boundary(inputs, plan, digest):
    """Authenticate the public projection from the independently pinned core.

    The core omits the two derived hashes so the unit input/fragment/public
    projection have no hash cycle. A worker cannot enroll an alternate route.
    """
    p=inputs['managed_boundary']
    fields={'schema','execution_sha256','source_root','source_head','registry_sha256','worker_uid','worker_gid',
        'workdir','home','state_root','harness','model','runtime_ms','timeout_ms','approved_at_ms','expires_at_ms',
        'adapter','native','node','bun','bwrap','systemctl','python','profile_files','runtime_files'}
    shared=('source_root','source_head','worker_uid','worker_gid','workdir','home','state_root','harness','model',
        'timeout_ms','approved_at_ms','expires_at_ms','profile_files','bun')
    if (type(p) is not dict or set(p)!=fields or p['schema']!='factory-managed-systemd-boundary/v1'
            or p['harness']!='codex' or p['execution_sha256']!=inputs['execution_sha256']
            or p['runtime_ms']!=inputs['runtime_ms'] or any(p[key]!=plan[key] for key in shared)
            or p['native']!=plan['harness_executable'] or any(p[key]!=inputs[key] for key in ('python','systemctl','bwrap'))):
        raise ValueError('executor managed core/plan binding')
    pins={entry['path']:entry['sha256'] for entry in plan['source_files']}
    if p['registry_sha256']!=pins.get('packages/swarm/src/executor/registry/executor-registry.json'):
        raise ValueError('executor managed registry binding')
    if (type(p['adapter']) is not dict or set(p['adapter'])!={'name','args','path','sha256'}
            or p['adapter']['name']!='codex-acp-swarm' or p['adapter']['args']!=[]):
        raise ValueError('executor managed ACP invocation')
    for key in ('adapter','native','node'):
        pin=p[key]
        if type(pin) is not dict or type(pin.get('sha256')) is not str or HEX.fullmatch(pin['sha256']) is None:
            raise ValueError('executor managed native pin')
        name=Path(_path(pin['path']))
        if not name.is_relative_to(p['source_root']) or pins.get(str(name.relative_to(p['source_root'])))!=pin['sha256']:
            raise ValueError('executor managed native materialization')
        if name.parent!=Path(p['native']['path']).parent:
            raise ValueError('executor managed executable search path')
        _read(name,expected=pin['sha256'],maximum=512*1024*1024)
    files=p['runtime_files']
    if type(files) is not list or not 1<=len(files)<=2048:
        raise ValueError('executor managed runtime inventory')
    names=[]
    for item in files:
        if type(item) is not dict or set(item)!={'path','sha256'} or type(item['sha256']) is not str or HEX.fullmatch(item['sha256']) is None:
            raise ValueError('executor managed runtime entry')
        names.append(_path(item['path']))
        _read(item['path'],expected=item['sha256'],maximum=512*1024*1024)
    staged_nice=str(Path(p['native']['path']).parent/'nice')
    if (names!=sorted(set(names)) or not {'/usr/lib/x86_64-linux-gnu/libc.so.6','/usr/bin/taskset'}.issubset(names)
            or len(set(names)&{'/usr/bin/nice',staged_nice})!=1):
        raise ValueError('executor managed runtime closure')
    if staged_nice in names and pins.get(str(Path(staged_nice).relative_to(p['source_root'])))!=next(item['sha256']for item in files if item['path']==staged_nice):
        raise ValueError('executor staged nice source binding')
    expected=canonical({**p,'unit_inputs_sha256':digest,
        'unit_fragment_sha256':hashlib.sha256(unit_fragment(inputs,plan,digest)).hexdigest()})
    if _read(BOUNDARY,maximum=LIMIT)!=expected:
        raise ValueError('executor managed public projection')
    return expected


def run_installed(*, approved_unit_inputs_sha256):
    if (os.geteuid(), os.getegid()) != (0, 0) or os.environ.get('FACTORY_STATE_MODE') == 'test':
        raise ValueError('production executor unit identity')
    raw = _read(INPUTS)
    inputs = parse_inputs(raw, approved_unit_inputs_sha256)
    if not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:
        raise ValueError('executor isolated Python required')
    for key in ('python', 'systemctl', 'bwrap'):
        _read(inputs[key]['path'], expected=inputs[key]['sha256'], maximum=200_000_000)
    if Path('/proc/self/exe').resolve() != Path(inputs['python']['path']):
        raise ValueError('executor Python executable binding')
    source = Path(inputs['source_root'])
    for path, key in ((WRAPPER, 'wrapper_sha256'), (SUPERVISOR, 'supervisor_sha256')):
        _read(source / path, expected=inputs[key])
    if Path(__file__).resolve() != source / WRAPPER:
        raise ValueError('executor wrapper source binding')
    _python_runtime(inputs)
    execution_raw=_read(EXECUTION,maximum=20_000_000)
    # Parse only independently authenticated bytes before project imports.
    if hashlib.sha256(execution_raw).hexdigest()!=inputs['execution_sha256']:
        raise ValueError('executor pre-import execution digest')
    boundary_raw=_boundary(inputs,json.loads(execution_raw),approved_unit_inputs_sha256)
    supervisor=_load_supervisor(inputs,execution_raw)
    plan = supervisor._config(execution_raw, inputs['execution_sha256'])
    by_name = {item['path']: item['sha256'] for item in plan['source_files']}
    if by_name.get(WRAPPER) != inputs['wrapper_sha256'] or by_name.get(SUPERVISOR) != inputs['supervisor_sha256']:
        raise ValueError('executor source inventory handoff binding')
    supervisor._installation(plan)
    _python_runtime(inputs)
    invocation = _measure_unit(inputs, plan, approved_unit_inputs_sha256)
    if _read(INPUTS) != raw or _boundary(inputs,plan,approved_unit_inputs_sha256)!=boundary_raw:
        raise ValueError('executor input changed before handoff')
    result = supervisor.execute_once(approved_execution_sha256=inputs['execution_sha256'])
    if _measure_unit(inputs, plan, approved_unit_inputs_sha256) != invocation:
        raise ValueError('executor invocation changed after handoff; reconcile')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approved-unit-inputs-sha256', required=True)
    try:
        print(canonical(run_installed(**vars(parser.parse_args()))).decode())
    except Exception:
        print('{"status":"held","reason":"executor-unit-reconciliation-required"}')
        raise SystemExit(1)
