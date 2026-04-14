"""Wait/sleep tool -- re-exports from domains.wait_seconds.

All business logic lives in ``domains/wait_seconds/``.
This file exists solely so that existing imports
(``from tools.wait_seconds import ...``) continue to resolve.
"""

from domains.wait_seconds.handler import (  # noqa: F401
    WaitSecondsManager,
    get_manager,
    wait_seconds,
)
from domains.wait_seconds.service import format_duration  # noqa: F401
