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
assert.equal(globalThis[Symbol.for('rose.test.kernelResourceCustody')],true,'guest backend must refuse browser/profile allocation too');
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

if __name__=='__main__':
    import unittest.mock
    unittest.main()
