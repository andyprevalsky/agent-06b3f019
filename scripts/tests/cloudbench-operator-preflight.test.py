#!/usr/bin/env python3
"""Offline actual gate entry + selected-UID private-file checks."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/cloudbench-operator-preflight.py'


class Preflight(unittest.TestCase):
    def test_missing_fly_refuses_before_git_or_allocation(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / 'scripts').mkdir()
            (root / 'scripts/cloudbench-operator-preflight.py').write_bytes(HELPER.read_bytes())
            fake = root / 'bin'
            fake.mkdir()
            marker = root / 'git-called'
            git = fake / 'git'
            git.write_text('#!/bin/sh\n: > "$CALL_MARKER"\nexit 99\n')
            git.chmod(0o700)
            gate = Path(os.environ.get('PREFLIGHT_GATE_SOURCE', ROOT / 'scripts/run-cloudbench-controller-gate'))
            env = dict(os.environ, PATH=str(fake) + ':/usr/bin:/bin', CALL_MARKER=str(marker),
                       CLOUDBENCH_GATE_ROOT_DIR=str(root), FLY_API_TOKEN='offline-fixture',
                       WARM_IMAGE_REF='offline-fixture', CLOUDBENCH_GATE_SELF_COPY='')
            result = subprocess.run(['/bin/bash', str(gate), '--', 'true'], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 78, result.stderr)
            self.assertIn('flyctl is not on launcher PATH', result.stderr)
            self.assertFalse(marker.exists(), 'git/network preparation ran before CLI preflight')
            self.assertEqual(list(root.glob('**/*intent*')), [])

    def test_private_input_requires_selected_owner_and_mode(self):
        spec = importlib.util.spec_from_file_location('preflight', HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'private.json'
            path.write_text('{}')
            path.chmod(0o600)
            module.private_input(path)
            with patch.object(module.os, 'geteuid', return_value=os.geteuid() + 1):
                with self.assertRaisesRegex(ValueError, 'owner differs'):
                    module.private_input(path)
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'group or other'):
                module.private_input(path)
            path.chmod(0o600)
            alias = path.parent / 'alias'
            alias.symlink_to(path)
            with self.assertRaisesRegex(ValueError, 'physical file'):
                module.private_input(alias)
            result = subprocess.run([sys.executable, str(HELPER), '--private-input', str(path)],
                                    capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
