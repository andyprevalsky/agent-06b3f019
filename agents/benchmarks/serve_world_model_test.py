"""Unit tests for the served-WMH `/rose_usage` route.

`build_app` needs a built WMH model artifact + the vendored `wmh` package, which is
too heavy for a unit test. The behavior we own — exposing the Rose usage accumulator
over `GET /rose_usage` — is isolated in `_add_rose_usage_route`, so we exercise that
against a bare FastAPI app + a real `RoseUsageAccumulator` via TestClient.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from benchmarks.serve_world_model import (
    RetrievalAuditRetriever,
    _add_retrieval_audit_route,
    _add_rose_usage_route,
    _install_root_scoped_sessions,
)
from benchmarks.wmh_rose_provider import RoseUsageAccumulator


def _app_with_usage(acc: RoseUsageAccumulator) -> TestClient:
    app = FastAPI()
    _add_rose_usage_route(app, acc)
    return TestClient(app)


def test_rose_usage_route_empty():
    client = _app_with_usage(RoseUsageAccumulator())
    resp = client.get("/rose_usage")
    assert resp.status_code == 200
    assert resp.json() == {
        "total_cost_usd": 0.0,
        "calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
    }


def test_rose_usage_route_reflects_recorded_usage():
    acc = RoseUsageAccumulator()
    acc.record(cost_usd=0.5, input_tokens=100, output_tokens=40)
    acc.record(cost_usd=0.25, input_tokens=10, output_tokens=4)
    client = _app_with_usage(acc)

    body = client.get("/rose_usage").json()
    assert body["calls"] == 2
    assert body["input_tokens"] == 110
    assert body["output_tokens"] == 44
    assert body["total_cost_usd"] == 0.75


def test_rose_usage_route_live_updates():
    """The route reads the accumulator live — usage recorded after wiring shows up."""
    acc = RoseUsageAccumulator()
    client = _app_with_usage(acc)

    assert client.get("/rose_usage").json()["calls"] == 0
    acc.record(cost_usd=0.01, input_tokens=3, output_tokens=1)
    assert client.get("/rose_usage").json()["calls"] == 1
    assert client.get("/rose_usage").json()["total_cost_usd"] == 0.01


def test_root_scoped_sessions_are_idempotent_at_served_wmh_boundary(monkeypatch):
    """Independent worker requests for one root resolve one server session."""
    class FakeSession:
        def __init__(self, session_id: str):
            self.id = session_id

    class FakeWorldModel:
        def __init__(self):
            self.created = 0

        def new_session(self, task=None, seed_state=None):
            self.created += 1
            return FakeSession(f"session-{self.created}")

        def step(self, session_id, action):
            return {"session_id": session_id, "action": action}

        def end_session(self, session_id):
            return {"ended": session_id}

    app = FastAPI()
    world_model = FakeWorldModel()
    _install_root_scoped_sessions(app, "rose", world_model)

    @app.post("/world_models/rose/sessions")
    def create_session(payload: dict):
        session = world_model.new_session(task=payload.get("task"))
        return {"session_id": session.id}

    client = TestClient(app)
    first = client.post(
        "/world_models/rose/sessions",
        json={"task": "root objective", "session_scope_id": "root-1"},
    ).json()
    child = client.post(
        "/world_models/rose/sessions",
        json={"task": "child delegation", "session_scope_id": "root-1"},
    ).json()
    other_root = client.post(
        "/world_models/rose/sessions",
        json={"task": "other objective", "session_scope_id": "root-2"},
    ).json()

    assert first == child == {"session_id": "session-1"}
    assert other_root == {"session_id": "session-2"}
    assert world_model.created == 2
    world_model.end_session(first["session_id"])
    reopened = client.post(
        "/world_models/rose/sessions",
        json={"task": "next root run", "session_scope_id": "root-1"},
    ).json()
    assert reopened == {"session_id": "session-3"}, "root scope returned an ended session"


def test_root_scoped_session_uses_only_requested_seed_state(monkeypatch):
    """The WMH replaces the environment; archived start fixtures are not live state."""
    from wmh.core.types import EnvState

    import benchmarks.world_model_harness as harness

    def archive_read_forbidden(*_args, **_kwargs):
        raise AssertionError("WMH session creation must not read the environment snapshot")

    monkeypatch.setattr(harness, "reconstruct_initial_state", archive_read_forbidden)
    monkeypatch.setattr(harness, "read_archive_json", archive_read_forbidden)

    class FakeSession:
        id = "session-hydrated"

    class FakeWorldModel:
        def __init__(self):
            self.seed_state = None

        def new_session(self, task=None, seed_state=None):
            self.seed_state = seed_state
            return FakeSession()

        def step(self, session_id, action):
            return {"session_id": session_id, "action": action}

    app = FastAPI()
    world_model = FakeWorldModel()
    _install_root_scoped_sessions(app, "rose", world_model)

    @app.post("/world_models/rose/sessions")
    def create_session(payload: dict):
        session = world_model.new_session(
            task=payload.get("task"),
            seed_state=EnvState.model_validate(payload.get("seed_state") or {}),
        )
        return {"session_id": session.id}

    response = TestClient(app).post(
        "/world_models/rose/sessions",
        json={
            "task": "fundraise",
            "session_scope_id": "root-live",
            "seed_state": {
                "structured": {
                    "schema": "rose.runtime_initial_state.v1",
                    "root_agent_id": "root-live",
                    "root_goal": "Raise $5M",
                },
                "scratchpad": "",
            },
        },
    )
    assert response.status_code == 200
    assert world_model.seed_state.structured == {
        "schema": "rose.runtime_initial_state.v1",
        "root_agent_id": "root-live",
        "root_goal": "Raise $5M",
    }
    second = TestClient(app).post(
        "/world_models/rose/sessions",
        json={
            "task": "deferred startup SMS",
            "session_scope_id": "root-live",
            "seed_state": {"structured": {"schema": "runtime-fallback"}, "scratchpad": ""},
        },
    )
    assert second.status_code == 200
    assert second.json()["session_id"] == response.json()["session_id"]
    assert world_model.seed_state.structured["root_goal"] == "Raise $5M"


def test_retrieval_audit_records_ordered_real_world_examples():
    from wmh.core.types import Action, ActionKind, EnvState, Observation, Step

    archived = Step(
        task="Buy a black beanie",
        state_before=EnvState(
            structured={"root_agent_id": "root-real", "root_goal": "Checkout on Amazon"}
        ),
        action=Action(
            kind=ActionKind.TOOL_CALL,
            name="rose.llm_tool_call.spawn_browser_agent",
            arguments={"goal": "Buy a beanie", "agent_id": "child-real"},
        ),
        observation=Observation(content="Checkout completed"),
        raw_span_ids=["span-real"],
    )

    class FakeRetriever:
        def __init__(self):
            self.steps = [archived]

        def topk(self, _state, _action, _k):
            return list(self.steps)

        def add(self, step):
            self.steps.append(step)

        def sample(self, n):
            return self.steps[:n]

        def index(self, _traces):
            return None

    audit = RetrievalAuditRetriever(FakeRetriever())
    query = Action(
        kind=ActionKind.TOOL_CALL,
        name="rose.llm_tool_call.spawn_browser_agent",
        arguments={"goal": "Buy a beanie"},
    )
    assert audit.topk(EnvState(structured={"url": "https://amazon.com"}), query, 5) == [archived]

    app = FastAPI()
    _add_retrieval_audit_route(app, audit)
    payload = TestClient(app).get("/retrieval_audit").json()
    assert payload["query_count"] == 1
    assert payload["offline_index_steps"] == 1
    assert payload["real_world_demo_uses"] == 1
    assert payload["events"][0]["demos"][0]["source"] == "real_world_archive"
    assert payload["events"][0]["demos"][0]["root_agent_id"] == "root-real"


def test_retrieval_audit_matches_code_tool_to_real_provider_alias():
    """Simulated code spawns can learn from production Claude Code completions."""
    from wmh.core.types import Action, ActionKind, EnvState, Observation, Step

    archived = Step(
        task="Write and return a runnable report",
        state_before=EnvState(structured={"root_agent_id": "root-real-code"}),
        action=Action(
            kind=ActionKind.TOOL_CALL,
            name="rose.code.spawn_claude_code_agent",
            arguments={"goal": "Write a report"},
        ),
        observation=Observation(content="**Status**: ✅ SUCCESS\n\nReport created."),
    )

    class FakeRetriever:
        def sample(self, n):
            return [archived][:n]

        def topk(self, _state, _action, _k):
            return [archived]

    audit = RetrievalAuditRetriever(FakeRetriever())
    query = Action(
        kind=ActionKind.TOOL_CALL,
        name="rose.code.spawn_code_agent",
        arguments={"goal": "Write a report"},
    )

    assert audit.topk(EnvState(structured={"root_goal": "Fundraise"}), query, 5) == [archived]


def test_retrieval_audit_shows_nested_canonical_tool_goal():
    from wmh.core.types import Action, ActionKind, EnvState

    class EmptyRetriever:
        def sample(self, _n):
            return []

        def topk(self, _state, _action, _k):
            return []

    audit = RetrievalAuditRetriever(EmptyRetriever())
    audit.topk(
        EnvState(),
        Action(
            kind=ActionKind.TOOL_CALL,
            name="rose.explore.spawn_explore_agent",
            arguments={"arguments": {"goal": "Find venture investors"}},
        ),
        5,
    )

    assert audit.snapshot()["events"][0]["query"]["action"]["arguments"]["goal"] == "Find venture investors"


def test_retrieval_uses_same_tool_distinct_real_world_runs_only():
    """Other tools, duplicate runs, and generated results cannot supply a prediction."""
    from wmh.core.types import Action, ActionKind, EnvState, Observation, Step, Trace
    from wmh.retrieval import EmbeddingRetriever
    from wmh.retrieval.embedders import HashingEmbedder

    action = Action(
        kind=ActionKind.TOOL_CALL,
        name="rose.explore.spawn_explore_agent",
        arguments={"goal": "Find investors for Rose Labs"},
    )

    def step(root: str, tool: str, goal: str) -> Step:
        return Step(
            task=goal,
            state_before=EnvState(structured={"root_agent_id": root, "root_goal": goal}),
            action=Action(kind=ActionKind.TOOL_CALL, name=tool, arguments={"goal": goal}),
            observation=Observation(content=f"result for {root}"),
        )

    archived = [
        step("creator-1", action.name, "Analyze Eric Topol as a creator"),
        step("creator-1", action.name, "Analyze Eric Topol as a creator"),
        step("creator-2", action.name, "Analyze Eric Topol as a creator"),
        step("vc-1", action.name, "Find VC investors in the Bay Area"),
        step("browser-1", "rose.browser.browser_action", "Find investors for Rose Labs"),
    ]
    retriever = EmbeddingRetriever(HashingEmbedder(dim=64))
    retriever.index([Trace(trace_id="archived", steps=archived)])
    audit = RetrievalAuditRetriever(retriever)
    generated = step("generated-1", action.name, "Find investors for Rose Labs")
    audit.add(generated)

    found = audit.topk(
        EnvState(structured={"root_agent_id": "live", "root_goal": "Find investors for Rose Labs"}),
        action,
        5,
    )

    assert {item.state_before.structured["root_agent_id"] for item in found} == {
        "creator-1",
        "vc-1",
    }
    assert audit.snapshot()["real_world_demo_uses"] == 2


def test_retrieval_ranks_delegated_action_subject_above_noisy_fixture_state():
    """A city-research step must not beat investor research for a fundraise query."""
    from wmh.core.types import Action, ActionKind, EnvState, Observation, Step, Trace
    from wmh.retrieval import EmbeddingRetriever
    from wmh.retrieval.embedders import HashingEmbedder

    tool = "rose.explore.spawn_explore_agent"
    query_goal = "Find venture investors for a Rose Labs fundraising round"

    def archived(root: str, state_goal: str, delegated_goal: str) -> Step:
        return Step(
            task=state_goal,
            state_before=EnvState(
                structured={"root_agent_id": root, "root_goal": state_goal}
            ),
            action=Action(
                kind=ActionKind.TOOL_CALL,
                name=tool,
                arguments={"arguments": {"goal": delegated_goal}},
            ),
            observation=Observation(content=delegated_goal),
        )

    city = archived("city", query_goal, "Compare Austin and Denver weather and neighborhoods")
    investor = archived(
        "investor", "Find business contacts", "Find venture capital investors in AI startups"
    )
    retriever = EmbeddingRetriever(HashingEmbedder(dim=64))
    retriever.index([Trace(trace_id="real", steps=[city, investor])])
    audit = RetrievalAuditRetriever(retriever)

    found = audit.topk(
        EnvState(structured={"root_agent_id": "live", "root_goal": query_goal}),
        Action(
            kind=ActionKind.TOOL_CALL,
            name=tool,
            arguments={"arguments": {"goal": query_goal}},
        ),
        2,
    )

    assert found[0].state_before.structured["root_agent_id"] == "investor"


def test_retrieval_preserves_historical_disconnected_source_hard_error():
    """Every real result stays eligible, even when current explore behavior changes."""
    import json

    from wmh.core.types import Action, ActionKind, EnvState, Observation, Step, Trace
    from wmh.retrieval import EmbeddingRetriever
    from wmh.retrieval.embedders import HashingEmbedder

    action = Action(
        kind=ActionKind.TOOL_CALL,
        name="rose.explore.spawn_explore_agent",
        arguments={"goal": "Research company using public sources"},
    )

    def archived(root: str, output: str, is_error: bool) -> Step:
        return Step(
            task=root,
            state_before=EnvState(structured={"root_agent_id": root}),
            action=action,
            observation=Observation(
                content=json.dumps(
                    {"category": "explore_result", "content": output, "is_error": is_error}
                )
            ),
        )

    stale = archived("old", "required data source(s) not connected: email, gmail", True)
    current = archived("new", "Public sources researched; Gmail unavailable and skipped", False)
    retriever = EmbeddingRetriever(HashingEmbedder(dim=64))
    retriever.index([Trace(trace_id="real", steps=[stale, current])])
    audit = RetrievalAuditRetriever(retriever)

    found = audit.topk(EnvState(), action, 5)
    assert len(found) == 2
    assert current in found and stale in found
    assert audit.snapshot()["eligible_index_steps"] == 2
