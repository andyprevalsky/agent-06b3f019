"""Re-export shim — canonical location is utils.format_tool_display."""

from utils.format_tool_display import (
    _truncate as _truncate,
)
from utils.format_tool_display import (
    format_tool_display as format_tool_display,
)

__all__ = ["format_tool_display", "_truncate"]
