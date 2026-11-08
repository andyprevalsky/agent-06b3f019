"""Shared-process guard for `pytest tests/unit` (one interpreter for every file).

The blackbox harness (`tests/blackbox/_test_utils.py`) installs process-wide
state when imported: it wraps every new `httpx.AsyncClient` transport in the
capture harness (which buffers whole response streams before returning them),
exports BLACKBOX_TEST_CAPTURE_OUTBOUND, and stubs Temporal's workflow clock.
That is correct inside a blackbox domain process, but a unit module importing it
at collection silently changed every later unit test in the same process: the
Foundry post-content stream test saw its mid-stream RemoteProtocolError raised
before any content and retried another deployment.

The baseline is taken when this conftest loads, before any unit module is
imported; every unit test must find it intact at setup and leave it intact.
"""

import os

import httpx
import pytest
import temporalio.workflow

_BASELINE = {
    "httpx.AsyncClient.__init__": lambda: httpx.AsyncClient.__init__,
    "temporalio.workflow.uuid4": lambda: temporalio.workflow.uuid4,
    "temporalio.workflow.now": lambda: temporalio.workflow.now,
    "env BLACKBOX_TEST_CAPTURE_OUTBOUND": lambda: os.environ.get("BLACKBOX_TEST_CAPTURE_OUTBOUND"),
}
_ORIGINAL = {name: read() for name, read in _BASELINE.items()}


def _leaked() -> list[str]:
    return [name for name, read in _BASELINE.items() if read() != _ORIGINAL[name]]


@pytest.fixture(autouse=True)
def shared_process_state_is_not_leaked():
    leaked = _leaked()
    assert not leaked, (
        f"process-global state changed before this test: {leaked}. A unit module must not import "
        "tests/blackbox/_test_utils at import time; load it in a fixture that restores this state."
    )
    yield
    leaked = _leaked()
    assert not leaked, f"this test leaked process-global state into later unit tests: {leaked}"
