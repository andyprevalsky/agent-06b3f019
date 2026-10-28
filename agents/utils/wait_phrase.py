"""wait_for display phrase normalization.

The UI title is composed as "Waiting for <description>". Models often write the
description as a full phrase ("Waiting for Chase balances"), which rendered as
"Waiting for Waiting for Chase balances". Mirrors front-end waitForPhrase.ts.
"""

from __future__ import annotations

import re

_WAIT_PREFIX = re.compile(r"^\s*(?:(?:still\s+)?(?:waiting|waited|wait)\s+(?:for|on)\s+)+", re.IGNORECASE)


def wait_target(text: str) -> str:
    """The waited-on target alone: "Waiting for Chase balances" -> "Chase balances"."""
    stripped = _WAIT_PREFIX.sub("", text).strip()
    return stripped or text.strip()
