"""Blackbox tests for the agents worker's agent-graph client (helpers/agent_graph.py).

Rose-builds-Rose C6. The backend
(`/api/agent-graph/*`, covered end to end by the backend `agent-graph`
blackbox) is faked through the httpx capture harness: these tests pin the
worker-side contract the backend relies on.

Invariants covered:
  - code agents cannot ask questions: the only agent-graph activity is send
    (no question activity, payload or route)
  - send is retry-safe: the message id derives from (workflow, tool call), so
    a retried activity posts the same id; definite scope errors (404/409) are
    non-retryable, transient 5xx are retryable
  - activity payload dataclasses decode with real annotations (the workflow
    sandbox resolves no string annotations)
  - adversarial (L-A2A-ADV): a response lost after the backend delivered is
    retried with the same id and lands once; a 429 from the per-sender cap is
    retryable no sooner than its Retry-After
"""

import asyncio
import dataclasses
import json
import typing
from datetime import timedelta
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest.mock import patch

import httpx
from _test_utils import BlackboxResult, setup_mock_fn, teardown_mock
from temporalio.exceptions import ApplicationError

BACKEND = "http://backend.test"


class FakeGraphBackend:
    """Records agent-graph requests; answers like the backend's routes."""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.status = 200
        self.seen_ids: set[str] = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        self.requests.append({"path": request.url.path, "headers": dict(request.headers), "body": body})
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "Agent not found in this tree"})
        if request.url.path.endswith("/questions"):
            return httpx.Response(
                200,
                json={
                    "deliver_to": "agent",
                    "agent_id": "parent-1",
                    "status": "delivered",
                    "message_id": body["message_id"],
                },
            )
        message_id = body.get("message_id", "")
        status = "duplicate" if message_id in self.seen_ids else "delivered"
        self.seen_ids.add(message_id)
        return httpx.Response(200, json={"message_id": message_id, "status": status, "to": {"id": body["to"]}})


def _config() -> SimpleNamespace:
    return SimpleNamespace(backend=SimpleNamespace(api_url=BACKEND, api_key="test-api-key"))


def _backend() -> FakeGraphBackend:
    backend = FakeGraphBackend()
    setup_mock_fn(backend.handler)
    return backend


def test_code_agents_have_no_question_activity():
    """The worker's agent-graph client only sends: nothing routes a code agent's question."""
    from helpers import agent_graph

    activities = sorted(
        name
        for name, value in vars(agent_graph).items()
        if callable(value) and hasattr(value, "__temporal_activity_definition")
    )
    assert activities == ["send_agent_graph_message_activity"], activities
    question_names = [name for name in vars(agent_graph) if "question" in name.lower()]
    assert question_names == [], f"code-agent question path re-added: {question_names}"


async def test_send_is_retry_safe_with_a_stable_message_id():
    from helpers.agent_graph import AgentGraphSendRequest, a2a_message_id, send_agent_graph_message_activity

    message_id = a2a_message_id("wf-root/run 1", "toolu_01")
    assert message_id == a2a_message_id("wf-root/run 1", "toolu_01"), "same tool call → same id"
    assert message_id != a2a_message_id("wf-root/run 1", "toolu_02"), "different tool call → different id"
    assert all(ch.isalnum() or ch in "._:-" for ch in message_id), message_id
    long_id = a2a_message_id("w" * 300, "t")
    assert len(long_id) <= 200 and long_id == a2a_message_id("w" * 300, "t"), long_id

    backend = _backend()
    request = AgentGraphSendRequest(agent_id="root-1", to="code-1", text="use port 4242", message_id=message_id)
    with patch("helpers.agent_graph.load_config", _config):
        first = await send_agent_graph_message_activity(request)
        retried = await send_agent_graph_message_activity(request)
    assert first["status"] == "delivered" and retried["status"] == "duplicate", (first, retried)
    assert [sent["body"]["message_id"] for sent in backend.requests] == [message_id, message_id]
    headers = backend.requests[0]["headers"]
    assert headers["x-agent-id"] == "root-1" and "x-code-session-id" not in headers, headers


async def test_scope_errors_are_final_and_transient_errors_retry():
    from helpers.agent_graph import AgentGraphSendRequest, send_agent_graph_message_activity

    backend = _backend()
    request = AgentGraphSendRequest(agent_id="root-1", to="other-tree", text="hi", message_id="m-1")
    for status, retryable in ((404, False), (409, False), (502, True)):
        backend.status = status
        with patch("helpers.agent_graph.load_config", _config):
            try:
                await send_agent_graph_message_activity(request)
            except ApplicationError as err:
                assert err.non_retryable is (not retryable), (status, err.non_retryable)
                assert str(status) in str(err), err
            else:
                raise AssertionError(f"HTTP {status} must raise")


async def test_lost_response_after_delivery_is_retried_once():
    """A Temporal retry after the backend delivered but the response was lost lands once."""
    from helpers.agent_graph import AgentGraphSendRequest, a2a_message_id, send_agent_graph_message_activity

    delivered: Dict[str, str] = {}
    requests: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        requests.append(body)
        message_id = body["message_id"]
        if message_id in delivered:
            return httpx.Response(200, json={"message_id": message_id, "status": "duplicate", "to": {"id": body["to"]}})
        delivered[message_id] = body["text"]
        # The backend committed the delivery; the response never reaches the worker.
        raise httpx.ReadError("connection reset after commit", request=request)

    setup_mock_fn(handler)
    message_id = a2a_message_id("wf-parent/run-1", "toolu_answer")
    request = AgentGraphSendRequest(agent_id="parent-1", to="code-1", text="use Postgres", message_id=message_id)
    with patch("helpers.agent_graph.load_config", _config):
        try:
            await send_agent_graph_message_activity(request)
        except ApplicationError as err:
            assert not err.non_retryable, f"a lost response must stay retryable: {err}"
        except httpx.HTTPError:
            pass  # a transport error fails the attempt; Temporal retries it
        else:
            raise AssertionError("the first attempt must fail when its response is lost")
        # Temporal's retry: same request payload, same message id.
        retried = await send_agent_graph_message_activity(request)
    assert retried["status"] == "duplicate", retried
    assert list(delivered) == [message_id], delivered
    assert [body["message_id"] for body in requests] == [message_id, message_id], requests


async def test_rate_limited_send_retries_no_sooner_than_retry_after():
    """The per-sender cap answers 429 + Retry-After; the activity retries after that delay."""
    from helpers.agent_graph import AgentGraphSendRequest, send_agent_graph_message_activity

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={"Retry-After": "7"},
            json={"error": "Too many agent messages from this sender; retry in 7s"},
        )

    setup_mock_fn(handler)
    request = AgentGraphSendRequest(agent_id="root-1", to="child-1", text="ping", message_id="flood-1")
    with patch("helpers.agent_graph.load_config", _config):
        try:
            await send_agent_graph_message_activity(request)
        except ApplicationError as err:
            assert not err.non_retryable, "a rate limit is temporary"
            assert "429" in str(err), err
            assert err.next_retry_delay == timedelta(seconds=7), err.next_retry_delay
        else:
            raise AssertionError("HTTP 429 must raise")


def test_payload_dataclasses_have_real_annotations():
    from helpers import agent_graph

    for cls in (agent_graph.AgentGraphSendRequest,):
        assert dataclasses.is_dataclass(cls)
        lazy = [name for name, value in cls.__annotations__.items() if isinstance(value, (str, typing.ForwardRef))]
        assert not lazy, f"{cls.__name__} has string annotations: {lazy}"


async def run_all_tests():
    print("agent-graph blackbox tests:")
    r = BlackboxResult()
    try:
        r.record("code_agents_have_no_question_activity", test_code_agents_have_no_question_activity)
        await r.record_async("send_is_retry_safe_with_stable_id", test_send_is_retry_safe_with_a_stable_message_id)
        await r.record_async(
            "scope_errors_final_transient_retry", test_scope_errors_are_final_and_transient_errors_retry
        )
        r.record("payload_dataclasses_real_annotations", test_payload_dataclasses_have_real_annotations)
        await r.record_async("lost_response_retried_once", test_lost_response_after_delivery_is_retried_once)
        await r.record_async(
            "rate_limited_send_retries_after_retry_after", test_rate_limited_send_retries_no_sooner_than_retry_after
        )
    finally:
        teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
