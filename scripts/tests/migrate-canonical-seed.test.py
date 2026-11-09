"""Hermetic actual publication CLI readiness boundary; never invokes Docker/network."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
class CanonicalSeedReadiness(unittest.TestCase):
    def run_fixture(self,exhaust=False):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'scripts').mkdir();(root/'back-end/prisma').mkdir(parents=True);(root/'agents/venv/bin').mkdir(parents=True);(root/'bin').mkdir()
            shutil.copyfile(ROOT/'scripts/migrate-canonical-seed.sh',root/'scripts/migrate-canonical-seed.sh')
            (root/'back-end/prisma/schema.prisma').write_text('new')
            (root/'base.prisma').write_text('old');(root/'migration.sql').write_text('select 1;')
            helper='''#!/usr/bin/env python3
import os,sys
from pathlib import Path
p=Path(os.environ['CASE']);name=Path(sys.argv[0]).name;a=sys.argv[1:]
def record(s):
 with (p/'calls').open('a')as f:f.write(s+'\\n')
if name=='python':
 if a[0]=='-c':print('32123')
 else:print('new-token' if 'back-end/prisma' in a[1] else 'old-token')
elif name=='docker':
 record('docker '+' '.join(a))
 if a[0]=='exec':
  if '-h' not in a:sys.exit(0)
  n=int((p/'tcp').read_text())+1 if(p/'tcp').exists()else 1
  (p/'tcp').write_text(str(n));sys.exit(1 if os.environ.get('EXHAUST')=='1' or n<3 else 0)
elif name=='psql':
 record('psql')
 sys.exit(0 if (p/'tcp').exists() and int((p/'tcp').read_text())>=3 and os.environ.get('EXHAUST')!='1' else 42)
elif name=='npx':
 action=a[2];record('cache '+action)
 if action=='head':sys.exit(3)
 if action=='get':Path(a[4]).write_bytes(b'fixture')
elif name=='sleep':record('sleep')
'''
            for name in ['docker','psql','npx','sleep']:
                path=root/'bin'/name;path.write_text(helper);path.chmod(0o755)
            path=root/'agents/venv/bin/python';path.write_text(helper);path.chmod(0o755)
            for name in ['restore-seed-dump.sh','validate-canonical-seed-dump.sh']:(root/'scripts'/name).write_text('#!/bin/sh\nexit 0\n')
            (root/'scripts/save-seed-dump.sh').write_text('#!/bin/sh\nprintf fixture > "$1"\n')
            env={**os.environ,'PATH':str(root/'bin')+os.pathsep+os.environ['PATH'],'CASE':str(root),'EXHAUST':str(int(exhaust))}
            result=subprocess.run(['bash',str(root/'scripts/migrate-canonical-seed.sh'),'15',str(root/'base.prisma'),str(root/'migration.sql')],env=env,capture_output=True,text=True,timeout=10)
            return result,(root/'calls').read_text().splitlines(),int((root/'tcp').read_text())if(root/'tcp').exists()else 0
    def test_unix_ready_does_not_admit_tcp_client(self):
        result,calls,count=self.run_fixture()
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(count,3)
        self.assertIn('cache put',calls)
        self.assertEqual(calls.count('sleep'),2)
    def test_readiness_exhaustion_refuses_clients_and_publication(self):
        result,calls,count=self.run_fixture(True)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(count,60)
        self.assertNotIn('psql',calls)
        self.assertNotIn('cache put',calls)
        self.assertIn('TCP readiness exhausted',result.stderr)
        self.assertEqual(calls.count('sleep'),60)
if __name__=='__main__':unittest.main()
