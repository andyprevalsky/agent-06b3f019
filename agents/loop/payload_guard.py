"""Activity payload size guard.

Temporal rejects any single data converter payload above 2 MiB. Hitting that
limit at schedule time used to cause a silent workflow-task retry loop (see
the parallel-tool-calls smoke incident of 2026-04-18): the SDK logs a
[TMPRL1103] warning, the workflow task fails to encode, Temporal replays with
exponential backoff, replay hits the same oversize payload, loop continues
until something kills the agent.

The helpers below let call sites that ship user-scaled data (accumulated
message context, attachments, sub-agent traces) fail fast and loudly with a
catchable Python exception BEFORE Temporal's encoder gets involved, so the
error surfaces as a normal tool failure instead of an unrecoverable stall.
"""

from __future__ import annotations

import json
from typing import Any, List

# Temporal's hard per-payload error ceiling is 2_097_152 B. Reserve headroom
# for framing + sibling args + SDK overhead; crash loudly before we hit it.
ACTIVITY_PAYLOAD_LIMIT_BYTES = 1_800_000


class ActivityPayloadTooLarge(Exception):
    """Raised when activity args would exceed Temporal's 2 MiB payload limit."""

    def __init__(self, activity_name: str, size: int):
        self.activity_name = activity_name
        self.size = size
        super().__init__(
            f"Cannot schedule activity '{activity_name}': serialized args are "
            f"{size:,} bytes (limit ~{ACTIVITY_PAYLOAD_LIMIT_BYTES:,}). "
            f"Trim context or move large blobs out-of-band."
        )


def measure_payload_bytes(args: List[Any]) -> int:
    """Return the JSON-serialized size of an activity argument list in bytes.

    Uses ``default=str`` so non-JSON-native values (datetimes, UUIDs) don't
    blow up the size check itself. Temporal's real encoder may pack these
    slightly differently, but the estimate is close enough to catch the
    orders-of-magnitude overshoots that cause the stall.
    """
    return sum(len(json.dumps(arg, default=str).encode("utf-8")) for arg in args)


def check_activity_payload(activity_name: str, args: List[Any]) -> None:
    """Raise ActivityPayloadTooLarge if serialized args exceed the limit."""
    size = measure_payload_bytes(args)
    if size > ACTIVITY_PAYLOAD_LIMIT_BYTES:
        raise ActivityPayloadTooLarge(activity_name, size)
