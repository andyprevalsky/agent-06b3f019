"""Workflow-safe deadlines for calls that actually enter the WMH boundary."""
from datetime import timedelta


def wmh_activity_timeout_options(mode: str, real_timeout: timedelta) -> dict:
    if mode in {"simulate", "shadow"}:
        # Temporal requires a scheduling bound. The run owner supplies cancellation;
        # no short per-attempt timer may abandon a still-running native operation.
        return {"schedule_to_close_timeout": timedelta(days=365)}
    return {"start_to_close_timeout": real_timeout}
