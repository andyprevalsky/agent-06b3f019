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


def test_autoscaler_runtime_handoff_capacity_loop(tmp_path):
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function, fleet_source_text

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
                            identifiers = (all_proxies.read_text().splitlines()
                                           if name == "proxy" and all_proxies.exists() else [p.read_text()])
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
                        (case / "inventory/current/health").write_text(
                            f"publisher_token=fixture-publisher\nvalid_until={int(time.time()) + 120}\n"
                        )
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
                        resolved = scaler.poll() is not None
                    if resolved:
                        break
                    assert scaler.poll() is None, "autoscaler-exited-before-control-boundary"
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
            }
        )
    )
    assert receipt["passed"] == receipt["total"], receipt["cases"]
