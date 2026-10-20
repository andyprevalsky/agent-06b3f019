"""Blackbox tests for the agents worker's agent-graph client (helpers/agent_graph.py).

Rose-builds-Rose C6 + question routing by spawner (UI ledger 47b). The backend
(`/api/agent-graph/*`, covered end to end by the backend `agent-graph`
blackbox) is faked through the httpx capture harness: these tests pin the
worker-side contract the backend relies on.

Invariants covered:
  - question routing: a root-spawned code agent asks the user; one spawned by
    any other agent asks that agent (same rule as questionRouteForSpawner)
  - the code agent's question is posted AS that code session (X-Agent-Id of
    the owning Rose agent + X-Code-Session-Id), with options and message id
  - send is retry-safe: the message id derives from (workflow, tool call), so
    a retried activity posts the same id; definite scope errors (404/409) are
    non-retryable, transient 5xx are retryable
  - activity payload dataclasses decode with real annotations (the workflow
    sandbox resolves no string annotations)
"""

import asyncio
import dataclasses
import json
import typing
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


def test_root_spawned_code_agent_question_goes_to_user():
    from helpers.agent_graph import question_route_for_spawner

    assert question_route_for_spawner("root-1", None) == {"deliver_to": "user", "agent_id": "root-1"}
    assert question_route_for_spawner("root-1", "") == {"deliver_to": "user", "agent_id": "root-1"}


def test_non_root_spawned_code_agent_question_goes_to_its_parent_agent():
    from helpers.agent_graph import question_route_for_spawner

    assert question_route_for_spawner("child-1", "root-1") == {"deliver_to": "agent", "agent_id": "child-1"}


async def test_code_agent_question_is_posted_as_the_code_session():
    from helpers.agent_graph import (
        AgentGraphQuestionOption,
        AgentGraphQuestionRequest,
        ask_code_agent_question_activity,
    )

    backend = _backend()
    with patch("helpers.agent_graph.load_config", _config):
        result = await ask_code_agent_question_activity(
            AgentGraphQuestionRequest(
                agent_id="parent-1",
                code_session_id="code-1",
                code_provider="codex",
                question="Postgres or SQLite?",
                message_id="q-1",
                options=[AgentGraphQuestionOption(label="Postgres", description="matches prod", recommended=True)],
            )
        )
    assert result == {"deliver_to": "agent", "agent_id": "parent-1", "status": "delivered", "message_id": "q-1"}
    [sent] = backend.requests
    assert sent["path"] == "/api/agent-graph/questions", sent
    headers = sent["headers"]
    assert headers["x-api-key"] == "test-api-key" and headers["x-agent-id"] == "parent-1", headers
    assert headers["x-code-session-id"] == "code-1" and headers["x-code-provider"] == "codex", headers
    assert sent["body"] == {
        "question": "Postgres or SQLite?",
        "message_id": "q-1",
        "options": [{"label": "Postgres", "description": "matches prod", "recommended": True}],
    }, sent["body"]


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


def test_payload_dataclasses_have_real_annotations():
    from helpers import agent_graph

    for cls in (
        agent_graph.AgentGraphSendRequest,
        agent_graph.AgentGraphQuestionRequest,
        agent_graph.AgentGraphQuestionOption,
    ):
        assert dataclasses.is_dataclass(cls)
        lazy = [name for name, value in cls.__annotations__.items() if isinstance(value, (str, typing.ForwardRef))]
        assert not lazy, f"{cls.__name__} has string annotations: {lazy}"
    assert not any(isinstance(v, str) for v in agent_graph.QuestionRoute.__annotations__.values())


async def run_all_tests():
    print("agent-graph blackbox tests:")
    r = BlackboxResult()
    try:
        r.record("root_spawned_question_goes_to_user", test_root_spawned_code_agent_question_goes_to_user)
        r.record(
            "non_root_spawned_question_goes_to_parent",
            test_non_root_spawned_code_agent_question_goes_to_its_parent_agent,
        )
        await r.record_async(
            "code_agent_question_posted_as_code_session", test_code_agent_question_is_posted_as_the_code_session
        )
        await r.record_async("send_is_retry_safe_with_stable_id", test_send_is_retry_safe_with_a_stable_message_id)
        await r.record_async(
            "scope_errors_final_transient_retry", test_scope_errors_are_final_and_transient_errors_retry
        )
        r.record("payload_dataclasses_real_annotations", test_payload_dataclasses_have_real_annotations)
    finally:
        teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
