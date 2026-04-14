"""Monitor tool — re-exports from domains/monitor.

All logic lives in domains/monitor/. This file exists for backward
compatibility so existing ``from tools.monitor import monitor_activity``
continues to work.
"""

from domains.monitor.handler import monitor, monitor_activity

__all__ = ["monitor", "monitor_activity"]
