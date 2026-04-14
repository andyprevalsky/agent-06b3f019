"""set-plan domain types -- schemas, typed dicts, and type aliases."""

from __future__ import annotations

from typing import TypedDict


class TaskObject(TypedDict):
    """A single task in the planner output."""

    goal: str
    tool_name: str


class PlanData(TypedDict):
    """Plan data structure for frontend and DAG executor."""

    type: str
    title: str
    content: str
    tasks: list[TaskObject]
    dependencies: dict[str, list[str]]
    join: str
    status: str
