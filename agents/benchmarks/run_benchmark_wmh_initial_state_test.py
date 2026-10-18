"""The benchmark seed must own the WMH session before any agent tool can run."""

from __future__ import annotations

import asyncio
import json
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


@pytest.mark.parametrize("as_of", [None, "", "yesterday", "2026-09-28T00:00:00", 20260928])
def test_seeded_worlds_must_pin_an_iso_utc_start_date(as_of):
    """The world clock starts at structured.as_of_utc; every seeded world pins it."""
    task = get_task_by_name("raise-5m-rose-labs-brex")
    assert task.wmh_initial_state["structured"]["as_of_utc"] == "2026-09-28T00:00:00Z"
    state = json.loads(json.dumps(task.wmh_initial_state))
    if as_of is None:
        del state["structured"]["as_of_utc"]
    else:
        state["structured"]["as_of_utc"] = as_of
    with pytest.raises(ValueError, match="as_of_utc"):
        bench.validate_wmh_initial_state(state, task.name)


def test_context_insertion_adds_researched_outcome_examples_without_changing_the_catalog(tmp_path):
    import json

    from benchmarks.wmh_context_insertion import EXAMPLES_TEXT, OUTCOME_EXAMPLES_KEY, insert_outcome_examples, main

    task = get_task_by_name("raise-5m-rose-labs-brex")
    original = json.loads(json.dumps(task.wmh_initial_state))
    examples = [
        {
            "action": "Cold pitch to an investor",
            "applies_when": "no mutual introduction",
            "typical_time": "1-14 days",
            "outcomes": [{"outcome": "No reply", "probability": 0.95}, {"outcome": "Reply", "probability": 0.05}],
            "sources": ["Gornall and Strebulaev 2018, https://www.gsb.stanford.edu/insights/do-vcs-really-favor-white-male-founders"],
        },
        {
            "action": "Wire after a signed SAFE",
            "outcomes": [{"outcome": "Received", "probability": 1}],
            "sources": ["Hustle Fund closing guide"],
        },
    ]
    state = insert_outcome_examples(task.wmh_initial_state, examples, item_id=task.name)
    assert task.wmh_initial_state == original
    assert bench.validate_wmh_initial_state(state, task.name) is state
    inserted = state["structured"][OUTCOME_EXAMPLES_KEY]
    assert inserted[0] == examples[0] and inserted[1]["outcomes"] == [{"outcome": "Received", "probability": 1.0}]
    assert {k: v for k, v in state["structured"].items() if k != OUTCOME_EXAMPLES_KEY} == original["structured"]
    # The examples inform the world model's reasoning; nothing enforces them.
    assert state["scratchpad"] == original["scratchpad"] + "\n\n" + EXAMPLES_TEXT
    assert "not constraints" in EXAMPLES_TEXT
    with pytest.raises(ValueError, match="already inserted"):
        insert_outcome_examples(state, examples, item_id=task.name)

    examples_file = tmp_path / "examples.json"
    examples_file.write_text(json.dumps(examples))
    out = tmp_path / "run-state.json"
    assert main(["--task", task.name, "--examples", str(examples_file), "--out", str(out)]) == 0
    # The CLI inserts the user's canonical base rates by default; examples ride on top.
    from benchmarks.wmh_context_insertion import insert_base_rates, load_canonical_base_rates

    with_rates = insert_base_rates(task.wmh_initial_state, load_canonical_base_rates(), item_id=task.name)
    assert json.loads(out.read_text()) == insert_outcome_examples(with_rates, examples, item_id=task.name)


def _example(**changes):
    example = {
        "action": "Cold pitch",
        "outcomes": [{"outcome": "No reply", "probability": 0.95}, {"outcome": "Reply", "probability": 0.05}],
        "sources": ["Gornall and Strebulaev 2018"],
    }
    example.update(changes)
    return example


@pytest.mark.parametrize(
    "examples",
    [
        [],
        [_example(sources=[])],
        [_example(sources=[" "])],
        [{k: v for k, v in _example().items() if k != "sources"}],
        [_example(outcomes=[{"outcome": "No reply", "probability": 0.9}])],
        [_example(outcomes=[{"outcome": "No reply", "probability": 1.5}, {"outcome": "Reply", "probability": -0.5}])],
        [_example(outcomes=[{"outcome": "No reply", "probability": float("nan")}])],
        [_example(outcomes=[{"outcome": "No reply", "probability": True}])],
        [_example(outcomes=[{"outcome": "Reply", "probability": 0.5}, {"outcome": "reply", "probability": 0.5}])],
        [_example(action=" ")],
        [_example(), _example()],
        [_example(weight=2)],
    ],
)
def test_context_insertion_rejects_unsourced_or_invalid_outcome_examples(examples):
    from benchmarks.wmh_context_insertion import insert_outcome_examples

    task = get_task_by_name("raise-5m-rose-labs-brex")
    with pytest.raises(ValueError):
        insert_outcome_examples(task.wmh_initial_state, examples, item_id=task.name)
