"""Blackbox tests for terminal_filter domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def test_feed_and_display():
    """feed text and verify get_display returns it."""
    from utils.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("Hello, world!\n")

    display = tf.get_display()

    assert "Hello, world!" in display


def test_reset():
    """feed text, reset, verify display is empty."""
    from utils.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("Some content\n")
    assert "Some content" in tf.get_display()
    assert "Some content" in tf.get_raw_output()

    tf.reset()

    assert tf.get_display() == ""
    assert tf.get_raw_output() == ""


def test_ansi_filtering():
    """feed text with ANSI escape codes, verify they are processed (not in output)."""
    from utils.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    # ANSI color code: \033[31m = red, \033[0m = reset
    tf.feed("\033[31mRed text\033[0m and normal\n")

    display = tf.get_display()

    assert "Red text" in display
    assert "and normal" in display
    # The ANSI escape codes should be processed by pyte, not appear as raw text
    assert "\033[31m" not in display


def test_raw_output_preserves_unwrapped_lines():
    """raw output keeps machine-readable lines that the terminal display wraps."""
    from utils.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=20, rows=24)
    long_json = '[Codex] {"rows":[{"name":"Long Company Name"}],"row_count":1}\n'
    tf.feed(long_json)

    assert "Long Company N\name" in tf.get_display()
    assert long_json.strip() in tf.get_raw_output()


def test_multiple_feeds():
    """Multiple feed calls accumulate content."""
    from utils.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("Line 1\n")
    tf.feed("Line 2\n")

    display = tf.get_display()

    assert "Line 1" in display
    assert "Line 2" in display


def test_get_line_count():
    """get_line_count returns correct number of non-empty lines."""
    from utils.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("Line 1\nLine 2\nLine 3\n")

    assert tf.get_line_count() == 3


def test_cursor_position():
    """get_cursor_position returns tuple of (row, col)."""
    from utils.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("ABC")

    row, col = tf.get_cursor_position()

    assert row == 0
    assert col == 3


def test_lf_only_claude_note_does_not_staircase():
    """Bare LF must match xterm convertEol — no mid-line Claude-note staircase."""
    from utils.terminal_filter import TerminalFilter

    # Real Claude Code PTY shape: LF without CR between notes/tool lines.
    sample = (
        "Claude note\n"
        "Session started in /home/user\n"
        "Claude note\n"
        "I'll start by checking GitHub access.\n"
        "  [Claude tool] Bash\n"
        "  [Claude tool] Bash\n"
    )
    tf = TerminalFilter(cols=80, rows=50)
    tf.feed(sample)
    display = tf.get_display()
    lines = display.split("\n")

    assert lines[0] == "Claude note"
    assert lines[1] == "Session started in /home/user"
    assert lines[2] == "Claude note"
    assert lines[3] == "I'll start by checking GitHub access."
    assert lines[4] == "  [Claude tool] Bash"
    assert lines[5] == "  [Claude tool] Bash"
    # Staircase signature: second line starts with many leading spaces.
    assert not lines[1].startswith("           ")


def test_convert_eol_preserves_existing_crlf_and_chunk_split_cr():
    """Existing CRLF stays single; CR|LF split across feeds does not double CR."""
    from utils.terminal_filter import TerminalFilter

    tf = TerminalFilter(cols=80, rows=24)
    tf.feed("Line A\r\n")
    tf.feed("Line B\r")
    tf.feed("\nLine C\n")
    display = tf.get_display()
    assert display.split("\n") == ["Line A", "Line B", "Line C"]
    # Raw chunks stay untouched (ANSI strip only); normalize is display-path only.
    assert "Line A\r\n" in tf.get_raw_output()

    # Preserve the old character-wise contract for every short control/text
    # string and both prior-chunk CR states, including an empty chunk.
    from itertools import product

    def reference(data, last_was_cr):
        out = []
        for char in data:
            if char == "\n" and not last_was_cr:
                out.append("\r")
            out.append(char)
            last_was_cr = char == "\r"
        return "".join(out), last_was_cr

    for length in range(7):
        for chars in product(("a", "\r", "\n", "\x1b", "界"), repeat=length):
            data = "".join(chars)
            for prior_cr in (False, True):
                assert TerminalFilter._normalize_convert_eol(data, prior_cr) == reference(data, prior_cr)


async def run_all_tests():
    print("terminal-filter blackbox tests:")
    r = BlackboxResult()
    r.record("feed_and_display", test_feed_and_display)
    r.record("reset", test_reset)
    r.record("ansi_filtering", test_ansi_filtering)
    r.record("raw_output_preserves_unwrapped_lines", test_raw_output_preserves_unwrapped_lines)
    r.record("multiple_feeds", test_multiple_feeds)
    r.record("get_line_count", test_get_line_count)
    r.record("cursor_position", test_cursor_position)
    r.record("lf_only_claude_note_does_not_staircase", test_lf_only_claude_note_does_not_staircase)
    r.record(
        "convert_eol_preserves_existing_crlf_and_chunk_split_cr",
        test_convert_eol_preserves_existing_crlf_and_chunk_split_cr,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
