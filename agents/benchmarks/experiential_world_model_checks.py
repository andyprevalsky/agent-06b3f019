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
        # The conflicted slow operation now owns the next commit; a newer fast
        # operation waits for it instead of predicting against a doomed revision.
        fast = asyncio.create_task(model.step(s.id, action(2), "sms-2"))
        for _ in range(20):
            await asyncio.sleep(0)
        assert fast_revisions == [("call-1", 0)] and not fast.done()
        slow_release[1].set()
        results = await asyncio.wait_for(asyncio.gather(slow, fast), 2)
        assert slow_revisions == [0, 1] and fast_revisions == [("call-1", 0), ("call-2", 2)]
        assert [r["metadata"]["committed_revision"] for r in results] == [2, 3]
        assert s.state == {"count": 3, "order": ["call-1", "call-0", "call-2"]} and not s.contended

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
