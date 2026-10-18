#!/usr/bin/env python3
"""Actual startup-card and visibility helpers preserve packets/errors without site imports."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import subprocess
import unittest

ROOT=Path(__file__).resolve().parents[2]
SOURCE=Path(os.environ.get('CLOUDBENCH_FLEET_CARD_SOURCE',str(ROOT/'scripts/run-bench-fleet')))


def function(name):
    source=SOURCE.read_text();start=source.index(name+'() {')
    header_end=source.index('\n',start)+1
    following=re.search(r'^[A-Za-z_][A-Za-z_0-9]*\(\) ?\{',source[header_end:],re.M)
    return source[start:header_end+following.start()]if following else source[start:]


class CardStartup(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);venv=self.root/'venv';(venv/'bin').mkdir(parents=True)
        binary=Path(sys.executable).resolve();(venv/'bin/python3').symlink_to(binary)
        (venv/'pyvenv.cfg').write_text('home = '+str(binary.parent)+'\ninclude-system-site-packages = false\n')
        packages=venv/f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages';packages.mkdir(parents=True)
        self.marker=self.root/'site-started'
        (packages/'owning-control.pth').write_text('import os,time; os.close(os.open('+repr(str(self.marker))+',os.O_WRONLY|os.O_CREAT,0o600)); time.sleep(0.15)\n')
        self.env=dict(os.environ,PATH=str(venv/'bin')+':'+os.environ['PATH'])

    def test_actual_startup_card_preserves_exact_manifest_clock_and_errors(self):
        fleet=self.root/'fleet';phase='provisioning "fixture"\noriginal phase'
        script=function('write_startup_card')+'\nBENCHES=(first second); CATALOG_MODES=(real simulate); SIM_ON_CSV=""; write_startup_card "$PHASE"\n'
        env=dict(self.env,FLEET_DIR=str(fleet),RUN_ID='fixture-run',FLEET_CONTROLLER_STARTED_EPOCH='1700000000',PHASE=phase)
        result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True,timeout=3)
        self.assertEqual(result.returncode,0,result.stderr)
        expected=dict(run_id='fixture-run',timestamp='2023-11-14T22:13:20+00:00',status='starting',phase=phase,
                      summary=dict(total=2,passed=0,failed=0,status='starting: '+phase),
                      tasks=[dict(name=name,status='starting',phase=phase)for name in ('first','second')],
                      per_task=[dict(name=name,status='starting',phase=phase)for name in ('first','second')])
        self.assertEqual(json.loads((fleet/'_batch/report-card.json').read_text()),expected)
        self.assertEqual(json.loads((fleet/'_batch/benches.json').read_text()),[dict(name='first',mode='REAL'),dict(name='second',mode='SIM')])
        blocked=self.root/'blocked';blocked.write_text('retained')
        refused=subprocess.run(['bash','-c',script],env=dict(env,FLEET_DIR=str(blocked)),capture_output=True,text=True,timeout=3)
        self.assertNotEqual(refused.returncode,0);self.assertEqual(blocked.read_text(),'retained')
        self.assertFalse(self.marker.exists(),'startup-card writer initialized venv site packages')

    def test_actual_visibility_preserves_exact_run_retry_and_transport_refusal(self):
        page=self.root/'page';calls=self.root/'calls';sleeps=self.root/'sleeps'
        script='''
curl(){ printf 'call\\n' >> "$CALLS"; [ "$CURL_STATUS" = 0 ] || return "$CURL_STATUS"; cat "$PAGE"; }
sleep(){ printf '%s\\n' "$1" >> "$SLEEPS"; }
'''+function('require_central_hub_visibility')+'\nrequire_central_hub_visibility\n'
        for content,status,success in [(json.dumps(dict(run_id='fixture-run')),0,True),(json.dumps(dict(run_id='other-run')),0,False),('{broken',0,False),('',7,False)]:
            page.write_text(content)
            for path in (calls,sleeps):
                if path.exists():path.unlink()
            result=subprocess.run(['bash','-c',script],env=dict(self.env,PAGE=str(page),CALLS=str(calls),SLEEPS=str(sleeps),CURL_STATUS=str(status),RUN_ID='fixture-run',DASH_BASE='12345',CLOUDBENCH_HUB_VISIBILITY_ATTEMPTS='2',UNIFIED_DASH_PID=''),capture_output=True,text=True,timeout=3)
            self.assertEqual(result.returncode==0,success,result.stderr)
            self.assertEqual(len(calls.read_text().splitlines()),1 if success else 2)
            self.assertEqual(sleeps.read_text().splitlines()if sleeps.exists()else [],[]if success else ['0.2','0.2'])
            if not success:self.assertIn('benchmark run is not visible',result.stderr)
        self.assertFalse(self.marker.exists(),'visibility parser initialized venv site packages')


if __name__=='__main__':unittest.main()
