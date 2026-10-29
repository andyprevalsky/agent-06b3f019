#!/usr/bin/env python3
"""Actual canonical campaign producer -> child reserve/release -> next cohort."""

import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import time
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CAMPAIGN = runpy.run_path(str(ROOT / "scripts/run-bench-campaign.py"))
SHARD_EPOCH = 1792287011.18
READY_KEYS = {"schema", "cohort_id", "status", "ready_count", "failed_count",
              "expected_count", "survivor_count", "updated_at"}


def write_exclusive(path, value):
    """The coordinator's O_EXCL barrier write."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, json.dumps(value).encode())
    finally:
        os.close(descriptor)


class CampaignTickets(unittest.TestCase):
    def campaign_fixture(self, mode="pass", old=False, old_mutation=False, old_relay=False):
        with tempfile.TemporaryDirectory(
            prefix="cleanup-ticket-campaign-"
        ) as temporary:
            root = Path(temporary)
            scripts = root / "scripts"
            scripts.mkdir()
            for name in (
                "run-bench-campaign.py",
                "cloudbench-cleanup-tickets.py",
                # The campaign's fixed-total infra stop predicate.
                "cloudbench-shard-coordinator.py",
                "cloudbench-infra-canary-preflight.py",
                "cloudbench-provider-capacity.py",
                "cloudbench-provider-limits.json",
            ):
                shutil.copyfile(Path(os.environ["SAME_CLI_CAMPAIGN_SOURCE"]) if name == "run-bench-campaign.py" and os.environ.get("SAME_CLI_CAMPAIGN_SOURCE") else ROOT / "scripts" / name, scripts / name)
            if mode in ("external-member-retry", "external-member-exhausted"):
                campaign=scripts/"run-bench-campaign.py"
                injection = "\ndef released_attempt(workspace, job):\n    return dict(resources_released=True, lifecycle_verified=True, terminal_task=job['controller_exit_code']==0, infra_failure=job['controller_exit_code']==17)\n\n"
                campaign.write_text(campaign.read_text().replace('if __name__ == "__main__":', injection+'if __name__ == "__main__":'))
            if mode in ("ticket-prepare-fail", "ticket-assign-fail"):
                # Fail only the campaign parent's in-process call, as a raced
                # child exit or a ticket refusal would, keeping child CLIs real.
                action = mode.split("-")[1]
                with (scripts / "cloudbench-cleanup-tickets.py").open("a") as helper:
                    helper.write("\n_fixture_original_" + action + " = " + action + "\n"
                                 "def " + action + "(args):\n"
                                 "    if __name__ == 'cleanup_parent_identity':\n"
                                 "        raise ValueError('fixture cleanup ticket " + action + " refusal')\n"
                                 "    return _fixture_original_" + action + "(args)\n")
            if "external" in mode:
                # External modes join the actual per-fleet barrier helper.
                shutil.copyfile(ROOT / "scripts/cloudbench-campaign-barrier.py", scripts / "cloudbench-campaign-barrier.py")
            if mode.startswith(("mutation", "relay")):
                for name in ("cloudbench-campaign-mutation.py", "cloudbench-script-snapshot.py", "cloudbench-port-lease.py", "cloudbench-cohort-reconcile.py", "cloudbench-machine-readiness.py", "cloudbench-campaign-machines.py"):
                    shutil.copyfile(Path(os.environ["SAME_CLI_CAMPAIGN_SOURCE"]) if name == "run-bench-campaign.py" and os.environ.get("SAME_CLI_CAMPAIGN_SOURCE") else ROOT / "scripts" / name, scripts / name)
                (scripts / "lib").mkdir()
                for name in ("cloudbench-env.sh", "cloudbench-inventory.sh"):
                    shutil.copyfile(ROOT / "scripts/lib" / name, scripts / "lib" / name)
                if old_mutation:
                    (scripts / "run-bench-campaign.py").write_bytes(subprocess.check_output(
                        ["git", "show", "0000435cd1fab76a4285e7c97da6e8177eced026:scripts/run-bench-campaign.py"], cwd=ROOT))
                (scripts / "cloudbench-campaign-inventory.sh").write_text("#!/bin/bash\nexec python3 \"$FIXTURE_ROOT/publisher.py\" \"$2\" \"$3\"\n")
                (root / "publisher.py").write_text("""import os,sys,time,json
from pathlib import Path
p=Path(sys.argv[1]);parent=int(sys.argv[2])
def birth(pid):return 'proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()[19]
index=p/'inventory';index.mkdir();generation=index/'.generation-fixture';generation.mkdir()
(generation/'admission-machines.json').write_text('[]')
(generation/'health').write_text('publisher_token=fixture\\nvalid_until='+str(int(time.time())+120)+'\\ngeneration=.generation-fixture\\n')
(index/'current').symlink_to(generation.name)
(p/'owner').write_text(''.join(k+'='+str(v)+'\\n' for k,v in dict(app='navi-whisper-lux-bench',pid=os.getpid(),pid_start=birth(os.getpid()),token='fixture',parent_pid=parent,parent_start=birth(parent)).items()))
while not(p/'stop').exists():time.sleep(.01)
""")
                if mode.startswith("relay"):
                    for name in ("cloudbench-shared-relay.py", "run-bench-cloud", "run-bench-fleet"):
                        shutil.copyfile(Path(os.environ["SAME_CLI_CAMPAIGN_SOURCE"]) if name == "run-bench-campaign.py" and os.environ.get("SAME_CLI_CAMPAIGN_SOURCE") else ROOT / "scripts" / name, scripts / name)
                    if old_relay:
                        (scripts / "run-bench-campaign.py").write_bytes(subprocess.check_output(
                            ["git", "show", "ffe622243b8d704692fd3b69ab1d08eb1bb54040:scripts/run-bench-campaign.py"], cwd=ROOT))
                    publisher = (root / "publisher.py").read_text().replace("(generation/'admission-machines.json')", "(generation/'machines').mkdir()\n(generation/'machines'/'aaaaaaaaaaaaaa').write_text('private_ip=fd00::1\\ninstance_id=nested-new-instance\\n')\n(generation/'admission-machines.json')")
                    (root / "publisher.py").write_text(publisher)
                    fake = root / "bin"
                    fake.mkdir()
                    agent_fixture = ROOT / "scripts/tests/cloudbench-shared-transport-integration.test.py"
                    (fake / "flyctl").write_text("#!/usr/bin/env python3\n" + "import json,os,runpy,signal,sys,time\nfrom pathlib import Path\n" +
                        "if sys.argv[1]=='status': print(json.dumps({'Name':'navi-whisper-lux-bench','Organization':{'Slug':'fixture'},'Network':''}));raise SystemExit(0)\n" +
                        "if 'FLY_AGENT_ISOLATED' not in os.environ:\n with (Path(os.environ['FIXTURE_ROOT'])/'events').open('a') as f:f.write('DEFAULT_AGENT_ROUTE\\n')\n raise SystemExit(31)\n" +
                        "agent=runpy.run_path(" + repr(str(agent_fixture)) + ")['FakeUnixAgent'](Path(os.environ['FLY_AGENT_SOCKET_PATH']).parent,os.environ['FLY_AGENT_SOCKET_PATH'])\n" +
                        "signal.signal(signal.SIGTERM,lambda *a:sys.exit(0))\nprint('Proxying localhost:',flush=True)\ntry:\n while True:time.sleep(.02)\nfinally:agent.close()\n")
                    (fake / "flyctl").chmod(0o700)
                (scripts / "cloudbench-campaign-seed.py").write_text("import pathlib,sys\np=pathlib.Path(sys.argv[sys.argv.index('--barrier')+1]);(p/'seed-proof.private.json').write_text('{}')\n")
                if "external" in mode:
                    # A canonical fixture GET that only ends when interrupted.
                    (scripts / "cloudbench-campaign-seed.py").write_text(
                        "import os,pathlib,signal,sys,time\n"
                        "events=pathlib.Path(os.environ['FIXTURE_ROOT'])/'events'\n"
                        "def joined(*unused):\n with events.open('a') as f:f.write('SEED_JOINED\\n')\n sys.exit(143)\n"
                        "signal.signal(signal.SIGTERM,joined)\n"
                        "with events.open('a') as f:f.write('SEED_ENTER\\n')\n"
                        "while True:time.sleep(.05)\n")
            if old:
                (scripts / "run-bench-campaign.py").write_bytes(
                    subprocess.check_output(
                        [
                            "git",
                            "show",
                            "5a05e6590099f9cdf97f980574a5db99ff2f4289:scripts/run-bench-campaign.py",
                        ],
                        cwd=ROOT,
                    )
                )
            (scripts / "run-fleet-infra-canary").write_text(
                '#!/bin/bash\nexec bash "' + str(scripts / "run-bench") + '"\n'
            )
            source = (ROOT / "scripts/run-bench-fleet").read_text()
            start = source.index("reserve_cleanup_disk_space() {")
            end = source.index("\nreap_orphaned_fleet_proxies()", start)
            functions = source[start:end]
            (scripts / "run-bench").write_text(
                """#!/bin/bash
set -euo pipefail
ROOT_DIR="$FIXTURE_ROOT"
FLEET_OWNER_PID_START="$(python3 -c 'from pathlib import Path;import os;print("proc-start:"+Path("/proc/sys/kernel/random/boot_id").read_text().strip()+":"+Path("/proc/self/stat").read_text().rsplit(") ",1)[1].split()[19])')"
# Capture the shell's birth rather than its short-lived Python child.
FLEET_OWNER_PID_START="$(python3 - "$PPID" "$$" <<'BIRTH'
from pathlib import Path
import sys
print('proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+Path('/proc',sys.argv[2],'stat').read_text().rsplit(') ',1)[1].split()[19])
BIRTH
)"
CLEANUP_DISK_RESERVE_FILE="$FIXTURE_ROOT/.git/cloudbench-fleet-ownership/${RUN_BENCH_CAMPAIGN_JOB_ID:-__infra_canary__-$RUN_BENCH_CLEANUP_COHORT_ID}/cleanup-disk-reserve"
mkdir -p "$(dirname "$CLEANUP_DISK_RESERVE_FILE")"
"""
                + functions
                + """
trap release_cleanup_disk_reserve EXIT
if [[ "$FIXTURE_CANARY_MODE" != mutation* && "$FIXTURE_CANARY_MODE" != relay* ]]; then
 [ -z "${CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY:-}" ] || exit 94
 [ -z "${CLOUDBENCH_CAMPAIGN_INVENTORY_DIR:-}" ] || exit 95
 [ -z "${CLOUDBENCH_SHARED_RELAY_AUTHORITY:-}${CLOUDBENCH_SHARED_RELAY_DIRECTORY:-}${CLOUDBENCH_SHARED_RELAY_PID:-}${CLOUDBENCH_SHARED_RELAY_BIRTH:-}${CLOUDBENCH_SHARED_RELAY_AGENT_PID:-}${CLOUDBENCH_SHARED_RELAY_AGENT_BIRTH:-}" ] || exit 96
fi
if [[ "$FIXTURE_CANARY_MODE" == relay* ]]; then
 source "$FIXTURE_ROOT/scripts/lib/cloudbench-env.sh"
 APP=navi-whisper-lux-bench
 RUN_ID=fixture-nested
 RUN_LOG_TOKEN=fixture-nested
 mid=aaaaaaaaaaaaaa
 CLOUDBENCH_SCRIPT_SNAPSHOT="$FIXTURE_ROOT/scripts"
 if [ "$FIXTURE_CANARY_MODE" = relay-foreign ]; then CLOUDBENCH_SHARED_RELAY_AUTHORITY="$FIXTURE_ROOT/foreign-authority"; fi
 if [ "$FIXTURE_CANARY_MODE" = relay-source ]; then
  cp "$FIXTURE_ROOT/scripts/cloudbench-shared-relay.py" "$FIXTURE_ROOT/relay-original.py"
  trap 'cp "$FIXTURE_ROOT/relay-original.py" "$FIXTURE_ROOT/scripts/cloudbench-shared-relay.py"; release_cleanup_disk_reserve' EXIT
  printf "\\n# foreign relay source\\n" >> "$FIXTURE_ROOT/scripts/cloudbench-shared-relay.py"
 fi
 cloudbench_start_data_plane_proxy 0 3003 fd00::1 "$FIXTURE_ROOT/proxy-$$.log" proxy metrics 2
 printf 'SHARED_ROUTE:%s\\n' "${CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE:-0}" >> "$FIXTURE_ROOT/events"
 cloudbench_proxy_stop proxy
fi
if [[ "$FIXTURE_CANARY_MODE" == mutation* ]]; then
 source "$FIXTURE_ROOT/scripts/lib/cloudbench-env.sh"
 source "$FIXTURE_ROOT/production-fly.sh"
 APP=navi-whisper-lux-bench
 ROOT_DIR="$FIXTURE_ROOT"
 clone_timeout=5
 CLOUDBENCH_CAPACITY_RESERVATION_ROOT="$FIXTURE_ROOT/capacity"
 private_source_allows_provider_call() { return 0; }
 archived_reuse_sftp_get() { return 2; }
 archived_reuse_transport_args() { ARCHIVED_FLY_ARGS=("$@"); }
 flyctl() { printf 'PROVIDER_BOUNDARY:%s\\n' "${CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE:-0}" >> "$FIXTURE_ROOT/events"; }
 case "$FIXTURE_CANARY_MODE" in
  mutation-source) printf '\\n# changed source\\n' >> "$FIXTURE_ROOT/scripts/cloudbench-campaign-mutation.py" ;;
  mutation-foreign) CLOUDBENCH_CAMPAIGN_INVENTORY_DIR="$FIXTURE_ROOT/foreign" ;;
  mutation-dead) python3 - "$CLOUDBENCH_CAMPAIGN_INVENTORY_DIR" <<'DEAD'
import os,signal,sys,time
from pathlib import Path
p=Path(sys.argv[1])/'owner';owner=dict(line.split('=',1) for line in p.read_text().splitlines());pid=int(owner['pid'])
os.kill(pid,signal.SIGTERM)
for unused in range(100):
 try: state=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()[0]
 except FileNotFoundError: break
 time.sleep(.01)
with (Path(os.environ['FIXTURE_ROOT'])/'events').open('a') as stream:stream.write('PUBLISHER_RETIRED\\n')
DEAD
 ;;
 esac
 FLY machine clone fixture-source
fi
if [ "${CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE:-0}" = 1 ] && [ "$FIXTURE_CANARY_MODE" = foreign ]; then
 RUN_BENCH_CLEANUP_JOB=__foreign_preflight__
fi
reserve_cleanup_disk_space
if [ "${CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE:-0}" = 1 ]; then
 printf 'CANARY_ENTER\n' >> "$FIXTURE_ROOT/events"
 trap 'printf "CANARY_JOINED\n" >> "$FIXTURE_ROOT/events"; exit 143' TERM INT
 case "$FIXTURE_CANARY_MODE" in
  fail) exit 17 ;;
  cancel|relay-cancel|external-abort-canary|startup-canary) while :; do sleep .05; done ;;
 esac
 printf 'CANARY_DONE\n' >> "$FIXTURE_ROOT/events"
 exit 0
fi
printf 'TASK_START\n' >> "$FIXTURE_ROOT/events"
[ -n "${CLOUDBENCH_COHORT_PREFLIGHT_RECEIPT:-}" ] || exit 92
if [ "$FIXTURE_CANARY_MODE" = tamper ]; then CLOUDBENCH_COHORT_PREFLIGHT_SHA256=0000000000000000000000000000000000000000000000000000000000000000; fi
CLOUDBENCH_INFRA_CANARY_COLD_BOOTSTRAP="$FIXTURE_COLD" CLOUDBENCH_INFRA_CANARY_REF="$FIXTURE_BENCH_REF" python3 -S "$FIXTURE_ROOT/scripts/cloudbench-infra-canary-preflight.py" --stamp "$FIXTURE_ROOT/.context/fleet-infra-canary.last-pass" --lock "$FIXTURE_ROOT/.context/fleet-infra-canary-preflight.transaction.lock" --ttl-seconds 3600 --width 2 --canary "$FIXTURE_ROOT/scripts/run-fleet-infra-canary" --nested-controller-lock cloudbench-controller-infra-canary-preflight.lock
if [[ "$FIXTURE_CANARY_MODE" == external-member-* && "$RUN_BENCH_CAMPAIGN_JOB_ID" = r001-j0008 ]]; then
 if [ "$FIXTURE_CANARY_MODE" = external-member-exhausted ] || [ "${RUN_BENCH_CAMPAIGN_ATTEMPT:-1}" = 1 ]; then
  printf 'MEMBER_FAILED\n' >> "$FIXTURE_ROOT/events"
  exit 17
 fi
 printf 'MEMBER_RETRY_READY\n' >> "$FIXTURE_ROOT/events"
fi
if [ -n "${FIXTURE_BARRIER_SECONDS:-}" ]; then
 printf 'ENV|%s|%s|%s|%s|%s\n' "$RUN_BENCH_CAMPAIGN_JOB_ID" "$RUN_BENCH_CAMPAIGN_TOTAL_JOBS" "$RUN_BENCH_CAMPAIGN_STARTED_AT" "$BENCHMARK_HUB_GROUP_RUN_ID" "${RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER:-}${RUN_BENCH_CAMPAIGN_TASK_INDEXES:-}${RUN_BENCH_CAMPAIGN_GROUP_TOTAL:-}${RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT:-}" >> "$FIXTURE_ROOT/events"
 if python3 "$FIXTURE_ROOT/scripts/cloudbench-campaign-barrier.py" --deadline "$(python3 -c 'import sys,time;print(time.time()+float(sys.argv[1]))' "$FIXTURE_BARRIER_SECONDS")" --controller-pid "$$"; then
  printf 'BARRIER_RELEASED\n' >> "$FIXTURE_ROOT/events"
  exit 0
 fi
 printf 'BARRIER_FAILED\n' >> "$FIXTURE_ROOT/events"
 exit 1
fi
python3 - "$RUN_BENCH_CAMPAIGN_BARRIER_DIR" "$RUN_BENCH_CAMPAIGN_JOB_ID" "$$" <<'READY'
import json,sys,time
from pathlib import Path
cohort=Path(sys.argv[1]);job=sys.argv[2]
(cohort/'ready'/(job+'.json')).write_text(json.dumps(dict(cohort_id=cohort.name,job_id=job,controller_pid=int(sys.argv[3]),ready_at=time.time())))
end=time.monotonic()+10
while not(cohort/'release.json').exists():
 if time.monotonic()>end:raise TimeoutError('campaign did not release ready cohort')
 time.sleep(.01)
READY
"""
            )
            if mode.startswith(("mutation", "relay")):
                start = source.index("FLY() {")
                end = source.index("\nis_sim_on()", start)
                (root / "production-fly.sh").write_text(source[start:end])
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(root),
                    "-c",
                    "user.name=fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "commit",
                    "-qm",
                    "owning ticket source",
                ],
                check=True,
            )
            bench_ref = subprocess.check_output(
                ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
            ).strip()
            if mode == "explicit":
                subprocess.run(
                    [
                        "git",
                        "-C",
                        str(root),
                        "-c",
                        "user.name=fixture",
                        "-c",
                        "user.email=fixture@example.invalid",
                        "commit",
                        "--allow-empty",
                        "-qm",
                        "new harness same benchmark ref",
                    ],
                    check=True,
                )
            transport = root / "transport"
            transport.mkdir()
            device = int.from_bytes(os.urandom(5), "big")
            self.addCleanup(
                shutil.rmtree,
                Path("/tmp")
                / ("rose-cloudbench-cleanup-admission-" + str(os.getuid()))
                / str(device),
                ignore_errors=True,
            )
            (transport / "sitecustomize.py").write_text("""import os,stat
prefix=os.environ['FIXTURE_RESERVE_PREFIX']
def wrapper(original):
 def observed(path,*a,**k):
  value=original(path,*a,**k)
  if isinstance(path,(str,bytes,os.PathLike)) and os.path.abspath(os.fsdecode(path)).startswith(prefix) and stat.S_ISDIR(value.st_mode):
   fields=list(value);fields[2]=int(os.environ['FIXTURE_DEVICE']);return os.stat_result(fields)
  return value
 return observed
os.stat=wrapper(os.stat);os.lstat=wrapper(os.lstat)
""")
            env = dict(
                os.environ,
                PYTHONPATH=str(transport),
                FIXTURE_DEVICE=str(device),
                FIXTURE_RESERVE_PREFIX=str(root / ".git/cloudbench-fleet-ownership"),
                FIXTURE_ROOT=str(root),
                FIXTURE_CANARY_MODE=mode,
                FIXTURE_COLD="1" if mode == "explicit" else "0",
                FIXTURE_BENCH_REF=bench_ref,
                BENCHMARK_HUB_GROUP_RUN_ID="fixture",
                CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY="0",
                CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION="0",
                CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY="foreign-shell-authority",
                CLOUDBENCH_CAMPAIGN_INVENTORY_DIR="/foreign-shell-inventory",
                CLOUDBENCH_SHARED_RELAY_AUTHORITY="/foreign-shell-relay",
                CLOUDBENCH_SHARED_RELAY_DIRECTORY="/foreign-shell-relay",
                CLOUDBENCH_SHARED_RELAY_PID="9999999",
                CLOUDBENCH_SHARED_RELAY_BIRTH="foreign",
                CLOUDBENCH_SHARED_RELAY_AGENT_PID="9999998",
                CLOUDBENCH_SHARED_RELAY_AGENT_BIRTH="foreign",
                CLOUDBENCH_CLEANUP_DISK_RESERVE_MB="1",
                CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB="1",
                CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB="0",
            )
            for name in list(env):
                if name.startswith("RUN_BENCH_CAMPAIGN_") or name.startswith(
                    "RUN_BENCH_CLEANUP_"
                ):
                    env.pop(name)
            if old or old_relay:
                for key in list(env):
                    if key.startswith("CLOUDBENCH_SHARED_RELAY_"):
                        env.pop(key)
            if mode.startswith(("mutation", "relay")):
                env.pop("CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY", None)
                env.pop("CLOUDBENCH_CAMPAIGN_INVENTORY_DIR", None)
                env.update(CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY="1", CLOUDBENCH_CAMPAIGN_SHARED_RELAY="0", CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION="1")
                if mode.startswith("relay"):
                    env.update(CLOUDBENCH_CAMPAIGN_SHARED_RELAY="1", CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION="0", FLY_API_TOKEN="offline-fixture", PATH=str(root / "bin") + os.pathsep + env["PATH"])
                    # The relay claims its HOME's single WireGuard peer; never the operator's.
                    (root / "home").mkdir(mode=0o700, exist_ok=True)
                    env["HOME"] = str(root / "home")
            if "external" in mode:
                barrier = root / "external-barrier"
                barrier.mkdir(mode=0o700)
                env.update(
                    RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER=str(barrier),
                    # Global manifest positions of fixture-a/b/c in a 300-task
                    # manifest (600 = 300 tasks x 2 runs across all shards).
                    RUN_BENCH_CAMPAIGN_TASK_INDEXES="7,3,190",
                    RUN_BENCH_CAMPAIGN_GROUP_TOTAL="600",
                    RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT=repr(SHARD_EPOCH),
                    FIXTURE_BARRIER_SECONDS="6" if mode == "external-deadline" else "30",
                )
                # This 600-copy group exceeds the reviewed provider cap; select a
                # validated wide registry (every limit x100), never a skip.
                limits = json.loads((ROOT / "scripts/cloudbench-provider-limits.json").read_text())
                for row in limits["enforced"] + limits["informational"]:
                    row["limit"] *= 100
                (root / "provider-limits.json").write_text(json.dumps(limits))
                env["CLOUDBENCH_PROVIDER_LIMITS_FILE"] = str(root / "provider-limits.json")
            if mode == "fresh":
                stamp = root / ".context/fleet-infra-canary.last-pass"
                stamp.parent.mkdir(parents=True, exist_ok=True)
                stamp.write_text("retained canonical PASS\n")
                original_stamp_mtime = stamp.stat().st_mtime_ns
            argv = [
                sys.executable,
                str(scripts / "run-bench-campaign.py"),
                "--root",
                str(root),
                "--runs",
                "2",
                "--concurrency",
                "6" if "external" in mode else "3",
                "--task",
                "fixture-a",
                "--task",
                "fixture-b",
                "--task",
                "fixture-c",
                "--forward-arg=--strict-barrier",
            ]
            if mode.startswith("startup-"):
                epoch=time.time()-(901 if mode=="startup-expired" else 898)
                env["RUN_BENCH_CAMPAIGN_STARTUP_DEADLINE_EPOCH"]=str(epoch+9300-7200-1200)
                argv.extend(["--e2e-started-at",str(epoch),"--e2e-timeout","9300",
                             "--forward-arg=--timeout","--forward-arg=7200"])
            if mode == "explicit":
                argv.extend(
                    [
                        "--forward-arg=--ref",
                        "--forward-arg=" + bench_ref,
                        "--forward-arg=--cold-primary-bootstrap",
                    ]
                )
            if "external" in mode:
                return self.external_barrier_run(root, argv, env, mode)
            if mode in ("cancel", "relay-cancel"):
                child = subprocess.Popen(
                    argv,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                try:
                    deadline = time.monotonic() + 15
                    while not (root / "events").exists() or "CANARY_ENTER" not in (root / "events").read_text():
                        if child.poll() is not None or time.monotonic() > deadline:
                            raise AssertionError("parent canary did not enter")
                        time.sleep(0.02)
                    child.send_signal(signal.SIGTERM)
                    stdout, stderr = child.communicate(timeout=15)
                    result = subprocess.CompletedProcess(
                        argv, child.returncode, stdout, stderr
                    )
                finally:
                    if child.poll() is None:
                        child.terminate()
                        child.wait()
            else:
                result = subprocess.run(
                    argv, env=env, capture_output=True, text=True, timeout=25
                )
            summaries = list(
                (root / ".context/benchmarks/campaigns").glob("*/summary.json")
            )
            details = "\n".join(
                p.read_text()
                for p in (root / ".context/benchmarks/campaigns").rglob("*.log")
            )
            events = (
                (root / "events").read_text().splitlines()
                if (root / "events").exists()
                else []
            )
            if mode.startswith("startup-"):
                self.assertNotEqual(result.returncode,0,result.stdout+result.stderr+details)
                self.assertNotIn("TASK_START",events)
                self.assertFalse(list((root/".context/benchmarks/campaigns").glob("*/startup-cohorts/*/release.json")))
                self.assertEqual(len(summaries),1)
                self.assertTrue(json.loads(summaries[0].read_text())["startup_timeout_exceeded"])
                if mode=="startup-canary":
                    self.assertIn("CANARY_ENTER",events)
                    self.assertIn("CANARY_JOINED",events)
                return
            if mode.startswith("relay"):
                if old_relay or mode in ("relay-foreign", "relay-source", "relay-cancel"):
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr + details)
                    self.assertNotIn("TASK_START", events)
                    if old_relay:
                        self.assertIn("DEFAULT_AGENT_ROUTE", events)
                    else:
                        self.assertNotIn("DEFAULT_AGENT_ROUTE", events)
                    if mode == "relay-cancel":
                        self.assertIn("CANARY_JOINED", events)
                    return
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr + details)
                self.assertNotIn("DEFAULT_AGENT_ROUTE", events)
                self.assertEqual(events.count("SHARED_ROUTE:1"), 1)
                self.assertEqual(events.count("SHARED_ROUTE:0"), 6)
                self.assertLess(events.index("SHARED_ROUTE:1"), events.index("TASK_START"))
                return
            if mode.startswith("mutation"):
                if old_mutation or mode != "mutation":
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr + details)
                    self.assertNotIn("TASK_START", events)
                    self.assertFalse(any(x.startswith("PROVIDER_BOUNDARY:") for x in events))
                    if old_mutation:
                        self.assertIn("KeyError: 'CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'", details)
                    elif mode == "mutation-source":
                        self.assertIn("native mutation authority changed before execution", details)
                    elif mode == "mutation-foreign":
                        self.assertIn("foreign mutation admission inventory scope", details)
                    elif mode == "mutation-dead":
                        self.assertIn("PUBLISHER_RETIRED", events)
                    return
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr + details)
                self.assertEqual(events.count("PROVIDER_BOUNDARY:1"), 1)
                self.assertEqual(events.count("PROVIDER_BOUNDARY:0"), 6)
                self.assertLess(events.index("PROVIDER_BOUNDARY:1"), events.index("TASK_START"))
                return
            if mode in ("external-member-retry", "external-member-exhausted"):
                campaign=scripts/"run-bench-campaign.py"
                injection = "\ndef released_attempt(workspace, job):\n    return dict(resources_released=True, lifecycle_verified=True, terminal_task=job['controller_exit_code']==0, infra_failure=job['controller_exit_code']==17)\n\n"
                campaign.write_text(campaign.read_text().replace('if __name__ == "__main__":', injection+'if __name__ == "__main__":'))
            if mode in ("ticket-prepare-fail", "ticket-assign-fail"):
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr + details)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(len(summaries), 1)
                summary = json.loads(summaries[0].read_text())
                self.assertEqual(summary["status"], "failed")
                self.assertEqual(summary["cleanup_ticket_failure"], mode.split("-")[1])
                self.assertIn("finished_at", summary)
                self.assertTrue(all(job["status"] in ("failed", "cancelled") for job in summary["jobs"]), summary["jobs"])
                if mode == "ticket-prepare-fail":
                    self.assertNotIn("TASK_START", events)
                    self.assertNotIn("CANARY_ENTER", events)
                return
            if mode not in ("pass", "fresh", "explicit") or old:
                self.assertNotEqual(
                    result.returncode, 0, result.stdout + result.stderr + details
                )
                if old:
                    self.assertIn("TASK_START", events)
                    self.assertNotIn("CANARY_ENTER", events)
                elif mode == "tamper":
                    self.assertIn("TASK_START", events)
                    self.assertIn("receipt checksum differs", details)
                else:
                    self.assertNotIn("TASK_START", events)
                    if mode in ("cancel", "relay-cancel"):
                        self.assertIn("CANARY_JOINED", events)
                return
            self.assertEqual(
                result.returncode, 0, result.stdout + result.stderr + details
            )
            self.assertEqual(len(summaries), 1)
            summary = json.loads(summaries[0].read_text())
            self.assertEqual(summary["status"], "passed")
            self.assertEqual(len(summary["startup_cohorts"]), 2)
            # Unset shard variables keep the original schedule and projection.
            self.assertEqual([job["job_id"] for job in summary["jobs"]],
                             [f"r{1 + i // 3:03d}-j{i + 1:04d}" for i in range(6)])
            self.assertFalse({"external_barrier", "job_prefix", "group_total", "group_started_at"} & set(summary))
            self.assertEqual([path for path in root.rglob("*.json")
                              if "campaign-external-barrier-ready-v1" in path.read_text()], [])
            self.assertEqual(events.count("CANARY_DONE"), 0 if mode == "fresh" else 1)
            self.assertEqual(events.count("TASK_START"), 6)
            if mode != "fresh":
                self.assertLess(events.index("CANARY_DONE"), events.index("TASK_START"))
            self.assertEqual(summary["peak_concurrency"], 3)
            if mode == "fresh":
                self.assertEqual(stamp.stat().st_mtime_ns, original_stamp_mtime)
            for cohort in summaries[0].parent.joinpath("startup-cohorts").glob("c*"):
                receipt = json.loads(
                    (cohort / "infra-canary-preflight.pass.json").read_text()
                )
                self.assertEqual(
                    receipt["canary_pass_epoch"],
                    receipt["stamp_observation"]["mtime_ns"] / 1000000000,
                )
                if mode == "fresh":
                    self.assertEqual(receipt["check_kind"], "FRESH_STAMP")
                base = cohort / "cleanup-budget"
                self.assertTrue((base / "retired.json").exists())
                self.assertEqual(
                    len(list((base / "owners").glob("*/*/*.json"))),
                    3 if mode == "fresh" or cohort.name == "c002" else 4,
                )
                self.assertEqual(
                    len(list((base / "terminal").glob("*/*/*.released.json"))),
                    3 if mode == "fresh" or cohort.name == "c002" else 4,
                )
                budget = json.loads((base / "budget.json").read_text())
                self.assertFalse(
                    (
                        Path(budget["global_root"])
                        / "ticket-grants"
                        / (budget["global_budget_id"] + ".json")
                    ).exists()
                )

    def external_barrier_run(self, root, argv, env, mode):
        """Act as the sharded coordinator against one real strict campaign."""
        if mode in ("external-member-retry", "external-member-exhausted"):
            argv.extend(["--retry-infra","1"])
        barrier = Path(env["RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER"])
        events_path = root / "events"
        release_id = "a1" * 16

        def events():
            return events_path.read_text().splitlines() if events_path.exists() else []

        def status():
            try:
                return json.loads((barrier / "ready.json").read_text())["status"]
            except (OSError, ValueError, KeyError):
                return None

        child = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            def wait_until(check, label):
                deadline = time.monotonic() + 30
                while not check():
                    if child.poll() is not None or time.monotonic() > deadline:
                        if child.poll() is None:
                            child.terminate()
                        raise AssertionError(label + " was not reached: " + str(events()) + "".join(child.communicate()))
                    time.sleep(0.02)

            if mode in ("external-release", "external-abort", "external-member-retry"):
                wait_until(lambda: status() == "ready", "external readiness")
                cohort = next((root / ".context/benchmarks/campaigns").glob("*/startup-cohorts/c001"))
                self.assertEqual(len(list((cohort / "ready").glob("*.json"))), 6)
                time.sleep(0.5)
                # Every member is ready, yet no copy passes before the global release.
                self.assertEqual(status(), "ready")
                self.assertFalse((cohort / "release.json").exists())
                self.assertNotIn("BARRIER_RELEASED", events())
                if mode == "external-member-retry":
                    self.assertEqual(events().count("MEMBER_FAILED"),1)
                    self.assertIn("MEMBER_RETRY_READY",events())
                if mode in ("external-release", "external-member-retry"):
                    write_exclusive(barrier / "release.json", {
                        "schema": "campaign-external-barrier-release-v1",
                        "release_id": release_id, "released_at": "2026-10-18T00:00:00+00:00"})
                else:
                    write_exclusive(barrier / "abort.json", {
                        "schema": "campaign-external-barrier-abort-v1",
                        "release_id": release_id, "reason": "coordinator abort fixture"})
            elif mode in ("external-abort-canary", "mutation-external-abort-seed"):
                marker = "CANARY_ENTER" if mode == "external-abort-canary" else "SEED_ENTER"
                wait_until(lambda: marker in events(), marker)
                self.assertEqual(status(), "waiting")
                write_exclusive(barrier / "abort.json", {
                    "schema": "campaign-external-barrier-abort-v1",
                    "release_id": release_id, "reason": "coordinator abort fixture"})
            stdout, stderr = child.communicate(timeout=60)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait()
        observed = events()
        output = stdout + stderr + str(observed)
        (summary_path,) = (root / ".context/benchmarks/campaigns").glob("*/summary.json")
        summary = json.loads(summary_path.read_text())
        cohort = summary_path.parent / "startup-cohorts/c001"
        ready = json.loads((barrier / "ready.json").read_text())
        history = [item["status"] for item in summary["external_barrier"]["status_history"]]
        self.assertEqual(set(ready), READY_KEYS, output)
        self.assertEqual((ready["schema"], ready["cohort_id"], ready["expected_count"]),
                         ("campaign-external-barrier-ready-v1", "c001", 6))
        self.assertEqual(ready["status"], history[-1], output)
        self.assertEqual(len(summary["startup_cohorts"]), 1)
        self.assertEqual(list(barrier.glob(".*")), [], "atomic replace leaves no temporary file")
        if mode == "external-member-exhausted":
            self.assertNotEqual(child.returncode,0,output)
            self.assertEqual(observed.count("MEMBER_FAILED"),2)
            self.assertNotIn("BARRIER_RELEASED",observed)
            self.assertFalse((cohort/"release.json").exists())
            self.assertEqual(summary["startup_cohorts"][0]["status"],"aborted")
            self.assertEqual(sum(bool(j.get("infra_failure")) for j in summary["jobs"]),1)
            self.assertEqual(sum(j["status"]=="cancelled" for j in summary["jobs"]),5)
            return
        if mode in ("external-release", "external-member-retry"):
            self.assertEqual(child.returncode, 0, output)
            self.assertEqual(history, ["waiting", "ready", "released"])
            self.assertEqual((ready["ready_count"], ready["failed_count"], ready["survivor_count"]), (6, 0, 6))
            self.assertEqual(summary["external_barrier"]["release_id"], release_id)
            self.assertEqual(json.loads((cohort / "release.json").read_text())["cohort_id"], "c001")
            self.assertEqual(observed.count("BARRIER_RELEASED"), 6)
            self.assertEqual(summary["status"], "passed")
            expected = ["r001-j0008", "r001-j0004", "r001-j0191", "r002-j0308", "r002-j0304", "r002-j0491"]
            self.assertEqual([job["job_id"] for job in CAMPAIGN["campaign_jobs"](
                ["fixture-a", "fixture-b", "fixture-c"], 2, [7, 3, 190], 300)], expected)
            self.assertEqual([job["job_id"] for job in summary["jobs"]], expected)
            self.assertEqual(summary["total_jobs"], 6)
            self.assertEqual((summary["task_indexes"], summary["group_total"], summary["group_started_at"]),
                             ([7, 3, 190], 600, CAMPAIGN["campaign_group_timestamp"](SHARD_EPOCH)))
            # Cohort manifest and cleanup tickets carry the same global IDs.
            self.assertEqual(sorted(json.loads((cohort / "manifest.json").read_text())["jobs"]), sorted(expected))
            children = sorted(line.split("|")[1:] for line in observed if line.startswith("ENV|"))
            # Children publish the operator's group identity, size and clock;
            # shard controls themselves never reach a child fleet.
            self.assertEqual(children, sorted(
                [job, "600", CAMPAIGN["campaign_group_timestamp"](SHARD_EPOCH), "fixture", ""] for job in expected))
            self.assertFalse((summary_path.parent / "hub-group.json").exists(),
                             "a shard with a preset group never publishes its own group record")
            return
        self.assertNotEqual(child.returncode, 0, output)
        self.assertNotIn("BARRIER_RELEASED", observed)
        self.assertFalse((cohort / "release.json").exists())
        self.assertNotIn("released", history)
        if mode == "external-deadline":
            self.assertEqual(history[0], "waiting")
            self.assertIn("ready", history)
            self.assertEqual(history[-1], "failed")
            self.assertEqual(observed.count("BARRIER_FAILED"), 6)
            failed=sum(bool(job.get("startup_failed_before_release")) for job in summary["jobs"])
            self.assertGreaterEqual(failed,1)
            self.assertEqual((ready["failed_count"], ready["survivor_count"]), (failed,6-failed))
            self.assertEqual(summary["startup_cohorts"][0]["status"], "aborted")
            self.assertTrue({job["status"] for job in summary["jobs"]} <= {"failed","cancelled"})
            self.assertEqual(sum(job["status"]=="failed" for job in summary["jobs"]),failed)
            self.assertIsNone(summary["external_barrier"]["abort"])
            return
        self.assertEqual(history[-1], "aborted")
        self.assertEqual(json.loads((cohort / "abort.json").read_text())["reason"],
                         "external barrier abort: coordinator abort fixture")
        self.assertEqual((summary["external_barrier"]["abort"]["reason"], summary["external_barrier"]["abort"]["release_id"]),
                         ("coordinator abort fixture", release_id))
        self.assertEqual(summary["startup_cohorts"][0]["status"], "aborted")
        self.assertEqual({job["status"] for job in summary["jobs"]}, {"cancelled"})
        if mode == "external-abort":
            self.assertEqual(history, ["waiting", "ready", "aborted"])
            # Ready children observe the cohort abort through their own barrier.
            self.assertEqual(observed.count("BARRIER_FAILED"), 6)
        else:
            self.assertEqual(history, ["waiting", "aborted"])
            self.assertNotIn("TASK_START", observed)
            if mode == "external-abort-canary":
                self.assertIn("CANARY_JOINED", observed)
            else:
                self.assertIn("SEED_JOINED", observed)
                self.assertNotIn("CANARY_ENTER", observed)

    def test_explicit_startup_deadline_admits_no_late_task(self):
        self.campaign_fixture(mode="startup-expired")

    def test_explicit_startup_deadline_joins_active_canary(self):
        self.campaign_fixture(mode="startup-canary")

    def test_strict_member_retry_rejoins_full_cohort_then_releases(self):
        self.campaign_fixture(mode="external-member-retry")

    def test_strict_member_retry_exhaustion_aborts_without_partial_release(self):
        self.campaign_fixture(mode="external-member-exhausted")

    def test_external_barrier_holds_release_until_coordinator_release(self):
        self.campaign_fixture(mode="external-release")

    def test_external_abort_before_release_aborts_ready_cohort(self):
        self.campaign_fixture(mode="external-abort")

    def test_external_abort_interrupts_parent_canary_and_seed_preflight(self):
        for mode in ("external-abort-canary", "mutation-external-abort-seed"):
            with self.subTest(mode=mode):
                self.campaign_fixture(mode=mode)

    def test_external_barrier_without_release_fails_at_fleet_deadline(self):
        self.campaign_fixture(mode="external-deadline")

    def test_shard_environment_refused_before_campaign_artifacts(self):
        with tempfile.TemporaryDirectory(prefix="campaign-shard-refusal-") as temporary:
            root = Path(temporary)
            barrier = root / "barrier"
            barrier.mkdir(mode=0o700)
            base = {key: value for key, value in os.environ.items()
                    if not key.startswith(("RUN_BENCH_CAMPAIGN_", "BENCHMARK_HUB_", "CLOUDBENCH_STRICT"))}
            base["RUN_BENCH_CAMPAIGN_ROOT"] = str(root / "campaigns")
            strict = ["--forward-arg=--strict-barrier"]
            cases = [
                ("two cohorts", {"RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER": str(barrier)}, "3", strict, "exactly one startup cohort"),
                ("not strict", {"RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER": str(barrier)}, "6", [], "exactly one startup cohort"),
                ("relative barrier", {"RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER": "barrier"}, "6", strict, "existing absolute directory"),
                ("missing barrier", {"RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER": str(root / "absent")}, "6", strict, "existing absolute directory"),
            ]
            group = {"BENCHMARK_HUB_GROUP_RUN_ID": "operator-group"}
            indexed = {**group, "RUN_BENCH_CAMPAIGN_GROUP_TOTAL": "600"}
            cases.append(("indexes without total", {**group, "RUN_BENCH_CAMPAIGN_TASK_INDEXES": "0,1,2"}, "6", [], "requires RUN_BENCH_CAMPAIGN_GROUP_TOTAL"))
            cases.append(("total not runs multiple", {**group, "RUN_BENCH_CAMPAIGN_GROUP_TOTAL": "601", "RUN_BENCH_CAMPAIGN_TASK_INDEXES": "0,1,2"}, "6", [], "multiple of --runs"))
            for indexes in ("", "1,2", "0,1,2,3", "1,1,2", "0,1,300", "-1,2,3", "a,b,c", "01,2,3", "1, 2,3", "1,2,3,"):
                message = ("one per --task" if indexes in ("1,2", "0,1,2,3", "1,1,2", "0,1,300")
                           else "non-negative integers")
                cases.append(("indexes " + repr(indexes), {**indexed, "RUN_BENCH_CAMPAIGN_TASK_INDEXES": indexes}, "6", [], message))
            for total in ("0", "5", "abc", "-600", "100001", "06"):
                cases.append(("total " + total, {**group, "RUN_BENCH_CAMPAIGN_GROUP_TOTAL": total}, "6", [], "GROUP_TOTAL must be"))
            for started in ("nan", "inf", "-1", "0", "2026-10-18T00:00:00Z", ""):
                cases.append(("started " + started, {**group, "RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT": started}, "6", [], "positive finite epoch"))
            cases.append(("total without group", {"RUN_BENCH_CAMPAIGN_GROUP_TOTAL": "600"}, "6", [], "preset BENCHMARK_HUB_GROUP_RUN_ID"))
            cases.append(("start without group", {"RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT": "1792287011.18"}, "6", [], "preset BENCHMARK_HUB_GROUP_RUN_ID"))
            for label, extra, concurrency, forward, message in cases:
                with self.subTest(case=label):
                    result = subprocess.run(
                        [sys.executable, str(ROOT / "scripts/run-bench-campaign.py"), "--root", str(root),
                         "--runs", "2", "--concurrency", concurrency, "--task", "a", "--task", "b", "--task", "c", *forward],
                        env={**base, **extra}, capture_output=True, text=True, timeout=30)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(message, result.stderr)
                    self.assertFalse((root / "campaigns").exists(), "refusal precedes campaign artifacts")
                    self.assertEqual(list(barrier.iterdir()), [])

    def test_shard_job_lists_concatenate_into_one_unique_group_schedule(self):
        campaign_jobs, sharded = CAMPAIGN["campaign_jobs"], CAMPAIGN["sharded_campaign_jobs"]
        tasks = [f"task-{index}" for index in range(7)]
        single = campaign_jobs(tasks, 3)
        self.assertEqual([job["job_id"] for job in campaign_jobs(tasks[:2], 2)],
                         ["r001-j0001", "r001-j0002", "r002-j0003", "r002-j0004"])
        self.assertEqual(campaign_jobs(tasks, 3, list(range(7)), 7), single)
        for layout in ([[0, 1, 2], [3, 4], [5, 6]], [[0, 5, 2], [1, 3, 4, 6]], [[6], [0, 1, 2, 3, 4, 5]]):
            with self.subTest(layout=layout):
                shards = [{"tasks": [tasks[i] for i in indexes], "runs": 3, "task_indexes": indexes} for indexes in layout]
                lists = [campaign_jobs(shard["tasks"], 3, shard["task_indexes"], 7) for shard in shards]
                identifiers = [job["job_id"] for jobs in lists for job in jobs]
                # K shard lists concatenate to the single controller's unique IDs.
                self.assertEqual(len(identifiers), len(set(identifiers)))
                self.assertEqual(sorted(identifiers), sorted(job["job_id"] for job in single))
                self.assertEqual(sharded(shards, 7), single)
        self.assertEqual([job["job_id"] for job in campaign_jobs(["task-5", "task-1"], 2, [5, 1], 7)],
                         ["r001-j0006", "r001-j0002", "r002-j0013", "r002-j0009"])
        for indexes, total in (([0, 0], 7), ([0, 7], 7), ([0, -1], 7), ([0, True], 7), ([0], 7), ([0, 1], None)):
            with self.assertRaises(ValueError):
                campaign_jobs(tasks[:2], 3, indexes, total)
        with self.assertRaises(ValueError):
            campaign_jobs(tasks[:2], 3, None, 7)
        overlapping = [{"tasks": tasks[:2], "runs": 3, "task_indexes": [0, 1]},
                       {"tasks": tasks[1:3], "runs": 3, "task_indexes": [1, 2]}]
        with self.assertRaises(ValueError):
            sharded(overlapping, 7)
        with self.assertRaises(ValueError):
            sharded([], 7)
        combined = sharded([{"tasks": tasks[:3], "runs": 3, "task_indexes": [0, 1, 2]},
                            {"tasks": tasks[3:], "runs": 3, "task_indexes": [3, 4, 5, 6]}], 7)
        identifiers = [job["job_id"] for job in combined]
        state = CAMPAIGN["campaign_group_state"]("operator-group", SHARD_EPOCH, combined)
        record = CAMPAIGN["campaign_group_record"](state)
        self.assertEqual((record["run_id"], record["timestamp"]),
                         ("operator-group", CAMPAIGN["campaign_group_timestamp"](SHARD_EPOCH)))
        self.assertEqual([member["member_id"] for member in record["run_group"]["members"]], identifiers)
        self.assertEqual({outcome["status"] for outcome in record["run_group"]["outcomes"].values()}, {"queued"})
        self.assertEqual(CAMPAIGN["campaign_group_timestamp"](SHARD_EPOCH), "2026-10-18T01:30:11.180000+00:00")
        with self.assertRaises(ValueError):
            CAMPAIGN["campaign_group_state"]("operator-group", SHARD_EPOCH, combined + combined[:1])

    def test_parent_n2_and_workers_use_owned_shared_relay_without_default_agent(self):
        self.campaign_fixture(mode="relay")
        self.campaign_fixture(mode="relay", old_relay=True)

    def test_parent_n2_foreign_relay_never_falls_back_to_default_agent(self):
        for mode in ("relay-foreign", "relay-source", "relay-cancel"):
            with self.subTest(mode=mode):
                self.campaign_fixture(mode=mode)

    def test_parent_n2_and_workers_use_same_checked_mutation_authority(self):
        self.campaign_fixture(mode="mutation")
        self.campaign_fixture(mode="mutation", old_mutation=True)

    def test_parent_n2_mutation_guards_remain_fail_closed(self):
        for mode in ("mutation-source", "mutation-foreign", "mutation-dead"):
            with self.subTest(mode=mode):
                self.campaign_fixture(mode=mode)

    def test_actual_campaign_dispatches_independent_ticket_owners_and_retires_each_cohort(
        self,
    ):
        self.campaign_fixture()

    def test_old_campaign_forks_workers_before_shared_preflight(self):
        self.campaign_fixture(old=True)

    def test_foreign_parent_origin_never_forks_task_workers(self):
        self.campaign_fixture(mode="foreign")

    def test_parent_and_workers_bind_explicit_benchmark_ref_and_cold_policy(self):
        self.campaign_fixture(mode="explicit")

    def test_parent_reuses_existing_fresh_stamp_without_new_canary(self):
        self.campaign_fixture(mode="fresh")

    def test_child_rejects_changed_cohort_receipt(self):
        self.campaign_fixture(mode="tamper")

    def test_cleanup_ticket_prepare_failure_finalizes_failed_summary(self):
        self.campaign_fixture("ticket-prepare-fail")

    def test_cleanup_ticket_assign_failure_joins_child_and_finalizes_failed(self):
        self.campaign_fixture("ticket-assign-fail")

    def test_failed_parent_canary_never_forks_task_workers(self):
        self.campaign_fixture(mode="fail")

    def test_cancelled_parent_canary_is_joined_before_campaign_returns(self):
        self.campaign_fixture(mode="cancel")


if __name__ == "__main__":
    unittest.main()
