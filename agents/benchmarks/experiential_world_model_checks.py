"""Owning simulator regressions, run from the existing WMH blackbox gate in 3.12."""

import asyncio
import json
from copy import deepcopy

import pytest

from benchmarks.experiential_world_model import ParallelWorldModel, action_from_canonical


def action(n):
    return {
        "kind": "tool_call",
        "name": "rose.browser.spawn_browser_agent",
        "arguments": {
            "schema": "rose.canonical_action.v1",
            "category": "browser",
            "name": "spawn_browser_agent",
            "arguments": {"goal": f"Perform operation {n}"},
            "agent_id": f"child-{n}",
            "tool_call_id": f"call-{n}",
            "timestamp_ms": 10,
        },
    }


def reply(request, state, content="completed"):
    evidence = json.loads(request.messages[1].content)
    return json.dumps(
        {
            "message": "",
            "tool_results": [
                {
                    "call_id": evidence["candidate_response"]["tool_calls"][0]["call_id"],
                    "content": content,
                    "is_error": False,
                }
            ],
            "state": state,
            "terminal": False,
        }
    )


class Retriever:
    def retrieve(self, query):
        return ()


@pytest.mark.parametrize("enabled", [False, True])
def test_failed_demo_filter_precedes_packing_and_preserves_live_errors_and_replay(enabled):
    from exp.simulation.retrieval import RAGMatch, RAGTransition
    from benchmarks.wmh_execution_policy import execution_identity

    def match(n, failed):
        return RAGMatch(transition=RAGTransition(
            transition_id=f"example-{n}", trace_id="trace", lineage_id=f"lineage-{n}",
            action_span_id=f"action-{n}", observation_span_id=f"obs-{n}", task="Inspect route",
            initial_context={"task": "reference only"},
            action={"kind": "tool_call", "tool_name": "rose.browser.spawn_browser_agent", "tool_arguments": {}},
            observation={"kind": "tool_result", "content": json.dumps({"is_error": failed, "content": "no route"})},
            key_text="Inspect route", key_sha256="a" * 64), score=1.0)

    async def run():
        demos = (match(1, True), match(2, False))
        class Examples:
            def retrieve(self, query):
                return demos
        requests, draws = [], []
        async def complete(request):
            requests.append(request)
            if len(requests) == 1:
                return "invalid JSON"  # Repair must not reintroduce excluded examples.
            evidence = json.loads(request.messages[1].content)
            call = evidence["candidate_response"]["tool_calls"][0]["call_id"]
            return json.dumps({"schema": "rose.wmh_outcome_distribution.v1", "outcomes": [{
                "id": "live_failure", "probability": 1, "description": "Live boundary failure",
                "tool_results": [{"call_id": call, "is_error": True, "content": "live error remains"}],
                "state_patch": []}]})
        def draw():
            draws.append(0.5)
            return draws[-1]
        config = {"inference_pool": "rose-1-flash", "inference_pool_sha256": "b" * 64,
                  "azure_first": True, "exclude_failed_tool_examples": enabled}
        identity = execution_identity("rose-outcome-distribution-v2", "artifact-a", "a" * 64,
                                      runtime_config=config)
        model = ParallelWorldModel(complete, Examples(), execution_policy="rose-outcome-distribution-v2",
                                   execution_identity=identity, sample_uniform=draw)
        session = model.new_session("Research", {"receipts": []}, "root")
        result = await model.step(session.id, action(1), "inv")
        assert result["is_error"] is True and result["content"] == "live error remains"
        assert await model.step(session.id, action(1), "inv") == result
        assert len(draws) == 1 and len(requests) == 2
        for request in requests:
            evidence = json.loads(request.messages[1].content)
            assert len(evidence["grounded_examples"]) == (1 if enabled else 2)
            assert evidence["environment_state"] == {"receipts": []}
            assert any(x["transition_id"] == "example-2" for x in evidence["grounded_examples"])
        assert len(demos) == 2
    asyncio.run(run())


def distribution_reply(request, *, probability=0.05):
    evidence = json.loads(request.messages[1].content)
    call_id = evidence["candidate_response"]["tool_calls"][0]["call_id"]
    return json.dumps(
        {
            "schema": "rose.wmh_outcome_distribution.v1",
            "outcomes": [
                {
                    "id": "missing_route",
                    "probability": 1 - probability,
                    "description": "No suitable contact route observed",
                    "tool_results": [{"call_id": call_id, "content": "no route", "is_error": False}],
                    "state_patch": [{"op": "add", "path": "/unselected", "value": True}],
                },
                {
                    "id": "inquiry_submitted",
                    "probability": probability,
                    "description": "Official form submitted with a confirmation",
                    "tool_results": [{"call_id": call_id, "content": "submission confirmed", "is_error": False}],
                    "state_patch": [{"op": "add", "path": "/receipts/-", "value": call_id}],
                },
            ],
        }
    )


def test_rejected_reply_is_recorded_privately_before_protocol_repair_without_committing_it():
    from exp.simulation.engines.text.prompt import TextWorldModelProtocolError
    async def run():
        records, calls = [], []
        raw = '{"invalid JSON"'
        async def complete(request):
            calls.append(request)
            if len(calls) == 1:
                error = TextWorldModelProtocolError("invalid JSON fixture")
                error.rejected_response = {"content": raw, "usage": {"prompt_tokens": 1}}
                raise error
            return distribution_reply(request)
        model = distribution_model(complete, sample_uniform=lambda: 0.975, record_prediction=records.append)
        session = model.new_session("Submit", {"receipts": []}, "root")
        result = await model.step(session.id, action(1), "inv")
        failures = [x for x in records if x.get("error")]
        assert len(failures) == 1 and failures[0]["rejected_response"]["content"] == raw
        assert session.revision == 1 and len(session.history) == 1
        assert result["content"] == "submission confirmed" and raw not in json.dumps(session.history)
    asyncio.run(run())


def distribution_model(complete, *, policy="rose-outcome-distribution-v1", **kwargs):
    from benchmarks.wmh_execution_policy import execution_identity

    return ParallelWorldModel(
        complete,
        Retriever(),
        execution_policy=policy,
        execution_identity=execution_identity(policy, "artifact-a", "a" * 64),
        **kwargs,
    )


@pytest.mark.parametrize("policy", ["rose-outcome-distribution-v1", "rose-outcome-distribution-v2"])
def test_distribution_samples_once_commits_only_selected_branch_and_retains_full_state(policy):
    async def run():
        requests, records, draws = [], [], []

        def draw():
            draws.append(0.975)
            return draws[-1]

        async def complete(request):
            requests.append(request)
            return distribution_reply(request)

        model = distribution_model(complete, policy=policy, sample_uniform=draw, record_prediction=records.append)
        seed = {"private_facts": {"company": None}, "receipts": ["prior"], "funds_cents": 0}
        session = model.new_session("Submit an inquiry; do not invent company facts", seed, "root")
        result = await model.step(session.id, action(1), "inv-1")
        retry = deepcopy(action(1))
        retry["arguments"]["timestamp_ms"] = 99
        assert await model.step(session.id, retry, "inv-1") == result
        assert len(draws) == len(requests) == 1 and session.revision == 1
        assert session.state == {**seed, "receipts": ["prior", "call-1"]}
        assert result["content"] == "submission confirmed"
        selection = result["metadata"]["outcome_selection"]
        assert selection["selected_outcome_id"] == "inquiry_submitted"
        assert selection["probability"] == 0.05 and selection["draw"] == 0.975
        assert selection["snapshot_revision"] == 0
        predictions = [r for r in records if r["schema"] == "rose.wmh_native_prediction.v1"]
        decisions = [r for r in records if r["schema"] == "rose.wmh_outcome_selection.v1"]
        assert len(predictions) == len(decisions) == 1
        assert {k: v for k, v in decisions[0]["selection"].items() if k != "outcomes"} == selection
        assert predictions[0]["prediction_id"] == selection["prediction_id"]
        assert predictions[0]["request_sha256"] == selection["request_sha256"]
        assert session.history[0]["observation"]["metadata"]["outcome_selection"] == selection
        assert {k: v for k, v in model.audit[-1]["outcome_selection"].items() if k != "outcomes"} == selection
        assert "outcomes" not in selection
        from utils.world_model_observation import world_model_observation_to_tool_result

        assert "No suitable contact route observed" not in json.dumps(
            world_model_observation_to_tool_result(result, simulated=True)
        )
        assert all("unselected" not in m.model_dump_json() for m in session.messages)

    asyncio.run(run())


def test_distribution_protocol_repair_and_failed_invocation_retry_keep_the_same_draw():
    async def run():
        requests, draws = [], []

        def draw():
            draws.append(0.975)
            return draws[-1]

        async def complete(request):
            requests.append(request)
            if len(requests) == 1:
                raise RuntimeError("transport failed")
            if len(requests) == 2:
                return distribution_reply(request, probability=2)
            return distribution_reply(request)

        model = distribution_model(complete, sample_uniform=draw)
        session = model.new_session("Submit", {"receipts": []}, "root")
        with pytest.raises(RuntimeError, match="transport failed"):
            await model.step(session.id, action(1), "inv")
        assert session.revision == 0
        result = await model.step(session.id, action(1), "inv")
        assert result["content"] == "submission confirmed" and draws == [0.975]
        assert len(requests) == 3
        assert "distribution" in requests[-1].messages[-1].content
        assert "terminal false" not in requests[-1].messages[-1].content
        assert session.state == {"receipts": ["call-1"]}

    asyncio.run(run())


def test_distribution_rebases_concurrent_predictions_without_rerolling_or_losing_effects():
    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        requests, records, draws = [], [], []

        def draw():
            draws.append(0.975)
            return draws[-1]

        async def complete(request):
            requests.append(request)
            if len(requests) == 2:
                entered.set()
            await release.wait()
            evidence = json.loads(request.messages[1].content)
            payload = json.loads(distribution_reply(request))
            payload["outcomes"][1]["state_patch"].append(
                {"op": "replace", "path": "/funds_cents", "value": evidence["environment_state"]["funds_cents"] + 7}
            )
            return json.dumps(payload)

        model = distribution_model(complete, sample_uniform=draw, record_prediction=records.append)
        session = model.new_session("Perform both operations", {"funds_cents": 0, "receipts": []}, "root")
        work = [asyncio.create_task(model.step(session.id, action(n), f"inv-{n}")) for n in (1, 2)]
        await asyncio.wait_for(entered.wait(), 2)
        release.set()
        results = await asyncio.wait_for(asyncio.gather(*work), 2)
        assert len(requests) == 3 and len(draws) == 2
        assert session.state["funds_cents"] == 14
        assert set(session.state["receipts"]) == {"call-1", "call-2"}
        assert "unselected" not in session.state and session.revision == 2
        selections = [r["selection"] for r in records if r["schema"] == "rose.wmh_outcome_selection.v1"]
        assert sorted(s["snapshot_revision"] for s in selections) == [0, 0, 1]
        assert all(s["draw"] == 0.975 for s in selections)
        assert {r["metadata"]["snapshot_revision"] for r in results} == {0, 1}

    asyncio.run(run())


def test_distribution_append_only_predictions_merge_without_repredicting():
    """A wide fan-out of record-appending steps commits as each finishes (user-approved append-merge)."""

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        requests = []

        async def complete(request):
            requests.append(request)
            if len(requests) == 3:
                entered.set()
            await release.wait()
            return distribution_reply(request)

        model = distribution_model(complete, sample_uniform=lambda: 0.975)
        session = model.new_session("Contact three funds", {"receipts": []}, "root")
        work = [asyncio.create_task(model.step(session.id, action(n), f"inv-{n}")) for n in (1, 2, 3)]
        await asyncio.wait_for(entered.wait(), 2)
        release.set()
        results = await asyncio.wait_for(asyncio.gather(*work), 2)
        assert len(requests) == 3 and session.revision == 3
        assert sorted(session.state["receipts"]) == ["call-1", "call-2", "call-3"]
        merged = sorted(r["metadata"].get("append_merged_from_revision", -1) for r in results)
        assert merged == [-1, 0, 0] and all(r["metadata"]["state_retries"] == 0 for r in results)
        # History records the state each commit actually applied to.
        assert [len(step["state_before"]["receipts"]) for step in session.history] == [0, 1, 2]

    asyncio.run(run())


def test_distribution_append_prediction_rebases_after_an_intervening_replace():
    """A record append is not merged over a commit that changed existing state."""

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        requests = []

        async def complete(request):
            requests.append(request)
            evidence = json.loads(request.messages[1].content)
            payload = json.loads(distribution_reply(request))
            if evidence["candidate_response"]["tool_calls"][0]["call_id"] == "call-1":
                payload["outcomes"][1]["state_patch"] = [{"op": "replace", "path": "/funds_cents", "value": 500}]
                return json.dumps(payload)
            entered.set()
            await release.wait()
            return json.dumps(payload)

        model = distribution_model(complete, sample_uniform=lambda: 0.975)
        session = model.new_session("Fund then record", {"receipts": [], "funds_cents": 0}, "root")
        slow = asyncio.create_task(model.step(session.id, action(2), "inv-2"))
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.wait_for(model.step(session.id, action(1), "inv-1"), 2)
        release.set()
        result = await asyncio.wait_for(slow, 2)
        assert len(requests) == 3 and result["metadata"]["state_retries"] == 1
        assert "append_merged_from_revision" not in result["metadata"]
        assert session.state == {"receipts": ["call-2"], "funds_cents": 500}

    asyncio.run(run())


def test_a_new_prediction_runs_beside_a_rebase_and_commits_after_it():
    """Run 7 (2026-10-12): one replace queued a 15-agent fan-out behind one re-prediction at a time.
    A new operation predicts at once and only its commit yields to the older conflicted one."""

    async def run():
        first_entered, first_release = asyncio.Event(), asyncio.Event()
        rebase_entered, rebase_release, third_entered = asyncio.Event(), asyncio.Event(), asyncio.Event()
        requests, seen = [], {}

        async def complete(request):
            requests.append(request)
            call = json.loads(request.messages[1].content)["candidate_response"]["tool_calls"][0]["call_id"]
            payload = json.loads(distribution_reply(request))
            if call == "call-1":
                payload["outcomes"][1]["state_patch"] = [{"op": "replace", "path": "/funds_cents", "value": 500}]
            elif call == "call-2":
                seen[call] = seen.get(call, 0) + 1
                entered, release = (first_entered, first_release) if seen[call] == 1 else (rebase_entered, rebase_release)
                entered.set()
                await release.wait()
            else:
                third_entered.set()
            return json.dumps(payload)

        model = distribution_model(complete, sample_uniform=lambda: 0.975)
        session = model.new_session("Fund, then record two calls", {"receipts": [], "funds_cents": 0}, "root")
        second = asyncio.create_task(model.step(session.id, action(2), "inv-2"))
        await asyncio.wait_for(first_entered.wait(), 2)
        await asyncio.wait_for(model.step(session.id, action(1), "inv-1"), 2)
        first_release.set()
        await asyncio.wait_for(rebase_entered.wait(), 2)
        third = asyncio.create_task(model.step(session.id, action(3), "inv-3"))
        # The new operation predicts while the conflicted one re-predicts...
        await asyncio.wait_for(third_entered.wait(), 2)
        await asyncio.sleep(0.05)
        # ...but cannot commit ahead of it.
        assert not third.done() and session.revision == 1
        rebase_release.set()
        results = await asyncio.wait_for(asyncio.gather(second, third), 2)
        assert len(requests) == 4 and session.revision == 3
        assert session.state == {"receipts": ["call-2", "call-3"], "funds_cents": 500}
        assert [r["metadata"]["committed_revision"] for r in results] == [2, 3]
        assert [r["metadata"]["state_retries"] for r in results] == [1, 0]
        assert results[1]["metadata"]["append_merged_from_revision"] == 1

    asyncio.run(run())


def test_distribution_new_record_keys_merge_but_a_shared_new_key_rebases():
    """Creating an absent key is a new record; two creations of the same key are not merged."""

    async def run():
        for shared in (False, True):
            entered, release = asyncio.Event(), asyncio.Event()
            requests = []

            async def complete(request):
                requests.append(request)
                call = json.loads(request.messages[1].content)["candidate_response"]["tool_calls"][0]["call_id"]
                payload = json.loads(distribution_reply(request))
                key = "research_runs" if shared else f"{call}_runs"
                payload["outcomes"][1]["state_patch"] = [{"op": "add", "path": f"/{key}", "value": [call]}]
                if len(requests) == 2:
                    entered.set()
                await release.wait()
                return json.dumps(payload)

            model = distribution_model(complete, sample_uniform=lambda: 0.975)
            session = model.new_session("Research two funds", {"receipts": []}, "root")
            work = [asyncio.create_task(model.step(session.id, action(n), f"inv-{n}")) for n in (1, 2)]
            await asyncio.wait_for(entered.wait(), 2)
            release.set()
            results = await asyncio.wait_for(asyncio.gather(*work), 2)
            if shared:
                # JSON Patch add on an existing key replaces it: never merge over it.
                assert len(requests) == 3 and sorted(r["metadata"]["state_retries"] for r in results) == [0, 1]
                assert not any("append_merged_from_revision" in r["metadata"] for r in results)
            else:
                assert len(requests) == 2 and session.state["call-1_runs"] == ["call-1"]
                assert session.state["call-2_runs"] == ["call-2"]
            assert session.revision == 2

    asyncio.run(run())


def _timed(payload, elapsed=(60_000, 60_000)):
    payload = json.loads(payload) if isinstance(payload, str) else payload
    payload["schema"] = "rose.wmh_timed_outcome_distribution.v1"
    for outcome, value in zip(payload["outcomes"], elapsed):
        outcome["elapsed_ms"] = value
    return payload


@pytest.mark.parametrize(
    "elapsed,valid",
    [((60_000, 3_600_000), True), ((0, 0), True), ((None, 1), False), ((-1, 1), False), ((True, 1), False),
     ((1.5, 1), False), ((400 * 86_400_000, 1), False)],
)
def test_timed_distribution_requires_a_plausible_elapsed_time_per_outcome(elapsed, valid):  # V1
    from benchmarks.wmh_outcomes import parse_distribution

    request = type("R", (), {})()
    evidence = {"candidate_response": {"tool_calls": [{"call_id": "call-1"}]}}
    request.messages = (None, type("M", (), {"content": json.dumps(evidence)})())
    payload = _timed(distribution_reply(request), elapsed)
    if elapsed[0] is None:
        del payload["outcomes"][0]["elapsed_ms"]
    content = json.dumps(payload)
    if valid:
        parsed = parse_distribution(content, base_state={"receipts": []}, expected_call_ids=("call-1",), timed=True)
        assert [o["elapsed_ms"] for o in parsed["outcomes"]] == list(elapsed)
    else:
        with pytest.raises(ValueError):
            parse_distribution(content, base_state={"receipts": []}, expected_call_ids=("call-1",), timed=True)
    # The untimed protocol keeps its exact contract.
    with pytest.raises(ValueError):
        parse_distribution(json.dumps(_timed(distribution_reply(request))), base_state={"receipts": []},
                           expected_call_ids=("call-1",))


def test_scheduled_events_stay_hidden_until_their_world_time():  # V6
    from benchmarks.wmh_outcomes import restore_hidden_events, visible_world_state

    state = {"structured": {"scheduled_events": [
        {"available_at_ms": 2, "description": "sent"}, {"available_at_ms": 9, "description": "reply"},
        {"description": "no time: visible"},
    ], "other": 1}, "scratchpad": "x"}
    view, hidden = visible_world_state(state, at_ms=7)
    assert [e["description"] for e in view["structured"]["scheduled_events"]] == ["sent", "no time: visible"]
    assert [e["description"] for e in hidden] == ["reply"]
    assert visible_world_state(state, at_ms=11)[1] == []
    # A prediction made on the view keeps the hidden future when it commits.
    view["structured"]["scheduled_events"].append({"available_at_ms": 20, "description": "meeting"})
    merged = restore_hidden_events(view, hidden)
    assert [e["description"] for e in merged["structured"]["scheduled_events"]] == [
        "sent", "no time: visible", "meeting", "reply"]
    assert visible_world_state({"structured": {}, "scratchpad": ""}, at_ms=0)[0]["structured"]["scheduled_events"] == []


def _timed_action(n, agent="root"):
    stamped = action(n)
    stamped["arguments"]["agent_id"] = agent
    stamped["arguments"]["timestamp_ms"] = 999  # wall clock from the caller; the world clock wins
    return stamped


def test_timed_actions_run_at_world_time_and_advance_their_agent_once():  # V2, V3
    async def run():
        requests = []

        async def complete(request):
            requests.append(request)
            return json.dumps(_timed(distribution_reply(request), (7_200_000, 7_200_000)))

        model = distribution_model(complete, policy="rose-outcome-distribution-v3", sample_uniform=lambda: 0.975)
        seed = {"structured": {"schema": "test", "as_of_utc": "2026-10-11T00:00:00Z"}, "scratchpad": "", "receipts": []}
        session = model.new_session("Raise", seed, "root")
        start = 1_791_676_800_000
        first = await model.step(session.id, _timed_action(1), "inv-1")
        evidence = json.loads(requests[0].messages[1].content)
        assert evidence["candidate_response"]["tool_calls"][0]["arguments"]["timestamp_ms"] == start
        assert first["metadata"]["world_time_ms"] == start and first["metadata"]["elapsed_ms"] == 7_200_000
        assert session.clock.time_of("root") == start + 7_200_000
        again = await model.step(session.id, _timed_action(1), "inv-1")
        assert again == first and len(requests) == 1 and session.clock.time_of("root") == start + 7_200_000
        second = await model.step(session.id, _timed_action(2), "inv-2")
        assert second["metadata"]["world_time_ms"] == start + 7_200_000

    asyncio.run(run())


def test_a_scheduled_reply_is_invisible_before_its_time_and_visible_after():  # V6
    async def run():
        seen = []

        async def complete(request):
            evidence = json.loads(request.messages[1].content)
            seen.append([e["description"] for e in evidence["environment_state"]["structured"]["scheduled_events"]])
            payload = _timed(distribution_reply(request), (2 * 86_400_000, 2 * 86_400_000))
            return json.dumps(payload)

        model = distribution_model(complete, policy="rose-outcome-distribution-v3", sample_uniform=lambda: 0.975)
        day = 86_400_000
        seed = {
            "structured": {
                "schema": "test",
                "as_of_utc": "1970-01-08T00:00:00Z",
                "scheduled_events": [{"available_at_ms": 9 * day, "description": "investor reply"}],
            },
            "scratchpad": "",
            "receipts": [],
        }
        session = model.new_session("Check inbox", seed, "root")
        await model.step(session.id, _timed_action(1), "check-day-7")  # starts at day 7
        await model.step(session.id, _timed_action(2), "check-day-9")  # starts at day 9
        assert seen == [[], ["investor reply"]]
        # The committed world kept the hidden reply throughout.
        assert [e["description"] for e in session.state["structured"]["scheduled_events"]] == ["investor reply"]

    asyncio.run(run())


def test_runner_owns_the_world_date_so_parallel_record_appends_still_merge():
    """Run 5 (2026-10-12): every outcome rewrote /structured/as_of_utc, so no fan-out step
    could merge and 28 parallel outreach steps predicted one at a time."""

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        seen = []

        async def complete(request):
            evidence = json.loads(request.messages[1].content)
            seen.append(evidence["environment_state"]["structured"]["as_of_utc"])
            call = evidence["candidate_response"]["tool_calls"][0]["call_id"]
            payload = _timed(distribution_reply(request), (60_000, 60_000))
            for outcome in payload["outcomes"]:
                outcome["state_patch"] = [
                    {"op": "replace", "path": "/structured/as_of_utc", "value": "2026-09-28T00:01:00Z"},
                    {"op": "add", "path": "/receipts/-", "value": call},
                ]
            if len(seen) == 2:
                entered.set()
            await release.wait()
            return json.dumps(payload)

        model = distribution_model(complete, policy="rose-outcome-distribution-v3", sample_uniform=lambda: 0.975)
        seed = {"structured": {"schema": "t", "as_of_utc": "2026-09-28T00:00:00Z"}, "scratchpad": "", "receipts": []}
        session = model.new_session("Pitch two funds", seed, "root")
        work = [asyncio.create_task(model.step(session.id, _timed_action(n), f"inv-{n}")) for n in (1, 2)]
        await asyncio.wait_for(entered.wait(), 2)
        release.set()
        results = await asyncio.wait_for(asyncio.gather(*work), 2)
        assert len(seen) == 2 and all(r["metadata"]["state_retries"] == 0 for r in results)
        assert sorted(session.state["receipts"]) == ["call-1", "call-2"]
        assert session.state["structured"]["as_of_utc"] == "2026-09-28T00:00:00Z"
        assert seen == ["2026-09-28T00:00:00Z", "2026-09-28T00:00:00Z"]

    asyncio.run(run())


def test_served_world_clock_registers_waits_and_finishes_agents():
    import httpx

    from benchmarks.serve_experiential_world_model import create_app

    async def run():
        async def complete(request):
            return json.dumps(_timed(distribution_reply(request)))

        model = distribution_model(complete, policy="rose-outcome-distribution-v3", sample_uniform=lambda: 0.975)
        model.new_session("Raise", {"structured": {"schema": "t", "as_of_utc": "1970-01-01T00:00:00Z"}, "scratchpad": ""}, "root")
        base = "/world_models/rose/scopes/root/clock"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app("rose", model)), base_url="http://wmh") as http:
            assert (await http.post(f"{base}/agents/root/register", json={})).status_code == 200
            assert (await http.post(f"{base}/agents/child/register", json={"parent": "root"})).json()["time_ms"] == 0
            waited = (await http.post(f"{base}/agents/child/wait", json={"wait_id": "w", "duration_ms": 3_600_000})).json()
            assert waited == {"resumed": True, "time_ms": 3_600_000, "deadline_ms": 3_600_000}
            assert (await http.post(f"{base}/agents/child/finish", json={})).status_code == 200
            snapshot = (await http.get(base)).json()
            assert {a["agent_id"]: a["state"] for a in snapshot["agents"]} == {"root": "running", "child": "done"}
            assert next(a for a in snapshot["agents"] if a["agent_id"] == "root")["time_ms"] == 3_600_000
            assert (await http.post(f"{base}/agents/x/wait", json={"wait_id": "w"})).status_code == 422
            assert (await http.get("/world_models/rose/scopes/missing/clock")).status_code == 404

    asyncio.run(run())


def test_distribution_invalid_unselected_branch_never_commits_and_retirement_fences_late_result():
    async def run():
        requests = []

        async def invalid(request):
            requests.append(request)
            payload = json.loads(distribution_reply(request))
            payload["outcomes"][0]["state_patch"] = [{"op": "remove", "path": "/missing"}]
            return json.dumps(payload)

        model = distribution_model(invalid, sample_uniform=lambda: 0.975)
        seed = {"receipts": [], "private_fact": None}
        session = model.new_session("Submit", seed, "invalid-root")
        with pytest.raises(ValueError, match="target"):
            await model.step(session.id, action(1), "invalid-inv")
        assert len(requests) == 2 and session.revision == 0 and session.state == seed
        assert session.messages == session.history == () and not model.audit

        entered, release = asyncio.Event(), asyncio.Event()

        async def late(request):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                pass
            return distribution_reply(request)

        model = distribution_model(late, sample_uniform=lambda: 0.975)
        session = model.new_session("Submit", seed, "closed-root")
        task = asyncio.create_task(model.step(session.id, action(1), "late-inv"))
        await asyncio.wait_for(entered.wait(), 2)
        receipt = await model.end_session(session.id)
        with pytest.raises(ValueError, match="ended before commit"):
            await task
        assert receipt["state"] == seed and receipt["history"] == [] and receipt["revision"] == 0
        assert session.id not in model.sessions
        with pytest.raises(ValueError, match="retired"):
            model.new_session("Submit again", seed, "closed-root")

    asyncio.run(run())


def test_parallel_predictions_merge_disjoint_mutations_and_deduplicate_retries():
    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()
        active = 0
        peak = 0
        calls = []

        async def complete(request):
            nonlocal active, peak
            e = json.loads(request.messages[1].content)
            calls.append(e)
            active += 1
            peak = max(peak, active)
            if active == 2:
                entered.set()
            await release.wait()
            active -= 1
            state = deepcopy(e["environment_state"])
            call = e["candidate_response"]["tool_calls"][0]
            state.setdefault("forms", {})[call["call_id"]] = {"submitted": True}
            return reply(request, state)

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Root goal", {"fixed_identity": "Tamara"}, "root")
        assert model.new_session("Child delegation", {}, "root") is s
        operations = [asyncio.create_task(model.step(s.id, action(n), f"inv-{n}")) for n in (1, 2, 1, 2)]
        await asyncio.wait_for(entered.wait(), 2)
        release.set()
        results = await asyncio.wait_for(asyncio.gather(*operations), 2)
        assert peak == 2 and len(calls) == 3 and len(s.history) == 2
        assert s.state == {
            "fixed_identity": "Tamara",
            "forms": {"call-1": {"submitted": True}, "call-2": {"submitted": True}},
        }
        assert all(r["content"] == "completed" for r in results)
        assert {e["candidate_response"]["tool_calls"][0]["arguments"]["arguments"]["goal"] for e in calls} == {
            "Perform operation 1",
            "Perform operation 2",
        }
        assert all(e["task"]["instruction"] == "Root goal" for e in calls)
        assert s.history[0]["state_before"] == {"fixed_identity": "Tamara"}
        assert len(s.history[1]["state_before"]["forms"]) == 1
        assert s.revision == 2

    asyncio.run(run())


def test_equal_concurrent_deposits_repredict_instead_of_losing_an_effect():
    async def run():
        barrier = asyncio.Event()
        entered = 0
        calls = []

        async def complete(request):
            nonlocal entered
            e = json.loads(request.messages[1].content)
            calls.append(e)
            entered += 1
            if entered == 2:
                barrier.set()
            await asyncio.wait_for(barrier.wait(), 2)
            state = deepcopy(e["environment_state"])
            state["balance"] += 10
            return reply(request, state, str(state["balance"]))

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Record both deposits", {"balance": 0})
        results = await asyncio.gather(model.step(s.id, action(1)), model.step(s.id, action(2)))
        assert s.state["balance"] == 20 and len(calls) == 3 and len(s.history) == 2
        assert sorted(r["content"] for r in results) == ["10", "20"]
        assert sorted(r["metadata"]["state_retries"] for r in results) == [0, 1]
        assert len(calls[-1]["visible_conversation"]) == 2

    asyncio.run(run())


def test_shared_read_dependencies_cannot_write_skew_on_disjoint_fields():
    async def run():
        entered = 0
        barrier = asyncio.Event()
        calls = []

        async def complete(request):
            nonlocal entered
            e = json.loads(request.messages[1].content)
            calls.append(e)
            entered += 1
            if entered == 2:
                barrier.set()
            await asyncio.wait_for(barrier.wait(), 2)
            state = deepcopy(e["environment_state"])
            total = sum(state["reserved"].values())
            approved = total + 80 <= state["capacity"]
            if approved:
                state["reserved"][e["candidate_response"]["tool_calls"][0]["call_id"]] = 80
            return reply(request, state, "approved" if approved else "declined")

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Reserve capacity", {"capacity": 100, "reserved": {}})
        results = await asyncio.gather(model.step(s.id, action(1)), model.step(s.id, action(2)))
        assert sum(s.state["reserved"].values()) <= 100
        assert sorted(r["content"] for r in results) == ["approved", "declined"] and len(calls) == 3

    asyncio.run(run())


def test_json_boolean_and_number_changes_are_distinct_world_mutations():
    async def run():
        async def complete(request):
            return reply(request, {"value": 1, "nested": [1]})

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Change type", {"value": True, "nested": [True]})
        await model.step(s.id, action(1))
        assert type(s.state["value"]) is int and type(s.state["nested"][0]) is int

    asyncio.run(run())


def test_failed_operation_after_caller_cancel_is_removed_before_first_retry():
    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def complete(request):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            if calls == 1:
                raise RuntimeError("recorded provider failure")
            return reply(request, {"retried": True})

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Inspect", {})
        caller = asyncio.create_task(model.step(s.id, action(1), "inv"))
        await entered.wait()
        operation = s.receipts["inv"][1]
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller
        release.set()
        with pytest.raises(RuntimeError):
            await operation
        await asyncio.sleep(0)
        assert not s.receipts
        assert (await model.step(s.id, action(1), "inv"))["content"] == "completed" and calls == 2

    asyncio.run(run())


def test_failed_protocol_never_commits_and_retry_retains_exact_evidence():
    async def run():
        requests = []

        async def complete(request):
            requests.append(request)
            return json.dumps({"output": "old protocol", "state": {"bad": True}})

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Inspect", {"balance": 0})
        with pytest.raises(ValueError):
            await model.step(s.id, action(1), "inv")
        assert s.state == {"balance": 0} and not s.history and not s.receipts
        assert len(requests) == 2 and requests[0].messages == requests[1].messages[:2]

    asyncio.run(run())


@pytest.mark.parametrize(
    "encoded",
    [
        {
            "schema": "rose.canonical_observation.v1",
            "category": "browser",
            "content": "",
            "is_error": False,
            "metadata": {},
        },
        {"output": "", "is_error": False},
    ],
)
def test_decoded_blank_observations_never_commit(encoded):
    async def run():
        async def complete(request):
            return reply(request, {"bad_commit": True}, json.dumps(encoded))

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Inspect", {})
        with pytest.raises(ValueError):
            await model.step(s.id, action(1))
        assert s.state == {} and not s.history and not s.receipts

    asyncio.run(run())


def test_relay_protocol_rejection_uses_native_repair_and_preserves_evidence():
    from exp.simulation.engines.text.prompt import TextWorldModelProtocolError

    async def run():
        requests = []

        async def complete(request):
            requests.append(request)
            if len(requests) == 1:
                raise TextWorldModelProtocolError("Native result call IDs differ")
            return reply(request, {"repaired": True})

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Original goal", {})
        result = await model.step(s.id, action(1))
        assert result["content"] == "completed" and len(requests) == 2 and s.revision == 1
        assert requests[0].messages == requests[1].messages[:2]

    asyncio.run(run())


def test_cancelled_http_caller_keeps_receipt_and_close_prevents_late_commit():
    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()
        count = 0

        async def complete(request):
            nonlocal count
            count += 1
            entered.set()
            await release.wait()
            return reply(request, {"sent": True})

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Send", {})
        caller = asyncio.create_task(model.step(s.id, action(1), "inv"))
        await entered.wait()
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller
        retry = asyncio.create_task(model.step(s.id, action(1), "inv"))
        release.set()
        assert (await retry)["content"] == "completed" and count == 1 and len(s.history) == 1
        await model.end_session(s.id)
        assert not model.sessions
        entered.clear()
        release.clear()
        s2 = model.new_session("Next", {})
        pending = asyncio.create_task(model.step(s2.id, action(2), "inv"))
        await entered.wait()
        await model.end_session(s2.id)
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert not s2.history

    asyncio.run(run())


def test_served_retirement_joins_provider_freezes_receipt_and_fences_root_scope():
    import httpx

    from benchmarks.serve_experiential_world_model import create_app

    async def run():
        entered = {n: asyncio.Event() for n in (1, 2)}
        release = {n: asyncio.Event() for n in (1, 2)}
        cleanup_entered = asyncio.Event()
        cleanup_release = asyncio.Event()
        cleanup_done = asyncio.Event()
        provider_tasks = {}
        usage = {"calls": 0}

        async def provider(request, n):
            entered[n].set()
            try:
                await release[n].wait()
            except asyncio.CancelledError:
                cleanup_entered.set()
                await cleanup_release.wait()
                cleanup_done.set()
                raise
            usage["calls"] += 1
            return reply(request, {"seed": n, "observed": True})

        async def complete(request):
            e = json.loads(request.messages[1].content)
            n = int(e["candidate_response"]["tool_calls"][0]["call_id"].split("-")[1])
            task = asyncio.create_task(provider(request, n))
            provider_tasks[n] = task
            return await asyncio.shield(task)

        model = ParallelWorldModel(complete, Retriever())
        a = model.new_session("Root A", {"seed": 1}, "root-a")
        b = model.new_session("Root B", {"seed": 2}, "root-b")

        async def retire_provider(session_id):
            n = 1 if session_id == a.id else 2
            task = provider_tasks[n]
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            return {"session_id": session_id, "join_verified": True, "usage": deepcopy(usage)}

        model.retire_provider = retire_provider
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app("rose", model)), base_url="http://wmh"
        ) as http:
            calls = [
                asyncio.create_task(http.post(f"/world_models/rose/sessions/{s.id}/step", json={"action": action(n)}))
                for n, s in ((1, a), (2, b))
            ]
            retirement = None
            try:
                await asyncio.wait_for(entered[1].wait(), 2)
                await asyncio.wait_for(entered[2].wait(), 2)
                retirement = asyncio.create_task(http.delete(f"/world_models/rose/sessions/{a.id}"))
                await asyncio.sleep(0.05)
                assert not retirement.done(), "DELETE returned before provider cleanup joined"
                await asyncio.wait_for(cleanup_entered.wait(), 2)
                assert not cleanup_done.is_set() and not calls[1].done()
                cleanup_release.set()
                receipt = (await asyncio.wait_for(retirement, 2)).json()
                assert receipt == {
                    "ended": a.id,
                    "engine": "experiential",
                    "session_scope_id": "root-a",
                    "session_id": a.id,
                    "revision": 0,
                    "state": {"seed": 1},
                    "history": [],
                    "usage": {"calls": 0},
                    "join_verified": True,
                }
                assert cleanup_done.is_set()
                assert (
                    await http.post(
                        "/world_models/rose/sessions",
                        json={"task": "Stale worker", "seed_state": {}, "session_scope_id": "root-a"},
                    )
                ).status_code == 409
                assert (
                    await http.post(f"/world_models/rose/sessions/{a.id}/step", json={"action": action(1)})
                ).status_code == 404
                release[2].set()
                assert (await asyncio.wait_for(calls[1], 2)).status_code == 200
                assert b.revision == 1 and b.state == {"seed": 2, "observed": True}
                assert (await http.delete(f"/world_models/rose/sessions/{a.id}")).json() == receipt
                assert usage["calls"] == 1 and a.revision == 0
            finally:
                cleanup_release.set()
                for event in release.values():
                    event.set()
                await asyncio.gather(*calls, *([retirement] if retirement else []), return_exceptions=True)
                await asyncio.gather(*provider_tasks.values(), return_exceptions=True)
                await model.close()

    asyncio.run(run())


def test_served_retirement_slow_cancelled_drain_fails_one_attempt_and_retry_joins(monkeypatch):
    """Run 7 (2026-10-20): DELETE after the benchmark timeout cancelled ~90 in-flight
    predictions whose cleanup outlasted the join bound, so that attempt returned 500.
    The session must stay fenced and a later retirement must return the joined receipt."""
    import httpx

    import benchmarks.experiential_world_model as native
    from benchmarks.serve_experiential_world_model import create_app

    monkeypatch.setattr(native, "NATIVE_SESSION_JOIN_SECONDS", 0.05)

    async def run():
        entered = asyncio.Event()
        drained = asyncio.Event()
        drain = asyncio.Event()

        async def complete(request):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await drain.wait()  # e.g. durable prediction record still writing
                drained.set()
                raise

        model = ParallelWorldModel(complete, Retriever())
        session = model.new_session("Raise", {"raised": 0}, "root")
        transport = httpx.ASGITransport(app=create_app("rose", model), raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://wmh") as http:
            step = asyncio.create_task(
                http.post(f"/world_models/rose/sessions/{session.id}/step", json={"action": action(1)})
            )
            try:
                await asyncio.wait_for(entered.wait(), 2)
                first = await http.delete(f"/world_models/rose/sessions/{session.id}")
                assert first.status_code == 500 and not drained.is_set()
                assert session.closed and not model.retired
                late = await http.post(f"/world_models/rose/sessions/{session.id}/step", json={"action": action(2)})
                assert late.status_code == 409, "a failed retirement attempt must keep the world fenced"
                drain.set()
                # Served by uvicorn this is a 500; the in-process transport re-raises it.
                (outcome,) = await asyncio.wait_for(asyncio.gather(step, return_exceptions=True), 2)
                assert isinstance(outcome, asyncio.CancelledError) or outcome.status_code == 500
                assert drained.is_set()
                second = await http.delete(f"/world_models/rose/sessions/{session.id}")
                assert second.status_code == 200, second.text
                receipt = second.json()
                assert receipt["join_verified"] is True and receipt["ended"] == session.id
                assert receipt["revision"] == 0 and receipt["state"] == {"raised": 0} and receipt["history"] == []
                assert (await http.delete(f"/world_models/rose/sessions/{session.id}")).json() == receipt
            finally:
                drain.set()
                await asyncio.gather(step, return_exceptions=True)
                await model.close()

    asyncio.run(run())


def test_retirement_persists_once_checks_frozen_identity_and_bounds_fences(tmp_path):
    from benchmarks.build_experiential_world_model import atomic_json

    async def run():
        publications = []

        async def complete(request):
            return reply(request, {"seed": {"unchanged": True}, "submitted": True})

        def publish(receipt):
            path = tmp_path / f"{receipt['session_id']}.json"
            atomic_json(path, receipt)
            publications.append(path)
            return path

        model = ParallelWorldModel(
            complete,
            Retriever(),
            maximum_sessions=1,
            record_retirement=publish,
            load_retirement=lambda path: json.loads(path.read_text()),
        )
        session = model.new_session("Original root", {"seed": {"unchanged": True}}, "root")
        await model.step(session.id, action(1))
        before = deepcopy(session.history)
        first = await model.end_session(session.id)
        assert first["revision"] == 1 and first["state"]["submitted"] is True
        assert first["history"] == list(before) and first["join_verified"] is True
        first["state"]["submitted"] = False
        second = await model.end_session(session.id)
        assert second["state"]["submitted"] is True and len(publications) == 1
        assert not model.sessions and not session.history and not session.state
        assert len(model.closed_scopes) == len(model.retired) == 1
        with pytest.raises(ValueError, match="capacity"):
            model.new_session("Another root", {}, "other")
        modified = json.loads(publications[0].read_text())
        modified["revision"] = 99
        atomic_json(publications[0], modified)
        with pytest.raises(RuntimeError, match="changed after publication"):
            await model.end_session(session.id)
        assert len(publications) == 1

    asyncio.run(run())


def test_retirement_rejects_wrong_provider_join_and_keeps_admission_closed():
    async def run():
        async def complete(request):
            return reply(request, {})

        calls = 0

        async def retire(session_id):
            nonlocal calls
            calls += 1
            return {"session_id": "wrong" if calls == 1 else session_id, "join_verified": True, "usage": {"calls": 0}}

        model = ParallelWorldModel(complete, Retriever(), retire_provider=retire)
        session = model.new_session("Root", {}, "root")
        with pytest.raises(RuntimeError, match="exact session join"):
            await model.end_session(session.id)
        assert session.closed and not model.retired
        with pytest.raises(ValueError, match="retired"):
            model.new_session("Stale", {}, "root")
        with pytest.raises(ValueError, match="closed"):
            await model.step(session.id, action(1))
        assert (await model.end_session(session.id))["join_verified"] is True and calls == 2

    asyncio.run(run())


def test_call_identity_and_invocation_reuse_are_validated():
    a = action(1)
    a["arguments"]["tool_call_id"] = ""
    with pytest.raises(ValueError):
        action_from_canonical(a)

    async def run():
        async def complete(request):
            return reply(request, {})

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Inspect", {})
        await model.step(s.id, action(1), "same")
        with pytest.raises(ValueError, match="different action"):
            await model.step(s.id, action(2), "same")
        assert len(s.history) == 1

    asyncio.run(run())


def test_invocation_reuse_cannot_conflate_boolean_and_numeric_arguments():
    async def run():
        async def complete(request):
            return reply(request, {})

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Inspect", {})
        first = action(1)
        first["arguments"]["arguments"]["enabled"] = True
        await model.step(s.id, first, "inv")
        second = deepcopy(first)
        second["arguments"]["arguments"]["enabled"] = 1
        with pytest.raises(ValueError, match="different action"):
            await model.step(s.id, second, "inv")

    asyncio.run(run())


def test_eight_same_root_predictions_overlap_and_commit_every_effect():
    async def run():
        barrier = asyncio.Event()
        active = 0
        peak = 0
        calls = 0

        async def complete(request):
            nonlocal active, peak, calls
            active += 1
            peak = max(peak, active)
            calls += 1
            if active == 8:
                barrier.set()
            await asyncio.wait_for(barrier.wait(), 2)
            await asyncio.sleep(0)
            active -= 1
            e = json.loads(request.messages[1].content)
            state = deepcopy(e["environment_state"])
            state["count"] += 1
            return reply(request, state, str(state["count"]))

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Count every operation", {"count": 0}, "root")
        results = await asyncio.gather(*(model.step(s.id, action(n)) for n in range(8)))
        assert peak == 8 and s.state["count"] == 8 and len(s.history) == 8
        assert sorted(int(r["content"]) for r in results) == list(range(1, 9))
        # Eight overlapped predictions; each of the seven conflicted operations then
        # rebases exactly once in its turn (previously 8+7+...+1 = 36 predictions).
        assert calls == 15 and sorted(r["metadata"]["committed_revision"] for r in results) == list(range(1, 9))
        assert max(r["metadata"]["state_retries"] for r in results) == 1 and not s.contended

    asyncio.run(run())


def test_rebased_slow_prediction_gets_commit_turn_before_newer_fast_operations():
    """A slow prediction (explore) must not be rebased forever by a stream of fast commits."""

    async def run():
        slow_entered = [asyncio.Event(), asyncio.Event()]
        slow_release = [asyncio.Event(), asyncio.Event()]
        slow_revisions, fast_revisions = [], []
        fast_entered = asyncio.Event()

        async def complete(request):
            e = json.loads(request.messages[1].content)
            state = deepcopy(e["environment_state"])
            call = e["candidate_response"]["tool_calls"][0]["call_id"]
            if call == "call-0":
                attempt = len(slow_revisions)
                slow_revisions.append(state["count"])
                assert attempt < 2, "slow operation was rebased again after its conflict"
                slow_entered[attempt].set()
                await slow_release[attempt].wait()
            else:
                fast_revisions.append((call, state["count"]))
                if call == "call-2":
                    fast_entered.set()
            state["count"] += 1
            state.setdefault("order", []).append(call)
            return reply(request, state, call)

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Explore while messaging", {"count": 0}, "root")
        slow = asyncio.create_task(model.step(s.id, action(0), "explore"))
        await asyncio.wait_for(slow_entered[0].wait(), 2)
        assert (await asyncio.wait_for(model.step(s.id, action(1), "sms-1"), 2))["content"] == "call-1"
        slow_release[0].set()
        await asyncio.wait_for(slow_entered[1].wait(), 2)
        # The conflicted slow operation now owns the next commit. A newer fast
        # operation still predicts at once, but cannot commit ahead of it.
        fast = asyncio.create_task(model.step(s.id, action(2), "sms-2"))
        # Wait for the observable event, not a count of loop ticks (flaked under gate load).
        await asyncio.wait_for(fast_entered.wait(), 2)
        await asyncio.sleep(0.05)
        assert fast_revisions == [("call-1", 0), ("call-2", 1)] and not fast.done()
        slow_release[1].set()
        results = await asyncio.wait_for(asyncio.gather(slow, fast), 2)
        # Its prediction from revision 1 was overtaken by a replacing commit, so
        # it rebases once, at its own turn.
        assert slow_revisions == [0, 1] and fast_revisions == [("call-1", 0), ("call-2", 1), ("call-2", 2)]
        assert [r["metadata"]["committed_revision"] for r in results] == [2, 3]
        assert [r["metadata"]["state_retries"] for r in results] == [1, 1]
        assert s.state == {"count": 3, "order": ["call-1", "call-0", "call-2"]} and not s.contended

    asyncio.run(run())


def test_slow_operation_outlives_its_first_caller_and_the_retry_rejoins_it():
    """A long prediction is not killed by an operation deadline; the caller's retry joins it."""

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def complete(request):
            calls.append(request)
            entered.set()
            await release.wait()
            return reply(request, {"researched": True}, "memo")

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Explore investors", {}, "root")
        first = asyncio.create_task(model.step(s.id, action(1), "explore"))
        await asyncio.wait_for(entered.wait(), 2)
        # The first HTTP caller times out and Temporal retries the activity.
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        loop = asyncio.get_running_loop()
        clock = loop.time
        loop.time = lambda: clock() + 3600
        try:
            for _ in range(5):
                await asyncio.sleep(0)
        finally:
            del loop.time
        retry = asyncio.create_task(model.step(s.id, action(1), "explore"))
        release.set()
        result = await asyncio.wait_for(retry, 2)
        assert result["content"] == "memo" and len(calls) == 1 and s.revision == 1

    asyncio.run(run())


def test_served_activity_reports_operations_still_in_flight():
    """Benchmark stall detection reads this: a leaf waiting on a prediction is not stalled."""
    import httpx

    from benchmarks.serve_experiential_world_model import create_app

    async def run():
        release = asyncio.Event()
        entered = asyncio.Event()

        async def complete(request):
            entered.set()
            await release.wait()
            e = json.loads(request.messages[1].content)
            state = deepcopy(e["environment_state"])
            state["count"] = state.get("count", 0) + 1
            return reply(request, state)

        model = ParallelWorldModel(complete, Retriever())
        s = model.new_session("Explore", {}, "root")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app("rose", model)), base_url="http://wmh"
        ) as http:
            url = f"/world_models/rose/sessions/{s.id}/activity"
            assert (await http.get(url)).json() == {"revision": 0, "operations_in_flight": 0}
            work = [asyncio.create_task(model.step(s.id, action(n), f"inv-{n}")) for n in (1, 2)]
            await asyncio.wait_for(entered.wait(), 2)
            assert (await http.get(url)).json() == {"revision": 0, "operations_in_flight": 2}
            release.set()
            await asyncio.wait_for(asyncio.gather(*work), 2)
            assert (await http.get(url)).json() == {"revision": 2, "operations_in_flight": 0}
            assert (await http.get("/world_models/rose/sessions/missing/activity")).status_code == 404
            assert (await http.get(f"/world_models/other/sessions/{s.id}/activity")).status_code == 404

    asyncio.run(run())


def test_declared_capacity_rejects_required_context_without_truncation():
    from exp.common.models import ModelCapabilities
    from exp.simulation.world_model.runtime import WorldModelCapacityError

    async def run():
        calls = []

        async def complete(request):
            calls.append(request)
            return reply(request, {})

        model = ParallelWorldModel(
            complete,
            Retriever(),
            capabilities=ModelCapabilities(maximum_output_tokens=16384, context_window_tokens=17000),
        )
        task = "Preserve the entire original task. " * 1000
        s = model.new_session(task, {})
        with pytest.raises(WorldModelCapacityError):
            await model.step(s.id, action(1))
        assert not calls and s.task == task and not s.history and not s.receipts

    asyncio.run(run())


def test_native_prediction_trace_retains_full_root_and_delegated_goal():
    async def run():
        records = []

        async def complete(request):
            return reply(request, {"submitted": True}, "received")

        model = ParallelWorldModel(complete, Retriever(), record_prediction=records.append)
        root = "The entire original root goal"
        s = model.new_session(root, {"known": True})
        result = await model.step(s.id, action(1))
        evidence = json.loads(records[0]["request"]["messages"][1]["content"])
        assert evidence["task"]["instruction"] == root
        assert (
            evidence["candidate_response"]["tool_calls"][0]["arguments"]["arguments"]["goal"] == "Perform operation 1"
        )
        assert json.loads(records[0]["response"])["tool_results"][0]["content"] == "received"
        interval = result["metadata"]["prediction_attempts"][0]
        assert interval["started_at_ms"] <= interval["finished_at_ms"] and interval["snapshot_revision"] == 0

    asyncio.run(run())


def test_native_trace_records_bridge_rejection_and_protocol_repair():
    from exp.simulation.engines.text.prompt import TextWorldModelProtocolError

    async def run():
        records = []
        calls = 0

        async def complete(request):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise TextWorldModelProtocolError("Rejected invalid native observation before cache done")
            return reply(request, {"repaired": True})

        model = ParallelWorldModel(complete, Retriever(), record_prediction=records.append)
        session = model.new_session("Complete root goal", {})
        result = await model.step(session.id, action(1))
        assert len(records) == len(result["metadata"]["prediction_attempts"]) == calls == 2
        assert records[0]["error"]["type"] == "TextWorldModelProtocolError"
        assert "response" not in records[0]
        assert [record["protocol_repair"] for record in records] == [0, 1]
        assert (
            json.loads(records[0]["request"]["messages"][1]["content"])["task"]["instruction"] == "Complete root goal"
        )

    asyncio.run(run())


def test_native_replay_seed_excludes_its_original_real_trace_lineage():
    from benchmarks.experiential_world_model import lineage_id

    async def run():
        seen = []

        class CaptureRetriever:
            def retrieve(self, query):
                seen.append(query)
                return ()

        async def complete(request):
            return reply(request, {})

        model = ParallelWorldModel(complete, CaptureRetriever())
        s = model.new_session("Replay", {"structured": {"root_agent_id": "original-root"}})
        await model.step(s.id, action(1))
        assert seen[0].excluded_lineage_ids == (lineage_id("original-root"),)

    asyncio.run(run())


def _source_fixture(tmp_path):
    root = "real-root"
    source = tmp_path / "source"
    (source / "otel").mkdir(parents=True)
    (source / "sessions").mkdir()
    session = {
        "root_agent_id": root,
        "initial_state": {
            "root_agent_id": root,
            "root_goal": "Original source goal",
            "verified_product": "source product",
        },
        "split": "train",
        "transition_count": 2,
    }
    (source / "sessions" / f"{root}.session.json").write_text(json.dumps(session))
    (source / "sessions.json").write_text(json.dumps({"sessions": [session]}))
    spans = []
    for n in (1, 2):
        a = action(n)
        output = {
            "schema": "rose.canonical_observation.v1",
            "category": "browser",
            "content": f"observed {n}",
            "is_error": n == 2,
            "metadata": {},
        }

        def attrs(values):
            return [{"key": k, "value": {"stringValue": v}} for k, v in values.items()]

        spans.extend(
            [
                {
                    "spanId": f"action-{n}",
                    "name": "chat " + a["name"],
                    "startTimeUnixNano": 100 + n * 4,
                    "endTimeUnixNano": 101 + n * 4,
                    "attributes": attrs(
                        {
                            "gen_ai.operation.name": "chat",
                            "gen_ai.tool.name": a["name"],
                            "gen_ai.tool.call.arguments": json.dumps(a["arguments"]),
                            "gen_ai.prompt": "Original source goal",
                        }
                    ),
                },
                {
                    "spanId": f"obs-{n}",
                    "parentSpanId": f"action-{n}",
                    "name": "execute_tool " + a["name"],
                    "startTimeUnixNano": 102 + n * 4,
                    "endTimeUnixNano": 103 + n * 4,
                    "attributes": attrs(
                        {
                            "gen_ai.operation.name": "execute_tool",
                            "gen_ai.tool.name": a["name"],
                            "gen_ai.tool.output": json.dumps(output),
                        }
                    ),
                },
            ]
        )
    (source / "otel" / f"{root}.otel.jsonl").write_text("\n".join(json.dumps(s) for s in spans) + "\n")
    return source


def test_native_artifact_preserves_context_pairs_errors_and_rejects_identity_drift(tmp_path):
    from benchmarks.build_experiential_world_model import build
    from benchmarks.serve_experiential_world_model import load_native

    source = _source_fixture(tmp_path)
    out = tmp_path / "native"
    digest = "a" * 64
    pointer = build(source, out, "rose-test", "rose-1-ultra", digest)
    assert pointer["observations"] == 2 and pointer["trajectories"] == 1
    artifact, retriever = load_native(out, "rose-test", "rose-1-ultra", digest)
    transitions = retriever.loaded.transitions
    assert len(transitions) == 2
    assert all(
        t.task == "Original source goal" and t.initial_context["verified_product"] == "source product"
        for t in transitions
    )
    assert sorted(json.loads(t.observation.content)["is_error"] for t in transitions) == [False, True]
    assert {t.action_span_id for t in transitions} == {"action-1", "action-2"}
    with pytest.raises(ValueError, match="pool identity"):
        load_native(out, "rose-test", "rose-1-ultra", "b" * 64)
    p = out / "models/rose-test/experiential.json"
    bad = json.loads(p.read_text())
    bad["world_model_manifest_sha256"] = "0" * 64
    p.write_text(json.dumps(bad))
    with pytest.raises(ValueError, match="manifest differs"):
        load_native(out, "rose-test", "rose-1-ultra", digest)


@pytest.mark.parametrize("gc_enabled", [True, False])
def test_native_load_verifies_each_immutable_artifact_once(tmp_path, monkeypatch, gc_enabled):
    import gc

    from exp.common.project import ArtifactCorruptionError, ArtifactStore
    from exp.common.project.database import project_connection

    from benchmarks.build_experiential_world_model import build
    from benchmarks.serve_experiential_world_model import _ReadSnapshot, load_native

    source = _source_fixture(tmp_path)
    output = tmp_path / "output"
    build(source, output, "test", "rose-1-ultra", "a" * 64)
    expected_artifact, expected_retriever = load_native(output, "test", "rose-1-ultra", "a" * 64)
    original = ArtifactStore.read
    calls = {}
    snapshots = []
    original_init = _ReadSnapshot.__init__

    def initialize(snapshot, paths):
        original_init(snapshot, paths)
        snapshots.append(snapshot)

    monkeypatch.setattr(_ReadSnapshot, "__init__", initialize)

    def read(store, artifact_id):
        assert not gc.isenabled(), "automatic GC remains enabled during verified startup loading"
        calls[artifact_id] = calls.get(artifact_id, 0) + 1
        return original(store, artifact_id)

    monkeypatch.setattr(ArtifactStore, "read", read)
    original_gc_enabled = gc.isenabled()
    original_thresholds = gc.get_threshold()
    try:
        (gc.enable if gc_enabled else gc.disable)()
        artifact, retriever = load_native(output, "test", "rose-1-ultra", "a" * 64)
        assert artifact == expected_artifact and retriever.loaded == expected_retriever.loaded
        assert len(retriever.loaded.transitions) == 2
        assert len(calls) == 3 and set(calls.values()) == {1}, calls
        assert gc.isenabled() is gc_enabled and gc.get_threshold() == original_thresholds
        # A fresh load revalidates all three artifacts; no trust survives the scope.
        load_native(output, "test", "rose-1-ultra", "a" * 64)
        assert set(calls.values()) == {2}, calls
        assert all(not snapshot.verified for snapshot in snapshots)
        assert gc.isenabled() is gc_enabled
        with pytest.raises(ValueError, match="pool identity"):
            load_native(output, "test", "rose-1-ultra", "b" * 64)
        assert all(not snapshot.verified for snapshot in snapshots)
        assert gc.isenabled() is gc_enabled
        dataset_id = retriever.loaded.index.sources[0].artifact_input.artifact_id
        with project_connection(output / "experiential", write=True) as connection:
            connection.execute(
                "UPDATE project_artifact_files SET payload=? WHERE project_id=? AND artifact_id=? AND path=?",
                (b"corrupted source", "test", dataset_id, "traces.jsonl"),
            )
        with pytest.raises(ArtifactCorruptionError):
            load_native(output, "test", "rose-1-ultra", "a" * 64)
        assert all(not snapshot.verified for snapshot in snapshots)
        assert gc.isenabled() is gc_enabled and gc.get_threshold() == original_thresholds
    finally:
        (gc.enable if original_gc_enabled else gc.disable)()


def test_native_conformance_binds_every_case_to_exact_real_records(tmp_path):
    from benchmarks.build_experiential_world_model import bind_conformance, build
    from benchmarks.serve_experiential_world_model import load_native

    source = _source_fixture(tmp_path)
    output = tmp_path / "native"
    pointer = build(source, output, "rose-test", "rose-1-ultra", "a" * 64)
    _, retriever = load_native(output, "rose-test", "rose-1-ultra", "a" * 64)
    cases = [
        {
            "root_agent_id": item.trace_id,
            "action": item.action.tool_arguments,
            "observation": json.loads(item.observation.content),
        }
        for item in retriever.loaded.transitions
    ]
    suite = tmp_path / "suite.json"
    suite.write_text(json.dumps({"status": "passed", "requested_examples": 2, "examples": cases}))
    bound = bind_conformance(suite, output / "conformance.json", retriever.loaded.transitions, pointer)
    assert bound["eligible_examples"] == 2 and bound["native_world_model_id"] == pointer["world_model_id"]
    assert all(case["native_source_transition_ids"] for case in bound["examples"])
    cases[0]["observation"]["content"] = "unrelated result"
    suite.write_text(json.dumps({"status": "passed", "requested_examples": 2, "examples": cases}))
    with pytest.raises(ValueError, match="lacks matching native source"):
        bind_conformance(suite, output / "bad.json", retriever.loaded.transitions, pointer)
    assert not (output / "bad.json").exists()


def test_native_ascii_jsonl_preserves_unicode_and_public_provenance(tmp_path):
    import hashlib

    from exp.common.core.artifacts import canonical_json_bytes
    from exp.common.project import ArtifactStore, ProjectPaths
    from exp.common.traces import load_trace_dataset

    import benchmarks.build_experiential_world_model as building
    from benchmarks.serve_experiential_world_model import load_native

    source = _source_fixture(tmp_path)
    session_path = source / "sessions/real-root.session.json"
    session = json.loads(session_path.read_text())
    session["initial_state"]["unicode_resource"] = "café 🚀 \u2028 \u2029 \u0085"
    session["initial_state"]["typed_values"] = [True, 1, 1.0, False, 0, 0.0, None]
    session_path.write_text(json.dumps(session, ensure_ascii=False))
    output = tmp_path / "native"
    pointer = building.build(source, output, "test", "rose-1-ultra", "a" * 64)
    store = ArtifactStore(ProjectPaths(output / "experiential", "test"))
    artifact, retriever = load_native(output, "test", "rose-1-ultra", "a" * 64)
    rag = retriever.loaded
    for ref in rag.index.sources:
        dataset = load_trace_dataset(store, ref.artifact_input.artifact_id)
        assert store.read_bytes(dataset.dataset.dataset_id, dataset.dataset.traces_path).isascii()
        assert dataset.traces[0].initial_context["unicode_resource"] == session["initial_state"]["unicode_resource"]
    assert store.read_bytes(rag.index.rag_id, rag.index.transitions_path).isascii()
    assert store.read_bytes(rag.index.rag_id, rag.index.vectors_path).isascii()
    (source / "conformance.json").write_text(
        json.dumps(
            {
                "status": "passed",
                "requested_examples": 2,
                "examples": [
                    {
                        "root_agent_id": t.trace_id,
                        "action": t.action.tool_arguments,
                        "observation": json.loads(t.observation.content),
                    }
                    for t in rag.transitions
                ],
            }
        )
    )
    before = hashlib.sha256(canonical_json_bytes(artifact)).hexdigest()
    same = building.republish_ascii(output, "test", "rose-1-ultra", "a" * 64, source)
    after, _ = load_native(output, "test", "rose-1-ultra", "a" * 64)
    assert same["world_model_id"] == pointer["world_model_id"]
    assert hashlib.sha256(canonical_json_bytes(after)).hexdigest() == before


def test_native_republication_reuses_embeddings_rebinds_cases_and_keeps_old_artifacts(tmp_path):
    import hashlib
    import sys
    from collections import Counter
    from datetime import datetime, timezone

    from exp.common.core.artifacts import SourceIdentity, canonical_json_bytes, canonical_jsonl_bytes, stable_id
    from exp.common.project import ArtifactCorruptionError, ArtifactStore, ProjectPaths, artifact_input
    from exp.common.project.database import project_connection
    from exp.common.traces import TraceDataset, load_trace_dataset
    from exp.simulation.retrieval import RAGLineageBinding, persist_trace_rag
    from exp.simulation.world_model.artifact import (
        GroundedWorldModelArtifact,
        grounded_world_model_content,
        persist_grounded_world_model,
    )

    import benchmarks.build_experiential_world_model as building
    from benchmarks.experiential_world_model import lineage_id
    from benchmarks.serve_experiential_world_model import load_native

    source = _source_fixture(tmp_path)
    session_path = source / "sessions/real-root.session.json"
    session = json.loads(session_path.read_text())
    session["initial_state"]["unicode_resource"] = "café 🚀 \u2028 \u2029 \u0085"
    session["initial_state"]["typed_values"] = [True, 1, 1.0, False, 0, 0.0, None]
    session_path.write_text(json.dumps(session, ensure_ascii=False))
    trace, _, _ = building.load_rose_trace(source / "otel/real-root.otel.jsonl", session_path)
    output = tmp_path / "legacy"
    store = ArtifactStore(ProjectPaths(output / "experiential", "test"))
    now = datetime.now(timezone.utc)
    records = canonical_jsonl_bytes((trace,))
    digest = hashlib.sha256(records).hexdigest()
    dataset = TraceDataset(
        created_at=now,
        inputs=(),
        code_revision="legacy-native-fixture",
        source=SourceIdentity(kind="file", source_id="verified-fixture", sha256=digest),
        dataset_id=stable_id("rose-real-traces", {"records_sha256": digest}),
        semantic_convention_version="rose-canonical-export-v11",
        traces_path="traces.jsonl",
        traces_sha256=digest,
        trace_ids=(trace.trace_id,),
    )
    manifest = store.write(
        artifact_id=dataset.dataset_id,
        artifact_type="trace-dataset",
        envelope=dataset,
        files={"trace-dataset.json": canonical_json_bytes(dataset), "traces.jsonl": records},
    )
    original_rag = persist_trace_rag(
        store,
        (artifact_input(manifest),),
        (RAGLineageBinding(trace_id=trace.trace_id, lineage_id=lineage_id(trace.trace_id), partition="fit"),),
        created_at=now,
        code_revision="legacy-native-fixture",
    )
    world = persist_grounded_world_model(
        store,
        artifact_input(original_rag.manifest),
        model_alias="rose-1-ultra",
        model=building.model_snapshot("rose-1-ultra", "a" * 64),
        created_at=now,
        code_revision="legacy-native-fixture",
        top_k=5,
    )
    pointer_path = output / "models/test/experiential.json"
    pointer_path.parent.mkdir(parents=True)
    pointer = {
        "schema": "rose.experiential_model.v1",
        "upstream_revision": building.UPSTREAM_REVISION,
        "adapter_contract": building.ADAPTER_CONTRACT,
        "world_model_id": world.artifact.world_model_id,
        "world_model_manifest_sha256": artifact_input(world.manifest).sha256,
        "source_corpus": str(source),
        "observations": 2,
        "trajectories": 1,
        "exclusions": [{"retained": "original exclusion"}],
        "redactions": [{"retained": "original redaction"}],
    }
    pointer_path.write_text(json.dumps(pointer))
    examples = [
        {
            "root_agent_id": t.trace_id,
            "action": t.action.tool_arguments,
            "observation": json.loads(t.observation.content),
        }
        for t in original_rag.transitions
    ]
    (source / "conformance.json").write_text(
        json.dumps({"status": "passed", "requested_examples": 2, "examples": examples})
    )
    original_ids = (dataset.dataset_id, original_rag.index.rag_id, world.artifact.world_model_id)
    original_bytes = {identity: dict(store.read(identity).payloads) for identity in original_ids}
    calls = Counter()

    def profile(frame, event, arg):
        if event == "call":
            calls[frame.f_code.co_name] += 1

    sys.setprofile(profile)
    try:
        result = building.republish_ascii(output, "test", "rose-1-ultra", "a" * 64, source)
    finally:
        sys.setprofile(None)
    assert calls["load_rag_index"] >= 2 and calls["load_trace_dataset"] >= 2
    assert calls["load_rose_trace"] == calls["embed_rag_texts"] == 0
    new_world, retriever = load_native(output, "test", "rose-1-ultra", "a" * 64)
    new_rag = retriever.loaded
    assert tuple(canonical_json_bytes(t) for t in new_rag.transitions) == tuple(
        canonical_json_bytes(t) for t in original_rag.transitions
    )
    assert tuple(canonical_json_bytes(v) for v in new_rag.vectors) == tuple(
        canonical_json_bytes(v) for v in original_rag.vectors
    )
    new_dataset = load_trace_dataset(store, new_rag.index.sources[0].artifact_input.artifact_id)
    assert canonical_json_bytes(new_dataset.traces[0]) == canonical_json_bytes(trace)
    assert new_dataset.traces[0].source.identity == trace.source.identity
    assert new_dataset.dataset.dataset_id != dataset.dataset_id
    assert (
        new_rag.index.rag_id != original_rag.index.rag_id and new_world.world_model_id != world.artifact.world_model_id
    )
    assert new_world.serving_rag == artifact_input(new_rag.manifest)
    assert new_rag.manifest.inputs == (artifact_input(store.read(new_dataset.dataset.dataset_id).manifest),)
    assert result["exclusions"] == pointer["exclusions"] and result["redactions"] == pointer["redactions"]
    assert all(dict(store.read(identity).payloads) == original_bytes[identity] for identity in original_ids)
    assert store.read_bytes(new_dataset.dataset.dataset_id, new_dataset.dataset.traces_path).isascii()
    assert store.read_bytes(new_rag.index.rag_id, new_rag.index.transitions_path).isascii()
    bound = json.loads((output / "conformance.native.json").read_text())
    assert len(bound["examples"]) == 2 and bound["native_world_model_id"] == new_world.world_model_id
    examples[0]["latest_receipt"] = "rebound on idempotent republication"
    suite_path = source / "conformance.json"
    suite_path.write_text(json.dumps({"status": "passed", "requested_examples": 2, "examples": examples}))
    assert (
        building.republish_ascii(output, "test", "rose-1-ultra", "a" * 64)["world_model_id"] == new_world.world_model_id
    )
    assert (
        json.loads((output / "conformance.native.json").read_text())["examples"][0]["latest_receipt"]
        == examples[0]["latest_receipt"]
    )
    suite_bytes = suite_path.read_bytes()
    native_suite = output / "conformance.native.json"
    native_bytes = native_suite.read_bytes()
    suite_path.unlink()
    native_suite.unlink()
    with pytest.raises(ValueError, match="requires a complete conformance suite"):
        building.republish_ascii(output, "test", "rose-1-ultra", "a" * 64)
    assert json.loads(pointer_path.read_text()) == result
    suite_path.write_bytes(suite_bytes)
    native_suite.write_bytes(native_bytes)
    bad_values = new_world.model_dump(mode="json")
    bad_values["prompt_sha256"] = "0" * 64
    bad_values["world_model_id"] = stable_id(
        "grounded-world-model",
        grounded_world_model_content(
            serving_rag=new_world.serving_rag,
            model_alias=new_world.model_alias,
            model=new_world.model,
            prompt_version=new_world.prompt_version,
            prompt_sha256=bad_values["prompt_sha256"],
            top_k=new_world.top_k,
            code_revision=new_world.code_revision,
        ),
    )
    bad_world = GroundedWorldModelArtifact.model_validate(bad_values)
    bad_manifest = store.write(
        artifact_id=bad_world.world_model_id,
        artifact_type="grounded-world-model",
        envelope=bad_world,
        files={"world-model.json": canonical_json_bytes(bad_world)},
    )
    bad_pointer = {
        **result,
        "world_model_id": bad_world.world_model_id,
        "world_model_manifest_sha256": artifact_input(bad_manifest).sha256,
    }
    pointer_path.write_text(json.dumps(bad_pointer))
    with pytest.raises(ValueError, match="prompt digest differs"):
        building.republish_ascii(output, "test", "rose-1-ultra", "a" * 64)
    assert json.loads(pointer_path.read_text()) == bad_pointer
    pointer_path.write_text(json.dumps(result))
    with project_connection(store.paths.root, write=True) as connection:
        connection.execute(
            "UPDATE project_artifact_files SET payload=? WHERE project_id=? AND artifact_id=? AND path=?",
            (b"corrupted source", "test", new_dataset.dataset.dataset_id, "traces.jsonl"),
        )
    with pytest.raises(ArtifactCorruptionError):
        building.republish_ascii(output, "test", "rose-1-ultra", "a" * 64)
    assert json.loads(pointer_path.read_text()) == result


def test_upstream_secret_boundary_redacts_before_artifact_publication(tmp_path):
    from exp.common.core.artifacts import assert_secret_free

    from benchmarks.build_experiential_world_model import build, redact_archive

    safe, count = redact_archive(
        {
            "task": "Use sk-exampleCredentialOnlyForUnitTests",
            "password": "unit-test-value",
            "contact": "founder@example.test",
        }
    )
    assert count >= 2 and "password" not in safe and safe["contact"] == "founder@example.test"
    assert_secret_free(safe)
    source = _source_fixture(tmp_path)
    otel = source / "otel/real-root.otel.jsonl"
    raw = otel.read_text().replace("Original source goal", "Use sk-exampleCredentialOnlyForUnitTests")
    otel.write_text(raw)
    pointer = build(source, tmp_path / "native", "rose-test", "rose-1-ultra", "a" * 64)
    assert pointer["observations"] == 2 and pointer["redactions"][0]["redaction_count"] >= 2
    assert "sk-exampleCredentialOnlyForUnitTests" in otel.read_text()


def test_native_loader_rejects_valid_manifest_with_forged_content_identity(tmp_path):
    from exp.common.core.artifacts import canonical_json_bytes
    from exp.common.project import ArtifactStore, ProjectPaths, artifact_input
    from exp.simulation.world_model.artifact import GroundedWorldModelArtifact

    from benchmarks.build_experiential_world_model import build
    from benchmarks.serve_experiential_world_model import load_native

    output = tmp_path / "native"
    pointer = build(_source_fixture(tmp_path), output, "rose-test", "rose-1-ultra", "a" * 64)
    store = ArtifactStore(ProjectPaths(output / "experiential", "rose-test"))
    original = GroundedWorldModelArtifact.model_validate_json(
        store.read_bytes(pointer["world_model_id"], "world-model.json")
    )
    fake_id = "grounded-world-model-" + "f" * 20
    bad = original.model_copy(update={"world_model_id": fake_id})
    _, manifest = store.write_or_replay(
        artifact_id=fake_id,
        artifact_type="grounded-world-model",
        envelope=bad,
        envelope_path="world-model.json",
        envelope_type=GroundedWorldModelArtifact,
        files={"world-model.json": canonical_json_bytes(bad)},
    )
    pointer["world_model_id"] = fake_id
    pointer["world_model_manifest_sha256"] = artifact_input(manifest).sha256
    (output / "models/rose-test/experiential.json").write_text(json.dumps(pointer))
    with pytest.raises(ValueError, match="artifact ID differs"):
        load_native(output, "rose-test", "rose-1-ultra", "a" * 64)


def test_encoded_canonical_credentials_are_redacted_before_any_artifact_write(tmp_path):
    from exp.common.project import ArtifactStore, ProjectPaths

    from benchmarks.build_experiential_world_model import build
    from benchmarks.serve_experiential_world_model import load_native

    source = _source_fixture(tmp_path)
    otel = source / "otel/real-root.otel.jsonl"
    rows = [json.loads(line) for line in otel.read_text().splitlines()]
    for row in rows:
        for attribute in row["attributes"]:
            if attribute["key"] == "gen_ai.tool.call.arguments":
                action = json.loads(attribute["value"]["stringValue"])
                action["arguments"]["password"] = "unit-test-value"
                attribute["value"]["stringValue"] = json.dumps(action)
    otel.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
    output = tmp_path / "native"
    pointer = build(source, output, "rose-test", "rose-1-ultra", "a" * 64)
    assert pointer["observations"] == 2 and pointer["redactions"][0]["redaction_count"] >= 2
    assert "unit-test-value" in otel.read_text()
    artifact, retriever = load_native(output, "rose-test", "rose-1-ultra", "a" * 64)
    store = ArtifactStore(ProjectPaths(output / "experiential", "rose-test"))
    assert retriever.loaded.manifest.inputs
    payloads = [store.read_bytes(item.artifact_id, "traces.jsonl") for item in retriever.loaded.manifest.inputs]
    payloads.append(store.read_bytes(artifact.serving_rag.artifact_id, "transitions.jsonl"))
    assert all(b"unit-test-value" not in payload for payload in payloads)


def test_native_http_boundary_shares_root_world_and_keeps_retry_receipts():
    import httpx

    from benchmarks.serve_experiential_world_model import create_app

    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def complete(request):
            nonlocal calls
            calls += 1
            if calls == 2:
                entered.set()
            await release.wait()
            e = json.loads(request.messages[1].content)
            state = deepcopy(e["environment_state"])
            state[e["candidate_response"]["tool_calls"][0]["call_id"]] = True
            return reply(request, state)

        model = ParallelWorldModel(complete, Retriever())
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app("rose", model)), base_url="http://wmh"
        ) as http:
            first = (
                await http.post(
                    "/world_models/rose/sessions",
                    json={"task": "Root goal", "seed_state": {"known": True}, "session_scope_id": "root"},
                )
            ).json()["session_id"]
            second = (
                await http.post(
                    "/world_models/rose/sessions",
                    json={"task": "Child goal", "seed_state": {}, "session_scope_id": "root"},
                )
            ).json()["session_id"]
            assert first == second
            url = f"/world_models/rose/sessions/{first}/step"
            tasks = [
                asyncio.create_task(
                    http.post(url, json={"action": action(n)}, headers={"X-Rose-WMH-Invocation": f"inv-{n}"})
                )
                for n in (1, 2, 1)
            ]
            await asyncio.wait_for(entered.wait(), 2)
            release.set()
            responses = await asyncio.gather(*tasks)
            assert all(r.status_code == 200 for r in responses) and calls == 3
            state = (await http.get(f"/world_models/rose/sessions/{first}")).json()
            assert state["state"] == {"known": True, "call-1": True, "call-2": True} and len(state["history"]) == 2
            assert (await http.delete(f"/world_models/rose/sessions/{first}")).status_code == 200
            assert not model.sessions

    asyncio.run(run())


@pytest.mark.parametrize("policy_name", ["rose-virtual-public-affordances-v1", "rose-virtual-public-affordances-v2"])
def test_versioned_execution_overlay_precedes_public_packing_and_survives_repair(policy_name, monkeypatch):
    from dataclasses import replace

    import httpx
    from exp.simulation.engines.text.prompt import WORLD_MODEL_TEXT_SYSTEM_PROMPT

    from benchmarks import wmh_execution_policy
    from benchmarks.serve_experiential_world_model import create_app
    from benchmarks.wmh_execution_policy import execution_identity, execution_policy

    async def run():
        requests = []
        records = []
        identity = execution_identity(policy_name, "artifact-a", "a" * 64)

        async def complete(request):
            requests.append(request)
            if len(requests) == 1:
                return "invalid JSON"
            # This fixture verifies plumbing only, not model-semantic behavior.
            return reply(request, {"unknown_product": None, "funds_cents": 0}, "missing required product field")

        with pytest.raises(ValueError, match="artifact-bound execution identity"):
            ParallelWorldModel(complete, Retriever(), execution_policy=policy_name)
        assert requests == []
        model = ParallelWorldModel(
            complete,
            Retriever(),
            execution_policy=policy_name,
            execution_identity=identity,
            record_prediction=records.append,
        )
        session = model.new_session("full root goal", {"unknown_product": None, "funds_cents": 0}, "root")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app("test", model, identity={"execution_identity": identity})),
            base_url="http://fixture",
        ) as client:
            health = (await client.get("/healthz")).json()
            result = await model.step(session.id, action(1), "invocation")
            receipt = await model.end_session(session.id)
        expected = WORLD_MODEL_TEXT_SYSTEM_PROMPT + "\n\n" + execution_policy(policy_name).text
        assert len(requests) == 2 and all(r.messages[0].content == expected for r in requests)
        assert len({r["request_sha256"] for r in records}) == 2
        # An overlay must be counted before packing/admission, not appended after it.
        from exp.common.models import ModelCapabilities
        from exp.simulation.engines.text.tokens import Utf8UpperBoundTokenCounter
        from exp.simulation.world_model.runtime import WorldModelCapacityError

        baseline_request = requests[0].model_copy(
            update={
                "messages": (
                    requests[0].messages[0].model_copy(update={"content": WORLD_MODEL_TEXT_SYSTEM_PROMPT}),
                    *requests[0].messages[1:],
                )
            }
        )
        assert execution_policy("upstream").apply(baseline_request) is baseline_request
        assert execution_policy("rose-virtual-public-affordances-v1").metadata() == {
            "policy_id": "rose-virtual-public-affordances-v1",
            "policy_version": "1",
            "policy_sha256": "49d9d1f0430a5d8ee6aaaff9dd8783075a857b9c171e76ebe620a22e9ec7ba79",
            "base_system_sha256": "acae5f4de354cbd8e0e4753bbbf913a1100b8eeeb7af9ba84ed47f513d1b75ce",
            "effective_system_sha256": "fcb2596385c9456e62d6e21f3fe1ac6b64b693e833c3e4bb0a78e1f4fe21007f",
        }
        if policy_name == "rose-virtual-public-affordances-v2":
            assert execution_policy(policy_name).text.startswith(
                execution_policy("rose-virtual-public-affordances-v1").text + "\n\n"
            )
            assert len(execution_policy(policy_name).text.split("\n\n")) == 8
        capacity = Utf8UpperBoundTokenCounter().count(baseline_request) + baseline_request.maximum_output_tokens
        rejected_calls = []

        async def forbidden(request):
            rejected_calls.append(request)
            return reply(request, {})

        bounded = ParallelWorldModel(
            forbidden,
            Retriever(),
            capabilities=ModelCapabilities(maximum_output_tokens=16384, context_window_tokens=capacity),
            execution_policy=policy_name,
            execution_identity=identity,
        )
        bounded_session = bounded.new_session("full root goal", {"unknown_product": None, "funds_cents": 0}, "root")
        with pytest.raises(WorldModelCapacityError):
            await bounded.step(bounded_session.id, action(1), "invocation")
        assert rejected_calls == []
        assert json.loads(requests[0].messages[1].content)["candidate_response"] == action_from_canonical(
            action(1)
        ).model_dump(mode="json", exclude_none=True)
        assert (
            health["execution_identity"]
            == result["metadata"]["execution_identity"]
            == receipt["execution_identity"]
            == identity
        )
        assert all(r["execution_identity"] == identity for r in records)
        assert model.audit[-1]["execution_identity"] == identity
        assert receipt["state"] == {"unknown_product": None, "funds_cents": 0}
        assert all(r["request"]["messages"][0]["content"] == expected for r in records)
        with pytest.raises(ValueError, match="Unknown WMH execution policy"):
            execution_policy("unknown")
        for registered_name in ("upstream", "rose-virtual-public-affordances-v1", "rose-virtual-public-affordances-v2"):
            original_policy = execution_policy(registered_name)
            for changed_field in (
                {"name": "unregistered"},
                {"version": "changed"},
                {"text": original_policy.text + " changed"},
                {"effective_system_sha256": "0" * 64},
            ):
                with monkeypatch.context() as patcher:
                    patcher.setitem(
                        wmh_execution_policy._POLICIES, registered_name, replace(original_policy, **changed_field)
                    )
                    with pytest.raises(ValueError, match="without a new version"):
                        execution_policy(registered_name)
                    with pytest.raises(ValueError, match="without a new version"):
                        execution_identity(registered_name, "artifact-a", "a" * 64)

    asyncio.run(run())


def test_retirement_no_ack_after_cancelled_writer_owner():
    import threading
    async def run():
        ready = asyncio.Event()
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        async def complete(request):
            ready.set()
            await asyncio.Event().wait()
        def writer(record):
            entered.set(); release.wait(5); finished.set()
        model = ParallelWorldModel(complete, Retriever(), record_prediction=writer,
            execution_identity=json.loads(__import__("pathlib").Path(__file__).with_name("retirement_control_identity.json").read_text())["execution_identity"], execution_policy=json.loads(__import__("pathlib").Path(__file__).with_name("retirement_control_identity.json").read_text())["execution_identity"]["policy_id"])
        session = model.new_session("ownership control", {"scratchpad": "", "structured": {}})
        caller = asyncio.create_task(model.step(session.id, action(901), "inner-cancel"))
        await ready.wait()
        owned = next(iter(session.receipts.values()))[1]
        owned.cancel()
        while not entered.is_set(): await asyncio.sleep(.001)
        try:
            for task in asyncio.all_tasks():
                if getattr(task.get_coro(), "__name__", "") == "to_thread": task.cancel()
            await asyncio.gather(caller, return_exceptions=True)
            receipt = None
            try: receipt = await model.end_session(session.id)
            except RuntimeError: pass
            assert receipt is None or (finished.is_set() and owned.done()), "Verified ACK before durable writer finished"
        finally:
            release.set()
            await asyncio.gather(caller, return_exceptions=True)
    asyncio.run(run())


def test_retirement_retains_writer_error_after_receipt_removal():
    async def run():
        ready = asyncio.Event()
        async def complete(request):
            ready.set(); await asyncio.Event().wait()
        def writer(record): raise OSError("controlled durable writer failure")
        model = ParallelWorldModel(complete, Retriever(), record_prediction=writer,
            execution_identity=json.loads(__import__("pathlib").Path(__file__).with_name("retirement_control_identity.json").read_text())["execution_identity"], execution_policy=json.loads(__import__("pathlib").Path(__file__).with_name("retirement_control_identity.json").read_text())["execution_identity"]["policy_id"])
        session = model.new_session("ownership control", {"scratchpad": "", "structured": {}})
        caller = asyncio.create_task(model.step(session.id, action(900), "writer-error"))
        await ready.wait()
        owned = next(iter(session.receipts.values()))[1]; owned.cancel()
        await asyncio.gather(caller, return_exceptions=True)
        assert owned.done() and not session.receipts
        with pytest.raises(RuntimeError, match="durability"): await model.end_session(session.id)
        assert session.id not in model.retired
    asyncio.run(run())


import pathlib, threading
from concurrent.futures import ThreadPoolExecutor
from benchmarks import experiential_world_model as m
from benchmarks.wmh_native_prediction_writer import NativePredictionWriter
_V3I=json.loads((pathlib.Path(__file__).with_name('retirement_control_identity.json')).read_text())['execution_identity']
def _v3_model(c=None,r=None,**kw):return m.ParallelWorldModel(c,r,execution_policy=_V3I['policy_id'],execution_identity=_V3I,**kw)
class _V3R:
 def retrieve(self,q):return ()
def _v3_action(n):return {'kind':'tool_call','name':'rose.browser.spawn_browser_agent','arguments':{'schema':'rose.canonical_action.v1','category':'browser','name':'spawn_browser_agent','arguments':{'goal':'PRIVATE'},'tool_call_id':f'call-{n}','timestamp_ms':0}}
async def _v3_main():
 results=[]
 # Close drains later sessions and executor even if first publisher fails.
 owner=None;bad=None;published=[]
 def publish(r):
  if r['session_id']==bad:raise OSError('controlled publisher failure')
  published.append(r['session_id']);return r
 owner=_v3_model(record_retirement=publish,load_retirement=lambda r:r);a=owner.new_session('PRIVATE',{},'a');b=owner.new_session('PRIVATE',{},'b');bad=a.id
 for _ in range(2):
  try:await owner.close()
  except m.NativeDurabilityError:pass
  else:raise AssertionError('close swallowed publication error')
 assert owner._owned_executor is None and b.id in owner.retired and published==[b.id] and a.durability_failed
 try:owner.new_session('LATE',{},'late')
 except ValueError:pass
 else:raise AssertionError('close admission reopened')
 results.append('failedpublisher_multi_session_repeated_close_executor_drained PASS')
 # Queued required writer proxy cancellation must fail closed before execution.
 ready=asyncio.Event();block=threading.Event();entered=threading.Event();proxies=[];original=asyncio.wrap_future
 async def complete(q):ready.set();await asyncio.Event().wait()
 writer=NativePredictionWriter(_V3O/'queued-store',_V3I['base_world_model_id'],_V3I['base_protocol_sha256']);owner=_v3_model(complete,_V3R(),record_prediction=writer);a=owner.new_session('PRIVATE',{})
 call=asyncio.create_task(owner.step(a.id,_v3_action(1),'queued'));await ready.wait();owner._owned_executor.shutdown(wait=True);owner._owned_executor=ThreadPoolExecutor(max_workers=1)
 def busy():entered.set();block.wait(10)
 seed=owner._owned_executor.submit(busy)
 while not entered.is_set():await asyncio.sleep(.001)
 def wrap(f,*a,**kw):p=original(f,*a,**kw);proxies.append(p);return p
 asyncio.wrap_future=wrap;native=next(iter(a.receipts.values()))[1];native.cancel()
 while not proxies:await asyncio.sleep(.001)
 proxies[-1].cancel();await asyncio.gather(call,return_exceptions=True);asyncio.wrap_future=original;block.set();seed.result()
 assert a.durability_failed and not list((_V3O/'queued-store').rglob('*.json'))
 try:await owner.end_session(a.id)
 except m.NativeDurabilityError:pass
 else:raise AssertionError('queued writer failure ACK')
 try:await owner.close()
 except m.NativeDurabilityError:pass
 assert owner._owned_executor is None;results.append('actualstep_queued_proxy_canceled_writer_no_execution_no_ACK PASS')
 # Actual-step selection writer; repeated cancellation means no commit/sample reroll.
 entered,release=threading.Event(),threading.Event();writes=[];draws=[]
 async def response(req):
  cid=json.loads(req.messages[1].content)['candidate_response']['tool_calls'][0]['call_id']
  return json.dumps({'schema':'rose.wmh_timed_outcome_distribution.v1','outcomes':[{'probability':1.0,'description':'private control','elapsed_ms':0,'id':'privatecontrol','tool_results':[{'call_id':cid,'content':'CONTROL','is_error':False}],'state_patch':[]}]})
 real=NativePredictionWriter(_V3O/'selection-store',_V3I['base_world_model_id'],_V3I['base_protocol_sha256'])
 def writer(record):
  if record['schema']=='rose.wmh_outcome_selection.v1':entered.set();release.wait(10)
  real(record);writes.append(record['schema'])
 def draw():draws.append(1);return .5
 owner=_v3_model(response,_V3R(),record_prediction=writer,sample_uniform=draw);a=owner.new_session('PRIVATE',{},'selection');b=owner.new_session('PRIVATE',{},'other');call=asyncio.create_task(owner.step(a.id,_v3_action(2),'select'))
 for _ in range(5000):
  if entered.is_set() or call.done():break
  await asyncio.sleep(.001)
 assert entered.is_set(),str(await call) if call.done() else 'selection not reached'
 native=next(iter(a.receipts.values()))[1];native.cancel();await asyncio.sleep(.01);native.cancel();await asyncio.sleep(.01);assert not native.done();release.set();await asyncio.gather(call,return_exceptions=True)
 receipt=await owner.end_session(a.id);assert receipt['join_verified'] and a.revision==0 and len(draws)==1 and writes.count('rose.wmh_outcome_selection.v1')==1 and not b.closed;await owner.close();results.append('actualstep_selection_repeated_cancel_one_draw_no_commit_other_scope_preserved PASS')
 (_V3O/'new-controls-result.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
def test_v3_retirement_ownership_contracts(tmp_path):
 global _V3O
 _V3O=tmp_path
 asyncio.run(_v3_main())

from benchmarks.wmh_execution_policy import execution_identity
from benchmarks.build_experiential_world_model import atomic_json
def _extra_model(**kw):return m.ParallelWorldModel(None,None,execution_policy=_V3I['policy_id'],execution_identity=_V3I,**kw)
async def _extra_main():
 out=[]
 # Attack the asyncio proxy while the actual executor future is running.
 entered,release,finished=threading.Event(),threading.Event(),threading.Event();proxies=[];original=asyncio.wrap_future
 def wrapped(f,*a,**kw):p=original(f,*a,**kw);proxies.append(p);return p
 def writer(d):entered.set();release.wait(10);finished.set()
 owner=_extra_model(record_prediction=writer);asyncio.wrap_future=wrapped
 task=asyncio.create_task(owner._owned_thread_call(writer,{}))
 while not entered.is_set():await asyncio.sleep(.001)
 proxies[-1].cancel();await asyncio.sleep(.01);task.cancel();await asyncio.sleep(.01);proxies[-1].cancel();await asyncio.sleep(.01)
 assert not task.done() and not finished.is_set();release.set()
 try:await task
 except asyncio.CancelledError:pass
 assert finished.is_set();asyncio.wrap_future=original;await owner.close();out.append('actual_concurrent_future_proxy_and_repeated_outer_cancel PASS')
 # Real durable retirement publication, repeated owner cancellation, no duplicate publication.
 entered,release=threading.Event(),threading.Event();writes=[]
 def publisher(r):entered.set();release.wait(10);path=_EXTRAO/'publisher-store'/('receipt.json');atomic_json(path,r);writes.append(path);return path
 owner=_extra_model(record_retirement=publisher,load_retirement=lambda p:json.loads(p.read_text()));session=owner.new_session('PRIVATE',{},'publisher')
 caller=asyncio.create_task(owner.end_session(session.id))
 while not entered.is_set():await asyncio.sleep(.001)
 session.retirement.cancel();await asyncio.sleep(.01);session.retirement.cancel();await asyncio.sleep(.01);assert not session.retirement.done();release.set()
 await asyncio.gather(caller,return_exceptions=True);receipt=await owner.end_session(session.id);assert receipt['join_verified'] and len(writes)==1;await owner.close();out.append('actual_atomic_publisher_repeated_cancel_single_publication PASS')
 def fail(r):raise OSError('controlled publication failure')
 owner=_extra_model(record_retirement=fail,load_retirement=lambda p:None);session=owner.new_session('PRIVATE',{},'failedpublisher')
 try:await owner.end_session(session.id)
 except m.NativeDurabilityError:pass
 else:raise AssertionError('failed publisher ACK')
 assert session.durability_failed and session.id not in owner.retired
 owner._owned_executor.shutdown(wait=True);out.append('publisher_failure_retained_no_ACK PASS')
 # Actual step retrieval cancellation, unrelated session isolation.
 entered,release=threading.Event(),threading.Event()
 class Retriever:
  def retrieve(self,q):entered.set();release.wait(10);return ()
 owner=m.ParallelWorldModel(None,Retriever(),execution_policy=_V3I['policy_id'],execution_identity=_V3I);a=owner.new_session('PRIVATE',{},'A');b=owner.new_session('PRIVATE',{},'B')
 action={'kind':'tool_call','name':'rose.browser.spawn_browser_agent','arguments':{'schema':'rose.canonical_action.v1','category':'browser','name':'spawn_browser_agent','arguments':{'goal':'privatecontrol'},'agent_id':'child','tool_call_id':'privatecall','timestamp_ms':0}}
 call=asyncio.create_task(owner.step(a.id,action,'retrieve'))
 while not entered.is_set():await asyncio.sleep(.001)
 task=next(iter(a.receipts.values()))[1];task.cancel();await asyncio.sleep(.01);task.cancel();await asyncio.sleep(.01);assert not task.done();release.set();await asyncio.gather(call,return_exceptions=True)
 receipt=await owner.end_session(a.id);assert receipt['join_verified'] and b.id in owner.sessions and not b.closed and a.revision==0;await owner.close();out.append('actual_step_retrieval_repeated_cancel_other_session_isolation PASS')
 # Source default absence and false remain ordinary thread calls, no new executor.
 for identity in [None,execution_identity(_V3I['policy_id'],_V3I['base_world_model_id'],_V3I['base_world_model_manifest_sha256'],runtime_config={**_V3I['runtime_config'],'validation_recovery':False})]:
  owner=m.ParallelWorldModel(None,None,**({'execution_policy':_V3I['policy_id'],'execution_identity':identity} if identity else {}));assert await owner._owned_thread_call(lambda:42)==42 and not hasattr(owner,'_owned_executor');await owner.close()
 out.append('absent_false_no_owned_executor PASS');(_EXTRAO/'extra-controls-result.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))

def test_final_five_extra_controls(tmp_path):
 global _EXTRAO
 _EXTRAO=tmp_path
 asyncio.run(_extra_main())


def test_final_close_proxy_public_waiter_and_fence_order(monkeypatch):
    async def run():
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        fences, writes, proxies = [], [], []
        first = None
        def publisher(receipt):
            if receipt['session_id'] == first:
                entered.set(); release.wait(5); finished.set()
            writes.append(receipt['session_id']); return receipt
        owner = _v3_model(record_retirement=publisher, load_retirement=lambda r:r)
        a=owner.new_session('PRIVATE',{},'first'); b=owner.new_session('PRIVATE',{},'second'); first=a.id
        async def fence(sid):
            fences.append(sid); return {'session_id':sid,'join_verified':True}
        owner.retire_provider=fence
        original=asyncio.gather
        def gather(*tasks,**kw):
            proxy=original(*tasks,**kw); proxies.append(proxy); return proxy
        monkeypatch.setattr(asyncio,'gather',gather)
        waiter=asyncio.create_task(owner.close())
        while not entered.is_set() or b.id not in fences: await asyncio.sleep(.001)
        actual=owner._close_owner
        waiter.cancel()
        await original(waiter,return_exceptions=True)
        assert not actual.done() and not finished.is_set()
        proxies[0].cancel(); actual.cancel(); await asyncio.sleep(.01); actual.cancel()
        # A separate loop task progresses while actual owners remain blocked.
        ticks=[]
        for _ in range(10): ticks.append(1); await asyncio.sleep(.001)
        assert len(ticks)==10 and not actual.done() and not finished.is_set()
        release.set(); await original(actual,return_exceptions=True)
        await owner.close()
        assert finished.is_set() and sorted(writes)==sorted([a.id,b.id])
        assert owner._owned_executor is None and not owner.sessions
    asyncio.run(run())


def test_final_close_owner_cancelled_before_start():
    async def run():
        owner=_v3_model(); a=owner.new_session('PRIVATE',{},'beforestart')
        owner._closing=True
        first=owner._close_owner=asyncio.create_task(owner._close_owned()); first.cancel()
        await asyncio.gather(first,return_exceptions=True)
        await asyncio.gather(owner.close(),owner.close())
        assert owner._close_owner is not first and owner._close_owner.done()
        assert a.id in owner.retired and not owner.sessions
        with pytest.raises(ValueError): owner.new_session('LATE',{})
    asyncio.run(run())


def test_final_shutdown_error_preserves_session_error_and_owner():
    async def run(prior):
        class Executor(ThreadPoolExecutor):
            def shutdown(self,*args,**kwargs):
                super().shutdown(*args,**kwargs)
                raise OSError('controlled shutdown failure')
        def publisher(receipt):
            if prior: raise OSError('controlled first session failure')
            return receipt
        owner=_v3_model(record_retirement=publisher,load_retirement=lambda r:r)
        executor=owner._owned_executor=Executor(); a=owner.new_session('PRIVATE',{})
        errors=[]
        for _ in range(2):
            try: await owner.close()
            except BaseException as error: errors.append(error)
            else: raise AssertionError('shutdown error erased')
        assert owner._owned_executor is executor and errors[0] is errors[1]
        if prior:
            assert isinstance(errors[0],m.NativeDurabilityError)
            assert isinstance(errors[0].__cause__,OSError) and 'shutdown' in str(errors[0].__cause__)
            assert a.durability_failed and a.id not in owner.retired
        else:
            assert isinstance(errors[0],OSError) and 'shutdown' in str(errors[0])
            assert a.id in owner.retired
        assert all(not thread.is_alive() for thread in executor._threads)
    asyncio.run(run(True)); asyncio.run(run(False))


def test_final_actual_selection_writer_error(tmp_path):
    async def run():
        draws=[]
        async def response(request):
            cid=json.loads(request.messages[1].content)['candidate_response']['tool_calls'][0]['call_id']
            return json.dumps({'schema':'rose.wmh_timed_outcome_distribution.v1','outcomes':[{'probability':1.0,'description':'private control','elapsed_ms':0,'id':'privatecontrol','tool_results':[{'call_id':cid,'content':'CONTROL','is_error':False}],'state_patch':[]}]})
        real=NativePredictionWriter(tmp_path,_V3I['base_world_model_id'],_V3I['base_protocol_sha256'])
        def writer(record):
            if record['schema']=='rose.wmh_outcome_selection.v1': raise OSError('controlled selection writer failure')
            real(record)
        def draw(): draws.append(1); return .5
        owner=_v3_model(response,_V3R(),record_prediction=writer,sample_uniform=draw)
        a=owner.new_session('PRIVATE',{})
        with pytest.raises(m.NativeDurabilityError): await owner.step(a.id,_v3_action(3),'selection-error')
        assert a.durability_failed and not a.receipts and a.revision==0 and len(draws)==1
        with pytest.raises(m.NativeDurabilityError): await owner.end_session(a.id)
        assert a.id not in owner.retired
        with pytest.raises(m.NativeDurabilityError): await owner.close()
        assert owner._owned_executor is None
    asyncio.run(run())


def test_retirement_joins_actual_writer_beyond_original_ten_second_window(tmp_path):
    async def run():
        ready = asyncio.Event()
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        writes = []
        writer = NativePredictionWriter(tmp_path, _V3I['base_world_model_id'], _V3I['base_protocol_sha256'])
        async def complete(request):
            ready.set()
            await asyncio.Event().wait()
        def record(row):
            entered.set()
            release.wait(30)
            writer(row)
            writes.append(row['prediction_id'])
            finished.set()
        owner = _v3_model(complete, _V3R(), record_prediction=record)
        session = owner.new_session('PRIVATE writer ownership', {}, 'finite-writer-contract')
        caller = asyncio.create_task(owner.step(session.id, _v3_action(999), 'finite-writer'))
        await ready.wait()
        operation = next(iter(session.receipts.values()))[1]
        async def release_writer():
            await asyncio.sleep(11)
            release.set()
        releaser = asyncio.create_task(release_writer())
        receipt, error = None, None
        try:
            receipt = await owner.end_session(session.id)
        except Exception as exc:
            error = exc
        observed = (finished.is_set(), len(writes), operation.done(), bool(receipt and receipt.get('join_verified')))
        await releaser
        await asyncio.gather(caller, return_exceptions=True)
        await owner.close()
        assert observed == (True, 1, True, True), (observed, repr(error))
        assert session.revision == 0 and not session.receipts
    asyncio.run(run())


def _measured_source_fixture(tmp_path):
    """Two real calls: one with measured clocks (2m 14s), one exported without clocks."""
    source = _source_fixture(tmp_path)
    otel = next((source / "otel").iterdir())
    spans = [json.loads(line) for line in otel.read_text().splitlines()]
    for span in spans:
        if span["spanId"] == "obs-1":
            span["attributes"] += [
                {"key": "rose.tool.started_at_ms", "value": {"intValue": "1787537754364"}},
                {"key": "rose.tool.completed_at_ms", "value": {"intValue": str(1787537754364 + 134_000)}},
            ]
    otel.write_text("\n".join(json.dumps(s) for s in spans) + "\n")
    return source


def test_demo_renders_the_real_measured_tool_duration_not_the_ingest_ordinals(tmp_path):
    from exp.common.core.artifacts import canonical_json_bytes
    from exp.simulation.engines.text.prompt import build_world_model_request
    from exp.simulation.retrieval import RAGMatch, RAGTransition

    from benchmarks.build_experiential_world_model import build
    from benchmarks.serve_experiential_world_model import load_native

    digest = "a" * 64
    build(_measured_source_fixture(tmp_path), tmp_path / "native", "rose-test", "rose-1-ultra", digest)
    _, retriever = load_native(tmp_path / "native", "rose-test", "rose-1-ultra", digest)
    by_span = {t.action_span_id: t for t in retriever.loaded.transitions}
    # Ingest rewrites span clocks to microsecond ordinals; the measured duration survives.
    assert by_span["action-1"].elapsed_ms == 134_000
    assert by_span["action-2"].elapsed_ms is None
    # An unmeasured record keeps the pre-duration wire shape, so older corpora load unchanged.
    unmeasured = canonical_json_bytes(by_span["action-2"])
    assert b"elapsed" not in unmeasured
    assert RAGTransition.model_validate_json(unmeasured) == by_span["action-2"]

    task = _task_for_request()
    request = build_world_model_request(
        task,
        visible_messages=(),
        candidate_response=action_from_canonical(action(3)),
        grounded_examples=tuple(RAGMatch(transition=t, score=1.0) for t in (by_span["action-1"], by_span["action-2"])),
        maximum_output_tokens=1024,
    )
    examples = {e["transition_id"]: e for e in json.loads(request.messages[1].content)["grounded_examples"]}
    measured = examples[by_span["action-1"].transition_id]
    assert measured["elapsed"] == "2m 14s" and measured["elapsed_ms"] == 134_000
    assert set(measured) >= {"action", "observation", "elapsed"}
    assert not {"elapsed", "elapsed_ms"} & set(examples[by_span["action-2"].transition_id])


def _task_for_request():
    from exp.common.tasks import TaskCase

    from benchmarks.experiential_world_model import canonical_tool_schema

    return TaskCase(
        task_id="task-duration",
        lineage_group_id="lineage-current",
        partition="held_out",
        instruction="Research",
        initial_context={},
        tools=(canonical_tool_schema(action(3)["name"]),),
        workload_weight=1,
        source_trace_ids=("current",),
    )


def test_served_world_model_request_shows_each_demo_real_duration():
    """The actual serving path, not only the builder, places the duration beside each demo."""
    from exp.simulation.retrieval import RAGMatch, RAGTransition

    def demo(n, elapsed_ms):
        return RAGMatch(transition=RAGTransition(
            transition_id=f"example-{n}", trace_id="trace", lineage_id=f"lineage-{n}",
            action_span_id=f"action-{n}", observation_span_id=f"obs-{n}", task="Research",
            initial_context={},
            action={"kind": "tool_call", "tool_name": "rose.browser.spawn_browser_agent", "tool_arguments": {}},
            observation={"kind": "tool_result", "content": "done"},
            key_text="Research", key_sha256="a" * 64, elapsed_ms=elapsed_ms), score=1.0)

    class Examples:
        def retrieve(self, query):
            return (demo(1, 134_000), demo(2, 850), demo(3, 3_605_000), demo(4, None))

    async def run():
        requests = []

        async def complete(request):
            requests.append(request)
            return reply(request, {})

        model = ParallelWorldModel(complete, Examples())
        session = model.new_session("Research", {}, "root")
        await model.step(session.id, action(1), "inv")
        evidence = json.loads(requests[0].messages[1].content)
        rendered = {e["transition_id"]: e.get("elapsed") for e in evidence["grounded_examples"]}
        assert rendered == {"example-1": "2m 14s", "example-2": "850ms", "example-3": "1h 0m 5s", "example-4": None}


def test_v4_send_samples_a_concrete_reply_that_is_delivered_when_world_time_reaches_it():
    """Runs 13/18: replies were deferred as placeholders and never sampled or delivered."""
    from benchmarks.wmh_outcome_policy_v4_test import outcome, reply_event, send_distribution, world

    hour = 3_600_000

    async def run():
        seen = []

        async def complete(request):
            evidence = json.loads(request.messages[1].content)
            call = evidence["candidate_response"]["tool_calls"][0]
            at = call["arguments"]["timestamp_ms"]
            events = evidence["environment_state"]["structured"]["scheduled_events"]
            seen.append((at, [e["id"] for e in events]))
            due = [e["id"] for e in events if e["available_at_ms"] <= at and "delivered_at_ms" not in e]
            if len(seen) == 1:
                payload = send_distribution(event=reply_event(at=at + 2 * hour))
            else:
                payload = {
                    "schema": "rose.wmh_timed_outcome_distribution.v4",
                    "base_rates": [],
                    "outcomes": [
                        outcome(
                            "inbox", 1.0, delivered=due, elapsed=2 * hour,
                            content="1 new reply from Dana Lee" if due else "No new replies",
                        )
                    ],
                }
            for item in payload["outcomes"]:
                item["tool_results"][0]["call_id"] = call["call_id"]
            return json.dumps(payload)

        model = distribution_model(complete, policy="rose-outcome-distribution-v4", sample_uniform=lambda: 0.01)
        session = model.new_session("Pitch Dana", world(), "root")
        sent = await model.step(session.id, _timed_action(1), "send")
        assert sent["metadata"]["outcome_selection"]["selected_outcome_id"] == "delivered_reply_later"
        assert sent["metadata"]["outcome_selection"]["base_rate_results"] == {"cold_reply": True}
        early = await model.step(session.id, _timed_action(2), "check-early")
        late = await model.step(session.id, _timed_action(3), "check-late")
        assert seen[1][1] == [] and seen[2][1] == ["evt-reply-1"]
        assert early["content"] == "No new replies" and late["content"] == "1 new reply from Dana Lee"
        assert late["metadata"]["outcome_selection"]["delivered_event_ids"] == ["evt-reply-1"]
        [event] = session.state["structured"]["scheduled_events"]
        assert event["delivered_at_ms"] == late["metadata"]["world_time_ms"] >= event["available_at_ms"]
        assert event["available_at_ms"] == seen[0][0] + 2 * hour
        # Sampled at the send (elapsed 30 s); hidden at +30 s, delivered once the clock passed +2 h.
        assert seen[1][0] < event["available_at_ms"] <= seen[2][0]

    asyncio.run(run())


def test_v4_placeholder_reply_is_rejected_and_never_commits():
    from exp.simulation.engines.text.prompt import TextWorldModelProtocolError

    from benchmarks.wmh_outcome_policy_v4_test import send_distribution, world

    async def run():
        async def complete(request):
            call = json.loads(request.messages[1].content)["candidate_response"]["tool_calls"][0]
            payload = send_distribution(event={"available_at_ms": call["arguments"]["timestamp_ms"] + 1,
                                               "description": "Investor may respond; no response guaranteed"})
            for item in payload["outcomes"]:
                item["tool_results"][0]["call_id"] = call["call_id"]
            return json.dumps(payload)

        model = distribution_model(complete, policy="rose-outcome-distribution-v4", sample_uniform=lambda: 0.01)
        session = model.new_session("Pitch Dana", world(), "root")
        with pytest.raises(TextWorldModelProtocolError):
            await model.step(session.id, _timed_action(1), "send")
        assert session.revision == 0 and session.state["structured"]["scheduled_events"] == []

    asyncio.run(run())
