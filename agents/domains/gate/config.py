"""Gate domain constants and defaults."""

import os

from utils.attention_requests import REJECTION_SENTINEL

TOOL_NAME = "gate"
DEFAULT_SUBSCRIBE_URL = "https://roselabs.ai/subscribe"
DEFAULT_KYC_URL = "https://roselabs.ai/kyc/start"

# Explicit ALLOWLIST of gate types the non-purchase kill-switch may suppress —
# connection gates that only ask the user to hook up a data source (e.g.
# "connect your Gmail"). This is fail-closed: purchase gates
# (subscription/kyc/approval) AND any unrecognized/misspelled type are NOT in the
# set, so they always block. Add a type here only when it is safe to skip.
SUPPRESSIBLE_GATE_TYPES = frozenset({"source_connect"})

# Sentinel returned by `create_gate_request_activity` when it suppressed a gate
# instead of creating an attention request. `raise_gate_direct` branches on this
# ACTIVITY RESULT (recorded in Temporal history) rather than re-reading the env
# flag in workflow scope, so the decision is deterministic across replays.
GATE_SUPPRESSED_SENTINEL = "__gate_suppressed__"


def gate_is_suppressed(gate_type: str) -> bool:
    """Whether a gate of this type should be a non-blocking no-op right now.

    Only types in ``SUPPRESSIBLE_GATE_TYPES`` are eligible, and only while the
    kill-switch is engaged (``NON_PURCHASE_GATES_ENABLED`` unset/false). Purchase
    and unknown types always return False (block). Reads the env flag, so call
    this ONLY from activity/test scope — never from workflow code (Temporal
    determinism); see ``repo.create_gate_request_activity``.
    """
    if gate_type not in SUPPRESSIBLE_GATE_TYPES:
        return False
    enabled = os.getenv("NON_PURCHASE_GATES_ENABLED", "0").strip().lower() in ("1", "true", "yes", "on")
    return not enabled


__all__ = [
    "DEFAULT_KYC_URL",
    "DEFAULT_SUBSCRIBE_URL",
    "GATE_SUPPRESSED_SENTINEL",
    "REJECTION_SENTINEL",
    "SUPPRESSIBLE_GATE_TYPES",
    "TOOL_NAME",
    "gate_is_suppressed",
]
