"""Root-owned cap-one execution handoff using the existing issuer lock.

This is a future installed entrypoint, not an activation switch. Its separately
pinned execution-inputs.json and existing journal/runtime/profile enrollment are
required. It never initializes storage or promotes held reader JSON to authority.
The finite child invocation runs without root credentials; its exact journal
reservation and dispatch-start require a fresh root acknowledgment under lock.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

HERMES = Path(__file__).resolve().parent.parent / 'hermes'
sys.path.insert(0, str(HERMES))
import held_coordinator as coordinator
import publisher_once as publisher
import root_claim_commit as claims
from bootstrap_authority import locked_bootstrap_authority

CONFIG = 'execution-inputs.json'
CONSUMED = 'execution-cap-one.json'
CHILD = 'Projects/zouroboros-software-factory/scripts/hermes-execution.ts'
HEX = re.compile('[a-f0-9]{64}\\Z')
MAX_PLAN = 20_000_000
MAX_RUNTIME_FILE_BYTES = 512 * 1024 * 1024


def _hex(value):
    return type(value) is str and HEX.fullmatch(value) is not None


def _now():
    return time.time_ns() // 1_000_000


def _path(value):
    if type(value) is not str or not value.startswith('/') or str(Path(value)) != value or '\0' in value:
        raise ValueError('execution absolute path')
    parts = Path(value).parts
    if any(part in ('.', '..') for part in parts) or len(value) > 1024:
        raise ValueError('execution path shape')
    # Reject symlink ancestors as well as final path replacement.
    current = Path('/')
    for part in parts[1:]:
        current /= part
        if current.is_symlink():
            raise ValueError('execution path symlink')
    return Path(value)


def _file(path, uid, expected, maximum=32_000_000):
    path = _path(str(path))
    if uid == 0:
        for parent in path.parents:
            info = parent.stat(follow_symlinks=False)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('execution file ancestor ownership')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != uid or before.st_nlink != 1
                or before.st_mode & 0o022 or not 0 <= before.st_size <= maximum):
            raise ValueError('execution file ownership/mode/size')
        measured, size = hashlib.sha256(), 0
        while chunk := os.read(fd, 65536):
            measured.update(chunk); size += len(chunk)
            if size > maximum:
                raise ValueError('execution file bound')
        after, named = os.fstat(fd), path.stat(follow_symlinks=False)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode, s.st_uid, s.st_gid, s.st_nlink)
        if identity(before) != identity(after) or identity(named) != identity(after) or measured.hexdigest() != expected:
            raise ValueError('execution file changed')
        return (before.st_dev, before.st_ino)
    finally:
        os.close(fd)


def _config(raw, pin):
    value = publisher._json(raw, MAX_PLAN)
    fields = {'schema', 'coordinator_sha256', 'source_head', 'execution_id', 'worker_uid', 'worker_gid',
              'journal_path', 'journal_identity', 'workdir', 'home', 'state_root', 'bun', 'source_root',
              'source_files', 'source_links', 'runtime_attestation', 'profile_files', 'harness', 'harness_executable', 'model', 'timeout_ms', 'approved_at_ms', 'expires_at_ms',
              'claim_receipt_sha256', 'authority_artifact_sha256', 'subscriptions_only', 'maximum_launches'}
    if (not _hex(pin) or publisher.digest(raw) != pin or type(value) is not dict or set(value) != fields
            or value['schema'] != 'hermes-contained-execution-plan/v1' or value['subscriptions_only'] is not True
            or type(value['maximum_launches']) is not int or value['maximum_launches'] != 1
            or any(not _hex(value[k]) for k in ('coordinator_sha256', 'claim_receipt_sha256', 'authority_artifact_sha256'))
            or type(value['source_head']) is not str or re.fullmatch('[a-f0-9]{40}', value['source_head']) is None
            or type(value['execution_id']) is not str or re.fullmatch('exec-[A-Za-z0-9_.:-]{1,120}', value['execution_id']) is None
            or value['harness'] not in ('codex', 'claude-code') or type(value['model']) is not str
            or re.fullmatch('[A-Za-z0-9_.:-]{1,128}', value['model']) is None
            or any(type(value[k]) is not int for k in ('worker_uid', 'worker_gid', 'timeout_ms', 'approved_at_ms', 'expires_at_ms'))
            or min(value['worker_uid'], value['worker_gid'], value['approved_at_ms']) <= 0
            or not 0 < value['timeout_ms'] <= 120_000
            or not 0 < value['expires_at_ms'] - value['approved_at_ms'] <= 3_600_000
            or type(value['journal_identity']) is not list or len(value['journal_identity']) != 2
            or any(type(v) is not int or v < 0 for v in value['journal_identity'])):
        raise ValueError('independent execution plan required')
    for key in ('journal_path', 'workdir', 'home', 'state_root', 'source_root'):
        _path(value[key])
    for key in ('source_files', 'profile_files'):
        files = value[key]
        if type(files) is not list or not 1 <= len(files) <= (50_000 if key == 'source_files' else 2048):
            raise ValueError('execution exact source/profile inventory')
        names = []
        for item in files:
            if type(item) is not dict or set(item) != {'path', 'sha256'} or not _hex(item['sha256']):
                raise ValueError('execution file declaration')
            name = item['path']
            if type(name) is not str or Path(name).is_absolute() or '..' in Path(name).parts or str(Path(name)) != name:
                raise ValueError('execution relative file declaration')
            names.append(name)
        if names != sorted(set(names)):
            raise ValueError('execution duplicate/unsorted files')
    if CHILD not in [item['path'] for item in value['source_files']]:
        raise ValueError('execution child not source pinned')
    links = value['source_links']
    if type(links) is not list or len(links) > 20_000:
        raise ValueError('execution dependency link inventory')
    link_names = []
    for item in links:
        if (type(item) is not dict or set(item) != {'path', 'target'} or type(item['target']) is not str
                or not item['target'] or len(item['target']) > 1024 or '\0' in item['target']
                or type(item['path']) is not str or Path(item['path']).is_absolute()
                or '..' in Path(item['path']).parts or str(Path(item['path'])) != item['path']):
            raise ValueError('execution dependency link declaration')
        link_names.append(item['path'])
    if link_names != sorted(set(link_names)):
        raise ValueError('execution duplicate dependency links')
    for field in ('bun', 'harness_executable', 'runtime_attestation'):
        if type(value[field]) is not dict or set(value[field]) != {'path', 'sha256'} or not _hex(value[field]['sha256']):
            raise ValueError('execution runtime pin')
        _path(value[field]['path'])
    return value


# Exact historical source records also admitted by runtime-materialize.ts.
# The independently pinned materializer attestation establishes their Git tree;
# this consumer checks that those inert records have not changed, without
# following them or treating the live Git checkout as new execution authority.
INERT_SOURCE_ALIASES = {
    'AVATAR-USER.md': ('AVATAR-KEVIN.md', '6c689fb822a75c1ca139f31f6b4529b64d8f44a8'),
    'evaluations/bench': ('/home/workspace/zouroboros/packages/bench/evaluations', '028ac2b9117ddfd8d7384ca73478b522ecc44ed6'),
    'evaluations/rag': ('/home/workspace/zouroboros/packages/rag/evaluations', '3e2fe91aae1d43e6672ab83e331f94c047712461'),
    'evaluations/swarm': ('/home/workspace/zouroboros/packages/swarm/evaluations', '907f792ee68c16cd07b55e584fd2c0499707f367'),
    'Projects/zourobench-2026/node_modules': ('hal-adapter/node_modules', '4c75bc576400224b0f96b3ce0b4abebd32a552cb'),
}
INERT_ALIAS_WORKSPACE_BLOB = 'dda638de2b858681bdb3740c2cc5ba7d5df3db32'


def _git_blob(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def _source_inventory(plan):
    root = _path(plan['source_root'])
    files, links = [], []
    declared_links = {item['path']: item['target'] for item in plan['source_links']}
    declared_files = {item['path']: item['sha256'] for item in plan['source_files']}
    workspace_checked = False
    pending = [root]
    while pending:
        directory = pending.pop()
        info = directory.stat(follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022:
            raise ValueError('execution runtime directory ownership')
        # Classify each entry without inspecting symlink target metadata; even
        # os.walk(followlinks=False) follows targets when classifying entries.
        with os.scandir(directory) as entries:
            for entry in entries:
                # Git's worktree pointer is not executable application content.
                if directory == root and entry.name == '.git':
                    continue
                path = directory / entry.name
                item = entry.stat(follow_symlinks=False)
                relative = str(path.relative_to(root))
                if stat.S_ISLNK(item.st_mode):
                    target = os.readlink(path)
                    if relative in INERT_SOURCE_ALIASES:
                        expected, blob = INERT_SOURCE_ALIASES[relative]
                        if (item.st_uid != 0 or item.st_gid != 0 or target != expected
                                or declared_links.get(relative) != expected or _git_blob(target.encode()) != blob):
                            raise ValueError('execution inert source record')
                        if not workspace_checked:
                            workspace = root / 'pnpm-workspace.yaml'
                            pin = declared_files.get('pnpm-workspace.yaml')
                            _file(workspace, 0, pin)
                            raw = workspace.read_bytes()
                            if publisher.digest(raw) != pin or _git_blob(raw) != INERT_ALIAS_WORKSPACE_BLOB:
                                raise ValueError('execution inert workspace binding')
                            workspace_checked = True
                    elif item.st_uid != 0 or not path.resolve(strict=True).is_relative_to(root):
                        raise ValueError('execution runtime external dependency link')
                    links.append({'path': relative, 'target': target})
                elif stat.S_ISDIR(item.st_mode):
                    pending.append(path)
                elif stat.S_ISREG(item.st_mode):
                    files.append(relative)
                else:
                    raise ValueError('execution runtime special file')
        if len(files) > 50_000 or len(links) > 20_000:
            raise ValueError('execution runtime inventory bound')
    if (sorted(files) != [item['path'] for item in plan['source_files']]
            or sorted(links, key=lambda item: item['path']) != plan['source_links']):
        raise ValueError('execution runtime incomplete inventory')
    attestation = plan['runtime_attestation']
    _file(attestation['path'], 0, attestation['sha256'])
    raw = Path(attestation['path']).read_bytes()
    if publisher.digest(raw) != attestation['sha256']:
        raise ValueError('execution runtime attestation changed')
    value = json.loads(raw)
    if (type(value) is not dict or value.get('version') != 1 or value.get('candidate_root') != str(root)
            or value.get('merge_commit') != plan['source_head'] or value.get('tracked_clean') is not True
            or value.get('install_flags') != ['--offline', '--frozen-lockfile', '--ignore-scripts']
            or value.get('dependency_link_count') != len(links)
            or type(value.get('merge_tree')) is not str or re.fullmatch('[a-f0-9]{40}', value['merge_tree']) is None
            or any(not _hex(value.get(key)) for key in ('package_json_sha256', 'pnpm_lock_sha256',
                   'pnpm_workspace_sha256', 'normalized_dependency_graph_sha256', 'runtime_key_sha256'))):
        raise ValueError('execution runtime materialization binding')
    by_path = {item['path']: item['sha256'] for item in plan['source_files']}
    for filename, key in [('package.json', 'package_json_sha256'), ('pnpm-lock.yaml', 'pnpm_lock_sha256'),
                          ('pnpm-workspace.yaml', 'pnpm_workspace_sha256')]:
        if by_path.get(filename) != value[key]:
            raise ValueError('execution runtime dependency source binding')


def _installation(plan):
    _source_inventory(plan)
    # Executable/source parents must be outside the worker's mutable home and
    # workspace. Root-owned files in a replaceable parent are not fixed code.
    for location in (plan['source_root'], plan['bun']['path']):
        path = _path(location)
        for parent in path.parents:
            info = parent.stat(follow_symlinks=False)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('execution runtime ancestor ownership')
    _file(plan['bun']['path'], 0, plan['bun']['sha256'], 150_000_000)
    _file(plan['harness_executable']['path'], 0, plan['harness_executable']['sha256'], MAX_RUNTIME_FILE_BYTES)
    for root_key, files, uid in [('source_root', plan['source_files'], 0), ('home', plan['profile_files'], plan['worker_uid'])]:
        directory = _path(plan[root_key])
        info = directory.stat(follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
            raise ValueError('execution source/profile directory')
        for item in files:
            _file(directory / item['path'], uid, item['sha256'],
                  MAX_RUNTIME_FILE_BYTES if root_key == 'source_root' else 32_000_000)
        if root_key == 'home':
            # Omitted configuration in HOME could select a different provider.
            # The first launch needs an exact independently qualified profile.
            observed = []
            for current, directories, filenames in os.walk(directory, followlinks=False):
                for name in directories:
                    sub = Path(current) / name
                    info = sub.stat(follow_symlinks=False)
                    if sub.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
                        raise ValueError('execution profile directory drift')
                observed.extend(str((Path(current) / name).relative_to(directory)) for name in filenames)
                if len(observed) > 2048:
                    raise ValueError('execution profile inventory bound')
            if sorted(observed) != [item['path'] for item in files]:
                raise ValueError('execution profile inventory drift')
    for key in ('workdir', 'state_root'):
        info = _path(plan[key]).stat(follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != plan['worker_uid'] or info.st_mode & 0o022:
            raise ValueError('execution worker directory')
    _journal_identity(plan)


def _journal_identity(plan):
    path = _path(plan['journal_path'])
    if path.parent != Path(plan['state_root']):
        raise ValueError('execution journal must be enrolled state child')
    info = path.stat(follow_symlinks=False)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != plan['worker_uid'] or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600 or [info.st_dev, info.st_ino] != plan['journal_identity']):
        raise ValueError('execution journal inode/owner')
    # Do not let a root SQLite read create root-owned WAL/SHM beside the
    # worker's journal. Check the initialized main-file header without opening
    # SQLite; the child validates the complete schema through OperationJournal.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(fd)
        header = os.read(fd, 100)
        if ([opened.st_dev, opened.st_ino] != plan['journal_identity']
                or len(header) != 100 or header[:16] != b'SQLite format 3\0'
                or header[18:20] != b'\x02\x02' or int.from_bytes(header[60:64], 'big') != 2):
            raise ValueError('execution requires checkpointed v2 operation journal')
    finally:
        os.close(fd)


def _retained(authority, live, config, plan):
    journal = claims.load_enrolled_claim_journal(authority.issuer_fd, config['claim_journal_sha256'])
    selected = json.loads(journal.request_raw)
    pending = claims._pending_bound_request(authority.issuer_fd, journal.identity, selected, journal=journal, with_work=True)
    if pending is None:
        raise ValueError('execution has no retained signed work')
    signed, work = pending
    body = signed['body']
    expected_key = 'fc2_' + publisher.digest(('factory-claim-subject/v2\0hermes\0' + body['factory_work_id']).encode())
    # Prevent this consumer from creating a claim. Its prerequisite is an exact
    # durable acquisition, never merely an incomplete pending reader artifact.
    with closing(claims._database(authority.issuer_fd, existing_identity=journal.identity, journal=journal)) as db:
        claims._schema(db)
        if (db.execute('SELECT COUNT(*) FROM claims').fetchone()[0] != 1
                or db.execute('SELECT COUNT(*) FROM receipts').fetchone()[0] != 1
                or db.execute('SELECT key FROM claims WHERE key=?', (expected_key,)).fetchone() is None
                or db.execute('SELECT request_id FROM receipts WHERE request_id=? AND claim_key=?',
                              (body['request_id'], expected_key)).fetchone() is None):
            raise ValueError('execution requires committed cap-one claim')
    policy, public = claims._policy(authority.issuer_fd)
    bound = {key: body[key] for key in ('nonce', 'snapshot_sha256', 'receipt_sha256', 'board_identity_sha256')}
    result = claims._commit(live, authority.issuer_fd, signed, policy, public,
        (policy['reader_uid'], policy['reader_gid']), None, bound=bound,
        existing_identity=journal.identity, journal=journal, selected_work=work)
    if (result['retained_work']['claim_receipt_sha256'] != plan['claim_receipt_sha256']
            or result['retained_work']['authority_artifact_sha256'] != plan['authority_artifact_sha256']):
        raise ValueError('execution independently selected claim mismatch')
    return {key: result[key] for key in ('receipt', 'retained_work')}


def _packet(plan, pin, claim):
    names = ('source_head', 'execution_id', 'journal_path', 'journal_identity', 'worker_uid', 'worker_gid',
             'workdir', 'harness', 'model', 'timeout_ms', 'approved_at_ms', 'expires_at_ms')
    return dict(schema='hermes-contained-execution/v1', plan_sha256=pin, claim=claim,
                **{key: plan[key] for key in names})


def _cap_binding(packet):
    return {'schema': 'hermes-execution-consumed/v1',
        'packet_sha256': publisher.digest(publisher.canonical(packet)),
        'plan_sha256': packet['plan_sha256'], 'execution_id': packet['execution_id'],
        'factory_work_id': packet['claim']['receipt']['factory_work_id'],
        'authority_artifact_sha256': packet['claim']['retained_work']['authority_artifact_sha256'],
        'work_sha256': packet['claim']['retained_work']['work_sha256']}


def _cap_read(issuer_fd, packet):
    """Root-private cap, independent of the tool-capable worker's journal."""
    info = os.fstat(issuer_fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError('execution cap requires private root issuer directory')
    raw = publisher._read(issuer_fd, CONSUMED, group=0, limit=4096, missing=True)
    if raw is None:
        return None
    value = publisher._json(raw)
    binding = _cap_binding(packet)
    if (type(value) is not dict or set(value) != set(binding) | {'consumed_at_ms'}
            or any(value[key] != expected for key, expected in binding.items())
            or type(value['consumed_at_ms']) is not int
            or not packet['approved_at_ms'] <= value['consumed_at_ms'] < min(
                packet['expires_at_ms'], packet['claim']['receipt']['lease_expires_ms'])):
        raise ValueError('execution cap exists with conflicting or uncertain evidence')
    return raw


def _cap_consume(issuer_fd, packet):
    """Exclusive durable consumption. Partial/crashed writes burn capacity.

    Caller owns the actual issuer lock and rechecks its lineage. No cleanup or
    rollback removes this artifact; a later invocation is recovery-only.
    """
    if _cap_read(issuer_fd, packet) is not None:
        raise ValueError('execution cap already consumed')
    timestamp = _now()
    if not packet['approved_at_ms'] <= timestamp < min(packet['expires_at_ms'], packet['claim']['receipt']['lease_expires_ms']):
        raise ValueError('execution cap authority expired')
    raw = publisher.canonical(dict(_cap_binding(packet), consumed_at_ms=timestamp))
    fd = os.open(CONSUMED, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=issuer_fd)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('execution cap created ownership')
        offset = 0
        while offset < len(raw):
            written = os.write(fd, raw[offset:])
            if written <= 0:
                raise ValueError('execution cap incomplete write')
            offset += written
        os.fsync(fd)
        os.fsync(issuer_fd)
        named = os.stat(CONSUMED, dir_fd=issuer_fd, follow_symlinks=False)
        if (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino) or _cap_read(issuer_fd, packet) != raw:
            raise ValueError('execution cap changed after persistence')
        return raw
    finally:
        os.close(fd)


class _RootCap:
    """One invocation's consumption state, never derived from worker evidence."""
    def __init__(self, issuer_fd, packet):
        self.fd, self.packet = issuer_fd, packet
        self.retained = _cap_read(issuer_fd, packet)
        self.created = False
        self.launched = False

    def admit(self, stage):
        if stage == 'reserve':
            if self.retained is not None or self.created:
                raise ValueError('execution cap recovery-only; no new reservation grant')
            self.retained = _cap_consume(self.fd, self.packet)
            self.created = True
        elif stage != 'launch' or not self.created or self.launched:
            raise ValueError('execution cap has no invocation-owned launch')
        else:
            self.launched = True
        if _cap_read(self.fd, self.packet) != self.retained:
            raise ValueError('execution cap changed before grant')


def _drop(plan):
    os.setgroups([]); os.setgid(plan['worker_gid']); os.setuid(plan['worker_uid'])
    import ctypes
    if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
        os._exit(76)


def _environment(plan):
    binary = plan.get('harness_executable', {}).get('path')
    env = {'PATH': ':'.join([str(Path(plan['bun']['path']).parent),
        *([str(Path(binary).parent)] if binary else []), '/usr/bin', '/bin']),
        'HOME': plan['home'], 'LC_ALL': 'C.UTF-8', 'FACTORY_STATE_MODE': 'production', 'FACTORY_STATE_DIR': plan['state_root']}
    if binary:
        env['CODEX_BIN' if plan['harness'] == 'codex' else 'CLAUDE_CODE_BIN'] = binary
    return env


def _subscription(plan):
    args = ['login', 'status'] if plan['harness'] == 'codex' else ['auth', 'status', '--json']
    child = subprocess.Popen([plan['harness_executable']['path'], *args], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=plan['workdir'],
        env=_environment(plan), preexec_fn=lambda: _drop(plan), start_new_session=True, close_fds=True)
    output = {child.stdout: b'', child.stderr: b''}
    try:
        deadline = time.monotonic() + 5
        with selectors.DefaultSelector() as wait:
            for stream in output:
                wait.register(stream, selectors.EVENT_READ)
            while wait.get_map():
                events = wait.select(max(0, deadline - time.monotonic()))
                if not events:
                    raise ValueError('execution subscription status timeout')
                for event, _ in events:
                    chunk = os.read(event.fileobj.fileno(), 4096)
                    if not chunk:
                        wait.unregister(event.fileobj)
                    else:
                        output[event.fileobj] += chunk
                        if sum(map(len, output.values())) > 16_384:
                            raise ValueError('execution subscription status bound')
        _wait_owned_exit(child, max(0, deadline - time.monotonic()))
        if child.returncode != 0:
            raise ValueError('execution subscription status unavailable')
    finally:
        if child.returncode is None:
            _stop_owned_child(child)
        for stream in output:
            stream.close()
    stdout, stderr = output[child.stdout], output[child.stderr]
    if plan['harness'] == 'codex':
        if (stdout + stderr).strip() != b'Logged in using ChatGPT':
            raise ValueError('execution ChatGPT subscription required')
    else:
        value = json.loads(stdout)
        if (type(value) is not dict or value.get('loggedIn') is not True
                or value.get('authMethod') != 'claude.ai' or value.get('apiProvider') != 'firstParty'):
            raise ValueError('execution Claude subscription required')


def _wait_owned_exit(child, timeout):
    # WNOWAIT retains this owned PID until group cleanup, preventing a reused
    # process-group number from being mistaken for this child after reaping.
    deadline = time.monotonic() + timeout
    while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
        if time.monotonic() >= deadline:
            raise ValueError('execution child exit timeout')
        time.sleep(.01)
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=2)


def _stop_owned_child(child):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=2)


def _send_owned(child, value, deadline):
    raw = publisher.canonical(value) + b'\n'
    if len(raw) > 100_000:
        raise ValueError('execution child outbound frame bound')
    fd, offset = child.stdin.fileno(), 0
    os.set_blocking(fd, False)
    with selectors.DefaultSelector() as wait:
        wait.register(fd, selectors.EVENT_WRITE)
        while offset < len(raw):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not wait.select(remaining):
                raise ValueError('execution child send timeout')
            try:
                count = os.write(fd, raw[offset:])
            except BlockingIOError:
                continue
            if count <= 0:
                raise ValueError('execution child send incomplete')
            offset += count


def _run_child(plan, packet, fence):
    """Private pipes to a fixed child. No shell and no credential inheritance.

    Keep the issuer context owned until the child exits. A parent interruption
    leaves the durable operation uncertain; process-group cleanup never retries.
    """
    child = subprocess.Popen([plan['bun']['path'], str(Path(plan['source_root']) / CHILD), '--root-child'],
        cwd=plan['workdir'], env=_environment(plan), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        preexec_fn=lambda: _drop(plan), start_new_session=True, close_fds=True)
    binding = publisher.digest(publisher.canonical(packet))
    deadline = time.monotonic() + plan['timeout_ms'] / 1000 + 15
    buffer, phases = b'', []
    try:
        _send_owned(child, packet, deadline)
        with selectors.DefaultSelector() as wait:
            wait.register(child.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                if not wait.select(max(0, deadline - time.monotonic())):
                    break
                chunk = os.read(child.stdout.fileno(), 4096)
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > 16_384:
                    raise ValueError('execution child protocol bound')
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    message = publisher._json(line)
                    if type(message) is not dict:
                        raise ValueError('execution child protocol shape')
                    if message.get('schema') == 'hermes-execution-terminal/v1':
                        if set(message) != {'schema', 'result'} or buffer:
                            raise ValueError('execution terminal shape')
                        result = message['result']
                        if (type(result) is not dict or set(result) != {'schema', 'status', 'operation_id', 'execution_id',
                                'factory_work_id', 'receipt_sha256', 'replay', 'dispatch_eligible'}
                                or result['schema'] != 'hermes-contained-execution-result/v1' or result['status'] != 'held'
                                or result['execution_id'] != packet['execution_id']
                                or result['factory_work_id'] != packet['claim']['receipt']['factory_work_id']
                                or type(result['operation_id']) is not str or re.fullmatch('op-[A-Z0-9]{26}', result['operation_id']) is None
                                or type(result['replay']) is not bool or result['dispatch_eligible'] is not False
                                or result['receipt_sha256'] is not None and not _hex(result['receipt_sha256'])):
                            raise ValueError('execution terminal binding')
                        child.stdin.close()
                        _wait_owned_exit(child, 5)
                        if child.returncode != 0:
                            raise ValueError('execution child terminal exit')
                        return result
                    expected = ['reserve', 'launch'][len(phases)] if len(phases) < 2 else None
                    if message != {'schema': 'hermes-execution-fence/v1', 'stage': expected, 'binding': binding}:
                        raise ValueError('execution child fence sequence/binding')
                    fence(expected)
                    phases.append(expected)
                    grant = {'schema': 'hermes-execution-grant/v1', 'stage': expected, 'binding': binding}
                    _send_owned(child, grant, deadline)
        raise ValueError('execution child uncertain; reconcile existing operation')
    finally:
        # Reconcile only the process group created by this invocation. The
        # journal is deliberately retained whatever the child exit status.
        if child.returncode is None:
            _stop_owned_child(child)
        for stream in (child.stdin, child.stdout):
            if stream and not stream.closed:
                stream.close()


def execute_once(*, approved_execution_sha256):
    if os.geteuid() != 0 or os.getegid() != 0 or os.environ.get('FACTORY_STATE_MODE') == 'test':
        raise ValueError('production execution supervisor identity')
    with publisher._locked_roots() as (issuer, _reader, _lineage):
        raw = publisher._read(issuer, CONFIG, limit=MAX_PLAN)
        config_raw = publisher._read(issuer, coordinator.CONFIG)
    plan = _config(raw, approved_execution_sha256)
    config = coordinator._config(config_raw, plan['coordinator_sha256'])
    with locked_bootstrap_authority(**config['bootstrap'], coordinated=True) as authority:
        authority.measure_stopped()
        authority.check_local_publication()
        _installation(plan)
        _subscription(plan)
        _installation(plan)
        def fresh_authority():
            # Inventory and subscription checks can outlive the short floor
            # witness. Obtain a new protected-floor observation after that work;
            # the existing issuer lock and immutable bootstrap pins still bind
            # the same authority, and the normal age checks remain unchanged.
            observed = time.monotonic()
            witness = authority.observe_genesis()
            return coordinator._LiveAuthority(authority, config_raw, config, witness, observed)
        claim = _retained(authority, fresh_authority(), config, plan)
        packet = _packet(plan, approved_execution_sha256, claim)
        cap = _RootCap(authority.issuer_fd, packet)
        previous = [_now()]
        def fence(stage):
            first = _now()
            if first < previous[0] or first < plan['approved_at_ms']:
                raise ValueError('execution clock/approval')
            if publisher._read(authority.issuer_fd, CONFIG, limit=MAX_PLAN) != raw:
                raise ValueError('execution plan changed')
            _installation(plan)
            live = fresh_authority()
            if _retained(authority, live, config, plan) != claim:
                raise ValueError('execution claim changed')
            authority.check_lineage()
            last = _now()
            if last < first or last + plan['timeout_ms'] >= min(plan['expires_at_ms'], claim['receipt']['lease_expires_ms']):
                raise ValueError('execution approval/claim lifetime')
            previous[0] = last
            cap.admit(stage)
            authority.check_lineage()
            live.inspect()
            after_persistence = _now()
            if (after_persistence < last or after_persistence + plan['timeout_ms'] >= min(
                    plan['expires_at_ms'], claim['receipt']['lease_expires_ms'])):
                raise ValueError('execution approval expired during cap persistence')
            previous[0] = after_persistence
        return _run_child(plan, packet, fence)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approved-execution-sha256', required=True)
    try:
        print(publisher.canonical(execute_once(**vars(parser.parse_args()))).decode())
    except Exception:
        print('{"schema":"hermes-execution-held/v1"}')
        raise SystemExit(2)
