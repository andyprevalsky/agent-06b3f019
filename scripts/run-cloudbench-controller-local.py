#!/usr/bin/env python3
"""Run the complete Step 4cb inventory on an existing isolated Linux worker."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
import shutil
import stat
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from deploy_test_cycle import source
from deploy_test_process import CANCEL, cancellation_handlers, run_command

CASES = [
    ('environment', 'bash scripts/tests/cloudbench-env.test.sh'),
    ('autoscale', 'bash scripts/tests/cloudbench-acceptance-autoscale.test.sh'),
    (
        'status-service-shutdown',
        'python3 scripts/tests/run-cloudbench-controller-linux.py --fixture '
        'status-service-shutdown'
    ),
    ('infra-canary', 'bash scripts/tests/fleet-infra-canary.test.sh'),
    ('infra-stability', 'bash scripts/tests/fleet-infra-stability-proof.test.sh'),
    ('rootless-sms', 'python3 scripts/tests/cloudbench-exact-session-rootless-sms.test.py'),
    ('multi-workstream', 'bash scripts/tests/cloudbench-multi-workstream.test.sh'),
    ('linux-contract', 'python3 scripts/tests/cloudbench-controller-linux.test.py'),
    ('github-token', 'bash scripts/tests/cloudbench-github-token.test.sh'),
    ('seed-toolchain', 'bash scripts/tests/seed-dump-toolchain.test.sh'),
    ('wall-clock', 'agents/venv/bin/python -m pytest -q agents/benchmarks/wall_clock_backstop_test.py'),
    (
        'selected-pytest',
        'agents/venv/bin/python -m pytest -q '
        'agents/benchmarks/cloudbench_dependency_sync_test.py   '
        'agents/benchmarks/cloudbench_worker_snapshot_test.py   '
        'agents/benchmarks/cloudbench_recovery_review_test.py   '
        'agents/benchmarks/cloudbench_codex_auth_test.py   '
        "agents/benchmarks/cloud_batch_cleanup_test.py   -k 'fly_with_timeout or "
        'test_clone_retries_transient_volume_not_found or '
        'test_clone_gives_up_after_max_attempts or '
        'test_clone_times_out_and_retries_a_hung_clone or '
        'clone_creation_cannot_start_copied_primary or '
        'cloudbench_codex_auth or '
        'autoscaler_runtime_handoff or '
        'prisma_client or '
        'local_sync_and_stack_wire_prisma_freshness or '
        'cloud_patch_includes_tracked_and_untracked_changes or '
        'cloud_patch_detection_and_payload_include_staged_only_changes or '
        'worktree_patch_ignores_append_only_history_ledgers or '
        'patch_delivery_clears_stale_base64_configuration or '
        'shared_patch_digest_is_pinned_and_verified or '
        'declared_patch_payload_cannot_be_missing_or_empty or '
        'empty_local_patch_cleanup_is_nounset_safe or '
        'central_hub_runs_in_own_session_after_launcher_exit or '
        'central_hub_port_selection_skips_a_bound_port_without_a_listener or '
        'boot_launch_delivers_the_exact_worktree_patch_to_every_guest or '
        'boot_launch_runs_the_current_driver_before_applying_the_patch or '
        'boot_payload or '
        'boot_launch_compresses_complete_payload or '
        'autoscaled_worker_failure_publishes_durable_failure_marker or '
        'data_plane_proxies_retry_machine_dns_and_restart_if_lost or '
        'status_polled_over_data_plane_proxy_not_ssh or '
        'cloud_runner_avoids_live_run_port_collisions or '
        'fleet_barrier_reads_the_authoritative_rotated_status_port or '
        'data_plane_barrier_release_at_full_fleet_width or '
        'storage_readiness_inventory_reads_are_bounded or '
        'fleet_cleanup_releases_emergency_disk_reserve_before_provider_teardown or '
        'isolated_backend or '
        'local_predeploy_skips_wmh or '
        'cloud_agentcard_payment_tasks_provide_onboarding_callback_env or '
        'fleet_shared_patch_remains_authoritative_until_transport_selection or '
        'fleet_patch_packages_clean_unpushed_head_from_fetchable_base or '
        'autoscaler_scale_down_cancels_pending_worker or '
        'fleet_registry_release_id_is_idempotent_with_other_records or '
        'refresh_deps_tracks_exact_created_snapshot or '
        'refresh_deps_applies_exact_workspace_before_rebuild or '
        'fetch_ref_restores_dirty_exact_sha or '
        'warm_deps_preflight or '
        'fresh_controller_reuses_only_proven_donor_dependencies or '
        'verified_legacy_snapshot or '
        'dependency_proof_publication or '
        'exact_volume_ownership_survives_delayed_visibility_and_failed_delete or '
        'exact_recovery_routes_quarantined_owner_to_guest_recovery_before_reapers or '
        'pre_fix_guest_runner_receipt_cannot_authorize_exact_reaper or '
        'exact_recovery_seals_actual_retained_owner_remote_evidence_paths or '
        'hub_transport or '
        'guest_shutdown_child_confirmation or '
        'exact_guest_recovery_archives_bound_child_token or '
        'exact_recovery_consumes_runtime_receipt_completed_absent_primary or '
        'exact_recovery_consumes_runtime_receipt_publishes_audited_release or '
        'fleet_lifecycle_receipt_requires_final_registry_retirement or '
        'watchdog_collects_cancelled_artifact_after_bounded_shutdown or '
        'terminal_projection_preserves_benchmark_outcome or '
        'boot_driver_state_write_failure or '
        'driver_cleanup_persists_evidence_in_fresh_data_directory or '
        'driver_cleanup_requires_current_stack_receipt_on_normal_completion or '
        'autoscaled_worker_uses_authenticated_fetch_ref_helper or '
        'terminal_projection_empty_tasks or '
        'terminal_projection_rejection_removes_all_artifacts or '
        'status_recovery_read_closes_descriptor or '
        'cloudbench_recovery_review or '
        'migration or '
        'migrated_registry or '
        'owned_worker_volume or '
        'composite_result_finalizes_each_exact_root or '
        'minted_dispatch_preserves_live_root_observer or '
        'evaluated_wrapper_completion_publishes_once or '
        'data_plane_mirror_reads_current_owner_port or '
        'fleet_publishes_evaluation_before_teardown or '
        'boot_terminal_runtime_evidence_collects_complete_logs or '
        'cloudbench_worker_snapshot or '
        "quiesced_guest_writes_hashed_authoritative_zero_allocated_receipt'"
    ),
]
# The conditional benchmark blackbox belongs to its separately selected agents
# coverage gate. This entrypoint owns all twelve documented controller controls.
# Each top-level suite keeps its internal fixture ordering and owns a private
# TMPDIR; it does not share Python mocks or shell state with sibling processes.


def remove_suite_temporary(temporary, expected):
    """Restore owner directory access only inside the quiescent private fixture."""
    def require_owned(current):
        if current.st_dev != expected.st_dev or current.st_uid != os.geteuid():
            raise RuntimeError('suite temporary tree contains a foreign entry')

    def require_root():
        current = temporary.lstat()
        if (not stat.S_ISDIR(current.st_mode)
                or (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino)):
            raise RuntimeError('suite temporary directory identity changed')
        require_owned(current)

    def read_failed(error):
        raise error

    require_root()
    descriptor = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        current = os.fstat(descriptor)
        if (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino):
            raise RuntimeError('suite temporary directory identity changed')
        require_owned(current)
        for _, directories, files, directory in os.fwalk(
                '.', topdown=True, dir_fd=descriptor, follow_symlinks=False,
                onerror=read_failed):
            current = os.fstat(directory)
            require_owned(current)
            for name in directories + files:
                require_owned(os.stat(name, dir_fd=directory, follow_symlinks=False))
            os.fchmod(directory, stat.S_IMODE(current.st_mode) | stat.S_IRWXU)
        require_root()
        shutil.rmtree(temporary)
    finally:
        os.close(descriptor)


def run_case(root, folder, name, command):
    if CANCEL.is_set():
        return {'name': name, 'status': 'UNVERIFIED', 'reason': 'cancelled before execution'}
    log = folder / (name + '.log')
    temporary = Path(tempfile.mkdtemp(prefix='cloudbench-local-' + name + '-', dir='/var/tmp'))
    env = {**os.environ, 'TMPDIR': str(temporary), 'PYTHONDONTWRITEBYTECODE': '1'}
    env['PATH'] = str(root / 'agents' / 'venv' / 'bin') + os.pathsep + env.get('PATH', '')
    temporary_identity = temporary.stat()
    supervisor_receipt = folder / (name + '.supervisor.json')
    supervisor = Path(__file__).with_name('cloudbench-local-supervisor.py')
    started = time.time()
    print('GATE_STEP_START ' + name, flush=True)
    supervisor_exit = None
    supervision = None
    try:
        with log.open('wb') as stream:
            supervisor_exit, timed_out, cancelled, lingering = run_command(
                [sys.executable, str(supervisor), '--receipt', str(supervisor_receipt),
                 '--', 'bash', '-c', command],
                cwd=root, env=env, output=stream, timeout=None)
        supervision = json.loads(supervisor_receipt.read_text())
        code = supervision['native_exit']
        status = 'PASS' if code == 0 else 'FAIL'
        if (code not in (0, 1) or supervisor_exit != code
                or timed_out or cancelled or lingering
                or supervision.get('cancelled') or not supervision.get('quiescent')
                or supervision.get('orphaned_children') or supervision.get('error')):
            status = 'UNVERIFIED'
        raw = log.read_bytes()
        row = dict(name=name, command=['bash', '-c', command], status=status,
                   native_exit=code, started_at=started, finished_at=time.time(),
                   timed_out=timed_out, cancelled=cancelled, lingering_group=lingering,
                   log=str(log), sha256=hashlib.sha256(raw).hexdigest(),
                   fixture_tmp=str(temporary), supervisor_exit=supervisor_exit,
                   supervisor_receipt=str(supervisor_receipt), supervision=supervision)
        if status == 'PASS':
            remove_suite_temporary(temporary, temporary_identity)
            row['fixture_tmp_removed'] = True
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        row = dict(name=name, status='UNVERIFIED', reason=str(error),
                   started_at=started, finished_at=time.time(), log=str(log),
                   fixture_tmp=str(temporary), supervisor_exit=supervisor_exit,
                   supervisor_receipt=str(supervisor_receipt), supervision=supervision)
    (folder / (name + '.json')).write_text(json.dumps(row, indent=2) + '\n')
    print('GATE_STEP ' + name + ' status=' + row['status'] +
          ' exit=' + str(row.get('native_exit', 'unexecuted')), flush=True)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--max-workers', type=int, default=12)
    args = parser.parse_args()
    if sys.platform != 'linux' or not 1 <= args.max_workers <= 12:
        parser.error('requires Linux and 1..12 worker processes')
    os.umask(0o077)
    root = args.root.resolve()
    before = source(root)
    cases = list(CASES)
    artifacts = root / '.context' / 'cloudbench-local'
    artifacts.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='run-', dir=artifacts))
    folder.chmod(0o700)
    print('GATE_NATIVE_ARTIFACTS ' + str(folder), flush=True)
    (folder / 'inventory.json').write_text(json.dumps(dict(
        source=before, cases=cases), indent=2) + '\n')
    rows = []
    with cancellation_handlers(), ThreadPoolExecutor(max_workers=args.max_workers) as pool:
        futures = [pool.submit(run_case, root, folder, name, command) for name, command in cases]
        for future in as_completed(futures):
            rows.append(future.result())
    after = source(root)
    if before != after:
        rows = [{**row, 'status': 'UNVERIFIED', 'reason': 'source changed'} for row in rows]
    by_name = {row['name']: row for row in rows}
    rows = [by_name[name] for name, _ in cases]
    passed = all(row['status'] == 'PASS' for row in rows)
    result = dict(source=before, complete=all(row['status'] in ('PASS', 'FAIL') for row in rows),
                  source_unchanged=before == after, cases=rows)
    (folder / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print('GATE_RESULT exit=' + ('0' if passed else '1'), flush=True)
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
