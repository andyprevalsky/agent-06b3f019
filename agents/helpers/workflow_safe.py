"""Context-safe uuid/clock for code that runs in BOTH workflow and activity scope.

`run_agent` executes in two places: the main agent loop (inside the Temporal
workflow sandbox, where replay determinism matters) AND the explore agent, which
runs `run_agent` inside `spawn_explore_agent_activity` (a Temporal activity).

`workflow.uuid4()` / `workflow.now()` are replay-deterministic but only valid in
the workflow event loop — calling them from inside the explore activity raises
`_NotInWorkflowEventLoopError('Not in workflow event loop')`, which failed every
explore agent. These helpers branch on `workflow.in_workflow()`:
  - in the workflow  -> `workflow.uuid4()` / `workflow.now()` (replay-stable)
  - in the activity  -> real `uuid.uuid4()` / `datetime.now()` (activities are not
    replay-constrained, so raw values are correct and safe)

This module lives in `helpers/` on purpose: `helpers/` runs outside the workflow
sandbox and is intentionally NOT covered by the workflow-determinism AST guard
(`tests/blackbox/workflow_determinism.blackbox.py`), so it may hold the raw
`uuid.uuid4()`/`datetime.now()` calls the activity branch needs. Workflow-scope
callers (e.g. `run_agent`) only *call* these helpers and still get replay-stable
values via the `workflow.in_workflow()` branch.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from temporalio import workflow


def safe_uuid4():
    """`workflow.uuid4()` in the workflow (deterministic), real `uuid.uuid4()` in an activity."""
    return workflow.uuid4() if workflow.in_workflow() else uuid.uuid4()


def safe_now() -> datetime:
    """`workflow.now()` in the workflow (deterministic), real UTC clock in an activity."""
    return workflow.now() if workflow.in_workflow() else datetime.now(timezone.utc)


class ContextLogger:
    """Route shared workflow/activity logging through the owning runtime."""

    def __getattr__(self, method):
        def emit(event, *args, **fields):
            if workflow.in_workflow():
                # Temporal suppresses replay before formatting or emitting.
                logging_fields = {
                    key: fields.pop(key)
                    for key in ("exc_info", "stack_info", "stacklevel")
                    if key in fields
                }
                return getattr(workflow.logger, method)(
                    event, *args, extra=fields, **logging_fields
                )
            import structlog

            return getattr(structlog.get_logger(), method)(event, *args, **fields)

        return emit


def context_logger():
    return ContextLogger()
