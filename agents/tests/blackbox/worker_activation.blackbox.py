"""Blackbox tests for exact-build Temporal worker activation."""

import asyncio
from types import SimpleNamespace

from temporalio.client import WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode

from _test_utils import BlackboxResult, teardown_mock
from helpers.worker_activation import (
    wait_for_worker_build_activation,
    worker_deployment_activation_id,
)


class _Handle:
    def __init__(self, responses):
        self.responses = list(responses)

    async def describe(self):
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return SimpleNamespace(status=response)


class _Client:
    def __init__(self, responses):
        self.handle = _Handle(responses)
        self.requested_ids = []

    def get_workflow_handle(self, workflow_id):
        self.requested_ids.append(workflow_id)
        return self.handle


def _missing():
    return RPCError("missing", RPCStatusCode.NOT_FOUND, b"")


async def test_waits_for_only_the_exact_running_build_marker():
    build_id = "a" * 40
    deployment_token = "101-2"
    marker_id = worker_deployment_activation_id(build_id, deployment_token)
    client = _Client([_missing(), _missing(), WorkflowExecutionStatus.RUNNING])
    sleeps = []
    result = await wait_for_worker_build_activation(
        client,
        build_id,
        deployment_token,
        sleep=lambda seconds: _record_sleep(sleeps, seconds),
    )
    assert result == marker_id
    assert client.requested_ids == [marker_id, marker_id, marker_id]
    assert sleeps == [1.0, 1.0]


async def _record_sleep(sleeps, seconds):
    sleeps.append(seconds)


async def test_closed_marker_fails_closed():
    client = _Client([WorkflowExecutionStatus.COMPLETED])
    try:
        await wait_for_worker_build_activation(client, "b" * 40, "102-1")
        raise AssertionError("a closed marker must not activate a worker")
    except RuntimeError as exc:
        assert "COMPLETED" in str(exc)


async def test_missing_marker_times_out_without_accepting_another_build():
    clock = [0.0]
    client = _Client([_missing(), _missing()])

    async def advance(seconds):
        clock[0] += seconds

    try:
        await wait_for_worker_build_activation(
            client,
            "c" * 40,
            "103-1",
            timeout_seconds=1,
            poll_interval_seconds=1,
            monotonic=lambda: clock[0],
            sleep=advance,
        )
        raise AssertionError("a missing marker must time out")
    except TimeoutError as exc:
        assert "was not activated" in str(exc)
    assert client.requested_ids == [
        worker_deployment_activation_id("c" * 40, "103-1"),
        worker_deployment_activation_id("c" * 40, "103-1"),
    ]


def test_build_id_validation():
    try:
        worker_deployment_activation_id("not-a-sha", "104-1")
        raise AssertionError("invalid build IDs must fail closed")
    except ValueError as exc:
        assert "40-character Git SHA" in str(exc)


async def test_old_marker_for_same_build_cannot_authorize_new_attempt():
    build_id = "d" * 40
    old_marker = worker_deployment_activation_id(build_id, "105-1")
    new_marker = worker_deployment_activation_id(build_id, "105-2")
    assert old_marker != new_marker
    clock = [0.0]
    client = _Client([_missing(), _missing()])

    async def advance(seconds):
        clock[0] += seconds

    try:
        await wait_for_worker_build_activation(
            client,
            build_id,
            "105-2",
            timeout_seconds=1,
            poll_interval_seconds=1,
            monotonic=lambda: clock[0],
            sleep=advance,
        )
        raise AssertionError("an old deployment attempt marker must not authorize a new attempt")
    except TimeoutError:
        pass
    assert client.requested_ids == [new_marker, new_marker]


def test_deployment_token_validation():
    try:
        worker_deployment_activation_id("e" * 40, "unsafe:token")
        raise AssertionError("unsafe deployment tokens must fail closed")
    except ValueError as exc:
        assert "deployment token" in str(exc)


async def run_all_tests():
    print("worker-activation blackbox tests:")
    result = BlackboxResult()
    await result.record_async("exact_running_marker", test_waits_for_only_the_exact_running_build_marker)
    await result.record_async("closed_marker", test_closed_marker_fails_closed)
    await result.record_async("missing_timeout", test_missing_marker_times_out_without_accepting_another_build)
    await result.record_async(
        "old_attempt_isolation", test_old_marker_for_same_build_cannot_authorize_new_attempt
    )
    result.record("build_id_validation", test_build_id_validation)
    result.record("deployment_token_validation", test_deployment_token_validation)
    teardown_mock()
    return result.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
