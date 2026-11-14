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


    def run_snapshot_init(self, reads):
        """Run the real start_machines_snapshot_loop with scripted Fly list reads.

        ``reads`` holds one native status per fly_with_timeout call (machines
        list, then volumes list, per refresh); ``sleep`` is logged, not slept.
        """
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root/'reads').write_text(''.join(f'{status}\n' for status in reads))
            machines = json.dumps([dict(id='1234567890abcd', name='warm-fixture', state='stopped',
                config=dict(mounts=[dict(volume='vol-fixture', path='/data')]))])
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(('CLOUDBENCH_', 'INVENTORY_'))}
            env.update(FLEET_DIR=str(root), APP='fixture', LOG=str(root/'log'), READS=str(root/'reads'),
                       MACHINES=machines, VOLUMES=json.dumps([dict(id='vol-fixture', state='created')]),
                       MACHINE_READINESS_SCRIPT=str(SOURCE/'scripts/cloudbench-machine-readiness.py'))
            script = (
                'source "$1"; source "$2"\n'
                'sleep() { echo "sleep $1" >> "$LOG"; }\n'
                'machines_snapshot_loop() { exec /bin/sleep 30; }\n'
                'fly_with_timeout() {\n'
                '  echo "read $3 timeout=$1" >> "$LOG"\n'
                '  local n status; n=$(grep -c "^read " "$LOG"); status=$(sed -n "${n}p" "$READS")\n'
                '  [ "$status" = 0 ] || return "$status"\n'
                '  if [ "$3" = list ] && [ "$2" = machines ]; then printf "%s" "$MACHINES"; else printf "%s" "$VOLUMES"; fi\n'
                '}\n'
                'status=0; start_machines_snapshot_loop || status=$?\n'
                '[ -z "${SNAPSHOT_LOOP_PID:-}" ] || kill "$SNAPSHOT_LOOP_PID"\n'
                'exit "$status"\n'
            )
            result = subprocess.run(['/bin/bash', '-c', script, 'fixture', str(SOURCE/'scripts/lib/cloudbench-env.sh'),
                                     str(SOURCE/'scripts/lib/cloudbench-inventory.sh')],
                                    env=env, capture_output=True, text=True, timeout=20)
            published = (root/'inventory/current/names/warm-fixture').exists()
            return result, (root/'log').read_text().splitlines(), published

    def test_snapshot_init_retries_one_slow_read_then_publishes(self):
        result, log, published = self.run_snapshot_init([0, 142, 0, 0])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('timed out (attempt 1/3)', result.stderr)
        self.assertEqual(log, ['read list timeout=30', 'read list timeout=30', 'sleep 2',
                               'read list timeout=30', 'read list timeout=30'])
        self.assertTrue(published)

    def test_snapshot_init_persistent_timeout_and_other_failures_refuse(self):
        result, log, published = self.run_snapshot_init([142] * 4)
        self.assertEqual(result.returncode, 1)
        self.assertIn('shared inventory snapshot did not initialize', result.stderr)
        self.assertEqual(log, ['read list timeout=30', 'sleep 2', 'read list timeout=30',
                               'sleep 5', 'read list timeout=30'])
        self.assertFalse(published)
        # A non-timeout failure (auth, missing app) is never retried.
        result, log, published = self.run_snapshot_init([1, 0])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(log, ['read list timeout=30'])
        self.assertFalse(published)


if __name__ == '__main__':
    unittest.main()
