"""Terminal output filtering using pyte.

Like xterm.js on the frontend, pyte is a terminal emulator that processes
ANSI escape sequences, handles cursor movement, line overwrites, etc.
This provides clean, deduped output for the parent LLM.
"""

import re

import pyte

_BARE_LF_RE = re.compile(r"(?<!\r)\n")
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class TerminalFilter:
    """
    Filter terminal output using pyte (like xterm.js on frontend).

    Handles:
    - ANSI escape sequences (colors, formatting)
    - Cursor repositioning
    - Line overwrites (progress bars, spinners)
    - Carriage returns

    This produces clean output similar to what you'd see visually in a terminal.
    """

    def __init__(self, cols: int = 200, rows: int = 500):
        """
        Initialize the terminal filter.

        Args:
            cols: Terminal width in characters. 200 is wide enough for most output.
            rows: Terminal height (scrollback). 500 lines should capture full sessions.
        """
        self.cols = cols
        self.rows = rows
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.Stream(self.screen)
        self._raw_chunks: list[str] = []
        # Tracks whether the previous feed ended with CR so a chunk-boundary
        # `\r` + `\n` split is not turned into `\r\r\n`.
        self._last_was_cr = False

    @staticmethod
    def _normalize_convert_eol(data: str, last_was_cr: bool) -> tuple[str, bool]:
        """Match xterm.js ``convertEol: true``: bare LF also returns the cursor.

        Claude Code / many PTY streams emit LF without CR. pyte (unlike our FE
        xterm with convertEol) treats bare LF as "move down, keep column", which
        produces the staircase wraps persisted into ``ClaudeCodeSession.output``.
        """
        if data == "":
            return data, last_was_cr
        normalized = _BARE_LF_RE.sub("\r\n", data)
        if last_was_cr and data.startswith("\n"):
            normalized = normalized[1:]
        return normalized, data.endswith("\r")

    def feed(self, data: str) -> None:
        """
        Feed raw terminal data into the filter.

        Args:
            data: Raw terminal output including ANSI codes
        """
        self._raw_chunks.append(data)
        normalized, self._last_was_cr = self._normalize_convert_eol(data, self._last_was_cr)
        self.stream.feed(normalized)

    def get_display(self) -> str:
        """
        Get the current display as clean text.

        Returns:
            Cleaned terminal output with ANSI processed, empty lines removed.
        """
        lines = []
        for line in self.screen.display:
            stripped = line.rstrip()
            if stripped:
                lines.append(stripped)
        return "\n".join(lines)

    def get_display_full(self) -> str:
        """
        Get the full display including empty lines.

        Returns:
            Full terminal display preserving structure.
        """
        return "\n".join(line.rstrip() for line in self.screen.display)

    def get_raw_output(self) -> str:
        """
        Get raw terminal output with ANSI control sequences removed.

        This preserves machine-readable lines before terminal emulation wraps
        them to the screen width, which matters for structured JSON output.
        """
        return ANSI_ESCAPE_RE.sub("", "".join(self._raw_chunks))

    def reset(self) -> None:
        """Reset the terminal state (e.g., on reconnection with new buffer)."""
        self.screen.reset()
        self._raw_chunks.clear()
        self._last_was_cr = False

    def get_cursor_position(self) -> tuple[int, int]:
        """
        Get current cursor position.

        Returns:
            Tuple of (row, column) zero-indexed.
        """
        return (self.screen.cursor.y, self.screen.cursor.x)

    def get_line_count(self) -> int:
        """
        Get number of non-empty lines in the display.

        Returns:
            Count of lines with content.
        """
        return sum(1 for line in self.screen.display if line.rstrip())
