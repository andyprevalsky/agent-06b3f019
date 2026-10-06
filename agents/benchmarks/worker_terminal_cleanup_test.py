"""Compact actual-ledger controls for late allocation and exact worker cleanup."""

import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path


def test_worker_cleanup_and_terminal_allocation_ownership(tmp_path):
    from benchmarks.cloudbench_dependency_sync_test import FLEET_SCRIPT, _extract_fleet_function

    BASE = tmp_path
    RUN = BASE / "cases"
    RUN.mkdir()
    source = FLEET_SCRIPT.read_text()
    functions = (
        "worker_ledger_lock_acquire",
        "worker_ledger_lock_release",
        "cloudbench_record_worker_evidence_owner",
        "cloudbench_preserve_unlaunched_worker",
        "cleanup_failed_worker",
        "provision_worker",
    )
    (BASE / "subject.private.sh").write_text(
        "\n".join(_extract_fleet_function(source, name + "() {") for name in functions)
    )
    results = []
    for mode in [
        "capture_missing_never_launched",
        "capture_present",
        "launched_capture_missing",
        "missing_volume_owner",
        "physical_reap_failed",
        "child_already_finished",
        "child_finished_during_clone",
        "clone_cancelled_without_allocation",
        "clone_failure_ambiguous",
    ]:
        case = RUN / mode
        case.mkdir()
        worker = "deadbeef000001"
        (case / "worker-clones.ids").write_text(worker + "\n")
        (case / "worker-ready.ids").write_text("")
        (case / f"worker-{worker}.pending").touch()
        evidence = case / "worker-runtime-evidence" / worker
        evidence.mkdir(parents=True)
        (evidence / "owner.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "machine_id": worker,
                    "primary_machine_id": "deadbeef000002",
                    "run_token": "fixture-owner-0",
                    "workspace": "fixture",
                }
            )
        )
        # The failed stage never ran the worker. This records failure rather than
        # manufacturing runtime/ready/ACK evidence.
        (case / f"worker-{worker}.stage.log").write_text("neutralize cloned boot command failed rc=1\n")
        if mode in ("capture_present", "launched_capture_missing"):
            (case / f"worker-{worker}.launch-attempted").touch()
        if mode == "child_finished_during_clone":
            shutil.rmtree(case / "worker-runtime-evidence")
            (case / f"worker-{worker}.stage.log").unlink()
        script = r"""set -uo pipefail
    source "$1"
    CASE="$2"; MODE="$3"; WID=deadbeef000001
    fleet_registry_volume_for_id() {
        [ "$1" = "$WID" ] || return 1
        [ "$MODE" != missing_volume_owner ] || return 1
        printf 'vol-owned-fixture'
    }
    cloudbench_capture_worker_runtime_evidence() {
        printf '%s\n' "$2" >> "$CASE/capture-calls"
        [ "$MODE" = capture_present ] || [ "$MODE" = physical_reap_failed ]
    }
    reap_machine() {
        [ "$1" = "$WID" ] && [ "$3" = vol-owned-fixture ] || return 98
        printf '%s\n' "$1" >> "$CASE/reap-calls"
        [ "$MODE" != physical_reap_failed ]
    }
    fleet_audit_update_fresh_clone_by_id() {
        [ "$1" = "$WID" ] && [ "$2" = destroyed-verified-absent ] || return 98
        : > "$CASE/audit-terminal"
    }
    fleet_registry_release_id() { [ "$1" = "$WID" ] || return 98; : > "$CASE/registry-released"; }
    FLEET_OWNER_TOKEN=fixture-owner
    WARM_SOURCE_SIZE_GB=20; SNAP_ID=fixture-snapshot
    FLEET_WORKER_VM_SIZE=performance-1x; FLEET_WORKER_VM_MEMORY=8192
    machine_volume_size_gb() { printf 20; }
    reserve_worker_machine_slot() { : > "$CASE/reservation-called"; return 0; }
    capacity_release_reservation() { : > "$CASE/reservation-released"; return 0; }
    clone_machine_target() {
        : > "$CASE/clone-called"
        if [ "$MODE" = child_finished_during_clone ]; then
            printf '1\n' > "$CASE/benchmark-child.finished"
        fi
        if [ "$MODE" = clone_cancelled_without_allocation ]; then return 75; fi
        if [ "$MODE" = clone_failure_ambiguous ]; then return 1; fi
        printf '%s\n' "$WID" > "$1"
        printf '%s' "$WID"
    }
    controller_github_token_b64() { : > "$CASE/postterminal-setup-called"; return 1; }
    status=0
    case "$MODE" in
      child_already_finished|child_finished_during_clone|clone_cancelled_without_allocation|clone_failure_ambiguous)
        : > "$CASE/worker-clones.ids"
        if [ "$MODE" = child_already_finished ]; then printf '1\n' > "$CASE/benchmark-child.finished"; fi
        provision_worker fixture-task fixture-workspace deadbeef000002 ::1 0 "$CASE" fixture-owner-0 || status=$?
        ;;
      *) cleanup_failed_worker "$CASE" "$WID" || status=$? ;;
    esac
    printf '%s\n' "$status" > "$CASE/result-rc"
    """
        driver = case / "driver.private.sh"
        driver.write_text(script)
        start = time.monotonic()
        with (case / "stdout.private.log").open("wb") as out, (case / "stderr.private.log").open("wb") as err:
            p = subprocess.Popen(
                [shutil.which("bash") or "bash", str(driver), str(BASE / "subject.private.sh"), str(case), mode],
                stdout=out,
                stderr=err,
                start_new_session=True,
            )
            birth = subprocess.run(
                ["ps", "-p", str(p.pid), "-o", "lstart="], capture_output=True, text=True, timeout=10
            ).stdout.strip()
            try:
                process_rc = p.wait(timeout=30)
            except subprocess.TimeoutExpired:
                p.terminate()
                process_rc = p.wait(timeout=10)
        actual = int((case / "result-rc").read_text()) if (case / "result-rc").exists() else None
        facts = {
            name: (case / name).exists()
            for name in [
                "reap-calls",
                "capture-calls",
                "registry-released",
                "audit-terminal",
                "clone-called",
                "reservation-called",
                "postterminal-setup-called",
                "worker-clones.ids.lock",
            ]
        }
        tracked = (case / "worker-clones.ids").read_text().splitlines()
        error = None
        try:
            assert process_rc == 0, "fixture-shell-exited"
            if mode in ["capture_missing_never_launched", "capture_present"]:
                assert facts["reap-calls"], "optional-capture-blocked-exact-reap"
                assert actual == 0 and facts["registry-released"] and facts["audit-terminal"] and not tracked
            elif mode in ["missing_volume_owner", "physical_reap_failed", "launched_capture_missing"]:
                assert actual != 0 and tracked == [worker] and not facts["registry-released"]
                assert not facts["audit-terminal"]
                if mode in ("missing_volume_owner", "launched_capture_missing"):
                    assert not facts["reap-calls"], "unowned-volume-reap"
                else:
                    assert facts["reap-calls"], "physical-reap-control-not-reached"
                if mode == "launched_capture_missing":
                    assert facts["capture-calls"], "launched-capture-control-not-reached"
            elif mode == "child_already_finished":
                assert not facts["reservation-called"] and not facts["clone-called"], "postterminal-worker-allocation"
                assert not facts["postterminal-setup-called"]
            elif mode in ("clone_cancelled_without_allocation", "clone_failure_ambiguous"):
                assert facts["reservation-called"] and facts["clone-called"]
                assert not facts["postterminal-setup-called"]
                assert actual == (0 if mode == "clone_cancelled_without_allocation" else 1)
                assert not tracked
                assert (case / "reservation-released").exists() is (mode == "clone_cancelled_without_allocation")
                assert (case / "autoscaler.failed").exists() is (mode == "clone_failure_ambiguous")
            else:
                assert not facts["postterminal-setup-called"], "postterminal-worker-staging"
                assert facts["reap-calls"] and facts["registry-released"] and not tracked, "late-clone-not-released"
                assert (evidence / "not-launched.json").is_file(), "late-clone-evidence-not-preserved"
            assert not facts["worker-clones.ids.lock"], "owned-lock-retained"
        except AssertionError as exc:
            error = str(exc) or "incorrect-exact-release-state"
        current = subprocess.run(
            ["ps", "-p", str(p.pid), "-o", "lstart="], capture_output=True, text=True, timeout=10
        ).stdout.strip()
        result = {
            "case": mode,
            "passed": error is None,
            "error": error,
            "helper_rc": actual,
            "facts": facts,
            "tracked_count": len(tracked),
            "elapsed_seconds": time.monotonic() - start,
            "owner": {"pid": p.pid, "birth": birth, "reaped": True, "absent": not current},
        }
        (case / "receipt.private.json").write_text(json.dumps(result, indent=2))
        results.append(result)
    receipt = {
        "source_sha256": hashlib.sha256((BASE / "subject.private.sh").read_bytes()).hexdigest(),
        "control_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "run": str(RUN),
        "cases": results,
        "passed": sum(x["passed"] for x in results),
        "total": len(results),
        "real_ledger_claim_and_cleanup_function": True,
        "provider_model_calls": 0,
        "private_only": True,
    }
    (RUN / "receipt.private.json").write_text(json.dumps(receipt, indent=2))
    assert receipt["passed"] == receipt["total"], receipt["cases"]
    assert all(row["owner"]["absent"] for row in results)
