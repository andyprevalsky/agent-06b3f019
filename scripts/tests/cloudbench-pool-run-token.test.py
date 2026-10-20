#!/usr/bin/env python3
"""Actual native-proof function with sanitized saved native/owner identity."""
import copy
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'run-bench-fleet'
OWNER = '64b71bd37fb64850ad5bfb6846e2bd11'
MACHINE = '897915b6626e18'
VOLUME = 'vol_vdenx0ngde0j0934'
REF = '71103debd6a713b2efec5d51ac3d0efe784590c3'
IMAGE = 'sha256:c9e5a26607181680d9b4c3d35eafe002b2bdc3858cb896feb501eb9ad67ece14'
# Identity/shape/REF are from the saved native inventory and V30 owner ledger.
# All other environment data is omitted; the separate barrier secret is replaced.
ROW = dict(id=MACHINE, name='cloudbench-native-proof-fixture', state='stopped', instance_id='fixture-instance',
           image_ref={'digest': IMAGE}, config=dict(image='registry/example@' + IMAGE,
           restart={'policy': 'no'}, init={'cmd': ['bash', '/cloudbench-boot.sh']},
           mounts=[{'volume': VOLUME, 'path': '/data'}], guest={'cpu_kind': 'shared', 'cpus': 4, 'memory_mb': 8192},
           env={'REF': REF, 'CLOUDBENCH_RUN_TOKEN': OWNER + '-0', 'CLOUDBENCH_BARRIER_TOKEN': 'sanitized-independent-barrier'}))


class NativeRunIdentity(unittest.TestCase):
    def proof(self, token=None, barrier=None, change_second=False, guest=None, sim_values=False):
        row = copy.deepcopy(ROW)
        if guest is not None:
            row['config']['guest'] = guest
        if token is not None:
            row['config']['env']['CLOUDBENCH_RUN_TOKEN'] = token
        if barrier is not None:
            row['config']['env']['CLOUDBENCH_BARRIER_TOKEN'] = barrier
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / OWNER
            run = root / 'run'
            registry.mkdir(); (run / 'task').mkdir(parents=True)
            (registry / 'meta').write_text(f'fleet_owner_token={OWNER}\napp=app\nruns_root={root}\nrun_id=run\n')
            (run / 'task/.cid').write_text('clone ' + MACHINE + '\n')
            rows = [row, copy.deepcopy(row)]
            if change_second:
                rows[1]['config']['guest']['memory_mb'] = 4096
            (root / 'rows.json').write_text(json.dumps(rows))
            (root / 'cloudbench-campaign-machines.py').write_text(
                'import json\nfrom pathlib import Path\ni=0\ndef fetch(*args):\n global i\n rows=json.loads(Path(__file__).with_name("rows.json").read_text())\n row=rows[i];i+=1\n return json.dumps(row)\n')
            (root / 'cloudbench_execution_provenance.py').write_text(
                "def load_provenance(path):\n return {'base_sha': '" + REF + "', 'config': {'values': {'primary_vm_size': 'shared-cpu-2x', 'primary_vm_memory_mb': '4096', 'bundled_frontend_vm_size': 'shared-cpu-4x', 'bundled_frontend_vm_memory_mb': '8192'" + (", 'sim_vm_size': 'performance-8x', 'sim_vm_memory_mb': '65536'" if sim_values else '') + "}}}\n"
                "def load_task_matrix(path):\n return {'tasks': [{'name': 'task'}]}\n"
                "def validate_task_matrix_binding(*args):\n return []\n")
            match = re.search(r'^pool_native_reuse_proof\(\).*?^}\n', SOURCE.read_text(), re.M | re.S)
            assert match
            script = match.group() + '\nCLOUDBENCH_SCRIPT_SNAPSHOT="$1"; APP=app; POOL_COLD_BOOTSTRAP=0\npool_native_reuse_proof "$2" cloudbench-native-proof-fixture "$3" "$4" "$1/$5"\n'
            return subprocess.run(['bash', '-c', script, 'test', directory, MACHINE, VOLUME, IMAGE, OWNER], capture_output=True, text=True)

    def test_saved_run_identity_with_distinct_barrier_is_accepted(self):
        result = self.proof()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['machine_id'], MACHINE)

    def test_barrier_cannot_substitute_for_wrong_run_identity(self):
        self.assertNotEqual(self.proof(token='wrong-0', barrier=OWNER + '-0').returncode, 0)

    def test_changing_barrier_does_not_change_run_identity(self):
        result = self.proof(barrier='another-sanitized-barrier')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_sim_shaped_primary_is_accepted_only_with_recorded_sim_shape(self):
        sim = {'cpu_kind': 'performance', 'cpus': 8, 'memory_mb': 65536}
        result = self.proof(guest=sim, sim_values=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(self.proof(guest=sim).returncode, 0)

    def test_changed_native_pair_still_refuses(self):
        self.assertNotEqual(self.proof(change_second=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
