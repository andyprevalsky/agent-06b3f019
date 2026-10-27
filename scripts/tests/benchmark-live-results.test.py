#!/usr/bin/env python3
"""Compact deploy control: evaluated outcomes are visible before teardown."""

import os
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
    # Replace this wrapper with pytest: a signal sent to the gate's PID then
    # reaches the test process itself instead of orphaning a child pytest.
    os.chdir(AGENTS)
    os.execve(
        interpreter,
        [
            interpreter,
            "-m",
            "pytest",
            "-q",
            "benchmarks/cloudbench_dependency_sync_test.py",
            "benchmarks/cloudbench_image_dependency_contract_test.py",
            "benchmarks/cloud_batch_cleanup_test.py",
            "benchmarks/worker_capacity_loop_test.py",
            "benchmarks/cloudbench_worker_qualification_test.py",
            "benchmarks/worker_terminal_cleanup_test.py",
            "benchmarks/outcome_publication_test.py",
            "benchmarks/hub_upload_test.py",
            "benchmarks/cloudbench_monitor_test.py",
            "benchmarks/fleet_startup_phase_test.py",
            "benchmarks/cloudbench_image_build_test.py",
            "benchmarks/cloudbench_image_installer_test.py",
            "benchmarks/cloudbench_image_cli_test.py",
            "benchmarks/cloudbench_demo_cache_test.py",
            "benchmarks/cloudbench_campaign_barrier_test.py",
            "benchmarks/cloudbench_campaign_inventory_test.py",
            "benchmarks/cloudbench_runtime_retention_test.py",
            "benchmarks/local_lifecycle_test.py",
            "tests/demo_cache/test_demo_cache.py",
            "-k",
            "worker_qualification or runtime_collector_rechecks or post_config_start or sealed_primary_retirement or warm_deps_preflight_preserves_captured_exact_proof_when_later_read_fails or warm_deps_preflight_requires_live_verification_after_a_new_refresh or exact_recovery_pool_only_skips_nonexistent_warm_source or exact_recovery_rejects_unsafe_hierarchical_clone_topologies or failed_controller_all_sealed_archive or failed_fleet_forensic or exact_recovery_consumes_runtime_receipt or recovery_revalidates_exact_complete_copies or local_launchers_preserve_inherited_proxy_configuration or campaign_inventory or campaign_start_barrier or controller_execs_from_a_script_snapshot or cold_image or cloudbench_image_build or cloudbench_image_dependency_contract or demo_cache_probe or read_only_benchmark_clean_miss_never_calls_provider or write_through_disabled_by_isolated_shared_cache_flag or shared_cache_disable_flag_blocks_all_cache_writes or cloud_fleet_provenance_is_staged_stamped_aggregated_and_validated or execution_provenance_config_is_an_exact_nonsecret_allowlist or execution_provenance_binds_immutable_snapshot_not_mutable_checkout or prisma_client or cloud_fleet_acceptance_rejects_missing_and_opposite_provenance or exact_recovery_releases_only_its_capacity_and_proxy_leases or exact_recovery_validates_complete_capacity_cohort_before_release or current_registry_retirement_is_bounded_parallel_and_joins_receipts or current_registry_retirement_validates_cohort_before_native_mutations or current_preconfig_captures_before_disposable_reap or fleet_monitor or startup_state or current_phase or fleet_publishes_evaluation_before_teardown or evaluated_wrapper_completion_publishes_once or data_plane_mirror_reads_current_owner_port or evaluated_outcome_is_visible_before_agent_and_phone_teardown or native_world_retirement or native_world_joins or autoscaler_runtime_handoff_capacity or worker_cleanup_and_terminal_allocation_ownership or outcome_publication_http or outcome_wait_preserves or hub_transport or driver_cleanup_requires_current_stack_receipt_on_normal_completion or autoscaled_worker_uses_authenticated_fetch_ref_helper or cleanup_releases_emergency_disk or guest_shutdown_child_confirmation or exact_guest_recovery_archives_bound_child_token or exact_guest_cleanup_latch_survives_separate_runtime_capture_failure or live_response_preserves_phase_and_startup_label or machine_readiness_publishes_keyed_inventory_index or test_clone_retries_transient_volume_not_found or ambiguous_408_clone_absent_at_lookup_is_reaped_at_teardown or name_only_clone_only_after_joined_aged_absence or volume_only_record or waits_out_young_name_only_clone_visibility_window or unallocated_owned_name_exists or forced_recovery_retires_only_aged_absent_name_only_clone or fleet_lifecycle_receipt_requires_final_registry_retirement or exact_pool_claim_confirmation_requires_guest_receipt or fleet_retained_resources_do_not_claim_release or data_plane_barrier_release_at_full_fleet_width or prebuilt or fresh_role or real_boot_driver_interrupt_requires_canonical_runner_cleanup_ack or exact_tree_query_excludes_unmaterialized_logical_browsers",
        ],
        env,
    )
