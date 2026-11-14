"""Screenshot tool results are included by default; context is descriptive."""
from screenshot_revision_cases import png, setup, capture, images, admitted
from screenshot_revision_cases import (
    test_default_history_and_descriptive_context as test_original_capture_admitted,
    test_secret_text_redaction_preserves_captured_image as test_private_and_session,
    test_identity_is_description_not_admission as test_identity_and_tamper,
    test_stream_retry_preserves_partial_output_and_deadline as test_byte_budget,
    test_all_captures_survive_restore as test_restore_and_failure,
    test_capture_cancellation,
)


async def test_dedup_and_recent():
    from screenshot_revision_cases import (
        test_raster_bytes_and_discriminators_survive_repeated_redaction,
        test_descriptive_identity_preserves_control_exceptions,
        test_count_fallback_last_n_and_no_mutation,
        test_fallback_is_bounded_and_unrelated_errors_propagate,
        test_actual_browser_client_retries_count_only,
        test_actual_verifier_stream_retries_count_only,
        test_actual_actor_stream_retries_count_only,
    )
    for test in (
        test_raster_bytes_and_discriminators_survive_repeated_redaction,
        test_descriptive_identity_preserves_control_exceptions,
        test_count_fallback_last_n_and_no_mutation,
        test_fallback_is_bounded_and_unrelated_errors_propagate,
        test_actual_browser_client_retries_count_only,
        test_actual_verifier_stream_retries_count_only,
        test_actual_actor_stream_retries_count_only,
    ):
        await test()
