"""Offline replay of late bind failure and a host pause near readiness expiry."""
from pathlib import Path
import os,subprocess,tempfile,unittest
ROOT=Path(__file__).resolve().parents[2]
class ProxyReviewTests(unittest.TestCase):
 def replay(self,body):
  with tempfile.TemporaryDirectory() as temp:
   script='''set -eu
source "$1"
D="$2"; APP=offline
cloudbench_shared_relay_enabled() { return 1; }
cloudbench_terminate_and_wait() { kill -TERM "$2" 2>/dev/null || true; wait "$2" 2>/dev/null || true; }
clock=0; echo 0 > "$D/clock"
date() { case "$*" in *+%s*) cat "$D/clock";; *) echo replay;; esac; }
'''+body
   return subprocess.run(['bash','-c',script,'replay',str(ROOT/'scripts/lib/cloudbench-env.sh'),temp],capture_output=True,text=True,timeout=10)
 def late_collision(self,before_call=''):
  r=self.replay('''sleep() { local n; n=$(cat "$D/clock"); echo $((n+1)) > "$D/clock"; case "$1" in 0.5) command sleep .01;; *) command sleep .10;; esac; }
mkfifo "$D/collision-release"
exec {COLLISION_FD}<>"$D/collision-release"
collision_cleanup() {
 local primary=$? child child_status
 trap - EXIT
 # Capture this private replay shell's own job identities in the parent shell.
 jobs -p > "$D/owned-jobs"
 printf 'release\n' >&"$COLLISION_FD"
 while IFS= read -r child; do
  child_status=0
  wait "$child" 2>/dev/null || child_status=$?
  printf 'collision cleanup joined=%s status=%s\n' "$child" "$child_status" >&2
 done < "$D/owned-jobs"
 exec {COLLISION_FD}>&-
 printf 'collision cleanup complete primary=%s\n' "$primary" >&2
 exit "$primary"
}
trap collision_cleanup EXIT
tail() {
 local status=0 arg is_proxy_log=0
 for arg in "$@"; do [ "$arg" != "$D/proxy.log" ] || is_proxy_log=1; done
 command tail "$@" || status=$?
 if [ "$is_proxy_log" = 1 ] && [ "$status" = 0 ]; then printf 'scan\n' >> "$D/events"; fi
 return "$status"
}
flyctl() { command sleep .04; IFS= read -r release <&"$COLLISION_FD"; echo 'listen tcp: bind: address already in use'; printf 'publication\n' >> "$D/events"; return 1; }
curl() { return 0; }
eval "$(declare -f cloudbench_charge_bounded_step | sed '1s/cloudbench_charge_bounded_step/original_charge/')"
cloudbench_charge_bounded_step() {
 # This original phase follows the initial log scan and post-probe settle.
 # Publish then join this exact fake child before the unchanged post-reap scan.
 case "$6" in 'backend proxy attempt '*)
  case "$6" in *retire|*wait) ;; *)
   PHASE_CHILD="$pid"
   printf 'release\n' >> "$D/events"
   printf 'release\n' >&"$COLLISION_FD"
   wait "$pid" 2>/dev/null || true
   printf 'join\n' >> "$D/events"
   touch "$D/released-after-first-scan"
  ;; esac
 ;; esac
 original_charge "$@"
}
'''+before_call+'''
rc=0; cloudbench_start_data_plane_proxy 61000 3001 host "$D/proxy.log" result backend 6 || rc=$?
[ -f "$D/released-after-first-scan" ] || { echo 'late collision phase was not exercised'; exit 92; }
[ "$(head -n 4 "$D/events")" = "$(printf 'scan\nrelease\npublication\njoin')" ] || { cat "$D/events"; echo 'late collision event order violated'; exit 93; }
[ "$rc" = 98 ] || { cat "$D/proxy.log"; echo "expected rotation98 got$rc"; exit 1; }
''')
  return r
 def test_collision_reported_after_initial_scan_returns_rotation(self):
  r=self.late_collision();self.assertEqual(r.returncode,0,r.stdout+r.stderr)
 def test_missing_phase_releases_and_joins_exact_child(self):
  r=self.late_collision('''cloudbench_start_data_plane_proxy() {
 flyctl proxy >> "$D/proxy.log" 2>&1 &
 return 0
}
''')
  self.assertEqual(r.returncode,92,r.stdout+r.stderr)
  self.assertIn('late collision phase was not exercised',r.stdout)
  self.assertIn('collision cleanup joined=',r.stderr)
  self.assertIn('status=1',r.stderr)
  self.assertIn('collision cleanup complete primary=92',r.stderr)
 def test_delayed_collision_is_joined_after_initial_scan(self):
  original=self.replay
  def delayed(body):
   # A child may be descheduled beyond the parent readiness sleeps.
   # Preserve its original .04 call and every parent polling/clock charge.
   return original(body.replace('flyctl() { command sleep .04;', 'flyctl() { command sleep .35; command sleep .04;', 1))
  self.replay=delayed
  try:self.test_collision_reported_after_initial_scan_returns_rotation()
  finally:self.replay=original
 def test_last_budget_step_stall_gets_one_fresh_observation(self):
  r=self.replay('''sleep() { local n increment=1; n=$(cat "$D/clock"); [ "$1" != 3 ] || increment=2; echo $((n+increment)) > "$D/clock"; command sleep .01; }
flyctl() { exec sleep 30; }
curl() {
 case " $* " in *" -w %{http_code} "*)
  if [ -f "$D/thawed" ]; then printf 204; else echo $(( $(cat "$D/clock") + 537 )) > "$D/clock"; touch "$D/thawed"; printf 000; fi;; esac
}
rc=0; result=''; cloudbench_start_data_plane_proxy 61000 3001 host "$D/proxy.log" result status 18 || rc=$?
[ "$rc" = 0 ] && [ -n "$result" ] || { cat "$D/proxy.log"; echo "fresh post-thaw observation missing rc=$rc"; exit 1; }
grep -q 'post-thaw probe charged=17 timeout=18\|post-thaw probe charged=18 timeout=18' "$D/proxy.log"
cloudbench_terminate_and_wait 1 "$result"
''');self.assertEqual(r.returncode,0,r.stdout+r.stderr)
 def test_repeated_stalls_cannot_reserve_unbounded_probes(self):
  r=self.replay('''sleep() { local n; n=$(cat "$D/clock"); echo $((n+1)) > "$D/clock"; command sleep .01; }
flyctl() { exec sleep 30; }
curl() {
 case " $* " in *" -w %{http_code} "*)
  count=$(cat "$D/probes" 2>/dev/null || echo 0); echo $((count+1)) > "$D/probes"
  echo $(( $(cat "$D/clock") + 537 )) > "$D/clock"; printf 000;; esac
}
rc=0; result=''; cloudbench_start_data_plane_proxy 61000 3001 host "$D/proxy.log" result status 18 || rc=$?
[ "$rc" = 1 ] && [ -z "$result" ] && [ "$(cat "$D/probes")" = 3 ] && [ "$(grep -c 'post-thaw probe' "$D/proxy.log")" = 1 ]
''');self.assertEqual(r.returncode,0,r.stdout+r.stderr)


 def test_remaining_budget_bounds_probe_and_single_monotone_charge(self):
  for timeout, expected_calls, expected_rc in ((5, 1, 1), (6, 1, 1), (7, 2, 0)):
   with self.subTest(timeout=timeout):
    r=self.replay(r'''sleep() { local n; n=$(cat "$D/clock"); echo $((n+1)) > "$D/clock"; command sleep .01; }
flyctl() { exec sleep 30; }
eval "$(declare -f cloudbench_charge_bounded_step | sed '1s/cloudbench_charge_bounded_step/original_charge/')"
cloudbench_charge_bounded_step() {
 local before=${!1}
 original_charge "$@"
 [ "${!1}" -ge "$before" ] || exit 91
 case "$6" in *wait)
  [ "${!1}" -le "$TEST_TIMEOUT" ] || exit 92
  echo "$4" >> "$D/wait-ceilings"
 ;; esac
}
curl() {
 case " $* " in *" -w %{http_code} "*)
  count=$(cat "$D/probes" 2>/dev/null || echo 0); echo $((count+1)) > "$D/probes"
  while [ "$#" -gt 0 ]; do if [ "$1" = --max-time ]; then shift; echo "$1" >> "$D/probe-limits"; break; fi; shift; done
  if [ "$count" = 0 ]; then echo $(( $(cat "$D/clock") + 537 )) > "$D/clock"; printf 000; else printf 204; fi
 ;; esac
}
rc=0; result=''
cloudbench_start_data_plane_proxy 61000 3001 host "$D/proxy.log" result status "$TEST_TIMEOUT" || rc=$?
[ "$rc" = "$EXPECTED_RC" ] && [ "$(cat "$D/probes" 2>/dev/null || echo 0)" = "$EXPECTED_CALLS" ] || { cat "$D/proxy.log"; exit 93; }
if [ "$EXPECTED_CALLS" -gt 0 ]; then
 [ "$(wc -l < "$D/wait-ceilings")" = 1 ] || exit 94
 sum=$(awk '{s+=$1} END{print s+1}' "$D/probe-limits")
 [ "$sum" -le "$(cat "$D/wait-ceilings")" ] || exit 95
fi
[ -z "$result" ] || cloudbench_terminate_and_wait 1 "$result"
'''.replace('$TEST_TIMEOUT',str(timeout)).replace('$EXPECTED_RC',str(expected_rc)).replace('$EXPECTED_CALLS',str(expected_calls)))
    self.assertEqual(r.returncode,0,r.stdout+r.stderr)


 def test_pause_during_wait_sleep_gets_fresh_observation(self):
  r=self.replay('''sleep() {
 local n; n=$(cat "$D/clock")
 if [ "$1" = 1 ] && [ ! -f "$D/thawed" ]; then
  echo $((n+537)) > "$D/clock"; touch "$D/thawed"
 else echo $((n+1)) > "$D/clock"; fi
 command sleep .01
}
flyctl() { exec sleep 30; }
curl() { case " $* " in *" -w %{http_code} "*)
 if [ -f "$D/thawed" ]; then printf 204; else printf 000; fi;; esac; }
rc=0; result=''; cloudbench_start_data_plane_proxy 61000 3001 host "$D/proxy.log" result status 18 || rc=$?
[ "$rc" = 0 ] && [ -n "$result" ] || { cat "$D/proxy.log"; exit 1; }
grep -q 'post-thaw probe charged=17 timeout=18' "$D/proxy.log"
cloudbench_terminate_and_wait 1 "$result"
''');self.assertEqual(r.returncode,0,r.stdout+r.stderr)


 def test_short_tail_zero_clock_progress_is_bounded_without_relaunch(self):
  r=self.replay(r'''sleep() { [ "$1" != 2 ] || echo 3 > "$D/clock"; command sleep .01; }
flyctl() { echo launch >> "$D/launches"; exec sleep 30; }
eval "$(declare -f cloudbench_charge_bounded_step | sed '1s/cloudbench_charge_bounded_step/original_charge/')"
cloudbench_charge_bounded_step() {
 local before=${!1}
 original_charge "$@"
 case "$6" in *wait)
  [ "${!1}" -gt "$before" ] && [ "${!1}" -le 3 ] || exit 91
  printf '%s\n' "${!1}" >> "$D/charges"
 ;; esac
}
curl() {
 case " $* " in *" -w %{http_code} "*)
  while [ "$#" -gt 0 ]; do if [ "$1" = --max-time ]; then shift; echo "$1" >> "$D/probe-limits"; break; fi; shift; done
  printf 503
 ;; esac
}
rc=0; result=''; cloudbench_start_data_plane_proxy 61000 3001 host "$D/proxy.log" result status 3 || rc=$?
[ "$rc" = 1 ] && [ -z "$result" ] && [ "$(wc -l < "$D/launches")" = 1 ] || exit 92
[ "$(tr '\n' ' ' < "$D/probe-limits")" = '2 1 1 ' ] || exit 93
[ "$(tr '\n' ' ' < "$D/charges")" = '1 2 3 ' ] || exit 94
''');self.assertEqual(r.returncode,0,r.stdout+r.stderr)


 def test_each_one_two_three_second_tail_observes_same_live_proxy(self):
  for remaining, limit in ((1, 1), (2, 1), (3, 2)):
   with self.subTest(remaining=remaining):
    r=self.replay(f"INITIAL={4-remaining}\nEXPECTED_LIMIT={limit}\n" + r'''sleep() {
 case "$1" in
  0.5) echo "$INITIAL" > "$D/clock";;
  2) echo $(( $(cat "$D/clock") + 2 )) > "$D/clock";;
 esac
 command sleep .01
}
flyctl() { echo launch >> "$D/launches"; exec sleep 30; }
curl() {
 case " $* " in *" -w %{http_code} "*)
  while [ "$#" -gt 0 ]; do if [ "$1" = --max-time ]; then shift; echo "$1" >> "$D/probe-limits"; break; fi; shift; done
  printf 425
 ;; esac
}
rc=0; result=''; cloudbench_start_data_plane_proxy 61000 3001 host "$D/proxy.log" result status 4 || rc=$?
[ "$rc" = 0 ] && [ -n "$result" ] || { cat "$D/proxy.log"; exit 91; }
[ "$(wc -l < "$D/launches")" = 1 ] && [ "$(cat "$D/probe-limits")" = "$EXPECTED_LIMIT" ] || exit 92
cloudbench_terminate_and_wait 1 "$result"
''')
    self.assertEqual(r.returncode,0,r.stdout+r.stderr)

 def test_invalid_timeout_rejected_before_dispatch(self):
  for value in ['0','-1','2.5','180s','9999999999999999999','08x',' 8']:
   with self.subTest(value=value):
    r=subprocess.run(['bash','-c','source "$1"; cloudbench_shared_relay_enabled(){ return 0; }; cloudbench_shared_proxy_start(){ echo DISPATCHED; }; cloudbench_start_data_plane_proxy 1 2 host /dev/null pid status "$2"','test',str(ROOT/'scripts/lib/cloudbench-env.sh'),value],capture_output=True,text=True,timeout=5)
    self.assertEqual(r.returncode,2,r.stdout+r.stderr);self.assertIn('Invalid proxy readiness timeout',r.stderr);self.assertNotIn('DISPATCHED',r.stdout)
 def test_decimal_defaults_and_invalid_settle(self):
  for value,expected in [('0008','8'),('180','180'),('999999999999999999','999999999999999999')]:
   r=subprocess.run(['bash','-c','source "$1"; cloudbench_shared_relay_enabled(){ return 0; }; cloudbench_shared_proxy_start(){ printf "%s" "$7"; }; cloudbench_start_data_plane_proxy 1 2 host /dev/null pid status "$2"','test',str(ROOT/'scripts/lib/cloudbench-env.sh'),value],capture_output=True,text=True,timeout=5)
   self.assertEqual((r.returncode,r.stdout),(0,expected),r.stderr)
  for settle,expected in [('bad','3'),('-1','3'),('1.2.3','3'),('NaN','3'),('1e309','3'),('.5','.5'),('0','0'),('3','3')]:
   with tempfile.TemporaryDirectory() as tmp:
    script='''source "$1"
D="$2"; echo 0 > "$D/clock"; APP=offline
cloudbench_shared_relay_enabled(){ return 1; }
date(){ if [ "$1" = +%s ]; then n=$(cat "$D/clock"); echo "$n"; echo $((n+1)) > "$D/clock"; else echo fixed; fi; }
sleep(){ printf '%s\\n' "$1" >> "$D/sleeps"; }
flyctl(){ return 1; }
curl(){ return 0; }
cloudbench_terminate_and_wait(){ wait "$2" 2>/dev/null || true; }
cloudbench_start_data_plane_proxy 1 2 host "$D/proxy.log" pid backend 1 || true
'''
    r=subprocess.run(['bash','-c',script,'test',str(ROOT/'scripts/lib/cloudbench-env.sh'),tmp],env={**os.environ,'CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS':settle},capture_output=True,text=True,timeout=5)
    self.assertEqual(r.returncode,0,r.stderr);values=(Path(tmp)/'sleeps').read_text().splitlines();self.assertIn(expected,values);self.assertNotIn(settle,values) if settle!=expected else None

if __name__=='__main__':unittest.main()
