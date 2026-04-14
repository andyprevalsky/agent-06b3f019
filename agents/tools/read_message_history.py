"""Backward-compatibility shim -- real implementation lives in domains/read_message_history/."""

from domains.read_message_history.handler import (  # noqa: F401
    read_message_history_activity,
    read_message_history_with_person,
)
