"""Record activity tasks whose body starts long after Temporal started them.

Temporal marks an activity *started* when the worker's poller takes the task,
but the Python body runs only once the worker's event loop reaches it. On a
saturated worker that gap can consume the whole start-to-close budget: the
attempt times out on the server without its body ever issuing a request, and
nothing in the activity's own logs shows why. This interceptor logs the gap at
the boundary so a timeout can be attributed to the worker, not the callee.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import structlog
from temporalio import activity
from temporalio.worker import ActivityInboundInterceptor, ExecuteActivityInput, Interceptor

logger = structlog.get_logger()

# Above ordinary scheduling jitter; well below the 10–30 s start-to-close
# budgets of the small backend activities that starve first.
DISPATCH_LAG_WARN_SECONDS = 5.0


def dispatch_lag_seconds(info: activity.Info, now: datetime) -> float:
    """Seconds between the server's start of this attempt and its body starting."""
    return (now - info.started_time).total_seconds()


class _DispatchLagInbound(ActivityInboundInterceptor):
    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        info = activity.info()
        lag = dispatch_lag_seconds(info, datetime.now(timezone.utc))
        if lag >= DISPATCH_LAG_WARN_SECONDS:
            budget = info.start_to_close_timeout.total_seconds() if info.start_to_close_timeout else None
            logger.warning(
                "activity.dispatch_lag",
                activity_type=info.activity_type,
                activity_id=info.activity_id,
                attempt=info.attempt,
                workflow_id=info.workflow_id,
                lag_s=round(lag, 3),
                start_to_close_s=budget,
            )
        return await self.next.execute_activity(input)


class ActivityDispatchLagInterceptor(Interceptor):
    """Worker interceptor that logs activity bodies starting late."""

    def intercept_activity(self, next: ActivityInboundInterceptor) -> ActivityInboundInterceptor:
        return _DispatchLagInbound(next)
