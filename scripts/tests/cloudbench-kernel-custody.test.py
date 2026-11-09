#!/usr/bin/env python3
"""Guest launch custody with the real preload and a stub provider fetch only."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]

class GuestCustody(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.repo=Path(self.temp.name)/'guest repo;literal'
        self.guard=self.repo/'back-end/scripts/blackbox-kernel-proxy-custody.cjs'
        self.guard.parent.mkdir(parents=True)
        shutil.copyfile(ROOT/'back-end/scripts/blackbox-kernel-proxy-custody.cjs',self.guard)
        shutil.copyfile(ROOT/'back-end/scripts/verify-kernel-proxy-custody.cjs',self.guard.with_name('verify-kernel-proxy-custody.cjs'))
    def tearDown(self):self.temp.cleanup()
    def launch(self, probe, options='--max-old-space-size=128', policy='1'):
        source=(ROOT/'scripts/cloudbench-run.sh').read_text()
        match=re.search(r'^# Cloud guest Kernel proxy custody\n(.*?)^# End cloud guest Kernel proxy custody\n',source,re.M|re.S)
        fragment=match.group(1) if match else ''
        script='source "$HELPER"; STACK_ENV=(); log() { :; }; finish() { exit "$1"; }; gosu() { shift; "$@"; };\n'+fragment+'\nenv "${STACK_ENV[@]}" node -e "$PROBE"'
        env={**os.environ,'HELPER':str(ROOT/'scripts/lib/cloudbench-env.sh'),'REPO_DIR':str(self.repo),'APP_USER':'fixture','BENCH_TARGET_MODE_FOR_STACK':'local','CLOUDBENCH_KERNEL_PROXY_CUSTODY':policy,'NODE_OPTIONS':options,'PROBE':probe}
        return subprocess.run(['bash','-c',script],env=env,text=True,capture_output=True,timeout=8)
    def test_actual_guest_launch_blocks_allocation_but_preserves_reads_and_reuse(self):
        probe=r'''const assert=require('node:assert/strict');
assert.equal(globalThis[Symbol.for('rose.test.kernelProxyCustody')],true,'guest backend must preload custody');
let calls=[];const guard=require(process.env.GUARD_FOR_TEST);
guard.installKernelProxyCustody(async (url,init)=>{calls.push([String(url),init?.method||'GET']);return new Response('{}',{status:200});});
(async()=>{for(const url of ['https://api.onkernel.com/proxies','https://api.kernel.sh/proxies','https://api.onkernel.com/browsers','https://api.onkernel.com/profiles'])assert.equal((await fetch(url,{method:'POST'})).status,409);
assert.equal(calls.length,0);await fetch('https://api.onkernel.com/proxies');await fetch('https://api.onkernel.com/proxies/existing');await fetch('https://api.onkernel.com/browsers/existing');await fetch('https://api.onkernel.com/profiles/existing');assert.equal(calls.length,4);console.log('custody/read/reuse verified');})().catch(e=>{console.error(e);process.exitCode=1});'''
        with unittest.mock.patch.dict(os.environ,{'GUARD_FOR_TEST':str(self.guard)}):r=self.launch(probe)
        self.assertEqual(r.returncode,0,r.stderr)
    def test_missing_guard_stops_before_node(self):
        self.guard.unlink();r=self.launch("console.log('NODE_LAUNCHED')")
        self.assertNotEqual(r.returncode,0);self.assertNotIn('NODE_LAUNCHED',r.stdout)
    def test_invalid_guest_policy_cannot_disable_enforcement(self):
        for value in ('','true','2','1 '):
            with self.subTest(value=value):
                r=self.launch("console.log('NODE_LAUNCHED')",policy=value)
                self.assertNotEqual(r.returncode,0)
                self.assertNotIn('NODE_LAUNCHED',r.stdout)

    def test_existing_node_options_are_preserved(self):
        r=self.launch("const assert=require('node:assert/strict');assert.ok(process.env.NODE_OPTIONS.includes('--max-old-space-size=128'));assert.equal(globalThis[Symbol.for('rose.test.kernelProxyCustody')],true)")
        self.assertEqual(r.returncode,0,r.stderr)
    def verify_runtime(self, guarded):
        source=(ROOT/'scripts/cloudbench-run.sh').read_text()
        fragment=re.search(r'^# Cloud guest Kernel proxy verification\n(.*?)^# End cloud guest Kernel proxy verification\n',source,re.M|re.S).group(1)
        stub=self.repo/'stub-fetch.cjs'
        stub.write_text("globalThis.fetch=async()=>new Response('{}',{headers:"+json.dumps({'x-rose-kernel-proxy-custody':'enforced-v1','x-rose-kernel-resource-custody':'enforced-v1'} if guarded else {})+"});")
        script='log() { :; }; finish() { exit "$1"; }; gosu() { shift; "$@"; };\n'+fragment+'\necho TASKS_ADMITTED'
        env={**os.environ,'APP_USER':'fixture','REPO_DIR':str(self.repo),'BACKEND_PORT':'1',
             'CLOUDBENCH_KERNEL_PROXY_CUSTODY':'1','KERNEL_PROXY_NODE_OPTIONS':'--require="'+str(stub)+'"'}
        return subprocess.run(['bash','-c',script],env=env,text=True,capture_output=True,timeout=8)
    def test_runtime_unprotected_backend_is_rejected_before_tasks(self):
        r=self.verify_runtime(False)
        self.assertNotEqual(r.returncode,0);self.assertNotIn('TASKS_ADMITTED',r.stdout)
    def test_runtime_protected_backend_is_admitted(self):
        r=self.verify_runtime(True)
        self.assertEqual(r.returncode,0,r.stderr);self.assertIn('TASKS_ADMITTED',r.stdout)

    def test_controller_transfers_policy_bit_without_local_path(self):
        source=(ROOT/'scripts/run-bench-cloud').read_text()
        assignment='CLOUDBENCH_KERNEL_PROXY_CUSTODY="$(cloudbench_kernel_proxy_custody_policy)" || exit 1'
        self.assertIn(assignment,source)
        boot=next(line for line in source.splitlines() if '--env "CLOUDBENCH_KERNEL_PROXY_CUSTODY=' in line)
        ssh=next(line for line in source.splitlines() if 'echo "export CLOUDBENCH_KERNEL_PROXY_CUSTODY=' in line)
        for value,expected in [('--require=/controller/only/blackbox-kernel-proxy-custody.cjs','1'),('--max-old-space-size=128','0')]:
            script='source "$HELPER"; '+assignment+'; _envargs=( '+boot.strip()+' ); printf "%s\\n" "${_envargs[@]}"; '+ssh.strip()
            r=subprocess.run(['bash','-c',script],env={**os.environ,'HELPER':str(ROOT/'scripts/lib/cloudbench-env.sh'),'NODE_OPTIONS':value,'CLOUDBENCH_KERNEL_PROXY_CUSTODY':'0'},text=True,capture_output=True,timeout=8)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertIn('CLOUDBENCH_KERNEL_PROXY_CUSTODY='+expected,r.stdout)
            self.assertNotIn('/controller/only',r.stdout)
    def test_selected_policy_refuses_unverified_production_target_before_launch(self):
        source=(ROOT/'scripts/cloudbench-run.sh').read_text()
        fragment=re.search(r'^# Cloud guest Kernel proxy custody\n(.*?)^# End cloud guest Kernel proxy custody\n',source,re.M|re.S).group(1)
        script='source "$HELPER"; STACK_ENV=(); log() { :; }; finish() { exit "$1"; }; '+fragment+'\necho NODE_LAUNCHED'
        r=subprocess.run(['bash','-c',script],env={**os.environ,'HELPER':str(ROOT/'scripts/lib/cloudbench-env.sh'),'CLOUDBENCH_KERNEL_PROXY_CUSTODY':'1','BENCH_TARGET_MODE_FOR_STACK':'prod'},text=True,capture_output=True,timeout=8)
        self.assertNotEqual(r.returncode,0);self.assertNotIn('NODE_LAUNCHED',r.stdout)

    def test_unselected_policy_keeps_original_node_launch(self):
        source=(ROOT/'scripts/cloudbench-run.sh').read_text()
        fragment=re.search(r'^# Cloud guest Kernel proxy custody\n(.*?)^# End cloud guest Kernel proxy custody\n',source,re.M|re.S).group(1)
        self.guard.unlink()
        script='source "$HELPER"; STACK_ENV=(); log() { :; }; finish() { exit "$1"; }; '+fragment+'\n[ "${#STACK_ENV[@]}" = 0 ]'
        r=subprocess.run(['bash','-c',script],env={**os.environ,'HELPER':str(ROOT/'scripts/lib/cloudbench-env.sh'),'CLOUDBENCH_KERNEL_PROXY_CUSTODY':'0'},text=True,capture_output=True,timeout=8)
        self.assertEqual(r.returncode,0,r.stderr)

    def test_guest_readiness_requires_existing_runtime_verifier_before_tasks(self):
        source=(ROOT/'scripts/cloudbench-run.sh').read_text()
        self.assertIn('verify-kernel-proxy-custody.cjs',source)
        self.assertLess(source.index('verify-kernel-proxy-custody.cjs'),source.index('scripts/setup-benchmark-payment.ts'))
        self.assertIn('cloudbench_kernel_proxy_node_options',source)


class GuestBrowserProjection(unittest.TestCase):
    """Actual native contract with synthetic authenticated enum reads; no provider calls."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'agents').mkdir();(self.root/'back-end').mkdir()
        self.agents=self.root/'agents/.env';self.backend=self.root/'back-end/.env'
        self.agents.write_bytes(b'# worker\r\nexport BROWSER_PROVIDER="tilion"\r\nSECRET=never-output\r\n')
        self.backend.write_bytes(b'BROWSER_PROVIDER=tilion\nTILION_API_KEY=fixture-secret\nOTHER=unchanged\n')
        self.out=self.root/'private';self.out.mkdir(mode=0o700)
    def command(self, body):
        return subprocess.run(['bash','-c','source "$1"\n'+body,'fixture',str(ROOT/'scripts/lib/cloudbench-env.sh')],
             cwd=self.root,text=True,capture_output=True,timeout=8)
    def test_original_mismatch_then_native_projection_and_exact_hashes(self):
        before=(self.agents.read_bytes(),self.backend.read_bytes())
        red=self.command('cloudbench_validate_browser_provider_contract agents/.env back-end/.env tilion kernel')
        self.assertNotEqual(red.returncode,0);self.assertIn('local=tilion prod=kernel',red.stderr)
        source=(ROOT/'scripts/run-bench-cloud').read_text()
        function=source[source.index('validate_environment_contract() {'):source.index('\nmachine_state_for_activation()')]
        # Stub only native authenticated readback, never contract/projection.
        body=function+'\nresolve_prod_backend_browser_provider() { echo tilion; }; resolve_prod_worker_browser_provider() { echo kernel; }; cloudbench_require_agentcard_org_oauth() { return 0; };\nvalidate_environment_contract private'
        green=self.command(body)
        self.assertEqual(green.returncode,0,green.stderr)
        self.assertEqual((self.agents.read_bytes(),self.backend.read_bytes()),before)
        self.assertEqual((self.out/'agents.env').read_bytes(),before[0].replace(b'"tilion"',b'kernel'))
        self.assertEqual((self.out/'backend.env').read_bytes(),before[1])
        manifest=json.loads((self.out/'browser-projection.json').read_text())
        import hashlib
        for name,raw in zip(('agents.env','backend.env'),before):
            self.assertEqual(manifest['files'][name]['original_sha256'],hashlib.sha256(raw).hexdigest())
            self.assertEqual(manifest['files'][name]['projected_sha256'],hashlib.sha256((self.out/name).read_bytes()).hexdigest())
        self.assertNotIn('never-output',json.dumps(manifest));self.assertNotIn('fixture-secret',json.dumps(manifest))
        self.assertEqual(manifest['allowed_changes'],{'agents.env':['BROWSER_PROVIDER'],'backend.env':[]})
        self.assertEqual((self.out/'agents.env').stat().st_mode&0o777,0o600)
    def test_missing_duplicate_malformed_backend_mismatch_and_unknown_enum_refuse(self):
        for value in (b'SECRET=unchanged\n',b'BROWSER_PROVIDER=tilion\nBROWSER_PROVIDER=kernel\n',b'BROWSER_PROVIDER="tilion\n',b'BROWSER_PROVIDER=unknown\n'):
            self.agents.write_bytes(value)
            r=self.command('cloudbench_write_guest_browser_env_files agents/.env back-end/.env tilion kernel private')
            self.assertNotEqual(r.returncode,0)
        self.agents.write_bytes(b'BROWSER_PROVIDER=tilion\n')
        for enums in ('unknown kernel','kernel kernel','tilion unknown'):
            r=self.command('cloudbench_write_guest_browser_env_files agents/.env back-end/.env '+enums+' private')
            self.assertNotEqual(r.returncode,0)
    def test_projection_is_before_staging_and_manifest_binds_it(self):
        source=(ROOT/'scripts/run-bench-cloud').read_text()
        body=source[source.index('_inject_secrets_locked() {'):source.index('\nmaintenance_targets()')]
        self.assertLess(body.index('validate_environment_contract "$browser_env_dir"'),body.index('FLY secrets set --stage'))
        self.assertIn('local agents_src="$browser_env_dir/agents.env"',body)
        self.assertIn('"$agents_src" "$backend_src" "$guest_temporal_override"',body)
        self.assertIn('"browser_projection": json.load',body)

if __name__=='__main__':
    import unittest.mock
    unittest.main()
