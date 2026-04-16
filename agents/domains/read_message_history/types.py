"""Read-message-history domain types.

Schemas, type aliases, and data structures.
Imports: external packages only.
"""

from typing import Any, Awaitable, Callable, TypedDict

# Type alias for execute_activity callable
ExecuteActivityCallable = Callable[..., Awaitable[Any]]


class PersonInfo(TypedDict, total=False):
    """Person record returned from backend API."""

    id: str
    firstName: str
    lastName: str
    phoneNumber: str
    email: str


class MessageRecord(TypedDict, total=False):
    """Single message in a conversation history."""

    text: str
    direction: str
    timestamp: str
    channel: str
    message: str


class ReadMessageHistoryResult(TypedDict, total=False):
    """Result from the read_message_history_activity."""

    person: PersonInfo | None
    messages: list[MessageRecord]
    message: str
    count: int
    multiple_matches: bool
    matches: list[PersonInfo]


class ReadMetadata(TypedDict, total=False):
    """Metadata attached to tool events for downstream verification."""

    phone: str | None
    email: str | None
    first_name: str | None
    last_name: str | None
    person_id: str | None
    person_phone: str | None
    person_email: str | None
