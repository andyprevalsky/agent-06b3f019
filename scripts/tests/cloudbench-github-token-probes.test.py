#!/usr/bin/env python3
"""Offline owning-boundary controls for run-bench-cloud token validation."""
import base64
import json
import os
import shlex
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(os.environ.get('CLOUDBENCH_TOKEN_SOURCE', Path(__file__).resolve().parents[1] / 'run-bench-cloud'))

class TokenProbeCounts(unittest.TestCase):
    def run_case(self, *, b64='', gh='', ambient='', gh_env='', files=None, statuses=None, durable=False, statuses_next=None):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'back-end').mkdir(); (root/'agents').mkdir(); (root/'bin').mkdir()
            for name, values in (files or {}).items():
                (root/name/'.env').write_text(''.join(f'{key}={value}\n' for key,value in values.items()))
            source = SOURCE.read_text()
            functions = source[source.index('github_token_can_fetch_repo() {'):source.index('# Resolve the CONTROLLER GitHub token')]
            functions += source[source.index('token_to_git_auth_header() {'):source.index('resolve_controller_git_auth_header() {')]
            library = (SOURCE.parent/'lib/cloudbench-env.sh').read_text()
            functions += library[library.index('cloudbench_git_credential_github_token() {'):library.index('cloudbench_resolve_controller_github_token() {')]
            (root/'functions.sh').write_text(functions)
            (root/'bin'/'gh').write_text('''#!/usr/bin/env python3
import os,sys
assert sys.argv[1:] == ['auth','token','--hostname','github.com']
assert all(key not in os.environ for key in ['GITHUB_TOKEN','GH_TOKEN','GH_HOST'])
print(os.environ.get('FIXTURE_GH',''),end='')
''')
            (root/'bin'/'git').write_text('''#!/usr/bin/env python3
import base64,json,os,pathlib,stat,sys
args=sys.argv[1:]
assert os.environ['GIT_TERMINAL_PROMPT']=='0'
assert os.environ['GIT_ASKPASS']=='true'
if args[-2:]==['credential','fill']:
    assert args==['-c','credential.interactive=false','-C',os.environ['ROOT_DIR'],'credential','fill']
    assert sys.stdin.read()=='protocol=https\\n'+'host=github.com\\n'+'path=Rose-Ai-Labs/rose.git\\n\\n'
    sys.exit(0)
assert args==['-c','credential.helper=','ls-remote','--exit-code','https://github.com/Rose-Ai-Labs/rose.git','HEAD']
assert os.environ['GIT_CONFIG_NOSYSTEM']=='1'
p=pathlib.Path(os.environ['GIT_CONFIG_GLOBAL'])
assert stat.S_IMODE(p.stat().st_mode)==0o600
header=p.read_text().split('Authorization: Basic ',1)[1].strip()
credential=base64.b64decode(header).decode()
assert credential.startswith('x-access-token:')
token=credential.split(':',1)[1]
assert token not in args
with open(os.environ['FIXTURE_CALLS'],'a') as f: f.write(token+'\\n')
status=json.loads(os.environ['FIXTURE_STATUS']).get(token,'401')
sys.exit(0 if status=='200' else 7 if status=='transport-error' else 128)
''')
            (root/'bin'/'curl').write_text('#!/bin/sh\nexit 97\n')
            for p in (root/'bin').iterdir(): p.chmod(0o755)
            env = {k:v for k,v in os.environ.items() if not k.startswith(('GITHUB_','GH_','CLOUDBENCH_GITHUB_'))}
            env.update(PATH=str(root/'bin')+':'+os.environ['PATH'], ROOT_DIR=str(root), FIXTURE_GH=gh,
                       FIXTURE_CALLS=str(root/'calls'), FIXTURE_STATUS=json.dumps(statuses or {}),
                       GITHUB_TOKEN=ambient, GH_TOKEN=gh_env, GH_HOST='must-be-unset')
            if b64: env['CLOUDBENCH_GITHUB_TOKEN_B64']=base64.b64encode(b64.encode()).decode()
            command='source ./functions.sh; '+('resolve_durable_github_token' if durable else 'resolve_github_token')
            if statuses_next is not None:
                command += '; export FIXTURE_STATUS=' + shlex.quote(json.dumps(statuses_next)) + '; resolve_github_token'
            result=subprocess.run(['bash','-c',command],cwd=root,env=env,capture_output=True,text=True,timeout=10)
            calls=(root/'calls').read_text().splitlines() if (root/'calls').exists() else []
            print(json.dumps({'case':self._testMethodName,'calls':calls,'exit':result.returncode}))
            self.assertEqual(result.stderr,'')
            return result, calls

    def test_b64_success_does_not_probe_durable(self):
        result,calls=self.run_case(b64='injected',gh='cli',ambient='ambient',files={'back-end':{'GITHUB_DISPATCH_TOKEN':'durable'}},statuses={'injected':'200','durable':'200'})
        self.assertEqual(result.stdout,'injected'); self.assertEqual(calls,['injected'])

    def test_cli_success_precedes_env_and_durable(self):
        result,calls=self.run_case(b64='bad',gh='cli',ambient='ambient',files={'back-end':{'GITHUB_DISPATCH_TOKEN':'durable'}},statuses={'cli':'200','durable':'200'})
        self.assertEqual(result.stdout,'cli'); self.assertEqual(calls,['bad','cli'])

    def test_environment_fallback_then_lazy_durable(self):
        result,calls=self.run_case(ambient='ambient',files={'back-end':{'GITHUB_DISPATCH_TOKEN':'durable'}},statuses={'ambient':'200','durable':'200'})
        self.assertEqual(result.stdout,'ambient'); self.assertEqual(calls,['ambient'])

    def test_durable_success_is_not_revalidated(self):
        result,calls=self.run_case(files={'back-end':{'GITHUB_DISPATCH_TOKEN':'durable'}},statuses={'durable':'200'})
        self.assertEqual(result.stdout,'durable'); self.assertEqual(calls,['durable'])

    def test_duplicate_failed_candidates_are_once_per_resolution(self):
        result,calls=self.run_case(b64='bad',gh='bad',ambient='bad',files={'back-end':{'GITHUB_DISPATCH_TOKEN':'bad','GITHUB_TOKEN':'good'},'agents':{'GITHUB_DISPATCH_TOKEN':'bad','GITHUB_TOKEN':'good'}},statuses={'good':'200'})
        self.assertEqual(result.stdout,'good'); self.assertEqual(calls,['bad','good'])

    def test_durable_direct_keeps_priority_and_deduplicates(self):
        result,calls=self.run_case(durable=True,files={'back-end':{'GITHUB_DISPATCH_TOKEN':'bad','GITHUB_TOKEN':'good'},'agents':{'GITHUB_DISPATCH_TOKEN':'bad','GITHUB_TOKEN':'other'}},statuses={'good':'200','other':'200'})
        self.assertEqual(result.stdout,'good'); self.assertEqual(calls,['bad','good'])

    def test_all_invalid_fail_closed_and_transport_error_not_auth(self):
        result,calls=self.run_case(b64='bad',gh='bad',ambient='broken',files={'agents':{'GITHUB_TOKEN':'bad'}},statuses={'broken':'transport-error'})
        self.assertEqual(result.stdout,''); self.assertEqual(result.returncode,1); self.assertEqual(calls,['bad','broken'])

    def test_gh_token_environment_fallback_unchanged(self):
        result,calls=self.run_case(gh_env='gh-env',statuses={'gh-env':'200'})
        self.assertEqual(result.stdout,'gh-env'); self.assertEqual(calls,['gh-env'])

    def test_validation_is_fresh_in_same_shell(self):
        result,calls=self.run_case(b64='same',statuses={'same':'200'},statuses_next={'same':'401'})
        self.assertEqual(result.stdout,'same'); self.assertEqual(result.returncode,1)
        self.assertEqual(calls,['same','same'])

    def test_validation_is_fresh_on_next_resolution(self):
        for status, expected in [('200',0),('401',1)]:
            result,calls=self.run_case(b64='same',statuses={'same':status})
            self.assertEqual(result.returncode,expected); self.assertEqual(calls,['same'])

class MockServerCleanup(unittest.TestCase):
    def run_cleanup(self, *, delayed=False, early=False, cancelled=False, uncertain=False, failure=False):
        import signal
        import time
        root = Path(__file__).resolve().parents[2]
        source = (root / 'scripts/tests/cloudbench-github-token.test.sh').read_text()
        # Execute the exact owning shell cleanup, not a reimplementation.
        cleanup = source[source.index('TMP="$(mktemp -d)"'):source.index('LIVE_DISPATCH=')]
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            child = folder / 'server.py'
            child.write_text("""import http.server,json,os,signal,sys,time
from pathlib import Path
root=Path(sys.argv[1])
server=http.server.HTTPServer(('127.0.0.1',0),http.server.BaseHTTPRequestHandler)
raw=Path('/proc/self/stat').read_text().rsplit(') ',1)[1].split()
(root/'identity.json').write_text(json.dumps({'pid':os.getpid(),'birth':int(raw[19]),'parent':os.getppid(),'argv':sys.argv}))
if sys.argv[2]=='delay':
 def stop(sig,frame):
  signal.signal(signal.SIGTERM,signal.SIG_IGN)
  time.sleep(.2)
  signal.signal(signal.SIGTERM,signal.SIG_DFL)
  os.kill(os.getpid(),signal.SIGTERM)
 signal.signal(signal.SIGTERM,stop)
(root/'ready').touch()
while True: server.handle_request()
""")
            body = 'set -euo pipefail\n' + cleanup + '\nprintf %s "$TMP" > "$CASE_ROOT/temporary"\n'
            if early:
                body += 'exit 23\n'
            else:
                body += 'python3 "$CASE_ROOT/server.py" "$CASE_ROOT" ' + ('delay' if delayed else 'normal') + ' &\nSERVER_PID=$!\n'
                body += 'for i in $(seq 1 100); do [ ! -f "$CASE_ROOT/ready" ] || break; sleep .01; done\n[ -f "$CASE_ROOT/ready" ]\n'
                if uncertain:
                    body += 'wait() { return 127; }\n'
                body += 'kill -TERM $$\n' if cancelled else ('exit 23\n' if failure else 'exit 0\n')
            script = folder / 'case.sh';script.write_text(body)
            receipt = folder / 'receipt.json'
            process = subprocess.Popen(['python3',str(root/'scripts/cloudbench-local-supervisor.py'),
                '--receipt',str(receipt),'--','bash',str(script)],
                env={**os.environ,'CASE_ROOT':str(folder)},stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                stdout,stderr=process.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                process.terminate()
                stdout,stderr=process.communicate(timeout=10)
                self.fail('exact fixture supervisor exceeded bounded cleanup')
            result=json.loads(receipt.read_text())
            self.assertTrue(result['quiescent'],stderr.decode())
            self.assertEqual([],result['remaining'])
            identity=json.loads((folder/'identity.json').read_text()) if (folder/'identity.json').exists() else None
            if identity:
                self.assertFalse(Path('/proc',str(identity['pid'])).exists())
            retained=Path((folder/'temporary').read_text()).exists()
            if os.environ.get('CLOUDBENCH_JOIN_TEST_EVIDENCE'):
                evidence = Path(os.environ['CLOUDBENCH_JOIN_TEST_EVIDENCE'])
                evidence.mkdir(parents=True,exist_ok=True)
                target = Path(tempfile.mkdtemp(prefix='join-',dir=evidence))
                (target/'supervisor.json').write_text(json.dumps(result,indent=2)+'\n')
                (target/'identity.json').write_text(json.dumps(identity,indent=2)+'\n')
                (target/'stdout.log').write_bytes(stdout)
                (target/'stderr.log').write_bytes(stderr)
                (target/'case.sh').write_text(body)
                (target/'case.json').write_text(json.dumps({'delayed':delayed,'early':early,
                    'cancelled':cancelled,'uncertain':uncertain,'failure':failure,'retained':retained,
                    'supervisor_pid':process.pid,'supervisor_exit':process.returncode},indent=2)+'\n')
            if retained:
                # Only remove expected test evidence after native quiescence.
                import shutil
                shutil.rmtree(Path((folder/'temporary').read_text()))
            return process.returncode,result,retained,identity,stderr.decode()

    def test_delayed_term_is_joined_before_parent_exit(self):
        code,result,retained,identity,_=self.run_cleanup(delayed=True)
        self.assertEqual(0,code)
        self.assertEqual(0,result['native_exit'])
        self.assertFalse(result['orphaned_children'])
        self.assertEqual([],result['term_sent'])
        self.assertEqual([identity['parent']],[row['pid'] for row in result['reaped']])
        self.assertFalse(retained)

    def test_failure_before_assignment_keeps_original_status(self):
        _,result,retained,identity,_=self.run_cleanup(early=True)
        self.assertEqual(23,result['native_exit'])
        self.assertFalse(result['orphaned_children'])
        self.assertIsNone(identity)
        self.assertFalse(retained)

    def test_normal_and_cancelled_parent_join_owned_child(self):
        for cancelled in (False,True):
            with self.subTest(cancelled=cancelled):
                _,result,retained,_,_=self.run_cleanup(cancelled=cancelled)
                self.assertEqual(-15 if cancelled else 0,result['native_exit'])
                self.assertFalse(result['orphaned_children'])
                self.assertEqual([],result['term_sent'])
                self.assertFalse(retained)

    def test_failed_assertion_status_is_preserved_after_join(self):
        _,result,retained,_,_=self.run_cleanup(delayed=True,failure=True)
        self.assertEqual(23,result['native_exit'])
        self.assertFalse(result['orphaned_children'])
        self.assertFalse(retained)

    def test_unconfirmed_wait_retains_evidence_and_fails(self):
        _,result,retained,_,stderr=self.run_cleanup(delayed=True,uncertain=True)
        self.assertNotEqual(0,result['native_exit'])
        self.assertTrue(retained)
        self.assertIn('cleanup unconfirmed',stderr)

SLOW_PORT_ENV = 'CLOUDBENCH_TOKEN_TEST_SLOW_PORT_SECONDS'
# Emulates a loaded runner descheduling a mock server between creating its port
# file and writing the number (Path.write_text truncates first).
SLOW_PORT_SITECUSTOMIZE = f"""import os, pathlib, time
_write_text = pathlib.Path.write_text
def _stalled_write_text(self, data, *args, **kwargs):
    if self.name.startswith('port'):
        open(self, 'w').close()
        time.sleep(float(os.environ['{SLOW_PORT_ENV}']))
    return _write_text(self, data, *args, **kwargs)
pathlib.Path.write_text = _stalled_write_text
"""

# The suite runs this file, so its nested run under the stall must not recurse.
@unittest.skipIf(SLOW_PORT_ENV in os.environ, 'nested run inside the stalled-port regression')
class MockPortPublish(unittest.TestCase):
    def test_suite_never_reads_a_partially_published_mock_port(self):
        # PR #2338 deploy (2026-11-16): the rotation mock's empty port file made
        # ROT_GIT portless, failing "machine-env: delivered token was not valid
        # at delivery" on Blacksmith. Run the real suite with every port publish
        # stalled mid-write; offline only, so no live DISPATCH token.
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / 'sitecustomize.py').write_text(SLOW_PORT_SITECUSTOMIZE)
            env = {k: v for k, v in os.environ.items() if k != 'GITHUB_DISPATCH_TOKEN'}
            env.update({'PYTHONPATH': temp, SLOW_PORT_ENV: '0.5'})
            result = subprocess.run(['bash', str(root / 'scripts/tests/cloudbench-github-token.test.sh')],
                                    cwd=root, env=env, text=True, capture_output=True, timeout=240)
        self.assertEqual(0, result.returncode, result.stdout[-2000:] + result.stderr[-2000:])
        self.assertIn('ALL CHECKS PASSED', result.stdout)

if __name__ == '__main__': unittest.main()
