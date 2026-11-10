"""Canonical condition wait and controlled clock for Python tests.

A fixed ``time.sleep(0.2)`` used as synchronization passes on an idle host and
fails under CPU load. Tests wait for the observable condition instead:

    from condition_wait import wait_until
    pid = wait_until(lambda: read_pid(path), timeout=30, description="child pid file")

``wait_until`` polls the predicate with exponential backoff until it returns a
truthy value (which it returns) or the overall deadline passes. On timeout it
raises ``WaitTimeout`` carrying the last observed value or exception, so the
failure says what the test actually saw. ``async_wait_until`` is the asyncio
form and accepts sync or async predicates.

Tests that do deadline arithmetic inject ``FakeClock``: ``sleep`` advances its
time instantly, so a scenario about a 15-minute deadline runs in microseconds
and cannot be shifted by host load.

Stdlib only, so agents/ tests and scripts/tests can both import it by putting
``scripts/lib`` on ``sys.path``. The structural ratchet
``scripts/check_test_sleeps.py`` rejects new literal sleeps in test files.
"""

from __future__ import annotations

import asyncio
import inspect
import time
from typing import Any, Awaitable, Callable, Protocol, TypeVar, Union

T = TypeVar("T")

_UNSET = object()
_REPR_LIMIT = 2000


class Clock(Protocol):
    def monotonic(self) -> float: ...

    def sleep(self, seconds: float) -> None: ...

    async def async_sleep(self, seconds: float) -> None: ...


class SystemClock:
    """The real monotonic clock."""

    def monotonic(self) -> float:
        return time.monotonic()

    def time(self) -> float:
        return time.time()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    async def async_sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


SYSTEM_CLOCK = SystemClock()


class FakeClock:
    """A controlled clock: time moves only through ``advance`` or ``sleep``.

    ``monotonic()`` and ``time()`` move together. ``sleep``/``async_sleep``
    advance the clock by the requested amount without waiting (``async_sleep``
    still yields once so other tasks run). ``sleeps`` records every requested
    duration for assertions about backoff schedules.
    """

    def __init__(self, start: float = 1_000.0, *, wall_start: float = 1_700_000_000.0) -> None:
        self._monotonic = float(start)
        self._wall_offset = float(wall_start) - float(start)
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self._monotonic

    def time(self) -> float:
        return self._monotonic + self._wall_offset

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("FakeClock cannot move backwards")
        self._monotonic += seconds

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.advance(max(0.0, seconds))

    async def async_sleep(self, seconds: float) -> None:
        self.sleep(seconds)
        await asyncio.sleep(0)


class WaitTimeout(AssertionError):
    """The condition did not hold before the deadline."""

    def __init__(self, description: str, timeout: float, attempts: int, last_value: Any, last_error: BaseException | None):
        self.description = description
        self.timeout = timeout
        self.attempts = attempts
        self.last_value = last_value
        self.last_error = last_error
        if last_error is not None:
            observed = f"last error {type(last_error).__name__}: {_bounded_repr(last_error)}"
        elif last_value is _UNSET:
            observed = "no observation"
        else:
            observed = f"last value {_bounded_repr(last_value)}"
        super().__init__(f"timed out after {timeout:g}s waiting for {description} ({attempts} checks; {observed})")


def _bounded_repr(value: Any) -> str:
    text = repr(value)
    if len(text) > _REPR_LIMIT:
        return f"{text[:_REPR_LIMIT]}... [{len(text) - _REPR_LIMIT} more chars]"
    return text


def _validate(timeout: float, initial_interval: float, max_interval: float, backoff: float) -> None:
    if timeout < 0:
        raise ValueError("timeout must be >= 0")
    if initial_interval <= 0 or max_interval <= 0:
        raise ValueError("poll intervals must be > 0")
    if backoff < 1:
        raise ValueError("backoff must be >= 1")


def wait_until(
    predicate: Callable[[], T],
    *,
    timeout: float,
    description: str,
    initial_interval: float = 0.01,
    max_interval: float = 0.25,
    backoff: float = 2.0,
    ignore_exceptions: tuple[type[BaseException], ...] = (),
    clock: Clock | None = None,
) -> T:
    """Poll ``predicate`` until it returns a truthy value; return that value.

    The predicate is always checked at least once and once more at the
    deadline, so a condition that becomes true during the final interval is
    not reported as a timeout. Exceptions listed in ``ignore_exceptions`` mean
    "not ready yet" and are reported on timeout; any other exception propagates.
    """
    _validate(timeout, initial_interval, max_interval, backoff)
    clock = clock or SYSTEM_CLOCK
    deadline = clock.monotonic() + timeout
    interval = initial_interval
    attempts = 0
    last_value: Any = _UNSET
    last_error: BaseException | None = None
    while True:
        attempts += 1
        try:
            value = predicate()
        except ignore_exceptions as exc:
            last_error = exc
        else:
            if value:
                return value
            last_value, last_error = value, None
        remaining = deadline - clock.monotonic()
        if remaining <= 0:
            raise WaitTimeout(description, timeout, attempts, last_value, last_error)
        clock.sleep(min(interval, remaining))
        interval = min(interval * backoff, max_interval)


async def async_wait_until(
    predicate: Callable[[], Union[T, Awaitable[T]]],
    *,
    timeout: float,
    description: str,
    initial_interval: float = 0.01,
    max_interval: float = 0.25,
    backoff: float = 2.0,
    ignore_exceptions: tuple[type[BaseException], ...] = (),
    clock: Clock | None = None,
) -> T:
    """Asyncio form of ``wait_until``; ``predicate`` may be sync or async."""
    _validate(timeout, initial_interval, max_interval, backoff)
    clock = clock or SYSTEM_CLOCK
    deadline = clock.monotonic() + timeout
    interval = initial_interval
    attempts = 0
    last_value: Any = _UNSET
    last_error: BaseException | None = None
    while True:
        attempts += 1
        try:
            value = predicate()
            if inspect.isawaitable(value):
                value = await value
        except ignore_exceptions as exc:
            last_error = exc
        else:
            if value:
                return value
            last_value, last_error = value, None
        remaining = deadline - clock.monotonic()
        if remaining <= 0:
            raise WaitTimeout(description, timeout, attempts, last_value, last_error)
        await clock.async_sleep(min(interval, remaining))
        interval = min(interval * backoff, max_interval)
