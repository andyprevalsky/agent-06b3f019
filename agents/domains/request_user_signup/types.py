"""Types for request-user-signup domain.

Imports: external packages only.
"""

from enum import Enum


class SignupOutcome(str, Enum):
    """Possible outcomes after the signup prompt is shown."""

    COMPLETED = "completed"
    DISMISSED = "dismissed"
    MESSAGE = "message"  # User sent a message instead of acting on the prompt
