"""Terminal output filtering using pyte.

Like xterm.js on the frontend, pyte is a terminal emulator that processes
ANSI escape sequences, handles cursor movement, line overwrites, etc.
This provides clean, deduped output for the parent LLM.
"""

import pyte


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

    def feed(self, data: str) -> None:
        """
        Feed raw terminal data into the filter.

        Args:
            data: Raw terminal output including ANSI codes
        """
        self.stream.feed(data)

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
        return '\n'.join(lines)

    def get_display_full(self) -> str:
        """
        Get the full display including empty lines.

        Returns:
            Full terminal display preserving structure.
        """
        return '\n'.join(line.rstrip() for line in self.screen.display)

    def reset(self) -> None:
        """Reset the terminal state (e.g., on reconnection with new buffer)."""
        self.screen.reset()

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
