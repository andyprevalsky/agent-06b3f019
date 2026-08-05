"""Blackbox tests for fingerprint_injection domain."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


async def test_apply_fingerprint_none():
    """apply_fingerprint_injection returns False when fingerprint is None."""
    from helpers.fingerprint_injection import apply_fingerprint_injection

    mock_page = MagicMock()
    result = await apply_fingerprint_injection(mock_page, None)

    assert result is False


async def test_apply_fingerprint_with_user_agent():
    """apply_fingerprint_injection returns True when valid fingerprint provided."""
    from helpers.fingerprint_injection import apply_fingerprint_injection

    # Build mock page with CDP session support
    mock_cdp_session = AsyncMock()
    mock_cdp_session.send = AsyncMock()

    mock_context = AsyncMock()
    mock_context.new_cdp_session = AsyncMock(return_value=mock_cdp_session)
    mock_context.add_init_script = AsyncMock()

    mock_page = MagicMock()
    mock_page.context = mock_context

    fingerprint = {
        "userAgentOverride": {
            "userAgent": "MyBot/1.0",
            "userAgentMetadata": {
                "platform": "Linux",
                "architecture": "x86_64",
            },
        },
        "initScript": "console.log('fingerprint injected');",
        "timezone": "America/Los_Angeles",
    }

    result = await apply_fingerprint_injection(mock_page, fingerprint)

    assert result is True
    # Verify CDP session was created and Network.enable was called
    mock_context.new_cdp_session.assert_called_once_with(mock_page)
    mock_cdp_session.send.assert_any_call("Network.enable")
    mock_cdp_session.send.assert_any_call("Network.setUserAgentOverride", fingerprint["userAgentOverride"])
    mock_cdp_session.send.assert_any_call(
        "Emulation.setTimezoneOverride", {"timezoneId": "America/Los_Angeles"}
    )


async def test_apply_fingerprint_to_context_none():
    """apply_fingerprint_to_context returns False when fingerprint is None."""
    from helpers.fingerprint_injection import apply_fingerprint_to_context

    mock_context = MagicMock()
    result = await apply_fingerprint_to_context(mock_context, None)

    assert result is False


async def test_apply_fingerprint_to_context_with_script():
    """apply_fingerprint_to_context applies init script and scrollbar script."""
    from helpers.fingerprint_injection import apply_fingerprint_to_context

    mock_context = AsyncMock()
    mock_context.add_init_script = AsyncMock()

    fingerprint = {
        "initScript": "console.log('init');",
    }

    result = await apply_fingerprint_to_context(mock_context, fingerprint)

    assert result is True
    # Should have been called twice: once for initScript, once for scrollbar
    assert mock_context.add_init_script.call_count == 2


async def run_all_tests():
    print("fingerprint-injection blackbox tests:")
    r = BlackboxResult()
    await r.record_async("apply_fingerprint_none", test_apply_fingerprint_none)
    await r.record_async("apply_fingerprint_with_user_agent", test_apply_fingerprint_with_user_agent)
    await r.record_async("apply_fingerprint_to_context_none", test_apply_fingerprint_to_context_none)
    await r.record_async("apply_fingerprint_to_context_with_script", test_apply_fingerprint_to_context_with_script)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
