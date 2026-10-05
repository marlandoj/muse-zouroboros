"""Native runtime bound accommodates pinned Codex ELF without unbounded reads."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('executor_size_bound',Path(__file__).with_name('hermes-execution-supervisor.py'))
supervisor=importlib.util.module_from_spec(spec);spec.loader.exec_module(supervisor)


@unittest.skipUnless(os.name=='posix' and os.geteuid()==0,'root immutable runtime fixtures')
class RuntimeBoundTests(unittest.TestCase):
    def test_sparse_above_512_mib_is_refused_before_any_read(self):
        self.assertEqual(supervisor.MAX_RUNTIME_FILE_BYTES,512*1024*1024)
        with tempfile.TemporaryDirectory(prefix='zo-task-runtime-bound-',dir='/root') as temp:
            path=Path(temp)/'native';path.write_bytes(b'');path.chmod(0o600)
            with path.open('r+b') as stream:stream.truncate(supervisor.MAX_RUNTIME_FILE_BYTES+1)
            with patch.object(os,'read',side_effect=AssertionError('oversized file read')):
                with self.assertRaisesRegex(ValueError,'size'):
                    supervisor._file(path,0,'a'*64,supervisor.MAX_RUNTIME_FILE_BYTES)

    def test_chunk_limit_is_still_enforced_and_exact_small_limit_passes(self):
        with tempfile.TemporaryDirectory(prefix='zo-task-runtime-bound-',dir='/root') as temp:
            path=Path(temp)/'native';path.write_bytes(b'1234');path.chmod(0o600)
            supervisor._file(path,0,hashlib.sha256(b'1234').hexdigest(),4)
            real=os.read
            def expanded(fd,size):return real(fd,size)+b'x'
            with patch.object(os,'read',side_effect=expanded),self.assertRaisesRegex(ValueError,'bound'):
                supervisor._file(path,0,hashlib.sha256(b'1234').hexdigest(),4)


if __name__=='__main__':unittest.main()
