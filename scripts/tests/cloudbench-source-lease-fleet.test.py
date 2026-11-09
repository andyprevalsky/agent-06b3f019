#!/usr/bin/env python3
"""Exercise the real fleet source admission when its exact native lease is lost."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import signal
import unittest
ROOT=Path(__file__).resolve().parents[2]
FLEET=Path(os.environ.get('CLOUDBENCH_FLEET_UNDER_TEST',str(ROOT/'scripts/run-bench-fleet')))

class FleetLease(unittest.TestCase):
    def run_admission(self, status, protocol='cloudbench-source-lease-v1'):
        source=FLEET.read_text()
        function=re.search(r'^private_fleet_source_admission\(\) \{.*?^\}',source,re.M|re.S).group(0)
        script='''private_source_lease_guard() { return "$LEASE_STATUS"; }
inventory_machine_field() { case "$2" in instance_id) echo native1;; state) echo stopped;; storage_ready) echo 1;; esac; }
PRIVATE_SOURCE_ID=11111111111111
PRIVATE_SOURCE_INSTANCE_ID=native1
'''+function+'\nprivate_fleet_source_admission\n'
        return subprocess.run(['bash','-c',script],env={**os.environ,'LEASE_STATUS':str(status),
            'PRIVATE_SOURCE_LEASE_PROTOCOL':protocol},capture_output=True,text=True,timeout=5)
    def test_term_resistant_owned_holder_has_bounded_join(self):
        source=FLEET.read_text()
        function=re.search(r'^private_source_holder_identity\(\) \{.*?^\}',source,re.M|re.S).group(0)+'\n'+re.search(r'^finish_private_source_lease\(\) \{.*?^\}',source,re.M|re.S).group(0)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)
            child_code="import os,signal,time,pathlib;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path(os.environ['CHILD_READY']).write_text(str(os.getpid()));time.sleep(60)"
            script='source "$HELPER"\n'+function+"\n"+"""
FLEET_DIR="$FIXTURE"
CLOUDBENCH_CHILD_TERM_SECONDS=1
python3 -c "$CHILD_CODE" &
PRIVATE_SOURCE_LEASE_PID=$!
while [ ! -f "$CHILD_READY" ]; do sleep 0.02; done
PRIVATE_SOURCE_LEASE_BIRTH="$(private_source_holder_identity)"
finish_private_source_lease
"""
            env={**os.environ,'ROOT_DIR':str(ROOT),'HELPER':str(ROOT/'scripts/lib/cloudbench-env.sh'),'FIXTURE':directory,
                 'CHILD_CODE':child_code,'CHILD_READY':str(path/'child.pid')}
            try:
                result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True,timeout=3)
                self.assertNotEqual(result.returncode,0)
                self.assertIn('durable claim retained',result.stderr)
            finally:
                pid_file=path/'child.pid'
                if pid_file.exists():
                    pid=int(pid_file.read_text())
                    try:
                        # This exact test child was launched above; never signal a pattern.
                        observed=Path('/proc',str(pid),'cmdline').read_bytes()
                        if child_code.encode() in observed: os.kill(pid,signal.SIGKILL)
                    except (FileNotFoundError,ProcessLookupError):pass

    def test_reused_holder_pid_is_never_signaled(self):
        source=FLEET.read_text()
        function=re.search(r'^finish_private_source_lease\(\) \{.*?^\}',source,re.M|re.S).group(0)
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory)/'signals'
            script="""
kill() { if [ "$1" = -0 ]; then return 0; fi; echo "$*" >> "$SIGNAL_MARKER"; }
ps() { echo S; }
wait() { return 0; }
PRIVATE_SOURCE_LEASE_PID=987654
PRIVATE_SOURCE_LEASE_BIRTH=original-birth
private_source_holder_identity() { echo foreign-birth; }
FLEET_DIR="$EMPTY_FLEET"
"""+function+'\nfinish_private_source_lease || true\n'
            r=subprocess.run(['bash','-c',script],env={**os.environ,'SIGNAL_MARKER':str(marker),
                'EMPTY_FLEET':directory},capture_output=True,text=True,timeout=3)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertFalse(marker.exists(),'foreign reused PID received signal')

    def test_lost_lease_refuses_new_clone_admission_despite_matching_inventory(self):
        self.assertNotEqual(self.run_admission(1).returncode,0)
    def test_held_lease_admits_exact_ready_source(self):
        r=self.run_admission(0);self.assertEqual(r.returncode,0,r.stderr)
    def test_legacy_source_does_not_require_new_protocol(self):
        r=self.run_admission(1,'none');self.assertEqual(r.returncode,0,r.stderr)
if __name__=='__main__':unittest.main()
