"""The benchmark seed must own the WMH session before any agent tool can run."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import replace

import pytest

from benchmarks import run_benchmark as bench
from benchmarks.benchmark_tasks import get_task_by_name


def test_fundraise_seed_has_connected_sources_and_keeps_auth_route_unset():
    task = get_task_by_name("raise-5m-rose-labs-brex")
    state = task.wmh_initial_state
    assert state is not None
    assert bench.validate_wmh_initial_state(state, task.name) is state
    structured = state["structured"]
    assert structured["schema"] == "rose.wmh.fundraise_initial_state.v3"
    assert structured["acting_user"] == {
        "name": "Tamara Chayo",
        "role": "CEO",
        "authority": "company_ceo",
    }
    assert structured["company"] == {
        "name": "Rose Labs",
        "ceo": "Tamara Chayo",
        "cto": "Andy Prevalsky",
    }
    assert structured["brex"]["browser_session"] == "authenticated_via_browser_cookie"
    assert state["structured"]["brex"]["reauthentication_route"] is None
    assert structured["data_sources"] == {
        "email": {"connected": True, "provider": "gmail", "account": "tamara@roselabs.ai"},
        "gmail": {"connected": True, "account": "tamara@roselabs.ai"},
        "sms": {"connected": True, "phone_number_e164": "+12028803603"},
    }
    assert structured["connectivity_defaults"] == {
        "all_services_connected": True,
        "all_browser_sessions_authenticated": True,
        "unlisted_services_connected": True,
        "disconnected_services": [],
    }
    assert "Every data source, integration, app, website, and browser workspace" in state["scratchpad"]
    assert state["structured"]["brex"]["incoming_transfers"] == []
    assert state["structured"]["fundraising"]["pending_wires"] == []
    assert task.timeout_seconds == 600
    assert task.model == "rose-ultra"


def test_seed_is_created_before_agent_and_bound_to_same_root(monkeypatch):
    events = []
    task = replace(get_task_by_name("raise-5m-rose-labs-brex"))
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "simulate")
    monkeypatch.setenv("WMH_BASE_URL", "http://wmh.test")
    monkeypatch.setenv("WMH_MODEL_NAME", "rose-test")
    monkeypatch.delenv("WMH_SESSION_ID", raising=False)
    monkeypatch.delenv("WORLD_MODEL_SESSION_ID", raising=False)
    monkeypatch.setattr(bench, "_resolve_write_lock_enabled", lambda _task: None)

    async def headers():
        return {"X-API-Key": "test"}

    monkeypatch.setattr(bench, "_api_headers", headers)

    class FakeWMHClient:
        def __init__(self, base_url):
            assert base_url == "http://wmh.test"

        async def create_session(self, model_name, *, task, seed_state, session_scope_id):
            events.append(("seed", model_name, task, seed_state, session_scope_id))
            return "wmh-session-1"

    class FakeResponse:
        status_code = 201
        text = ""

        def __init__(self, agent_id):
            self.agent_id = agent_id

        def json(self):
            return {"agent_id": self.agent_id}

    class FakeHttpClient:
        def __init__(self, *, timeout):
            assert timeout == 90

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            assert url == "http://localhost:55120/api/agents"
            events.append(("create", json))
            return FakeResponse(json["agent_id"])

    monkeypatch.setattr(bench, "WMHHttpClient", FakeWMHClient)
    monkeypatch.setattr(bench.httpx, "AsyncClient", FakeHttpClient)
    agent_id = asyncio.run(bench.create_agent("http://localhost:55120", task))

    assert [event[0] for event in events] == ["seed", "create"]
    seed, create = events
    assert uuid.UUID(agent_id)
    assert seed[1] == "rose-test"
    assert seed[2] == create[1]["goal"]
    assert seed[3]["structured"]["root_goal"] == create[1]["goal"]
    assert seed[3]["structured"]["root_agent_id"] == agent_id == seed[4]
    assert seed[3]["structured"]["brex"]["reauthentication_route"] is None
    assert seed[3]["structured"]["data_sources"]["gmail"]["connected"] is True
    assert seed[3]["structured"]["connectivity_defaults"]["unlisted_services_connected"] is True
    assert create[1]["world_model_mode"] == "simulate"
    assert create[1]["model"] == "rose-ultra"
    assert bench._wmh_initial_state_evidence(task)["session_id"] == "wmh-session-1"


def test_explicit_session_cannot_bypass_initial_state(monkeypatch):
    task = get_task_by_name("raise-5m-rose-labs-brex")
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "simulate")
    monkeypatch.setenv("WMH_SESSION_ID", "unrelated-session")

    async def headers():
        return {}

    monkeypatch.setattr(bench, "_api_headers", headers)
    with pytest.raises(ValueError, match="would bypass wmh_initial_state"):
        asyncio.run(bench.create_agent("http://localhost:55120", task))


def test_context_insertion_adds_event_base_rates_without_changing_the_catalog(tmp_path):
    import json

    from benchmarks.wmh_context_insertion import (
        CALIBRATION_TEXT,
        EVENT_PROBABILITIES_KEY,
        insert_event_probabilities,
        main,
    )

    task = get_task_by_name("raise-5m-rose-labs-brex")
    original = json.loads(json.dumps(task.wmh_initial_state))
    events = [
        {"event": "Investor replies to an outreach email", "probability": 0.9},
        {"event": "Signed commitment wire settles in Brex", "probability": 1, "applies_when": "after a signed SAFE"},
    ]
    state = insert_event_probabilities(task.wmh_initial_state, events, item_id=task.name)
    assert task.wmh_initial_state == original
    assert bench.validate_wmh_initial_state(state, task.name) is state
    assert state["structured"][EVENT_PROBABILITIES_KEY] == [
        {"event": "Investor replies to an outreach email", "probability": 0.9},
        {"event": "Signed commitment wire settles in Brex", "probability": 1.0, "applies_when": "after a signed SAFE"},
    ]
    assert {k: v for k, v in state["structured"].items() if k != EVENT_PROBABILITIES_KEY} == original["structured"]
    assert state["scratchpad"] == original["scratchpad"] + "\n\n" + CALIBRATION_TEXT
    with pytest.raises(ValueError, match="already inserted"):
        insert_event_probabilities(state, events, item_id=task.name)

    events_file = tmp_path / "events.json"
    events_file.write_text(json.dumps(events))
    out = tmp_path / "run-state.json"
    assert main(["--task", task.name, "--events", str(events_file), "--out", str(out)]) == 0
    assert json.loads(out.read_text()) == state


@pytest.mark.parametrize(
    "events",
    [
        [],
        [{"event": "Reply", "probability": 1.5}],
        [{"event": "Reply", "probability": float("nan")}],
        [{"event": "Reply", "probability": True}],
        [{"event": " ", "probability": 0.5}],
        [{"event": "Reply", "probability": 0.5}, {"event": "reply", "probability": 0.4}],
        [{"event": "Reply", "probability": 0.5, "weight": 2}],
    ],
)
def test_context_insertion_rejects_invalid_event_tables(events):
    from benchmarks.wmh_context_insertion import insert_event_probabilities

    task = get_task_by_name("raise-5m-rose-labs-brex")
    with pytest.raises(ValueError):
        insert_event_probabilities(task.wmh_initial_state, events, item_id=task.name)
