#!/usr/bin/env python3
"""Exercise the actual shared readiness helper without network or new probes."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ReadinessDiagnosticsTests(unittest.TestCase):
    def test_existing_observations_survive_failure_without_changing_control_flow(self):
        source = Path(os.environ.get('READINESS_TEST_SOURCE',str(ROOT/'scripts/lib/cloudbench-env.sh'))).read_text()
        start=source.index('cloudbench_shared_proxy_start() {')
        helper=source[start:source.index('\ncloudbench_start_data_plane_proxy()',start)]
        scenarios=[('transport','000',7,True,3,2,1),('http','503',0,True,3,2,1),
                   ('dead_proxy','000',7,False,3,0,1),('no_budget','000',7,True,0,0,1),
                   ('healthy','204',0,True,3,1,0)]
        for name,http,curl_exit,alive,timeout,expected_probes,expected_return in scenarios:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                p=Path(tmp);(p/'clock').write_text('100');lease='a'*32
                script='''set -uo pipefail
ROOT_DIR="$1"
CLOUDBENCH_SHARED_RELAY_DIRECTORY="$2"
RUN_LOG_TOKEN=TOKEN_SECRET
mid=82d1477bed7678
printf '' > "$2/calls"
date() { local n; n=$(cat "$2/clock"); printf '%s\\n' "$n"; printf '%s' "$((n+1))" > "$2/clock"; }
'''
                # Keep fake state external because date/curl run in command substitutions.
                script=script.replace('"$2/clock"','"$FIXTURE/clock"')
                script+='''cloudbench_shared_relay_request() {
 printf '%s\\n' '{"lease":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","live_path":"'"$FIXTURE"'/leases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.live","live_value":"TOKEN_SECRET"}'
}
cloudbench_proxy_alive() { printf 'alive\\n' >> "$FIXTURE/calls"; [ "$ALIVE" = true ]; }
cloudbench_proxy_stop() { printf 'stop\\n' >> "$FIXTURE/calls"; }
cloudbench_status_proxy_lifecycle_response_accepted() { case "$1" in 204|410|425) return 0;; *) return 1;; esac; }
curl() { printf 'curl\\n' >> "$FIXTURE/calls"; printf '%s' "$HTTP"; return "$CURL_EXIT"; }
sleep() { printf 'sleep\\n' >> "$FIXTURE/calls"; }
'''+helper+'''
cloudbench_shared_proxy_start 9023 8011 private-ip "$FIXTURE/proxy.log" STATUS_PROXY_PID status "$LIMIT"
exit $?
'''
                env={**os.environ,'FIXTURE':tmp,'HTTP':http,'CURL_EXIT':str(curl_exit),'ALIVE':str(alive).lower(),'LIMIT':str(timeout)}
                result=subprocess.run(['bash','-c',script,'fixture',str(ROOT),tmp],env=env,capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,expected_return,result.stdout+result.stderr)
                calls=(p/'calls').read_text().splitlines();self.assertEqual(calls.count('curl'),expected_probes)
                self.assertEqual(calls.count('stop'),expected_return)
                log=(p/'proxy.log').read_text();self.assertNotIn('TOKEN_SECRET',log)
                self.assertNotIn('BODY_SECRET',log)
                if expected_return:
                    reason='proxy_not_alive' if not alive else 'deadline'
                    observed=http if expected_probes else 'not_probed'
                    code=str(curl_exit) if expected_probes else 'not_probed'
                    alive_value='false' if not alive else 'true' if expected_probes else 'not_checked'
                    self.assertIn(f'status readiness failed: reason={reason} last_http={observed} curl_exit={code} proxy_alive={alive_value}',log)
                else:self.assertNotIn('status readiness failed:',log)


    def test_unusable_acquire_response_releases_the_granted_lease(self):
        source = Path(os.environ.get('READINESS_TEST_SOURCE',str(ROOT/'scripts/lib/cloudbench-env.sh'))).read_text()
        start=source.index('cloudbench_shared_proxy_start() {')
        helper=source[start:source.index('\ncloudbench_start_data_plane_proxy()',start)]
        lease='b'*32
        scenarios=[('foreign_live_path','{"lease":"%s","live_path":"/elsewhere/%s.live","live_value":"V"}'%(lease,lease),[lease]),
                   ('missing_live_value','{"lease":"%s","live_path":"FIXTURE/leases/%s.live"}'%(lease,lease),[lease]),
                   ('invalid_lease','{"lease":"../x","live_path":"FIXTURE/leases/x.live","live_value":"V"}',[]),
                   ('not_json','not json',[])]
        for name,response,released in scenarios:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                script='''set -uo pipefail
CLOUDBENCH_SHARED_RELAY_DIRECTORY="$FIXTURE"
RUN_LOG_TOKEN=TOKEN
mid=82d1477bed7678
cloudbench_shared_relay_request() {
 case "$1" in
  acquire) printf '%s\\n' "${RESPONSE//FIXTURE/$FIXTURE}" ;;
  release) printf '%s %s %s\\n' "$2" "$3" "$4" >> "$FIXTURE/released" ;;
 esac
}
sleep() { :; }
'''+helper+'''
cloudbench_shared_proxy_start 9023 8011 private-ip "$FIXTURE/proxy.log" STATUS_PROXY_PID status 3
rc=$?
printf '%s|%s\\n' "${STATUS_PROXY_PID_LEASE:-}" "${STATUS_PROXY_PID_TOKEN:-}" > "$FIXTURE/published"
exit $rc
'''
                env={**os.environ,'FIXTURE':tmp,'RESPONSE':response}
                result=subprocess.run(['bash','-c',script],env=env,capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,1,result.stdout+result.stderr)
                path=Path(tmp)/'released'
                lines=path.read_text().splitlines() if path.exists() else []
                self.assertEqual(lines,['TOKEN-status-9023 --lease '+value for value in released])
                self.assertEqual((Path(tmp)/'published').read_text(),'|\n','an unusable lease is never published')

if __name__ == '__main__':unittest.main()
