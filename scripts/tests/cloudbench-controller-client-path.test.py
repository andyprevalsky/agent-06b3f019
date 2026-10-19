#!/usr/bin/env python3
"""Actual gate gosu/login shell and campaign publisher executable discovery."""
import hashlib,io,os,shlex,shutil,subprocess,tarfile,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
class ControllerClient(unittest.TestCase):
 def test_actual_gate_login_shell_reaches_campaign_inventory(self):
  gate=Path(os.environ.get('CLOUDBENCH_TEST_GATE_SOURCE',str(ROOT/'scripts/run-cloudbench-controller-gate'))).read_text()
  line=next(line.strip()for line in gate.splitlines()if line.strip().startswith("printf 'gosu rose bash -lc"))
  with tempfile.TemporaryDirectory(prefix='controller-client-entry-')as d:
   root=Path(d);root.chmod(0o777);repo=root/'repo';repo.mkdir();repo.chmod(0o755);(repo/'scripts').mkdir();(repo/'scripts').chmod(0o755);snapshot=repo/'snapshot';snapshot.mkdir();snapshot.chmod(0o755)
   for name,relative in [('cloudbench-env.sh','lib/cloudbench-env.sh'),('cloudbench-inventory.sh','lib/cloudbench-inventory.sh')]:
    (snapshot/name).write_bytes((ROOT/'scripts'/relative).read_bytes());(snapshot/name).chmod(0o644)
   prefix=(ROOT/'scripts/cloudbench-campaign-inventory.sh').read_text().split('FLY_API_TOKEN=',1)[0]
   (snapshot/'publisher.sh').write_text(prefix+'flyctl version\n');(snapshot/'publisher.sh').chmod(0o644)
   helper=ROOT/'scripts/cloudbench-install-controller-client.py'
   if helper.exists():
    archive=root/'fixture.tar.gz'
    official=os.environ.get('CLOUDBENCH_TEST_FLYCTL_ARCHIVE')
    if official:
     archive.write_bytes(Path(official).read_bytes());expected_sha='5041b9a563fff170fda4238b47048e9a5e714fc7ed2304668fd44bcdcd3bef83';expected_size=113733507
    else:
     c=root/'client.c';c.write_text('#include <stdio.h>\nint main(){puts("flyctl v0.4.115 linux/amd64");return 0;}\n')
     binary=root/'fake-client';subprocess.run(['cc',str(c),'-o',str(binary)],check=True,capture_output=True);raw=binary.read_bytes();expected_sha=hashlib.sha256(raw).hexdigest();expected_size=len(raw)
     with tarfile.open(archive,'w:gz')as tar:
      info=tarfile.TarInfo('flyctl');info.size=len(raw);tar.addfile(info,io.BytesIO(raw))
    archive.chmod(0o644)
    actual=repo/'scripts/actual-installer.py';actual.write_bytes(helper.read_bytes());actual.chmod(0o644)
    # Execute actual installer with its exact pinned production digest/version.
    # Only the HTTP fetch is replaced by the verified official local archive.
    (repo/'scripts'/helper.name).write_text('import runpy\nfrom pathlib import Path\ns=runpy.run_path('+repr(str(actual))+')\ns["install"].__globals__.update(BINARY_SHA256='+repr(expected_sha)+',BINARY_SIZE='+repr(expected_size)+')\ns["install"](Path('+repr(str(root/'bin'))+'),fetch=lambda:Path('+repr(str(archive))+').read_bytes())\n');(repo/'scripts'/helper.name).chmod(0o644)
   suite=shlex.join(['bash',str(snapshot/'publisher.sh'),str(repo),str(root),str(os.getpid())])
   rendered=subprocess.check_output(['bash','-c',line],env=dict(os.environ,suite=suite),text=True)
   gosu=os.environ.get('CLOUDBENCH_TEST_GOSU')or shutil.which('gosu')
   switch=[gosu,'65534:65534']if gosu else['/usr/bin/setpriv','--reuid=65534','--regid=65534','--clear-groups']
   rendered=rendered.replace('gosu rose',shlex.join(switch)).replace('/tmp/gate/repo',str(repo)).replace('/tmp/gate/bin',str(root/'bin')).replace('/tmp/gate/step-$n.log',str(root/'step.log'))
   command='export FLY_CONFIG_DIR='+shlex.quote(str(root/'config'))+'; n=1; '+rendered+'\nwait "$command_pid"\n'
   # sudo supplies an inaccessible root-owned client home; no HOME override.
   env=dict(os.environ,PATH='/usr/bin:/bin')
   result=subprocess.run(['sudo','-n','bash','-c',command],env=env,capture_output=True,text=True,timeout=20)
   output=(root/'step.log').read_text()if(root/'step.log').exists()else result.stdout+result.stderr
   try:
    self.assertEqual(result.returncode,0,output)
    self.assertIn('flyctl v0.4.115 linux/amd64',output)
    self.assertEqual(hashlib.sha256((root/'bin/flyctl').read_bytes()).hexdigest(),expected_sha)
   finally:subprocess.run(['sudo','-n','rm','-rf','--',str(root/'bin'),str(root/'config')],check=True)
if __name__=='__main__':unittest.main()
