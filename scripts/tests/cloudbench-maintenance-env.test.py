#!/usr/bin/env python3
"""Real permission boundary through run-bench dispatch; fake Fly only."""
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/cloudbench-maintenance-env.py"


class MaintenanceEnv(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.base.chmod(0o755)
        self.sudo = shutil.which("sudo")
        self.privileged = os.getuid() == 0 or bool(self.sudo and subprocess.run(
            [self.sudo, "-n", "true"], capture_output=True).returncode == 0)
        self.uid = 1001 if self.privileged else os.getuid()
        self.gid = 1001 if self.privileged else os.getgid()
        self.stage = self.base / "stage"
        self.stage.mkdir(mode=0o700)
        if self.privileged:
            self.root(["chown", f"{self.uid}:{self.gid}", str(self.stage)])
        self.prepare = runpy.run_path(str(HELPER))["prepare_fly_config"]

    def root(self, args):
        command = args if os.getuid() == 0 else [self.sudo, "-n", *args]
        return subprocess.run(command, check=True, capture_output=True, text=True)

    def prepare_state(self):
        if self.privileged:
            self.root(["python3", str(HELPER), "--stage", str(self.stage),
                       "--uid", str(self.uid), "--gid", str(self.gid)])
            return self.stage / "fly-state"
        return self.prepare(self.stage, self.uid, self.gid)

    def test_exclusive_private_state_no_repair(self):
        path = self.prepare_state()
        value = path.stat()
        self.assertEqual((value.st_uid, value.st_mode & 0o777), (self.uid, 0o700))
        marker = path / "original"
        if self.privileged:
            self.root(["touch", str(marker)])
        else:
            marker.touch()
        before = path.stat()
        if self.privileged:
            result = subprocess.run(([self.sudo, "-n"] if os.getuid() else []) +
                ["python3", str(HELPER), "--stage", str(self.stage), "--uid", str(self.uid), "--gid", str(self.gid)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
        else:
            with self.assertRaises(FileExistsError): self.prepare_state()
        self.assertEqual(path.stat().st_ino, before.st_ino)
        self.assertTrue(marker.exists())

    def test_symlink_stage_refused(self):
        alias = self.base / "alias"
        alias.symlink_to(self.stage)
        with self.assertRaises(ValueError):
            self.prepare(alias, self.uid, self.gid)

    def test_actual_run_bench_auth_permission_boundary(self):
        # Root-owned non-writable default maps the observed /.fly permission
        # boundary into a disposable fixture; HOME remains the observed '/'.
        blocked = self.base / "default-fly"
        blocked.mkdir(mode=0o555)
        if self.privileged:
            self.root(["chown", "0:0", str(blocked)])
        binpath = self.base / "bin"; binpath.mkdir()
        fake = binpath / "flyctl"
        fake.write_text('''#!/usr/bin/env python3
import json,os,pathlib,sys
assert sys.argv[1:]==['auth','token','--json','--quiet']
assert os.environ['HOME']=='/'
assert os.environ['FLY_API_TOKEN']=='fm1r_fixture_selected_from_agents'
assert 'FLY_ACCESS_TOKEN' not in os.environ
pathlib.Path(os.environ['FIXTURE_RECEIPT']+'.client').write_text(json.dumps({'uid':os.getuid(),'home':os.environ['HOME'],'selected_source':'agents_dotenv','same_selected_token':True}))
p=pathlib.Path(os.environ.get('FLY_CONFIG_DIR',os.environ['FIXTURE_DEFAULT_CONFIG']))/'perms.fixture'
try:
 with p.open('xb'):pass
except PermissionError:
 pathlib.Path(os.environ['FIXTURE_RECEIPT']+'.failure').write_text('permission_denied')
 print('Error: failed ensuring config directory perms: open '+str(p)+': permission denied',file=sys.stderr);sys.exit(1)
print(json.dumps({'token':'fixture-refreshed-token'}))
''');fake.chmod(0o755)
        # Exact actual resolver and fresh-native reader from the fleet source.
        source = (ROOT / "scripts/run-bench-fleet").read_text()
        start = source.index("fleet_preconfig_native_read() {")
        end = source.index("\n}\n", start) + 3
        extracted = source[start:end]
        # Feed auth only: fetch's HTTP boundary is replaced before any provider call.
        fetch = self.base / "cloudbench-campaign-machines.py"
        fetch.write_text((ROOT / "scripts/cloudbench-campaign-machines.py").read_text() + '''\n_original_fetch=fetch
def fetch(app,seconds,machine_id=None):
 import time
 return (authorization(os.environ['FLY_API_TOKEN'],time.monotonic()+seconds)+'\\n').encode()
''')
        stub = self.base / "fleet.sh"
        stub.write_text('''set -euo pipefail
FLEET_DIR="$FIXTURE_BASE"
source "$FIXTURE_REPO/scripts/lib/cloudbench-inventory.sh"
FLY_API_TOKEN=$(resolve_fly_token);export FLY_API_TOKEN
APP=fixture
CLOUDBENCH_SCRIPT_SNAPSHOT="$FIXTURE_BASE"
''' + extracted + '\nfleet_preconfig_native_read abc123 "$FIXTURE_RECEIPT"\n')
        # Real internal run-bench parser/dispatcher receives the export argv.
        repo = self.base / "repo"; (repo / "agents").mkdir(parents=True)
        (repo / "agents/.env").write_text('FLY_API_TOKEN=fm1r_fixture_selected_from_agents\n')
        (repo / "scripts/lib").mkdir(parents=True)
        shutil.copyfile(ROOT / "scripts/lib/cloudbench-inventory.sh", repo / "scripts/lib/cloudbench-inventory.sh")
        # run-bench executes from its own repo; resolver's dotenv lookup is relative.
        stub.write_text(stub.read_text().replace('source "$FIXTURE_REPO/scripts/lib/cloudbench-inventory.sh"', 'cd "$FIXTURE_REPO"\nsource "$FIXTURE_REPO/scripts/lib/cloudbench-inventory.sh"'))
        env = {k:v for k,v in os.environ.items() if k not in {'FLY_API_TOKEN','FLY_BENCH_API_TOKEN','FLY_CONFIG_DIR','FLY_ACCESS_TOKEN'}}
        env.update(HOME='/', PATH=str(binpath)+':'+os.environ['PATH'], RUN_BENCH_FLEET_BIN_UNDER_TEST=str(stub),
            FIXTURE_REPO=str(repo), FIXTURE_BASE=str(self.base), FIXTURE_DEFAULT_CONFIG=str(blocked))
        request = self.base / "request.json"; request.write_text('{}')
        (repo/'scripts/run-bench').write_bytes((ROOT/'scripts/run-bench').read_bytes())
        command = ['bash',str(repo/'scripts/run-bench'),'--ref','6189d6e6cdbcc82d7715809daef25158e6834534','--cold-handoff-request',str(request),'a'*64]
        def invoke(name, state=None):
            e = dict(env, FIXTURE_RECEIPT=str(self.stage/name))
            if state is not None:e['FLY_CONFIG_DIR']=str(state)
            if self.privileged:
                def demote():os.setgroups([]);os.setgid(self.gid);os.setuid(self.uid)
                return subprocess.run(command,env=e,preexec_fn=demote,capture_output=True,text=True,timeout=10)
            return subprocess.run(command,env=e,capture_output=True,text=True,timeout=10)
        red=invoke('red.json');self.assertNotEqual(red.returncode,0);self.assertIn('selected session refresh refused',red.stderr)
        self.assertEqual((self.stage/'red.json.failure').read_text(),'permission_denied')
        state=self.prepare_state();green=invoke('green.json',state)
        self.assertEqual(green.returncode,0,green.stderr)
        self.assertEqual((self.stage/'green.json').read_text(),'Bearer fixture-refreshed-token\n')
        self.assertFalse((self.stage/'red.json').exists())
        red_context=json.loads((self.stage/'red.json.client').read_text());green_context=json.loads((self.stage/'green.json.client').read_text())
        self.assertEqual(red_context,green_context);self.assertEqual(red_context['uid'],self.uid)
        self.assertEqual(list(blocked.iterdir()),[])

if __name__ == '__main__':
    if os.getuid() != 0 and shutil.which('sudo') and subprocess.run(['sudo','-n','true'],capture_output=True).returncode == 0:
        raise SystemExit(subprocess.run(['sudo','-n',sys.executable,__file__,*sys.argv[1:]]).returncode)
    unittest.main()
