"""Type definitions for the message-person domain."""

from typing import TypedDict


class PersonIdFields(TypedDict, total=False):
    """Result of classifying a person_id string into structured fields."""

    phone: str
    email: str
    first_name: str
    last_name: str
