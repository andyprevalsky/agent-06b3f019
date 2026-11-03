"""WHM-only recovery budget; native invocation and Rose routing stay with their owners.

native admitted prediction -> shared Rose recovery -> scheduled attempt -> Rose
Only transient failures repeat here. Strict result repair remains in Rose recovery.
"""

from __future__ import annotations

import asyncio
import math
import ssl
import sys
import time
from contextlib import aclosing
from copy import deepcopy
from dataclasses import dataclass, field
from random import SystemRandom

import httpx

# SDK2.26.0: two retries, 0.5*2**n with negative 25% jitter.
# Claude's ordinary fallback uses300s; recovered native Run12 reached349.598s.
# Add Rose's existing10s heartbeat interval and round up to360s.
from benchmarks.wmh_execution_policy import WMH_COMPLETION_RETRY_POLICY
from benchmarks.wmh_provider_capture import prediction_request
from providers.rose.errors import (
    RoseAllFailed,
    RoseAuthError,
    RoseDeadlineError,
    RoseInvalidRequest,
    RosePaymentRequiredError,
    RoseRateLimitError,
    RoseRefusalError,
    RoseServerError,
    RoseStallError,
)
from providers.rose.truncation import USAGE_COUNTERS
from providers.rose.types import StreamChunk
from providers.rose.whm_retry_observation import FAILURE_OBSERVER

POLICY = deepcopy(WMH_COMPLETION_RETRY_POLICY)
_monotonic = time.monotonic
_wall = time.time
_sleep = asyncio.sleep
_random = SystemRandom().random


def transient_failure(error: BaseException) -> bool:
    if getattr(error, "wmh_permanent_route_failure", False):
        return False
    if isinstance(
        error,
        (
            RoseAuthError,
            RoseInvalidRequest,
            RosePaymentRequiredError,
            RoseRefusalError,
            httpx.LocalProtocolError,
            httpx.UnsupportedProtocol,
        ),
    ):
        return False
    if isinstance(error, RoseAllFailed):
        return bool(error.step_errors) and all(transient_failure(item.error) for item in error.step_errors)
    status = getattr(error, "status", None)
    if type(status) is int:
        if status in (408, 409, 429) or status >= 500:
            return True
        if 400 <= status < 500:
            return False
    if isinstance(error.__cause__, (httpx.TransportError, ssl.SSLError, ConnectionError, TimeoutError)):
        return not isinstance(error.__cause__, (httpx.LocalProtocolError, httpx.UnsupportedProtocol))
    return isinstance(
        error,
        (
            RoseDeadlineError,
            RoseStallError,
            RoseServerError,
            RoseRateLimitError,
            httpx.TransportError,
            ssl.SSLError,
            ConnectionError,
            TimeoutError,
        ),
    )


def retry_after_seconds(error: BaseException | None) -> float:
    """Use a structured hint when available; never guess from error text."""
    value = getattr(error, "retry_after_s", None)
    if type(value) not in (int, float) or math.isnan(value) or value <= 0:
        value = 0.0
    if isinstance(error, RoseAllFailed):
        return max(float(value), max((retry_after_seconds(item.error) for item in error.step_errors), default=0.0))
    return float(value)


class WMHRetryBudgetError(RoseDeadlineError):
    """No further inference is admitted; known metering remains with the budget."""


class NonRecoverableCompletion(Exception):
    """Carry the original failure past Rose's result-repair catch, then unwrap."""

    def __init__(self, error):
        super().__init__(type(error).__name__)
        self.original = error


@dataclass
class CompletionRetryBudget:
    total_seconds: float = POLICY["total_seconds"]
    monotonic_start: float = field(default_factory=lambda: _monotonic())
    wall_start: float = field(default_factory=lambda: _wall())
    attempts: int = 0
    transient_retries: int = 0
    last_error: BaseException | None = None
    observed_attempts: list[dict] = field(default_factory=list)
    charged_elapsed: float = 0.0
    latest_request: dict = field(default_factory=dict)

    def remaining(self) -> float:
        # A forward wall-clock gap must not grant a fresh budget after a managed
        # VM resumes. Monotonic time still prevents backwards wall-clock extension.
        mono, wall = _monotonic(), _wall()
        self.charged_elapsed += max(mono - self.monotonic_start, wall - self.wall_start, 0.0)
        self.monotonic_start, self.wall_start = mono, wall
        return self.total_seconds - self.charged_elapsed

    async def admit(self, kwargs: dict) -> dict:
        if self.attempts >= POLICY["max_attempts"]:
            raise WMHRetryBudgetError("WHM completion attempt budget exhausted") from self.last_error
        if self.attempts:
            floor = retry_after_seconds(self.last_error)
            delay = 0.0
            if self.last_error is not None and transient_failure(self.last_error):
                delay = min(POLICY["max_delay_seconds"], POLICY["initial_delay_seconds"] * 2**self.transient_retries)
                delay *= 1.0 - 0.25 * _random()
                delay = max(delay, floor)
                self.transient_retries += 1
            if delay + POLICY["minimum_retry_seconds"] > self.remaining():
                raise WMHRetryBudgetError("WHM completion deadline cannot fit the retry floor") from self.last_error
            if delay:
                await _sleep(delay)
        remaining = self.remaining()
        if remaining <= 0 or (self.attempts and remaining < POLICY["minimum_retry_seconds"]):
            raise WMHRetryBudgetError("WHM completion overall deadline exhausted") from self.last_error
        self.attempts += 1
        self.latest_request = {
            **kwargs,
            "deadline_s": min(POLICY["attempt_seconds"], remaining),
            "ttft_timeout_s": POLICY["ttft_seconds"],
            "idle_timeout_s": POLICY["idle_seconds"],
        }
        return self.latest_request

    def observed(self, model: str, usage: dict, *, complete: bool) -> dict:
        row = {
            "model": model,
            "usage_complete": complete,
            **{key: usage[key] for key in USAGE_COUNTERS if type(usage.get(key)) is int and usage[key] >= 0},
        }
        self.observed_attempts.append(row)
        return row

    def usage(self) -> dict:
        rows = self.observed_attempts
        return {
            **{key: sum(row.get(key, 0) for row in rows) for key in USAGE_COUNTERS if any(key in row for row in rows)},
            "abandoned_attempts": deepcopy(rows[:-1]),
            "usage_complete": bool(rows) and all(row["usage_complete"] for row in rows),
        }


async def scheduled_attempt(attempt, kwargs: dict, budget: CompletionRetryBudget, capture):
    """Bound raw attempts across shared Rose repairs; discard failed partial replies."""
    while True:
        current = await budget.admit(kwargs)
        content, usage, model, usage_seen = [], {}, "", False
        held = []
        route_failures = []
        observer = FAILURE_OBSERVER.set(route_failures.append)
        try:
            async with asyncio.timeout(current["deadline_s"]):
                async with aclosing(attempt(**current)) as stream:
                    async for chunk in stream:
                        if budget.remaining() <= 0:
                            raise WMHRetryBudgetError("WHM completion overall deadline exhausted")
                        if chunk.kind == "content":
                            content.append(chunk.data.get("text", ""))
                        elif chunk.kind == "metadata":
                            model = chunk.data.get("actual_model", model)
                        elif chunk.kind == "usage":
                            usage, usage_seen = dict(chunk.data), True
                        if chunk.kind in ("usage", "done"):
                            held.append(chunk)
                        else:
                            yield chunk
            budget.observed(model, usage, complete=usage_seen)
            budget.last_error = None
        except Exception as error:
            floors = [row["retry_after_s"] for row in route_failures if row.get("retry_after_s")]
            if floors:
                error.retry_after_s = max(retry_after_seconds(error), max(floors))
            if any(row["permanent"] for row in route_failures):
                error.wmh_permanent_route_failure = True
            budget.last_error = error
            row = budget.observed(model, usage, complete=usage_seen)
            if not transient_failure(error) or isinstance(error, WMHRetryBudgetError):
                if (
                    isinstance(
                        error,
                        (
                            WMHRetryBudgetError,
                            RoseAuthError,
                            RoseInvalidRequest,
                            RosePaymentRequiredError,
                            RoseRefusalError,
                        ),
                    )
                    or getattr(error, "wmh_permanent_route_failure", False)
                    or (isinstance(error, RoseAllFailed) and not transient_failure(error))
                ):
                    raise NonRecoverableCompletion(error) from error
                raise
            # Transport failures also preserve exact collected bytes and known
            # numeric usage; no usage is invented when the provider never emits it.
            await capture(
                {
                    "kind": "transient_completion_failure",
                    "error_type": type(error).__name__,
                    "content": "".join(content),
                    "actual_model": model,
                    "usage": row,
                    "metering": {key: row[key] for key in USAGE_COUNTERS if key in row},
                    "usage_complete": usage_seen,
                    "attempt_ordinal": budget.attempts,
                    "request": prediction_request(current),
                }
            )
            if budget.attempts >= POLICY["max_attempts"]:
                raise
            yield StreamChunk(kind="restart", data={"reason": "wmh_transient_retry", "attempt": budget.attempts})
            continue
        finally:
            original_error = sys.exception()
            try:
                if route_failures:
                    # Quota classification can report the same HTTP response
                    # again; coalesce only persisted observations, not policy.
                    observations = {}
                    for index, failure in enumerate(route_failures):
                        key = failure.get("response_observation_id", ("event", index))
                        observations[key] = failure
                    await capture(
                        {
                            "kind": "provider_http_failures",
                            "attempt_ordinal": budget.attempts,
                            "request": prediction_request(current),
                            "route_failures": deepcopy(list(observations.values())),
                        }
                    )
            except Exception as capture_error:
                if original_error is not None:
                    raise capture_error from original_error
                raise
            finally:
                FAILURE_OBSERVER.reset(observer)
        for chunk in held:
            if budget.remaining() <= 0:
                raise WMHRetryBudgetError("WHM completion overall deadline exhausted")
            yield chunk
        return
