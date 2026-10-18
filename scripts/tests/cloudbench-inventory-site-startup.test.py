#!/usr/bin/env python3
"""Actual main publisher callsite skips irrelevant venv site initialization."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get('INVENTORY_SITE_SOURCE_ROOT', ROOT))


class InventorySiteStartup(unittest.TestCase):
    def test_actual_publisher_skips_site_and_preserves_ready_and_failed_states(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            venv = root/'venv'
            (venv/'bin').mkdir(parents=True)
            binary = Path(sys.executable).resolve()
            (venv/'bin/python3').symlink_to(binary)
            (venv/'pyvenv.cfg').write_text('home = '+str(binary.parent)+'\ninclude-system-site-packages = false\n')
            packages = venv/f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages'
            packages.mkdir(parents=True)
            marker = root/'site-started'
            (packages/'owning-control.pth').write_text(
                'import os,time; os.close(os.open('+repr(str(marker))+',os.O_WRONLY|os.O_CREAT,0o600)); time.sleep(0.15)\n'
            )
            source = (SOURCE/'scripts/lib/cloudbench-inventory.sh').read_text()
            match = re.search(r'^    python3[^\n]*"\$MACHINE_READINESS_SCRIPT" --publish-index \\\n[^\n]+', source, re.M)
            self.assertIsNotNone(match, 'actual publisher callsite missing')
            machines, volumes = root/'machines.json', root/'volumes.json'
            machines.write_text(json.dumps([dict(id='1234567890abcd', name='warm-fixture', state='stopped',
                instance_id='instance-fixture', private_ip='fdaa::1', config=dict(
                    init=dict(cmd=['sleep', 'infinity']), mounts=[dict(volume='vol-fixture', path='/data')]))]))
            env = dict(os.environ, PATH=str(venv/'bin')+':'+os.environ['PATH'],
                       MACHINE_READINESS_SCRIPT=str(SOURCE/'scripts/cloudbench-machine-readiness.py'),
                       machines_tmp=str(machines), volumes_tmp=str(volumes),
                       INVENTORY_INDEX=str(root/'index'), publish_tmp=str(root/'publish.log'),
                       CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN='owning-fixture')
            for key in ['CLOUDBENCH_INVENTORY_REFRESH_LOCK', 'CLOUDBENCH_INVENTORY_REFRESH_LOCK_TOKEN']:
                env.pop(key, None)
            for volume_state, ready, failed in [('created', '1', '0'), ('failed', '0', '1')]:
                volumes.write_text(json.dumps([dict(id='vol-fixture', state=volume_state)]))
                result = subprocess.run(['/bin/bash', '-c', 'status=0\n'+match.group(0)+'\nexit "$status"\n'],
                                        env=env, capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 0, (root/'publish.log').read_text())
                current = root/'index/current'
                fields = dict(line.split('=', 1) for line in (current/'machines/1234567890abcd').read_text().splitlines())
                self.assertEqual(fields['state'], 'stopped')
                self.assertEqual(fields['instance_id'], 'instance-fixture')
                self.assertEqual(fields['private_ip'], 'fdaa::1')
                self.assertEqual(fields['clone_cmd_inert'], '1')
                self.assertEqual(fields['storage_ready'], ready)
                self.assertEqual(fields['storage_failed'], failed)
                self.assertEqual((current/'names/warm-fixture').read_text(), '1234567890abcd\n')
                self.assertFalse(marker.exists(), 'stdlib publisher initialized venv site packages')


if __name__ == '__main__':
    unittest.main()
