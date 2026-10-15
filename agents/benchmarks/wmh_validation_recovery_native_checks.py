"""Actual pinned native-to-provider path; no artifact load or model calls."""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from exp.common.core.artifacts import sha256_json

from benchmarks.build_experiential_world_model import atomic_json, redact_archive
from benchmarks.experiential_world_model import ParallelWorldModel
from benchmarks.serve_experiential_world_model import native_provider_complete, native_provider_http_client
from benchmarks.wmh_execution_policy import execution_identity
from benchmarks.wmh_native_prediction_writer import NativePredictionWriter
from benchmarks.wmh_provider_capture import PrivateRejectionRecorder, close_owner, open_owner

root, port = Path(sys.argv[1]), int(sys.argv[2])
os.umask(0o077)
identity = execution_identity(
    "rose-outcome-distribution-v3",
    "artifact-a",
    "a" * 64,
    runtime_config={
        "inference_pool": "rose-1-flash",
        "inference_pool_sha256": "b" * 64,
        "azure_first": True,
        "exclude_failed_tool_examples": True,
        "validation_recovery": True,
    },
)


def attempts(session_id):
    records = [json.loads(path.read_text()) for path in (root / "native-predictions" / session_id).glob("*.json")]
    return [attempt for record in records for attempt in record.get("provider_attempts", [])]


def fixture_owner(session_id, prediction_id):
    request = {"fixture": "offline owner identity control"}
    digest = sha256_json(request)
    return digest, {
        "schema": "rose.wmh_native_prediction.v1",
        "session_id": session_id,
        "prediction_id": prediction_id,
        "request_sha256": digest,
        "execution_identity": identity,
        "call_id": "offline-fixture-call",
        "started_at_ms": time.time_ns() // 1_000_000,
        "snapshot_revision": 0,
        "state_retries": 0,
        "protocol_repair": 0,
        "request": request,
    }


class Retriever:
    def retrieve(self, query):
        return ()


async def run():
    records = []
    writer = NativePredictionWriter(root, identity["base_world_model_id"], identity["base_protocol_sha256"])

    def record(row):
        safe, redactions = redact_archive(row)
        records.append(safe)
        writer(row)

    async with native_provider_http_client(f"http://127.0.0.1:{port}", "offline-test-internal") as client:

        async def complete(session, prediction, request):
            return await native_provider_complete(client, root, identity, True, session, prediction, request)

        model = ParallelWorldModel(
            None,
            Retriever(),
            complete_scoped=complete,
            execution_policy="rose-outcome-distribution-v3",
            execution_identity=identity,
            sample_uniform=lambda: 0.5,
            record_prediction=record,
        )
        session = model.new_session("Inspect an existing source", {}, "root")
        action = {
            "kind": "tool_call",
            "name": "rose.browser.spawn_browser_agent",
            "arguments": {
                "schema": "rose.canonical_action.v1",
                "category": "browser",
                "name": "spawn_browser_agent",
                "arguments": {"goal": "Inspect source"},
                "agent_id": "actor",
                "tool_call_id": "call-1",
                "timestamp_ms": 10,
            },
        }
        result = await model.step(session.id, action, "invocation")
        assert result["content"] == "valid observed result"
        assert session.revision == len(session.history) == 1
        assert "private-rejected-marker" not in json.dumps(session.history)
        captured = attempts(session.id)
        assert len(captured) == 1
        assert captured[0]["content"] == '{"private-rejected-marker"'
        prediction_files = [
            path
            for path in (root / "native-predictions" / session.id).glob("*.json")
            if json.loads(path.read_text())["schema"] == "rose.wmh_native_prediction.v1"
        ]
        assert len(prediction_files) == 1
        final = json.loads(prediction_files[0].read_text())
        assert final["capture_pending"] is False and "response" in final and "error" not in final
        assert final["snapshot_revision"] == final["state_retries"] == final["protocol_repair"] == 0
        assert final["started_at_ms"] <= final["finished_at_ms"]
        assert sha256_json(final["request"]) == final["request_sha256"]
        assert "private-lease-marker" not in prediction_files[0].read_text()
        assert not (root / "native-provider-rejections").exists()
        assert all(
            json.loads(p.read_text())["active"] is False
            for p in (root / "native-provider-capture-owners" / session.id).glob("*.json")
        )
        assert len((root / "mock-provider-attempts.jsonl").read_text().splitlines()) == 2
        assert (await client.get("/rose_usage")).json()["total_cost_usd"] == 30
        # The original endpoint rejects unauthenticated and unowned captures before inference.
        payload = {
            "session_id": "foreign",
            "prediction_id": "foreign",
            "request_sha256": "a" * 64,
            "execution_identity": identity,
            "maximum_output_tokens": 16384,
            "messages": [{"role": "system", "content": "fixture"}, {"role": "user", "content": "{}"}],
        }
        response = await client.post("/complete", json=payload, headers={"X-Rose-Provider-Token": "wrong"})
        assert response.status_code == 401
        response = await client.post("/complete", json=payload)
        assert response.status_code == 409
        assert len((root / "mock-provider-attempts.jsonl").read_text().splitlines()) == 2
        bound_sha, bound_template = fixture_owner("bound-session", "bound-pred")
        open_owner(
            root,
            "bound-session",
            "bound-pred",
            bound_sha,
            identity,
            wire={"messages": payload["messages"], "maximum_output_tokens": 16384},
            template=bound_template,
        )
        bound = {**payload, "session_id": "bound-session", "prediction_id": "bound-pred", "request_sha256": bound_sha}
        tampered = {**bound, "messages": [{"role": "system", "content": "changed"}, {"role": "user", "content": "{}"}]}
        assert (await client.post("/complete", json=tampered)).status_code == 409
        bound_recorder = PrivateRejectionRecorder(root, sys.executable, bound)
        close_owner(root, "bound-session", "bound-pred")
        try:
            await bound_recorder({"content": "must not be admitted after closure"})
        except ValueError:
            pass
        else:
            raise AssertionError("Closed owner admitted a new writer")
        assert (await client.post("/complete", json=bound)).status_code == 409
        assert len((root / "mock-provider-attempts.jsonl").read_text().splitlines()) == 2
        # Caller cancellation retains the admitted native operation and replays it once.
        lifecycle = model.new_session("Inspect source", {}, "caller-cancel-scope")
        (root / "block-capture-session").write_text(lifecycle.id)
        caller = asyncio.create_task(model.step(lifecycle.id, action, "caller-cancel-invocation"))
        for _ in range(500):
            if (root / "blocked-writer-started").exists():
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("Exact native rejection writer did not reach barrier")
        pid = int((root / "blocked-writer-pid").read_text())
        caller.cancel()
        try:
            await caller
        except asyncio.CancelledError:
            pass
        assert lifecycle.revision == 0 and len(lifecycle.history) == 0
        assert any(
            json.loads(path.read_text())["active"] is True
            for path in (root / "native-provider-capture-owners" / lifecycle.id).glob("*.json")
        )
        # Advance only the test event-loop scheduler past an accidental HTTPX
        # default read deadline while the exact writer is held. No wall sleep,
        # timeout increase or native/world timestamp mutation is used.
        loop = asyncio.get_running_loop()
        original_loop_time = loop.time
        try:
            loop.time = lambda: original_loop_time() + 6.0
            # Another native scope retains independent ContextVar capture ownership.
            parallel = model.new_session("Inspect independent source", {}, "parallel-scope")
            assert (await model.step(parallel.id, action, "parallel-invocation"))["content"] == "valid observed result"
            assert parallel.revision == 1
            assert len(attempts(parallel.id)) == 1
            (root / "release-capture").touch()
            assert (await model.step(lifecycle.id, action, "caller-cancel-invocation"))[
                "content"
            ] == "valid observed result"
            assert lifecycle.revision == len(lifecycle.history) == 1
            assert len(attempts(lifecycle.id)) == 1
            assert all(
                json.loads(path.read_text())["active"] is False
                for path in (root / "native-provider-capture-owners" / lifecycle.id).glob("*.json")
            )
            assert not Path(f"/proc/{pid}").exists(), "Exact writer process remained after rejoin"
        finally:
            loop.time = original_loop_time

        # Retirement cancels the actual native operation while the writer is admitted.
        (root / "blocked-writer-started").unlink()
        (root / "blocked-writer-pid").unlink()
        (root / "release-capture").unlink()
        retired = model.new_session("Inspect retirement source", {}, "retirement-scope")
        (root / "block-capture-session").write_text(retired.id)

        async def retire_provider(session_id):
            response = await client.post(f"/sessions/{session_id}/retire")
            response.raise_for_status()
            return response.json()

        model.retire_provider = retire_provider
        wait_retired = asyncio.create_task(model.step(retired.id, action, "retire-invocation"))
        for _ in range(500):
            if (root / "blocked-writer-started").exists():
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("Exact retirement writer did not reach barrier")
        pid = int((root / "blocked-writer-pid").read_text())
        ending = asyncio.create_task(model.end_session(retired.id))
        await asyncio.sleep(0.05)
        assert not ending.done(), "Retirement acknowledged before exact writer joined"
        assert Path(f"/proc/{pid}").exists()
        (root / "release-capture").touch()
        retirement = await ending
        await asyncio.gather(wait_retired, return_exceptions=True)
        assert retirement["revision"] == 0 and retirement["history"] == []
        assert not Path(f"/proc/{pid}").exists(), "Retirement left writer subprocess alive"
        assert all(
            json.loads(path.read_text())["active"] is False
            for path in (root / "native-provider-capture-owners" / retired.id).glob("*.json")
        )
        assert len(attempts(retired.id)) == 1
        # Real native writer subprocess is joined when its awaiting recorder is cancelled.
        cancel_sha, cancel_template = fixture_owner("cancel-session", "cancel-pred")
        open_owner(root, "cancel-session", "cancel-pred", cancel_sha, identity, template=cancel_template)
        recorder = PrivateRejectionRecorder(
            root,
            sys.executable,
            {
                "session_id": "cancel-session",
                "prediction_id": "cancel-pred",
                "request_sha256": cancel_sha,
                "execution_identity": identity,
            },
        )
        task = asyncio.create_task(recorder({"content": "private cancellation capture", "attempt_ordinal": 1}))
        await asyncio.sleep(0.05)
        task.cancel()
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        close_owner(root, "cancel-session", "cancel-pred")
        assert len(attempts("cancel-session")) == 1
        # Native protocol repair stays at two calls; each calls the shared Rose retry once.
        before = (await client.get("/rose_usage")).json()
        (root / "exhaust").touch()
        exhausted = model.new_session("Inspect exhausted source", {}, "exhaustion-scope")
        try:
            await model.step(exhausted.id, action, "exhaust-invocation")
        except Exception as error:
            from exp.simulation.engines.text.prompt import TextWorldModelProtocolError

            assert isinstance(error, TextWorldModelProtocolError)
        else:
            raise AssertionError("All invalid attempts incorrectly produced an observation")
        after = (await client.get("/rose_usage")).json()
        assert after["calls"] - before["calls"] == 2
        assert after["input_tokens"] - before["input_tokens"] == 40
        assert after["output_tokens"] - before["output_tokens"] == 12
        assert after["total_cost_usd"] - before["total_cost_usd"] == 60
        assert exhausted.revision == 0 and len(exhausted.history) == 0
        captured = attempts(exhausted.id)
        assert len(captured) == 4
        captures = list((root / "native-predictions" / exhausted.id).glob("*.json"))
        assert len(captures) == 2
        assert all(json.loads(path.read_text())["capture_pending"] is False for path in captures)
        assert all(
            "error" in json.loads(path.read_text()) and "response" not in json.loads(path.read_text())
            for path in captures
        )
        assert all(
            json.loads(path.read_text())["active"] is False
            for path in (root / "native-provider-capture-owners" / exhausted.id).glob("*.json")
        )
        assert all("private-lease-marker" not in path.read_text() for path in captures)
        (root / "exhaust").unlink()
        # Preserve a sampled error as a real native fixture retirement for the existing replay consumer.
        (root / "replay-negative").touch()
        replay = model.new_session("Inspect an offline source", {}, "replay-consumer-scope")
        explore_action = json.loads(json.dumps(action))
        explore_action["name"] = "rose.explore.spawn_explore_agent"
        explore_action["arguments"]["name"] = "spawn_explore_agent"
        explore_action["arguments"]["category"] = "explore"
        explore_action["arguments"]["tool_call_id"] = "replay-call"
        replay_result = await model.step(replay.id, explore_action, "replay-invocation")
        assert replay_result["is_error"] is True
        replay_retirement = await model.end_session(replay.id)
        atomic_json(root / "native-retirements" / (replay.id + ".json"), replay_retirement)
        (root / "replay-negative").unlink()
        (root / "consumer-session.txt").write_text(replay.id)

    print(
        json.dumps(
            {
                "success": True,
                "single_native_prediction_store": True,
                "rejected_attempt_visible_before_fallback": True,
                "native_history_commits": 1,
                "provider_attempts": 2,
                "private_rejections": 1,
                "per_model_cost_arithmetic": 30,
                "auth_and_foreign_scope_rejected_before_inference": True,
                "cancelled_native_writer_joined": True,
                "repeated_writer_cancellation_joined": True,
                "caller_cancel_rejoins_once": True,
                "parallel_capture_owner_unaffected": True,
                "retirement_joins_exact_writer_without_commit": True,
                "closed_owner_rejects_late_admission": True,
                "exhaustion": {
                    "native_calls": 2,
                    "rose_attempts": 4,
                    "private_captures": 4,
                    "history_commits": 0,
                    "input_tokens": 40,
                    "output_tokens": 12,
                    "mixed_model_cost": 60,
                },
            }
        )
    )


asyncio.run(run())
