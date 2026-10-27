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
            (root/'functions.sh').write_text(functions)
            (root/'bin'/'gh').write_text('''#!/usr/bin/env python3
import os,sys
assert sys.argv[1:] == ['auth','token','--hostname','github.com']
assert all(key not in os.environ for key in ['GITHUB_TOKEN','GH_TOKEN','GH_HOST'])
print(os.environ.get('FIXTURE_GH',''),end='')
''')
            (root/'bin'/'curl').write_text('''#!/usr/bin/env python3
import json,os,pathlib,stat,sys
args=sys.argv[1:]
assert args[-1]=='https://api.github.com/repos/Rose-Ai-Labs/rose/contents'
assert args[args.index('--connect-timeout')+1]=='5'
assert args[args.index('--max-time')+1]=='15'
p=pathlib.Path(args[args.index('--config')+1])
assert stat.S_IMODE(p.stat().st_mode)==0o600
content=p.read_text(); token=content.split('Bearer ',1)[1].split('"',1)[0]
assert token not in args
with open(os.environ['FIXTURE_CALLS'],'a') as f: f.write(token+'\\n')
status=json.loads(os.environ['FIXTURE_STATUS']).get(token,'401')
if status=='transport-error': sys.exit(7)
print(status,end='')
''')
            for p in (root/'bin').iterdir(): p.chmod(0o755)
            env = {k:v for k,v in os.environ.items() if not k.startswith(('GITHUB_','GH_','CLOUDBENCH_GITHUB_'))}
            env.update(PATH=str(root/'bin')+':'+os.environ['PATH'], FIXTURE_GH=gh,
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

if __name__ == '__main__': unittest.main()
