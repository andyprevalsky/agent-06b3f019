"""Blackbox tests for param_populator domain."""

import asyncio

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
    assert_captured_call,
    setup_mock_fn,
)


def test_types_contracts_are_importable():
    """Public param-populator result contract remains importable."""
    from domains.param_populator.types import PopulatedParams

    assert "params" in PopulatedParams.__annotations__
    assert "usage" in PopulatedParams.__annotations__


def test_build_prompt_basic():
    """_build_agent_system_prompt returns non-empty string containing the goal."""
    from activities.param_populator import _build_agent_system_prompt

    result = _build_agent_system_prompt("web_search", "Find AI trends")

    assert isinstance(result, str)
    assert len(result) > 0
    assert "Find AI trends" in result


def test_build_prompt_spawn_agent_alias_does_not_redefine_type_schema():
    """Alias-specific spawn-agent parameter rules live in the canonical tool schema."""
    from activities.param_populator import _build_agent_system_prompt

    result = _build_agent_system_prompt("spawn_agent", "Research competitors", alias_hint="spawn_explore_agent")

    assert "spawn_agent" in result
    assert "SPAWN TYPE" not in result
    assert 'type="explore"' not in result


def test_build_prompt_spawn_general_purpose_agent_no_duplicate_requirements():
    """Param populator should not duplicate spawn-agent subtype requirements."""
    from activities.param_populator import _build_agent_system_prompt

    result = _build_agent_system_prompt("spawn_agent", "Complete the task", alias_hint="spawn_general_purpose_agent")

    assert "Complete the task" in result
    assert "SPAWN TYPE" not in result
    assert "Required by policy: start_phase" not in result


def test_build_prompt_contains_tool_name():
    """_build_agent_system_prompt mentions the tool name in the prompt."""
    from activities.param_populator import _build_agent_system_prompt

    result = _build_agent_system_prompt("web_search", "Find things")

    assert "web_search" in result


def test_build_prompt_spawn_suffix_tool_adds_ephemeral_warning():
    """build_agent_system_prompt with any spawn_* tool_name adds ephemeral warning."""
    from domains.param_populator.service import build_agent_system_prompt

    result = build_agent_system_prompt("spawn_agent", "Do thing")
    assert "Ephemeral Session" in result
    assert "sessions are ephemeral" in result


def test_build_prompt_non_spawn_tool_no_ephemeral_warning():
    """Non-spawn tool prompts don't get the ephemeral warning."""
    from domains.param_populator.service import build_agent_system_prompt

    result = build_agent_system_prompt("web_search", "Find things")
    assert "Ephemeral Session" not in result
    assert "web_search" in result


def test_build_prompt_file_attachment_rules_included():
    """Prompt always includes file_pointer/attachment rules."""
    from domains.param_populator.service import build_agent_system_prompt

    result = build_agent_system_prompt("web_search", "Find things")
    assert "file_pointer" in result
    assert "attachments" in result


# =========================================================================
# populate_tool_params tests
# =========================================================================


class _FakeToolCall:
    """Pydantic-like tool_call container with model_dump()."""

    def __init__(self, data: dict):
        self._data = data

    def model_dump(self) -> dict:
        return dict(self._data)


class _FakePydanticResult:
    """Stand-in for the pydantic structured result object."""

    def __init__(self, tool_calls: list, response: str = "ok"):
        self.tool_calls = tool_calls
        self.response = response


def _install_populate_mocks(
    *,
    monkey_patch: dict,
    tool_calls: list | None = None,
    response: str = "ok",
    usage: dict | None = None,
    raise_on_call: Exception | None = None,
    context: list | None = None,
):
    """Patch fetch_agent_context and call_llm_structured_streaming in the service module."""
    import domains.param_populator.service as svc

    usage = usage or {"total_tokens": 10}
    context = context if context is not None else []

    async def fake_fetch_agent_context(agent_id: str):
        return context

    async def fake_call_llm_structured_streaming(**kwargs):
        if raise_on_call is not None:
            raise raise_on_call
        return _FakePydanticResult(tool_calls or [], response=response), usage, []

    monkey_patch["fetch_agent_context"] = svc.fetch_agent_context
    monkey_patch["call_llm_structured_streaming"] = svc.call_llm_structured_streaming
    svc.fetch_agent_context = fake_fetch_agent_context
    svc.call_llm_structured_streaming = fake_call_llm_structured_streaming


def _restore_populate_mocks(monkey_patch: dict):
    import domains.param_populator.service as svc

    svc.fetch_agent_context = monkey_patch["fetch_agent_context"]
    svc.call_llm_structured_streaming = monkey_patch["call_llm_structured_streaming"]


async def test_populate_raises_on_unknown_tool():
    """populate_tool_params raises ValueError when tool_name isn't in TOOL_MODELS."""
    from domains.param_populator.service import populate_tool_params

    try:
        await populate_tool_params(
            tool_name="totally_not_a_tool",
            goal="x",
            agent_id="agent-1",
            model="rose-fast",
        )
    except ValueError as e:
        assert "Unknown tool" in str(e)
    else:
        raise AssertionError("Expected ValueError for unknown tool")


async def test_populate_uses_agent_model():
    """Param populator uses the model selected for the agent."""
    from domains.param_populator.service import populate_tool_params
    import domains.param_populator.service as svc

    seen: dict = {}

    async def fake_fetch_agent_context(agent_id: str):
        return []

    async def fake_call_llm_structured_streaming(**kwargs):
        seen.update(kwargs)
        return _FakePydanticResult([_FakeToolCall({"tool": "web_search", "query": "q"})]), {"total_tokens": 1}, []

    async def fake_model_context(model):
        seen["budget_model"] = model
        return 200000

    original_window = svc.get_model_context_window
    svc.get_model_context_window = fake_model_context
    original_fetch = svc.fetch_agent_context
    original_call = svc.call_llm_structured_streaming
    svc.fetch_agent_context = fake_fetch_agent_context
    svc.call_llm_structured_streaming = fake_call_llm_structured_streaming
    try:
        await populate_tool_params(tool_name="web_search", goal="Find AI news", agent_id="agent-1", model="rose-fast")
    finally:
        svc.get_model_context_window = original_window
        svc.fetch_agent_context = original_fetch
        svc.call_llm_structured_streaming = original_call

    assert seen["budget_model"] == seen["model"] == "rose-fast"
    assert seen["call_site"] == "dag_param_populator"


async def test_populate_keeps_metadata_for_unadmitted_attachments():
    """An unrelated unreadable or oversized upload must not block parameter population."""
    from domains.param_populator.service import populate_tool_params
    import domains.param_populator.service as svc

    seen: dict = {}
    context = [
        {"role": "USER", "text": "earlier upload", "file_pointer": {
            "id": "unrelated-zip", "storage_path": "fixture/archive.zip", "original_filename": "archive.zip",
            "mime_type": "application/zip", "size_bytes": 2048}},
        {"role": "USER", "text": "find AI news"},
    ]

    async def fake_fetch_agent_context(agent_id: str):
        return context

    async def fake_call_llm_structured_streaming(**kwargs):
        seen.update(kwargs)
        return _FakePydanticResult([_FakeToolCall({"tool": "web_search", "query": "q"})]), {"total_tokens": 1}, []

    original_fetch = svc.fetch_agent_context
    original_call = svc.call_llm_structured_streaming
    svc.fetch_agent_context = fake_fetch_agent_context
    svc.call_llm_structured_streaming = fake_call_llm_structured_streaming
    try:
        await populate_tool_params(tool_name="web_search", goal="Find AI news", agent_id="agent-1", model="rose-fast")
    finally:
        svc.fetch_agent_context = original_fetch
        svc.call_llm_structured_streaming = original_call

    rendered = "\n".join(str(message.get("content")) for message in seen["messages"])
    assert "archive.zip" in rendered


async def test_populate_happy_path_returns_params_and_usage():
    """populate_tool_params returns {params, usage} on a valid LLM tool call."""
    from domains.param_populator.service import populate_tool_params

    mp: dict = {}
    _install_populate_mocks(
        monkey_patch=mp,
        tool_calls=[_FakeToolCall({"tool": "web_search", "query": "AI news"})],
        usage={"total_tokens": 42},
    )
    try:
        result = await populate_tool_params(
            tool_name="web_search",
            goal="Find AI news",
            agent_id="agent-1",
            model="rose-fast",
        )
    finally:
        _restore_populate_mocks(mp)

    assert result["params"] == {"query": "AI news"}
    assert result["usage"]["total_tokens"] == 42


async def test_populate_fallback_to_first_tool_call_on_mismatch():
    """If LLM calls a different tool, populate_tool_params falls back to the first tool_call.

    The fallback dict must still satisfy the asked-for tool's required fields; otherwise
    ValueError is raised by the required-field check below the fallback logic.
    """
    from domains.param_populator.service import populate_tool_params

    mp: dict = {}
    # Fallback tool_call names a different tool, but the dict happens to include
    # the asked-for tool's required 'query' field — so the fallback path succeeds.
    _install_populate_mocks(
        monkey_patch=mp,
        tool_calls=[
            _FakeToolCall({"tool": "web_fetch", "query": "fallback value", "url": "http://a.test"}),
        ],
    )
    try:
        result = await populate_tool_params(
            tool_name="web_search",
            goal="g",
            agent_id="agent-1",
            model="rose-fast",
        )
    finally:
        _restore_populate_mocks(mp)

    assert result["params"]["query"] == "fallback value"
    assert "url" in result["params"]


async def test_populate_raises_when_no_tool_calls():
    """populate_tool_params raises when the LLM returns zero tool_calls."""
    from domains.param_populator.service import populate_tool_params

    mp: dict = {}
    _install_populate_mocks(monkey_patch=mp, tool_calls=[], response="I refuse")
    try:
        try:
            await populate_tool_params(
                tool_name="web_search",
                goal="g",
                agent_id="agent-1",
                model="rose-fast",
            )
        except ValueError as e:
            assert "did not call any tools" in str(e)
        else:
            raise AssertionError("Expected ValueError")
    finally:
        _restore_populate_mocks(mp)


async def test_populate_raises_on_empty_required_field():
    """populate_tool_params raises when LLM returns empty required field."""
    from domains.param_populator.service import populate_tool_params

    mp: dict = {}
    _install_populate_mocks(
        monkey_patch=mp,
        tool_calls=[_FakeToolCall({"tool": "web_search", "query": "   "})],
    )
    try:
        try:
            await populate_tool_params(
                tool_name="web_search",
                goal="Some goal",
                agent_id="agent-1",
                model="rose-fast",
            )
        except ValueError as e:
            assert "Required field" in str(e)
        else:
            raise AssertionError("Expected ValueError for empty required field")
    finally:
        _restore_populate_mocks(mp)


async def test_populate_prefers_matching_tool_call():
    """When multiple tool_calls are returned, the one matching tool_name is preferred."""
    from domains.param_populator.service import populate_tool_params

    mp: dict = {}
    _install_populate_mocks(
        monkey_patch=mp,
        tool_calls=[
            _FakeToolCall({"tool": "web_fetch", "url": "http://a", "objective": "x"}),
            _FakeToolCall({"tool": "web_search", "query": "correct"}),
        ],
    )
    try:
        result = await populate_tool_params(
            tool_name="web_search",
            goal="g",
            agent_id="agent-1",
            model="rose-fast",
        )
    finally:
        _restore_populate_mocks(mp)

    assert result["params"] == {"query": "correct"}


async def test_populate_skips_none_tool_call_entries():
    """populate_tool_params filters out None entries in tool_calls."""
    from domains.param_populator.service import populate_tool_params

    mp: dict = {}
    _install_populate_mocks(
        monkey_patch=mp,
        tool_calls=[None, _FakeToolCall({"tool": "web_search", "query": "ok"})],
    )
    try:
        result = await populate_tool_params(
            tool_name="web_search",
            goal="g",
            agent_id="agent-1",
            model="rose-fast",
        )
    finally:
        _restore_populate_mocks(mp)

    assert result["params"] == {"query": "ok"}


async def test_populate_heartbeat_is_invoked():
    """heartbeat callable is invoked before DB fetch and LLM call when provided."""
    from domains.param_populator.service import populate_tool_params

    calls: list[str] = []

    def hb(msg: str) -> None:
        calls.append(msg)

    mp: dict = {}
    _install_populate_mocks(
        monkey_patch=mp,
        tool_calls=[_FakeToolCall({"tool": "web_search", "query": "x"})],
    )
    try:
        await populate_tool_params(
            tool_name="web_search",
            goal="g",
            agent_id="agent-1",
            model="rose-fast",
            heartbeat=hb,
        )
    finally:
        _restore_populate_mocks(mp)

    assert len(calls) >= 2
    assert any("Fetching" in m for m in calls)
    assert any("LLM" in m for m in calls)


# =========================================================================
# handler tests
# =========================================================================


async def test_handler_delegates_and_bubbles_exceptions():
    """populate_tool_params_activity logs and re-raises on service failure."""
    from domains.param_populator import handler as handler_mod

    async def fake_populate(**kwargs):
        raise RuntimeError("llm down")

    original = handler_mod.populate_tool_params
    handler_mod.populate_tool_params = fake_populate
    try:
        try:
            await handler_mod.populate_tool_params_activity(
                tool_name="web_search",
                goal="g",
                agent_id="agent-1",
                model="unused",
            )
        except RuntimeError as e:
            assert "llm down" in str(e)
        else:
            raise AssertionError("Expected RuntimeError")
    finally:
        handler_mod.populate_tool_params = original


async def test_handler_returns_service_result():
    """populate_tool_params_activity returns the service result on success."""
    from domains.param_populator import handler as handler_mod

    received: dict = {}

    async def fake_populate(**kwargs):
        received.update(kwargs)
        return {"params": {"query": "ok"}, "usage": {"total_tokens": 1}}

    original = handler_mod.populate_tool_params
    handler_mod.populate_tool_params = fake_populate
    try:
        result = await handler_mod.populate_tool_params_activity(
            tool_name="web_search",
            goal="g",
            agent_id="agent-1",
            model="rose-fast",
        )
    finally:
        handler_mod.populate_tool_params = original

    assert result == {"params": {"query": "ok"}, "usage": {"total_tokens": 1}}
    assert received["model"] == "rose-fast"


async def run_all_tests():
    print("param-populator blackbox tests:")
    r = BlackboxResult()
    r.record("types_contracts", test_types_contracts_are_importable)
    r.record("build_prompt_basic", test_build_prompt_basic)
    r.record("build_prompt_spawn_agent_alias_no_redefine", test_build_prompt_spawn_agent_alias_does_not_redefine_type_schema)
    r.record("build_prompt_spawn_general_no_duplicate", test_build_prompt_spawn_general_purpose_agent_no_duplicate_requirements)
    r.record("build_prompt_contains_tool_name", test_build_prompt_contains_tool_name)
    r.record("build_prompt_spawn_suffix_tool_adds_ephemeral_warning", test_build_prompt_spawn_suffix_tool_adds_ephemeral_warning)
    r.record("build_prompt_non_spawn_tool_no_ephemeral_warning", test_build_prompt_non_spawn_tool_no_ephemeral_warning)
    r.record("build_prompt_file_attachment_rules_included", test_build_prompt_file_attachment_rules_included)
    await r.record_async("populate_raises_on_unknown_tool", test_populate_raises_on_unknown_tool)
    await r.record_async("populate_uses_agent_model", test_populate_uses_agent_model)
    await r.record_async("populate_keeps_metadata_for_unadmitted_attachments", test_populate_keeps_metadata_for_unadmitted_attachments)
    await r.record_async("populate_happy_path", test_populate_happy_path_returns_params_and_usage)
    await r.record_async("populate_fallback_first_tool_call", test_populate_fallback_to_first_tool_call_on_mismatch)
    await r.record_async("populate_raises_no_tool_calls", test_populate_raises_when_no_tool_calls)
    await r.record_async("populate_raises_empty_required", test_populate_raises_on_empty_required_field)
    await r.record_async("populate_prefers_matching_tool_call", test_populate_prefers_matching_tool_call)
    await r.record_async("populate_skips_none_entries", test_populate_skips_none_tool_call_entries)
    await r.record_async("populate_heartbeat_invoked", test_populate_heartbeat_is_invoked)
    await r.record_async("handler_delegates_and_bubbles", test_handler_delegates_and_bubbles_exceptions)
    await r.record_async("handler_returns_service_result", test_handler_returns_service_result)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
