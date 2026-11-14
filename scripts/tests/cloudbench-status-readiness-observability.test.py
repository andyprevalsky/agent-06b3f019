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



class NativeReadinessTests(unittest.TestCase):
    """A live tunnel must retain its initialization progress until the deadline."""

    def run_native_proxy(self, scenario):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / 'bin'
            fake_bin.mkdir()
            fake_flyctl = fake_bin / 'flyctl'
            # The production launcher uses exec: supply an executable, not a shell function.
            fake_flyctl.write_text(r'''#!/usr/bin/env bash
set -uo pipefail
    printf '%s\n' "$BASHPID" >> "$FIXTURE/launches"
    printf '%s\n' "$BASHPID" > "$FIXTURE/current-pid"
    trap 'exit 0' TERM
    if [ "$SCENARIO" = dead-first ] && [ "$(wc -l < "$FIXTURE/launches")" = 1 ]; then
        exit 1
    fi
    while :; do command sleep 0.05; done
''')
            fake_flyctl.chmod(0o755)
            source = Path(os.environ.get('READINESS_TEST_SOURCE', str(ROOT / 'scripts/lib/cloudbench-env.sh')))
            script = r'''set -uo pipefail
source "$1"
APP=offline-readiness
CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS=0
proxy_pid=
printf '0\n' > "$FIXTURE/clock"
date() {
    if [ "$1" = +%s ]; then
        local ticks
        ticks=$(cat "$FIXTURE/clock")
        printf '%s\n' "$((ticks / 10))"
    else
        command date "$@"
    fi
}
sleep() {
    local ticks delta child="${!:-}" observed= remaining=500
    # Synchronize with the exact launched child without using wall time as
    # the controller's clock. Busy-host scheduling cannot spend its budget.
    if [ "$1" = 0.5 ]; then
        while [ "$remaining" -gt 0 ]; do
            observed=$(cat "$FIXTURE/current-pid" 2>/dev/null || true)
            [ "$observed" != "$child" ] || break
            command sleep 0.01
            remaining=$((remaining - 1))
        done
        [ "$observed" = "$child" ] || exit 91
        if [ "$SCENARIO" = dead-first ] && [ "$(wc -l < "$FIXTURE/launches")" = 1 ]; then
            wait "$child" || true
        fi
    fi
    case "$1" in 0.5) delta=5 ;; *) delta=$(($1 * 10)) ;; esac
    ticks=$(cat "$FIXTURE/clock")
    printf '%s\n' "$((ticks + delta))" > "$FIXTURE/clock"
}
curl() {
    local pid n=0 code=000
    pid=$(cat "$FIXTURE/current-pid")
    [ ! -f "$FIXTURE/probes-$pid" ] || n=$(cat "$FIXTURE/probes-$pid")
    n=$((n + 1))
    printf '%s\n' "$n" > "$FIXTURE/probes-$pid"
    # Model a WireGuard handshake which needs three observations in one
    # process incarnation; relaunching cannot inherit partial initialization.
    if [ "$SCENARIO" = rejected ]; then
        code=503
    elif [ "$n" -ge 3 ]; then
        code=425
    fi
    case " $* " in *" %{http_code} "*) printf '%s' "$code" ;; esac
    [ "$code" != 000 ]
}
# Real child ownership and reaping, without the production 5s grace interval.
cloudbench_terminate_and_wait() {
    shift
    local pid
    for pid in "$@"; do
        [ -n "$pid" ] || continue
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    done
}
cleanup() { cloudbench_terminate_and_wait 1 "${proxy_pid:-}"; }
trap cleanup EXIT
rc=0
cloudbench_start_data_plane_proxy 19023 8011 fd00::1 "$FIXTURE/proxy.log" proxy_pid status 5 || rc=$?
printf '%s\n' "$rc" > "$FIXTURE/result"
printf '%s\n' "$proxy_pid" > "$FIXTURE/published"
exit 0
'''
            environment = {key: value for key, value in os.environ.items()
                           if not key.startswith('CLOUDBENCH_SHARED_RELAY_')}
            environment.update(FIXTURE=temporary, SCENARIO=scenario,
                               PATH=str(fake_bin) + os.pathsep + environment.get('PATH', ''))
            result = subprocess.run(['bash', '-c', script, 'native-readiness', str(source)],
                                    env=environment, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            launches = (root / 'launches').read_text().splitlines()
            for pid in launches:
                with self.assertRaises(ProcessLookupError, msg='owned proxy was not reaped'):
                    os.kill(int(pid), 0)
            return (int((root / 'result').read_text()), launches,
                    (root / 'published').read_text().strip(),
                    (root / 'proxy.log').read_text())

    def test_initializing_tunnel_survives_unavailable_lifecycle(self):
        rc, launches, published, log = self.run_native_proxy('initializing')
        self.assertEqual(rc, 0, 'live tunnel initialization was repeatedly cancelled:\n' + log)
        self.assertEqual(len(launches), 1, 'HTTP 000 must not restart a live tunnel')
        self.assertEqual(published, launches[0])

    def test_dead_tunnel_is_replaced_before_readiness(self):
        rc, launches, published, log = self.run_native_proxy('dead-first')
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(launches), 2)
        self.assertEqual(published, launches[1])

    def test_rejected_lifecycle_still_fails_and_reaps_at_deadline(self):
        rc, launches, published, log = self.run_native_proxy('rejected')
        self.assertEqual(rc, 1, log)
        self.assertEqual(len(launches), 1, 'HTTP failures do not prove process failure')
        self.assertEqual(published, '')


if __name__ == '__main__':unittest.main()
