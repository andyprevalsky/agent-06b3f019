#!/usr/bin/env python3
"""Actual canonical campaign producer -> child reserve/release -> next cohort."""

import json
import os
from pathlib import Path
import shutil
import signal
import time
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class CampaignTickets(unittest.TestCase):
    def campaign_fixture(self, mode="pass", old=False, old_mutation=False):
        with tempfile.TemporaryDirectory(
            prefix="cleanup-ticket-campaign-"
        ) as temporary:
            root = Path(temporary)
            scripts = root / "scripts"
            scripts.mkdir()
            for name in (
                "run-bench-campaign.py",
                "cloudbench-cleanup-tickets.py",
                "cloudbench-infra-canary-preflight.py",
            ):
                shutil.copyfile(ROOT / "scripts" / name, scripts / name)
            if mode.startswith("mutation"):
                for name in ("cloudbench-campaign-mutation.py", "cloudbench-script-snapshot.py", "cloudbench-port-lease.py", "cloudbench-cohort-reconcile.py", "cloudbench-machine-readiness.py", "cloudbench-campaign-machines.py"):
                    shutil.copyfile(ROOT / "scripts" / name, scripts / name)
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
                (scripts / "cloudbench-campaign-seed.py").write_text("import pathlib,sys\np=pathlib.Path(sys.argv[sys.argv.index('--barrier')+1]);(p/'seed-proof.private.json').write_text('{}')\n")
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
if [[ "$FIXTURE_CANARY_MODE" != mutation* ]]; then
 [ -z "${CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY:-}" ] || exit 94
 [ -z "${CLOUDBENCH_CAMPAIGN_INVENTORY_DIR:-}" ] || exit 95
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
  cancel) while :; do sleep .05; done ;;
 esac
 printf 'CANARY_DONE\n' >> "$FIXTURE_ROOT/events"
 exit 0
fi
printf 'TASK_START\n' >> "$FIXTURE_ROOT/events"
[ -n "${CLOUDBENCH_COHORT_PREFLIGHT_RECEIPT:-}" ] || exit 92
if [ "$FIXTURE_CANARY_MODE" = tamper ]; then CLOUDBENCH_COHORT_PREFLIGHT_SHA256=0000000000000000000000000000000000000000000000000000000000000000; fi
CLOUDBENCH_INFRA_CANARY_COLD_BOOTSTRAP="$FIXTURE_COLD" CLOUDBENCH_INFRA_CANARY_REF="$FIXTURE_BENCH_REF" python3 -S "$FIXTURE_ROOT/scripts/cloudbench-infra-canary-preflight.py" --stamp "$FIXTURE_ROOT/.context/fleet-infra-canary.last-pass" --lock "$FIXTURE_ROOT/.context/fleet-infra-canary-preflight.transaction.lock" --ttl-seconds 3600 --width 2 --canary "$FIXTURE_ROOT/scripts/run-fleet-infra-canary" --nested-controller-lock cloudbench-controller-infra-canary-preflight.lock
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
            if mode.startswith("mutation"):
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
                CLOUDBENCH_CLEANUP_DISK_RESERVE_MB="1",
                CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB="1",
                CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB="0",
            )
            for name in list(env):
                if name.startswith("RUN_BENCH_CAMPAIGN_") or name.startswith(
                    "RUN_BENCH_CLEANUP_"
                ):
                    env.pop(name)
            if mode.startswith("mutation"):
                env.pop("CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY", None)
                env.pop("CLOUDBENCH_CAMPAIGN_INVENTORY_DIR", None)
                env.update(CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY="1", CLOUDBENCH_CAMPAIGN_SHARED_RELAY="0", CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION="1")
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
                "3",
                "--task",
                "fixture-a",
                "--task",
                "fixture-b",
                "--task",
                "fixture-c",
                "--forward-arg=--strict-barrier",
            ]
            if mode == "explicit":
                argv.extend(
                    [
                        "--forward-arg=--ref",
                        "--forward-arg=" + bench_ref,
                        "--forward-arg=--cold-primary-bootstrap",
                    ]
                )
            if mode == "cancel":
                child = subprocess.Popen(
                    argv,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                try:
                    deadline = time.monotonic() + 15
                    while not (root / "events").exists():
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
                    if mode == "cancel":
                        self.assertIn("CANARY_JOINED", events)
                return
            self.assertEqual(
                result.returncode, 0, result.stdout + result.stderr + details
            )
            self.assertEqual(len(summaries), 1)
            summary = json.loads(summaries[0].read_text())
            self.assertEqual(summary["status"], "passed")
            self.assertEqual(len(summary["startup_cohorts"]), 2)
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

    def test_failed_parent_canary_never_forks_task_workers(self):
        self.campaign_fixture(mode="fail")

    def test_cancelled_parent_canary_is_joined_before_campaign_returns(self):
        self.campaign_fixture(mode="cancel")


if __name__ == "__main__":
    unittest.main()
