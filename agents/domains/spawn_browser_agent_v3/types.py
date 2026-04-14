"""Types for spawn-browser-agent-v3 domain.

Schemas, type aliases, and data classes used across layers.
"""

from __future__ import annotations

from typing import List, Optional


class ClaudeTokenState:
    """Tracks Claude OAuth token state for pool rotation and fallback."""

    def __init__(self) -> None:
        self.access_token: Optional[str] = None
        self.source: Optional[str] = None  # 'user' | 'pool'
        self.pool_token_id: Optional[str] = None
        self.excluded_pool_ids: List[str] = []
        self.fallen_back_to_racing: bool = False
