"""Public schema activity to typed dispatch, with recorded original schemas (offline)."""
import asyncio
import copy
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult, get_captured_requests, setup_mock, teardown_mock

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "response_schema_dispatch_originals.json"


async def activity_result(schema, *, cached=False, cache_miss=False, persist=True):
    from helpers.llm import set_response_schema_activity

    setup_mock({"/api/agents/": {"status": 200, "json": {"ok": True}}})
    now = datetime.now(timezone.utc)
    info = SimpleNamespace(workflow_id="schema-owner", workflow_run_id="run", activity_id="schema",
                           activity_type="set_response_schema_activity", attempt=1, task_queue="queue",
                           current_attempt_scheduled_time=now, scheduled_time=now, started_time=now)
    usage = {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}
    generated = AsyncMock(return_value=(schema, None, usage))
    cache_write = AsyncMock()
    try:
        with (
            patch("helpers.llm.load_config", return_value=SimpleNamespace(backend=SimpleNamespace(
                api_url="http://mock-backend", api_key="fixture-key"))),
            patch("temporalio.activity.heartbeat"),
            patch("temporalio.activity.info", return_value=info),
            patch("helpers.llm._generate_response_schema_with_rose", generated),
            patch("providers.demo_cache.client.resolve_agent_fast_mode", AsyncMock(return_value=(False, "", False, "", "", False))),
            patch("providers.demo_cache.client.cache_get_first", AsyncMock(return_value=({"schema": schema, "usage": usage}, None) if cached else (None, None))),
            patch("providers.demo_cache.client.cache_set", cache_write),
        ):
            result = await set_response_schema_activity("schema-owner", ["Original authored goal"],
                                                        fast_mode_cache_enabled=cached or cache_miss, persist=persist)
        writes = [json.loads(r["requestBody"]) for r in get_captured_requests() if r["method"] == "PATCH"]
        assert len(writes) == int(persist)
        if persist:
            assert writes[0]["response_schema"] == result["schema"]
        assert generated.await_count == int(not cached)
        assert cache_write.await_count == int(cache_miss)
        if cache_miss:
            assert cache_write.call_args.args[3]["schema"] == schema
        assert result["usage"] == usage
        return result["schema"]
    finally:
        teardown_mock()


def typed_dispatch(schema):
    from utils.tool_schemas import SpawnAgentTool

    return SpawnAgentTool(tool="spawn_agent", type="browser", task_name="schema_child",
                          goal="Original authored goal", start_url="about:blank", output_schema=schema)


async def check_recorded_schema(task):
    from helpers.file_resolution import restore_schema_from_remote_session, transform_schema_for_remote_session

    for original in (row for row in json.loads(FIXTURE.read_text()) if row["task"] == task):
        schema = original["schema"]
        before = copy.deepcopy(schema)
        for cached, cache_miss in ((False, False), (True, False), (False, True)):
            for persist in (False, True):
                public = await activity_result(schema, cached=cached, cache_miss=cache_miss, persist=persist)
                # Same actual boundary: the old activity returns its unsupported
                # internal type and typed dispatch raises the original literal error.
                typed_dispatch(public)
                assert public == restore_schema_from_remote_session(before)
                assert transform_schema_for_remote_session(public) == before
                assert schema == before, "do not mutate a generated or cached schema"


async def test_recorded_bu055_schema_reaches_public_dispatch():
    await check_recorded_schema("polar-bu-055")


async def test_recorded_bu056_schema_reaches_public_dispatch():
    await check_recorded_schema("polar-bu-056")


async def test_recorded_bu058_schema_reaches_public_dispatch():
    await check_recorded_schema("polar-bu-058")

async def test_public_nested_nullable_constraints_are_preserved():
    from helpers.file_resolution import transform_schema_for_remote_session

    schema = {"fields": [
        {"name": "report", "type": "session_file_pointer", "required": False, "nullable": True},
        {"name": "rows", "type": "list[object]", "required": True, "minItems": 0, "maxItems": 4,
         "properties": [
             {"name": "label", "type": "str", "required": True, "minLength": 1, "maxLength": 30},
             {"name": "files", "type": "list[session_file_pointer]", "required": False, "nullable": True,
              "description": "Original field meaning", "minItems": 0, "maxItems": 3},
         ]},
    ]}
    before = copy.deepcopy(schema)
    public = await activity_result(schema)
    typed_dispatch(public)
    assert public["fields"][0]["type"] == "file_pointer"
    assert public["fields"][1]["properties"][1]["type"] == "list[file_pointer]"
    assert transform_schema_for_remote_session(public) == before
    assert schema == before
    assert await activity_result(public, cached=True) == public


async def test_public_non_file_schema_and_fail_closed_validation():
    from pydantic import ValidationError
    from helpers.llm import _GeneratedResponseSchema

    schema = {"fields": [{"name": "summary", "type": "str", "required": True,
                           "nullable": False, "description": "Original meaning", "minLength": 1}]}
    assert await activity_result(schema) == schema
    for kind in ("session_file_pointer", "list[session_file_pointer]"):
        internal = {"fields": [{"name": "files", "type": kind, "required": True}]}
        # Internal generator vocabulary remains usable by remote consumers.
        assert _GeneratedResponseSchema.model_validate({"reasoning": "recorded", **internal}).fields[0].type == kind
        try:
            typed_dispatch(internal)
        except ValidationError:
            pass
        else:
            raise AssertionError("public dispatch must still reject raw internal pointers")
    for invalid in (
        {"fields": [{"name": "bad", "type": "invented_type", "required": True}]},
        {"fields": [{"name": "bad", "type": "object", "required": True}]},
    ):
        try:
            typed_dispatch(await activity_result(invalid))
        except ValidationError:
            pass
        else:
            raise AssertionError("invalid schema must remain rejected")


async def run_all_tests():
    results = BlackboxResult()
    await results.record_async("recorded_bu055_schema_dispatch", test_recorded_bu055_schema_reaches_public_dispatch)
    await results.record_async("recorded_bu056_schema_dispatch", test_recorded_bu056_schema_reaches_public_dispatch)
    await results.record_async("recorded_bu058_schema_dispatch", test_recorded_bu058_schema_reaches_public_dispatch)
    await results.record_async("public_nested_nullable_constraints", test_public_nested_nullable_constraints_are_preserved)
    await results.record_async("public_non_file_and_fail_closed", test_public_non_file_schema_and_fail_closed_validation)
    return results.summary()


if __name__ == "__main__":
    raise SystemExit(0 if asyncio.run(run_all_tests())["failed"] == 0 else 1)
