#!/usr/bin/env python3
"""Compact deploy control: evaluated outcomes are visible before teardown."""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENTS = ROOT / "agents"
PYTHON = AGENTS / "venv/bin/python"

if __name__ == "__main__":
    interpreter = str(PYTHON) if PYTHON.exists() else sys.executable
    env = dict(os.environ)
    env["PATH"] = str(Path(interpreter).parent) + os.pathsep + env.get("PATH", "")
    if Path("/opt/homebrew/bin").is_dir():
        env["PATH"] = (
            str(Path(interpreter).parent) + ":/opt/homebrew/bin:" + env.get("PATH", "")
        )
    raise SystemExit(
        subprocess.call(
            [
                interpreter,
                "-m",
                "pytest",
                "-q",
                "benchmarks/cloudbench_dependency_sync_test.py",
                "benchmarks/cloud_batch_cleanup_test.py",
                "benchmarks/worker_capacity_loop_test.py",
                "benchmarks/worker_terminal_cleanup_test.py",
                "benchmarks/outcome_publication_test.py",
                "benchmarks/hub_upload_test.py",
                "benchmarks/cloudbench_monitor_test.py",
                "benchmarks/fleet_startup_phase_test.py",
                "benchmarks/cloudbench_image_build_test.py",
                "benchmarks/cloudbench_image_installer_test.py",
                "benchmarks/cloudbench_image_cli_test.py",
                "benchmarks/cloudbench_demo_cache_test.py",
                "tests/fast_cache/test_fast_cache.py",
                "-k",
                "cold_image or cloudbench_image_build or demo_cache_probe or read_only_benchmark_clean_miss_never_calls_provider or write_through_disabled_by_isolated_shared_cache_flag or shared_cache_disable_flag_blocks_all_cache_writes or exact_recovery_releases_only_its_capacity_and_proxy_leases or exact_recovery_validates_complete_capacity_cohort_before_release or current_registry_retirement_is_bounded_parallel_and_joins_receipts or current_registry_retirement_validates_cohort_before_native_mutations or fleet_monitor or startup_state or current_phase or fleet_publishes_evaluation_before_teardown or evaluated_outcome_is_visible_before_agent_and_phone_teardown or autoscaler_runtime_handoff_capacity or worker_cleanup_and_terminal_allocation_ownership or outcome_publication_http or outcome_wait_preserves or hub_transport_keeps_complete_transcripts_without_diagnostic_blobs or live_response_preserves_phase_and_startup_label or machine_readiness_publishes_keyed_inventory_index or test_clone_retries_transient_volume_not_found or fleet_lifecycle_receipt_requires_final_registry_retirement or exact_pool_claim_confirmation_requires_guest_receipt or fleet_retained_resources_do_not_claim_release or data_plane_barrier_release_at_full_fleet_width",
            ],
            cwd=AGENTS,
            env=env,
        )
    )
