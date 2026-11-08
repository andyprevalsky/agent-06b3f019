"""Actual autoscaler loop: unknown observation is pending, real failures stay hard."""

import hashlib
import json
import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path

from benchmarks.fixture_host_guard import FIXTURE_HOST_GUARD_SECONDS


def native(pid):
    p = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    return p.stdout.strip() or None


def control_boundary_reached(scaler, resolved):
    """One control-loop observation; True once the case reached its control boundary.

    `resolved` is the boundary read from the case's files, or None when the boundary is the
    autoscaler's own exit (fatal inventory and provision failure). That exit is read exactly once:
    a second poll() could see an exit that landed between two reads and report the boundary itself
    as "exited before the control boundary". A file-resolved case still requires a live autoscaler
    at every unresolved observation.
    """
    if resolved is None:
        return scaler.poll() is not None
    if resolved:
        return True
    assert scaler.poll() is None, "autoscaler-exited-before-control-boundary"
    return False


def test_autoscaler_runtime_handoff_capacity_exit_boundary_reads_exit_once():
    """Deterministic regression for the Blacksmith race (PR #1787 attempt 2, inventory_missing_machine):
    the autoscaler exits between two observations of an exit-resolved case."""
    import pytest

    class Scaler:
        def __init__(self, codes):
            self.codes, self.reads = list(codes), 0

        def poll(self):
            self.reads += 1
            return self.codes.pop(0) if len(self.codes) > 1 else self.codes[0]

    exiting = Scaler([None, 1])  # alive at this read, exited (rc 1) by the next
    assert control_boundary_reached(exiting, None) is False
    assert exiting.reads == 1, "an exit-resolved observation must read the exit once"
    assert control_boundary_reached(exiting, None) is True
    # A file-resolved case keeps its live-autoscaler requirement.
    with pytest.raises(AssertionError, match="autoscaler-exited-before-control-boundary"):
        control_boundary_reached(Scaler([1]), False)
    assert control_boundary_reached(Scaler([None]), False) is False
    assert control_boundary_reached(Scaler([1]), True) is True


def test_autoscaler_runtime_handoff_capacity_loop(tmp_path, monkeypatch):
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function, fleet_source_text

    # The inventory producer publishes a complete generation atomically. Keep
    # that contract when restoring the fixture even if its writer is delayed.
    write_text = Path.write_text

    def slow_health_write(path, data, *args, **kwargs):
        if path.name.startswith("health"):
            with path.open("w") as handle:
                time.sleep(0.2)
                return handle.write(data)
        return write_text(path, data, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", slow_health_write)

    BASE = tmp_path
    BASH = shutil.which("bash") or "bash"
    SOURCE = BASE / "subject.sh"
    fleet = fleet_source_text()
    SOURCE.write_text(
        f"source {shlex.quote(str(FLEET_SCRIPT.parent / 'lib/cloudbench-env.sh'))}\n" + "\n".join(
            _extract_fleet_function(fleet, name + "() {").replace(
                "inventory_machine_exists() {", "fixture_inventory_machine_exists() {", 1
            )
            for name in (
                "fleet_job_running",
                "inventory_pid_start_time",
                "inventory_pid_matches_start",
                "inventory_index_healthy",
                "inventory_machine_record_path",
                "inventory_machine_exists",
                "_box_desired",
                "_pool_ids",
                "_ready_pool_ids",
                "bench_autoscaler",
            )
        )
    )
    (BASE / "supervisor.private.sh").write_text(
        "\n".join(
            _extract_fleet_function(fleet, name + "() {")
            for name in (
                "terminate_fleet_runner_group",
                "run_fleet_child_supervised",
            )
        )
    )
    RUN = BASE / "cases"
    RUN.mkdir()
    results = []

    transient_modes = {"inventory_expired_then_ready", "inventory_read_miss_then_ready"}
    metrics_modes = {"metrics_proxy_loss_then_ready", "metrics_empty_scrapes_then_ready"}
    fatal_inventory_modes = {"inventory_wrong_token", "inventory_dead_publisher", "inventory_missing_machine"}
    for mode in ["pending_then_ready", "pending_until_child", "provision_failure", *sorted(transient_modes), *sorted(metrics_modes), *sorted(fatal_inventory_modes)]:
        case = RUN / mode
        case.mkdir()
        out = case / "bench"
        out.mkdir()
        q = shlex.quote
        script = r"""set -uo pipefail
    source "$1"
    CASE="$2"
    MODE="$3"
    OUT="$CASE/bench"
    APP=fixture-app
    RUN_ID=fixture-owned-loop
    AUTOSCALE_POLL=.05
    AUTOSCALE_MAX=3
    AUTOSCALER_FINALIZATION_WAIT_SECONDS=30
    BOX_HEALTH_PORT=3003
    CLOUDBENCH_BOOT_LAUNCH=0
    _machine_priv_ip() { printf 'fdaa::1'; }
    case "$MODE" in
        inventory_*|metrics_*)
            INVENTORY_INDEX="$CASE/inventory"
            INVENTORY_CLOCK_EPOCH="$(date +%s)"
            INVENTORY_CLOCK_SECONDS="$SECONDS"
            SNAPSHOT_LOOP_PID=$$
            SNAPSHOT_LOOP_PID_START="$(inventory_pid_start_time "$$")"
            SNAPSHOT_LOOP_TOKEN=fixture-publisher
            mkdir -p "$INVENTORY_INDEX/current/machines"
            printf 'state=started\n' > "$INVENTORY_INDEX/current/machines/feedface000001"
            printf 'publisher_token=fixture-publisher\nvalid_until=%s\n' "$((INVENTORY_CLOCK_EPOCH + 120))" > "$INVENTORY_INDEX/current/health"
            inventory_machine_exists() {
                local rc=0
                fixture_inventory_machine_exists "$@" || rc=$?
                printf '%s\n' "$rc" > "$CASE/inventory-observed"
                return "$rc"
            }
            ;;
        *) inventory_machine_exists() { return 0; } ;;
    esac
    release_autoscaler_metrics_owner() { return 0; }
    claim_autoscaler_metrics_port() { printf -v "$1" 62345; }
    cloudbench_terminate_and_wait() {
        shift
        for pid in "$@"; do
            [ -n "$pid" ] || continue
            if jobs -pr | grep -qx "$pid"; then kill -TERM "$pid"; fi
            wait "$pid" 2>/dev/null || true
        done
    }
    date() {
        if [ "$MODE" = metrics_proxy_loss_then_ready ] && [ "$*" = +%s ] \
            && [ -e "$CASE/proxy-fault-active" ]; then
            local tick=0
            [ ! -e "$CASE/proxy-clock" ] || tick="$(cat "$CASE/proxy-clock")"
            tick=$((tick + 31)); printf '%s\n' "$tick" > "$CASE/proxy-clock"
            [ "$tick" -lt 62 ] || : > "$CASE/proxy-recovery-expired"
            printf '%s\n' "$((1000 + tick))"
        else
            command date "$@"
        fi
    }
    flyctl() {
        printf '%s\n' "$BASHPID" > "$CASE/proxy.pid"
        printf '%s\n' "$BASHPID" >> "$CASE/proxy.pids"
        exec sleep 120
    }
    curl() {
        case " $* " in *' -o /dev/null '*)
            if [ ! -e "$CASE/inventory-fault" ]; then
                case "$MODE" in
                    inventory_expired_then_ready) printf 'publisher_token=fixture-publisher\nvalid_until=1\n' > "$INVENTORY_INDEX/current/health" ;;
                    inventory_read_miss_then_ready) rm "$INVENTORY_INDEX/current/health" ;;
                    inventory_wrong_token) printf 'publisher_token=wrong-publisher\nvalid_until=%s\n' "$((INVENTORY_CLOCK_EPOCH + 120))" > "$INVENTORY_INDEX/current/health" ;;
                    inventory_dead_publisher) SNAPSHOT_LOOP_PID=99999999 ;;
                    inventory_missing_machine) rm "$INVENTORY_INDEX/current/machines/feedface000001" ;;
                esac
                : > "$CASE/inventory-fault"
            fi
            return 0 ;;
        esac
        local poll=0
        [ ! -e "$CASE/polls" ] || poll="$(cat "$CASE/polls")"
        poll=$((poll+1)); printf '%s\n' "$poll" > "$CASE/polls"
        if [ "$MODE" = metrics_proxy_loss_then_ready ] && [ "$poll" -ge 3 ]; then
            if [ ! -e "$CASE/proxy-fault-started" ]; then
                : > "$CASE/proxy-fault-started"
                : > "$CASE/proxy-fault-active"
                kill -TERM "$metrics_proxy_pid"
            elif [ ! -e "$CASE/proxy-fault-active" ]; then
                : > "$CASE/proxy-observation-recovered"
            fi
        elif [ "$MODE" = metrics_empty_scrapes_then_ready ] && [ "$poll" -ge 3 ] && [ "$poll" -le 10 ]; then
            printf '%s\n' "$((poll - 2))" > "$CASE/empty-metrics-count"
            return 1
        elif [ "$MODE" = metrics_empty_scrapes_then_ready ] && [ "$poll" -gt 10 ]; then
            : > "$CASE/empty-metrics-recovered"
        fi
        printf 'desired_machine_count 3\n'
    }
    provision_worker() {
        local count=0 after=0
        [ ! -e "$CASE/calls" ] || count="$(wc -l < "$CASE/calls" | tr -d ' ')"
        count=$((count+1))
        [ ! -e "$OUT/benchmark-child.finished" ] || after=1
        printf '%s %s %s\n' "$count" "$(cat "$CASE/polls")" "$after" >> "$CASE/calls"
        case "$MODE" in inventory_*|metrics_*) inventory_index_healthy || { : > "$CASE/stale-capacity-mutation"; return 18; } ;; esac
        if [ "$MODE" = provision_failure ]; then
            printf 'fixture-provision-failure\n' > "$OUT/autoscaler.failed"
            return 17
        fi
        if [ "$MODE" = pending_until_child ]; then
            if [ "$count" = 3 ]; then
                : > "$CASE/third-pending"
                while [ ! -e "$OUT/benchmark-child.finished" ]; do sleep .01; done
            fi
            return 75
        fi
        [ "$count" -gt 1 ] || return 75
        printf 'worker-fixture-%s\n' "$count" >> "$OUT/worker-clones.ids"
        : > "$OUT/worker-fixture-$count.ready"
        return 0
    }
    reconcile_worker_ready_outcomes() {
        : > "$1/worker-ready.ids"
        while read -r wid; do
            [ -n "$wid" ] || continue
            [ ! -e "$1/$wid.ready" ] || printf '%s\n' "$wid" >> "$1/worker-ready.ids"
        done < "$1/worker-clones.ids"
    }
    reconcile_worker_failure_outcomes() { return 0; }
    bench_autoscaler fixture-task feedface000001 fixture-workspace 0 "$OUT" 61000 fixture-owner-0
    """
        driver = case / "driver.private.sh"
        driver.write_text(script)
        child_script = case / "child.private.sh"
        child_script.write_text(f"""set -eu
    printf '%s\\n' "$$" > {q(str(case / "child.pid"))}
    while [ ! -e {q(str(case / "release-child"))} ]; do sleep .01; done
    exit 1
    """)
        env = {k: os.environ[k] for k in ["PATH", "LANG"] if k in os.environ}
        env["PATH"] = str(Path(os.sys.executable).parent) + os.pathsep + env.get("PATH", "")
        processes = []
        owners = []
        started = time.monotonic()
        error = None
        with (
            (case / "child.private.log").open("wb") as child_log,
            (case / "scaler.private.log").open("wb") as scaler_log,
        ):
            try:
                child = subprocess.Popen(
                    [
                        BASH,
                        "-c",
                        'source "$1"; run_fleet_child_supervised "$2" "$3" "$4"',
                        "fixture",
                        str(BASE / "supervisor.private.sh"),
                        str(out / "benchmark-child.finished"),
                        BASH,
                        str(child_script),
                    ],
                    stdout=child_log,
                    stderr=subprocess.STDOUT,
                    env=env,
                    start_new_session=True,
                )
                processes.append(child)
                owners.append({"kind": "child_supervisor", "pid": child.pid, "birth": native(child.pid)})
                scaler = subprocess.Popen(
                    [BASH, str(driver), str(SOURCE), str(case), mode],
                    stdout=scaler_log,
                    stderr=subprocess.STDOUT,
                    env=env,
                    start_new_session=True,
                )
                processes.append(scaler)
                owners.append({"kind": "autoscaler", "pid": scaler.pid, "birth": native(scaler.pid)})
                deadline = time.monotonic() + FIXTURE_HOST_GUARD_SECONDS
                restored_inventory = False
                restored_metrics_proxy = False
                while True:
                    for name in ["proxy", "child"]:
                        p = case / f"{name}.pid"
                        if p.exists():
                            all_proxies = case / "proxy.pids"
                            source = all_proxies if name == "proxy" and all_proxies.exists() else p
                            # The shell's `>`/`>>` creates the file before printf writes each
                            # newline-terminated PID; parse only complete lines.
                            text = source.read_text()
                            identifiers = text.splitlines()[: text.count("\n")]
                            for identifier in identifiers:
                                if not identifier.strip():
                                    continue
                                pid = int(identifier)
                                if not any(o["kind"] == name and o["pid"] == pid for o in owners):
                                    owners.append({"kind": name, "pid": pid, "birth": native(pid)})
                    observed_inventory = case / "inventory-observed"
                    if mode in transient_modes and not restored_inventory and observed_inventory.exists() and observed_inventory.read_text().strip() not in {"", "0"}:
                        time.sleep(0.1)
                        assert scaler.poll() is None, "transient-inventory-aborted-live-autoscaler"
                        assert not (case / "calls").exists(), "capacity-mutated-before-fresh-inventory"
                        health = case / "inventory/current/health"
                        temporary_health = health.with_suffix(".tmp")
                        temporary_health.write_text(
                            f"publisher_token=fixture-publisher\nvalid_until={int(time.time()) + 120}\n"
                        )
                        temporary_health.replace(health)
                        restored_inventory = True
                    if mode == "metrics_proxy_loss_then_ready" and not restored_metrics_proxy and (case / "proxy-recovery-expired").exists():
                        time.sleep(0.1)
                        assert scaler.poll() is None, "post-ready-proxy-observation-aborted-live-child"
                        assert not (out / "autoscaler.failed").exists(), "post-ready-proxy-observation-written-as-failure"
                        (case / "proxy-fault-active").unlink()
                        restored_metrics_proxy = True
                    if mode == "pending_then_ready" or mode in transient_modes or mode in metrics_modes:
                        ready = (
                            (out / "worker-ready.ids").read_text().splitlines()
                            if (out / "worker-ready.ids").exists()
                            else []
                        )
                        resolved = len(ready) == 2
                        if mode == "metrics_proxy_loss_then_ready":
                            resolved = resolved and (case / "proxy-observation-recovered").exists()
                        elif mode == "metrics_empty_scrapes_then_ready":
                            resolved = resolved and (case / "empty-metrics-recovered").exists()
                    elif mode == "pending_until_child":
                        resolved = (case / "third-pending").exists()
                    else:
                        resolved = None  # this mode's control boundary is the autoscaler's own exit
                    if control_boundary_reached(scaler, resolved):
                        break
                    assert time.monotonic() < deadline, "fixture-host-guard"
                    time.sleep(0.01)
                (case / "release-child").touch()
                assert child.wait(timeout=FIXTURE_HOST_GUARD_SECONDS) == 1, "independent-child-return-code"
                scaler_rc = scaler.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)
                calls = [list(map(int, line.split())) for line in (case / "calls").read_text().splitlines()] if (case / "calls").exists() else []
                tracked = (out / "worker-clones.ids").read_text().splitlines()
                ready = (out / "worker-ready.ids").read_text().splitlines()
                assert all(row[2] == 0 for row in calls), "provision-called-after-independent-child-marker"
                assert (out / "benchmark-child.finished").read_text().strip() == "1"
                if mode == "pending_then_ready" or mode in transient_modes or mode in metrics_modes:
                    assert scaler_rc == 0, "pending-recovery-did-not-complete"
                    assert not (out / "autoscaler.failed").exists(), "pending-written-as-failure"
                    assert [row[1] for row in calls] == [1, 2, 2], "retried-pending-in-same-scale-pass"
                    assert tracked == ready == ["worker-fixture-2", "worker-fixture-3"], (
                        "wrong-tracked-ready-identities"
                    )
                    assert (out / "autoscaler.completed-after-child").read_text().strip() == "1"
                    if mode in transient_modes:
                        assert restored_inventory
                        assert not (case / "stale-capacity-mutation").exists()
                        assert "retrying" in (case / "scaler.private.log").read_text()
                    if mode in metrics_modes:
                        assert not (case / "stale-capacity-mutation").exists()
                        assert "retrying" in (case / "scaler.private.log").read_text()
                        if mode == "metrics_proxy_loss_then_ready":
                            assert restored_metrics_proxy
                        else:
                            assert int((case / "empty-metrics-count").read_text()) >= 8
                elif mode == "pending_until_child":
                    assert [row[1] for row in calls] == [1, 2, 3], "persistent-unknown-retried-in-same-pass"
                    assert tracked == ready == [], "persistent-unknown-admitted-worker"
                    assert scaler_rc == 0, "unallocated-postterminal-demand-blocked-release"
                    assert not (out / "autoscaler.failed").exists()
                    assert (out / "autoscaler.completed-after-child").read_text().strip() == "1"
                elif mode in fatal_inventory_modes:
                    assert scaler_rc == 1, "invalid-inventory-did-not-stop-autoscaler"
                    assert calls == [], "capacity-mutated-with-invalid-inventory"
                    assert (out / "autoscaler.failed").is_file(), "invalid-inventory-missing-durable-failure"
                    assert not (out / "autoscaler.completed-after-child").exists()
                else:
                    assert scaler_rc == 17, "true-provision-return-code-lost"
                    assert len(calls) == 1, "provision-retried-after-hard-failure"
                    assert tracked == ready == []
                    assert (out / "autoscaler.failed").read_text().strip() == "fixture-provision-failure"
                    assert not (out / "autoscaler.completed-after-child").exists()
            except Exception as exc:
                error = {"class": type(exc).__name__, "category": str(exc),
                         "child_finished_at_failure": (out / "benchmark-child.finished").exists(),
                         "desired_capacity_already_observed": (out / "autoscaler.ready").exists(),
                         "durable_autoscaler_failure": (out / "autoscaler.failed").read_text().strip() if (out / "autoscaler.failed").exists() else None}
            finally:
                (case / "release-child").touch(exist_ok=True)
                for p in processes:
                    if p.poll() is None:
                        p.terminate()
                    try:
                        p.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        p.kill()
                        p.wait(timeout=10)
        for owner in owners:
            owner["current_birth"] = native(owner["pid"])
            owner["absent"] = owner["current_birth"] is None
        result = {
            "mode": mode,
            "passed": error is None,
            "error": error,
            "elapsed_seconds": time.monotonic() - started,
            "owners": owners,
            "popen_children_reaped": all(p.poll() is not None for p in processes),
            "all_recorded_owners_absent": all(o["absent"] for o in owners),
            "scaler_rc": scaler.returncode,
            "calls": [list(map(int, line.split())) for line in (case / "calls").read_text().splitlines()]
            if (case / "calls").exists()
            else [],
        }
        (case / "receipt.private.json").write_text(json.dumps(result, indent=2))
        results.append(result)

    receipt = {
        "run": str(RUN),
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "control_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "supervisor_sha256": hashlib.sha256((BASE / "supervisor.private.sh").read_bytes()).hexdigest(),
        "cases": results,
        "passed": sum(r["passed"] for r in results),
        "total": len(results),
        "network_provider_model_calls": 0,
        "runtime_shell_flags": "set -uo pipefail",
        "product_limits_changed": False,
        "fixture_poll_seconds": 0.05,
    }
    (RUN / "receipt.private.json").write_text(json.dumps(receipt, indent=2))
    (BASE / "latest.private.json").write_text(json.dumps(receipt, indent=2))
    print(
        json.dumps(
            {
                "passed": receipt["passed"],
                "total": receipt["total"],
                "source_sha256": receipt["source_sha256"],
                "control_sha256": receipt["control_sha256"],
                "owners_absent": all(r["all_recorded_owners_absent"] for r in results),
                "failed_cases": [
                    {"mode": r["mode"], "error": r["error"], "scaler_rc": r["scaler_rc"]}
                    for r in results if not r["passed"]
                ],
            }
        )
    )
    assert receipt["passed"] == receipt["total"], receipt["cases"]


FINAL_HEALTH_TRANSPORT_ERROR = (
    'Error: tunnel unavailable: Error contacting Fly.io API when probing "personal": '
    "timed out (context deadline exceeded)"
)


def test_autoscaler_runtime_handoff_capacity_final_health_separates_transport_from_worker_death(tmp_path):
    """A failed controller SSH transport is not evidence that the worker died.

    2026-10-18 shard-03 r001-j0068: the final-acceptance probe of worker
    827446c7710178 failed inside the controller's Fly agent tunnel
    ("tunnel unavailable ... probing personal") before reaching the worker, and
    the fleet reported "worker became unhealthy before final acceptance". The
    real probe command runs through a POSIX shell-word split (as hallpass
    does) against fake pgrep/curl, so its remote verdict text is exercised.
    """
    from benchmarks.cloudbench_dependency_sync_test import _extract_fleet_function, fleet_source_text

    fleet = fleet_source_text()
    # The complete production worker-health block, including any helpers it
    # defines between the probe and the ready-worker aggregation.
    start = fleet.index("worker_operational() {")
    end_function = _extract_fleet_function(fleet, "ready_workers_operational() {")
    end = fleet.index(end_function) + len(end_function)
    subject = tmp_path / "subject.sh"
    subject.write_text(fleet[start:end] + "\n")
    remote_bin = tmp_path / "remote-bin"
    remote_bin.mkdir()
    for tool, body in {
        "pgrep": '#!/bin/sh\n[ "$*" = "-f python [w]orker.py" ] && [ -e "$REMOTE/$MACHINE.process" ]\n',
        "curl": '#!/bin/sh\ncase "$*" in *"http://127.0.0.1:3103/health"*) ;; *) exit 2 ;; esac\n[ -e "$REMOTE/$MACHINE.health" ] || exit 22\n',
    }.items():
        (remote_bin / tool).write_text(body)
        (remote_bin / tool).chmod(0o755)
    harness = r"""set -uo pipefail
source "$1"
CASE="$2"
OUT="$CASE/bench"
APP=fixture-app
FLEET_WORKER_HEALTH_PORT=3103
CLOUDBENCH_FINAL_WORKER_HEALTH_RETRY_SECONDS=0
fly_with_timeout() {
    shift
    local cmd="" prev="" arg machine="" mode calls
    for arg in "$@"; do
        [ "$prev" = -C ] && cmd="$arg"
        [ "$prev" = --machine ] && machine="$arg"
        prev="$arg"
    done
    printf '%s\n' "$machine" >> "$CASE/fly.calls"
    calls="$(grep -cx "$machine" "$CASE/fly.calls")"
    mode="$(sed -n "${calls}p" "$CASE/$machine.transport")"
    [ -n "$mode" ] || mode="$(tail -1 "$CASE/$machine.transport")"
    case "$mode" in
        fail) echo "$TRANSPORT_ERROR"; return 1 ;;
        hang) echo "[warn] FLY_COMPLETION_TIMEOUT shell_pid=1 shell_start_ticks=1 fly_return_status=unknown fifo_read_status=142"; return 142 ;;
    esac
    MACHINE="$machine" REMOTE="$CASE/remote" PATH="$REMOTE_BIN:$PATH" python3 -c 'import shlex,subprocess,sys; sys.exit(subprocess.run(shlex.split(sys.argv[1])).returncode)' "$cmd"
}
rc=0
ready_workers_operational "$OUT" > "$CASE/stdout" 2> "$CASE/stderr" || rc=$?
printf '%s\n' "$rc" > "$CASE/rc"
"""
    (tmp_path / "harness.sh").write_text(harness)
    cases = {
        # mode: ({machine: (transport schedule, process alive, health 200)}, expected rc)
        "healthy": ({"827446c7710178": (["ok"], True, True)}, 0),
        "transport-then-healthy": ({"827446c7710178": (["fail", "ok"], True, True)}, 0),
        "timeout-then-healthy": ({"827446c7710178": (["hang", "ok"], True, True)}, 0),
        "remote-process-missing": ({"827446c7710178": (["ok"], False, True)}, 1),
        "remote-health-503": ({"827446c7710178": (["ok"], True, False)}, 1),
        "transport-persistent": ({"827446c7710178": (["fail"], True, True)}, 75),
        "remote-unhealthy-beats-transport": (
            {"827446c7710178": (["fail"], True, True), "83dd001f7040e8": (["ok"], False, False)}, 1),
    }
    expected_calls = {
        "healthy": {"827446c7710178": 1},
        "transport-then-healthy": {"827446c7710178": 2},
        "timeout-then-healthy": {"827446c7710178": 2},
        "remote-process-missing": {"827446c7710178": 1},
        "remote-health-503": {"827446c7710178": 1},
        "transport-persistent": {"827446c7710178": 3},
        "remote-unhealthy-beats-transport": {"827446c7710178": 3, "83dd001f7040e8": 1},
    }
    observed = {}
    for mode, (machines, _expected) in cases.items():
        case = tmp_path / mode
        (case / "bench").mkdir(parents=True)
        (case / "remote").mkdir()
        (case / "bench/worker-ready.ids").write_text("".join(m + "\n" for m in machines))
        for machine, (schedule, process, health) in machines.items():
            (case / f"{machine}.transport").write_text("".join(s + "\n" for s in schedule))
            if process:
                (case / "remote" / f"{machine}.process").write_text("")
            if health:
                (case / "remote" / f"{machine}.health").write_text("")
        env = dict(os.environ, REMOTE_BIN=str(remote_bin), TRANSPORT_ERROR=FINAL_HEALTH_TRANSPORT_ERROR)
        env.pop("CLOUDBENCH_FINAL_WORKER_HEALTH_ATTEMPTS", None)
        subprocess.run(["bash", str(tmp_path / "harness.sh"), str(subject), str(case)],
                       env=env, check=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
        calls = (case / "fly.calls").read_text().split() if (case / "fly.calls").exists() else []
        observed[mode] = (int((case / "rc").read_text()), {m: calls.count(m) for m in machines})
    assert observed == {mode: (rc, expected_calls[mode]) for mode, (_machines, rc) in cases.items()}

    # Final acceptance reports the observed class, preserving the raw transport
    # output privately instead of discarding it.
    acceptance = _extract_fleet_function(fleet, "mandatory_worker_health_acceptable() {")
    for mode, message in {
        "remote-health-503": "mandatory autoscaler worker became unhealthy before final acceptance",
        "transport-persistent": "mandatory autoscaler worker health unobservable before final acceptance",
    }.items():
        case = tmp_path / mode
        (case / "fly.calls").unlink()
        (case / "bench/worker-827446c7710178.health.log").unlink()
        script = (harness.replace('ready_workers_operational "$OUT"', 'mandatory_worker_health_acceptable "$OUT" fixture-bench')
                  + "\n" + acceptance + "\n")
        (tmp_path / "acceptance.sh").write_text(script.replace('source "$1"\n', 'source "$1"\n' + acceptance + "\n", 1))
        subprocess.run(["bash", str(tmp_path / "acceptance.sh"), str(subject), str(case)],
                       env=dict(os.environ, REMOTE_BIN=str(remote_bin), TRANSPORT_ERROR=FINAL_HEALTH_TRANSPORT_ERROR),
                       check=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert (case / "rc").read_text().strip() == "1"
        stderr = (case / "stderr").read_text()
        assert message in stderr, stderr
        assert ("became unhealthy" in stderr) == (mode == "remote-health-503"), stderr
        log = (case / "bench/worker-827446c7710178.health.log").read_text()
        if mode == "transport-persistent":
            assert log.count("tunnel unavailable") == 3, log
