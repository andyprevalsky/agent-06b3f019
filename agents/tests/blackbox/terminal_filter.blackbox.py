"""Blackbox tests for terminal_filter domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_feed_and_display():
    """feed text and verify get_display returns it."""
    from helpers.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("Hello, world!\n")

    display = tf.get_display()

    assert "Hello, world!" in display


def test_reset():
    """feed text, reset, verify display is empty."""
    from helpers.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("Some content\n")
    assert "Some content" in tf.get_display()

    tf.reset()

    assert tf.get_display() == ""


def test_ansi_filtering():
    """feed text with ANSI escape codes, verify they are processed (not in output)."""
    from helpers.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    # ANSI color code: \033[31m = red, \033[0m = reset
    tf.feed("\033[31mRed text\033[0m and normal\n")

    display = tf.get_display()

    assert "Red text" in display
    assert "and normal" in display
    # The ANSI escape codes should be processed by pyte, not appear as raw text
    assert "\033[31m" not in display


def test_multiple_feeds():
    """Multiple feed calls accumulate content."""
    from helpers.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("Line 1\n")
    tf.feed("Line 2\n")

    display = tf.get_display()

    assert "Line 1" in display
    assert "Line 2" in display


def test_get_line_count():
    """get_line_count returns correct number of non-empty lines."""
    from helpers.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("Line 1\nLine 2\nLine 3\n")

    assert tf.get_line_count() == 3


def test_cursor_position():
    """get_cursor_position returns tuple of (row, col)."""
    from helpers.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("ABC")

    row, col = tf.get_cursor_position()

    assert row == 0
    assert col == 3


async def run_all_tests():
    print("terminal-filter blackbox tests:")
    r = BlackboxResult()
    r.record("feed_and_display", test_feed_and_display)
    r.record("reset", test_reset)
    r.record("ansi_filtering", test_ansi_filtering)
    r.record("multiple_feeds", test_multiple_feeds)
    r.record("get_line_count", test_get_line_count)
    r.record("cursor_position", test_cursor_position)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
