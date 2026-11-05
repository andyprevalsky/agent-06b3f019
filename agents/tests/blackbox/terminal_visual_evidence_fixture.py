"""Normal screenshot export and provider retry controls, without a sidecar gate."""
from screenshot_revision_cases import (
    test_export_and_actor_rehydrate as test_terminal_capture_reaches_polar,
    test_secret_text_redaction_preserves_captured_image as test_terminal_privacy_identity_and_restore,
    test_capture_cancellation as test_terminal_failed_write_cancel_and_revocation,
    test_all_captures_survive_restore as test_terminal_body_budget_and_no_authority,
)


async def test_terminal_invalid_receipts_fail_closed():
    from screenshot_revision_cases import (
        test_identity_is_description_not_admission,
        test_no_synthetic_screenshot,
        test_old_capture_time_stays_unrecorded_and_call_id_is_descriptive,
        test_legacy_screenshot_exclusion_does_not_hide_images,
        test_handler_image_projection_preserves_original_result,
    )
    for test in (
        test_identity_is_description_not_admission,
        test_no_synthetic_screenshot,
        test_old_capture_time_stays_unrecorded_and_call_id_is_descriptive,
        test_legacy_screenshot_exclusion_does_not_hide_images,
        test_handler_image_projection_preserves_original_result,
    ):
        await test()
