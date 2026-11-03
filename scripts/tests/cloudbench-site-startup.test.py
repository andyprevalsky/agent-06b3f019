#!/usr/bin/env python3
"""Actual stdlib-only startup callers must not initialize venv site packages."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get('SITE_STARTUP_SOURCE_ROOT', ROOT))


class SiteStartup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        venv = self.root/'venv'
        (venv/'bin').mkdir(parents=True)
        binary = Path(sys.executable).resolve()
        (venv/'bin/python3').symlink_to(binary)
        (venv/'pyvenv.cfg').write_text('home = '+str(binary.parent)+'\ninclude-system-site-packages = false\n')
        packages = venv/f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages'
        packages.mkdir(parents=True)
        self.marker = self.root/'site-started'
        (packages/'owning-control.pth').write_text(
            'import os,time; os.close(os.open('+repr(str(self.marker))+',os.O_WRONLY|os.O_CREAT,0o600)); time.sleep(0.15)\n'
        )
        self.env = dict(os.environ, PATH=str(venv/'bin')+':'+os.environ['PATH'])
        self.machine = dict(id='1234567890abcd', name='warm-fixture', state='stopped',
                            instance_id='instance-fixture', private_ip='fdaa::1',
                            config=dict(init=dict(cmd=['sleep', 'infinity']),
                                        mounts=[dict(volume='vol-fixture', path='/data', size_gb=32)]))
        self.machines = self.root/'machines.json'
        self.volumes = self.root/'volumes.json'
        self.machines.write_text(json.dumps([self.machine]))
        self.volumes.write_text(json.dumps([dict(id='vol-fixture', state='created')]))

    def test_actual_warm_volume_parser_skips_site_and_retains_validation(self):
        source = (SOURCE/'scripts/run-bench-fleet').read_text()
        body = source.split('warm_source_volume_size_from_inventory() {', 1)[1].split('\nmachine_volume_size_gb()', 1)[0]
        script = ('set -eu\n'
                  'fleet_admission_machines_json() { cat "$MACHINES"; }\n'
                  'warm_source_volume_size_from_inventory() {'+body+
                  '\nSNAPSHOT_LOOP_PID=42; CAPACITY_ADMISSION_DEADLINE=100; '
                  'warm_source_volume_size_from_inventory 1234567890abcd "$VOLUME"\n')
        result = subprocess.run(['/bin/bash', '-c', script],
                                env=dict(self.env, MACHINES=str(self.machines), VOLUME='vol-fixture'),
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '32')
        self.assertFalse(self.marker.exists(), 'stdlib warm parser initialized venv site packages')
        refused = subprocess.run(['/bin/bash', '-c', script],
                                 env=dict(self.env, MACHINES=str(self.machines), VOLUME='foreign-volume'),
                                 capture_output=True, text=True, timeout=3)
        self.assertNotEqual(refused.returncode, 0, 'wrong mounted volume must still refuse')

    def test_actual_inventory_publisher_skips_site_and_preserves_projection(self):
        source = (SOURCE/'scripts/lib/cloudbench-inventory.sh').read_text()
        match = re.search(r'^    python3[^\n]*"\$MACHINE_READINESS_SCRIPT" --publish-index \\\n[^\n]+', source, re.M)
        self.assertIsNotNone(match, 'actual publisher callsite missing')
        index = self.root/'index'
        output = self.root/'publish.log'
        result = subprocess.run(['/bin/bash', '-c', 'status=0\n'+match.group(0)+'\nexit "$status"\n'],
                    env=dict(self.env, MACHINE_READINESS_SCRIPT=str(SOURCE/'scripts/cloudbench-machine-readiness.py'),
                             machines_tmp=str(self.machines), volumes_tmp=str(self.volumes),
                             INVENTORY_INDEX=str(index), publish_tmp=str(output)),
                    capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, output.read_text() if output.exists() else result.stderr)
        projected = json.loads((index/'current/admission-machines.json').read_text())
        self.assertEqual(projected, [self.machine])
        state = dict(line.split('=', 1) for line in (index/'current/machines/1234567890abcd').read_text().splitlines())
        self.assertEqual(state['storage_ready'], '1')
        self.assertEqual(state['clone_cmd_inert'], '1')
        self.assertEqual(state['private_ip'], 'fdaa::1')
        self.assertFalse(self.marker.exists(), 'stdlib inventory publisher initialized venv site packages')


if __name__ == '__main__':
    unittest.main()
