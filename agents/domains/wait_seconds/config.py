"""Wait-seconds domain config — constants and defaults."""

from __future__ import annotations

# Validation bounds (seconds)
MIN_WAIT: int = 1
MAX_WAIT: int = 2_678_400  # 31 days

# Time-unit thresholds for human-readable formatting
SECONDS_PER_MINUTE: int = 60
SECONDS_PER_HOUR: int = 3_600
SECONDS_PER_DAY: int = 86_400
