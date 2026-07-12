"""Gate domain types.

Imports: none (own types only).
"""

from __future__ import annotations


class GateRejectedError(Exception):
    """Raised when the user declines (rejects) a gate instead of resolving it."""

    def __init__(self, gate_key: str, request_id: str = ""):
        self.gate_key = gate_key
        self.request_id = request_id
        super().__init__(f"User declined gate: {gate_key}")
