"""Blackbox tests for tool_schemas domain."""

import asyncio

import pytest

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    teardown_mock,
)


def _assert_raises(fn, match):
    try:
        fn()
    except Exception as e:
        assert match in str(e), f"Expected '{match}' in error, got: {e}"
        return
    raise AssertionError(f"Expected exception containing '{match}'")


def test_tool_models_has_all_tools():
    """TOOL_MODELS dict has keys for known core tools."""
    from utils.tool_schemas import TOOL_MODELS

    expected_tools = [
        "web_search",
        "web_fetch",
        "spawn_agent",
        "attempt_completion",
        "send_message_to_user",
        "wait_for",
        "message_person",
        "set_plan",
        "grep",
    ]

    for tool_name in expected_tools:
        assert tool_name in TOOL_MODELS, f"Expected '{tool_name}' in TOOL_MODELS"


def test_plan_phase_tools_subset():
    """PLAN_PHASE_TOOLS is a subset of TOOL_MODELS keys."""
    from utils.tool_schemas import PLAN_PHASE_TOOLS, TOOL_MODELS

    for tool_name in PLAN_PHASE_TOOLS:
        assert tool_name in TOOL_MODELS, f"PLAN_PHASE_TOOLS contains '{tool_name}' which is not in TOOL_MODELS"


def test_execute_phase_tools_subset():
    """EXECUTE_PHASE_TOOLS is a subset of TOOL_MODELS keys."""
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, TOOL_MODELS

    for tool_name in EXECUTE_PHASE_TOOLS:
        assert tool_name in TOOL_MODELS, f"EXECUTE_PHASE_TOOLS contains '{tool_name}' which is not in TOOL_MODELS"


def test_execute_phase_excludes_direct_web_search():
    """Execute-phase agents should route web research through explore sub-agents."""
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS

    assert "web_search" not in EXECUTE_PHASE_TOOLS


def test_all_phase_tools_superset():
    """ALL_PHASE_TOOLS contains every tool from both phases."""
    from utils.tool_schemas import ALL_PHASE_TOOLS, EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS, TOOL_MODELS

    for tool_name in PLAN_PHASE_TOOLS:
        assert tool_name in ALL_PHASE_TOOLS
    for tool_name in EXECUTE_PHASE_TOOLS:
        assert tool_name in ALL_PHASE_TOOLS
    for tool_name in ALL_PHASE_TOOLS:
        assert tool_name in TOOL_MODELS, f"ALL_PHASE_TOOLS contains '{tool_name}' which is not in TOOL_MODELS"


def test_create_agent_action_model():
    """create_agent_action_model returns a Pydantic model class."""
    from utils.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["web_search", "attempt_completion"])

    # Should be a class with tool_calls field
    assert hasattr(Model, "model_fields")
    assert "tool_calls" in Model.model_fields

    # Should be instantiable with response and empty tool_calls
    instance = Model(response="Thinking about next steps", tool_calls=[])
    assert instance.tool_calls == []
    assert instance.response == "Thinking about next steps"


def test_create_agent_action_model_single_tool():
    """create_agent_action_model works with a single tool."""
    from utils.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["attempt_completion"])

    assert "tool_calls" in Model.model_fields
    assert "response" in Model.model_fields
    instance = Model(response="Evaluating completion", tool_calls=[])
    assert instance.tool_calls == []


def test_create_agent_action_model_injects_completion_result_only_when_requested():
    """attempt_completion_with_result requires result; attempt_completion only offers an optional one."""
    from utils.tool_schemas import create_agent_action_model

    verified_model = create_agent_action_model(["attempt_completion"])
    unverified_model = create_agent_action_model(["attempt_completion_with_result"])

    verified_schema = verified_model.model_json_schema()
    unverified_schema = unverified_model.model_json_schema()

    verified_defs = verified_schema.get("$defs", {})
    unverified_defs = unverified_schema.get("$defs", {})

    # Verified loops: optional authored result; unverified handoff: required result.
    assert "result" in verified_defs["AttemptCompletionTool"]["properties"]
    assert "result" not in verified_defs["AttemptCompletionTool"].get("required", [])
    assert "result" in unverified_defs["AttemptCompletionWithResultTool"]["properties"]
    assert "result" in unverified_defs["AttemptCompletionWithResultTool"].get("required", [])


def test_explore_agent_action_model_accepts_documents_grep():
    """Explore agents must be able to search synced user documents via grep."""
    from utils.tool_schemas import EXPLORE_AGENT_TOOLS, create_agent_action_model

    assert "grep" in EXPLORE_AGENT_TOOLS

    Model = create_agent_action_model(EXPLORE_AGENT_TOOLS)
    instance = Model(
        response="Searching synced documents",
        tool_calls=[
            {
                "tool": "grep",
                "pattern": "project",
                "source": "documents",
                "filters": {"document_source": "obsidian"},
            }
        ],
    )

    assert instance.tool_calls[0].tool == "grep"
    assert instance.tool_calls[0].source == "documents"
    assert instance.tool_calls[0].filters == {"document_source": "obsidian"}


def test_explore_agent_action_model_accepts_summary_grep():
    """Explore agents can request aggregate local-data metadata before raw scans."""
    from utils.tool_schemas import EXPLORE_AGENT_TOOLS, create_agent_action_model

    Model = create_agent_action_model(EXPLORE_AGENT_TOOLS)
    instance = Model(
        response="Checking aggregate WhatsApp statistics",
        tool_calls=[
            {
                "tool": "grep",
                "pattern": "WhatsApp totals",
                "sources": ["summary"],
                "source": "summary",
            }
        ],
    )

    assert instance.tool_calls[0].tool == "grep"
    assert instance.tool_calls[0].sources == ["summary"]


def test_planner_assignable_tools():
    """PLANNER_ASSIGNABLE_TOOLS contains expected planner-specific tool names."""
    from utils.tool_schemas import PLANNER_ASSIGNABLE_TOOLS

    assert "spawn_explore_agent" in PLANNER_ASSIGNABLE_TOOLS
    assert "spawn_browser_agent" in PLANNER_ASSIGNABLE_TOOLS
    assert "spawn_code_agent" in PLANNER_ASSIGNABLE_TOOLS
    assert "reasoning" in PLANNER_ASSIGNABLE_TOOLS


def test_gpa_kill_switch_swaps_spawn_schema_and_planner_enums(monkeypatch=None):
    """ROSE_DISABLE_GENERAL_PURPOSE_AGENT removes GP/for_each from schemas."""
    import os

    from domains.spawn_agent.config import ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV

    previous = os.environ.get(ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV)
    os.environ[ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV] = "1"
    try:
        from utils.tool_schemas import (
            SpawnAgentToolNoGP,
            get_planner_assignable_tools,
            get_planner_response_model,
            get_tool_models,
        )

        assert get_tool_models()["spawn_agent"] is SpawnAgentToolNoGP
        type_schema = SpawnAgentToolNoGP.model_json_schema()["properties"]["type"]
        type_blob = str(type_schema)
        assert "general_purpose" not in type_blob or "disabled" in type_blob.lower()
        # Literal enum values must not include GP routes.
        assert "general_purpose" not in (type_schema.get("enum") or [])
        assert "for_each" not in (type_schema.get("enum") or [])
        assignable = get_planner_assignable_tools()
        assert "spawn_general_purpose_agent" not in assignable
        assert "spawn_general_purpose_agent_for_each" not in assignable
        assert "spawn_code_agent" in assignable
        planner_model = get_planner_response_model()
        assert planner_model.__name__ == "PlannerResponseNoGP"
    finally:
        if previous is None:
            os.environ.pop(ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV, None)
        else:
            os.environ[ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV] = previous


def test_planner_response_schema_is_compact():
    """Planner output schema omits old prose and mirrored dependency fields."""
    from utils.tool_schemas import PlannerResponse

    fields = set(PlannerResponse.model_fields)

    assert fields == {"title", "tasks", "join"}
    assert "reasoning" not in fields


def test_grep_tool_schema_exact_contract():
    """Grep exposes typed agent metadata queries alongside legacy filters."""
    from utils.tool_schemas import GrepTool

    schema = GrepTool.model_json_schema()
    props = set(schema["properties"].keys())
    assert props == {
        "tool",
        "pattern",
        "sources",
        "source",
        "role",
        "record_kind",
        "surface",
        "trace_path",
        "until",
        "require_source_access",
        "-B",
        "-A",
        "-C",
        "context",
        "-n",
        "-i",
        "head_limit",
        "offset",
        "order",
        "page_after",
        "multiline",
        "filters",
        "person",
        "since",
    }

    # Channel-first sources: concrete communication channels plus the umbrellas.
    expected_sources = {
        "messages",
        "email",
        "gmail",
        "imessage",
        "whatsapp",
        "network",
        "agent_network",
        "agent_trajectories",
        "transactions",
        "documents",
        "calendar",
        "drive",
        "summary",
    }

    def _enum_values(prop_schema: dict) -> set:
        values: set = set()
        for option in prop_schema.get("anyOf", []):
            values.update(option.get("enum", []))
            # `sources` is a list: its options are arrays whose items carry the enum.
            items = option.get("items")
            if isinstance(items, dict):
                values.update(items.get("enum", []))
        return values

    assert _enum_values(schema["properties"]["source"]) == expected_sources
    assert _enum_values(schema["properties"]["sources"]) == expected_sources
    assert _enum_values(schema["properties"]["role"]) == {"USER", "ASSISTANT", "TOOL"}
    assert _enum_values(schema["properties"]["record_kind"]) == {"message", "llm_output", "llm_context", "all"}
    assert "pattern" not in schema.get("required", [])

    removed = {
        "path",
        "glob",
        "type",
        "output_mode",
        "person_id",
        "limit",
        "roles",
        "search_in",
        "tool_name",
        "tool_status",
    }
    assert props.isdisjoint(removed)


# ── WaitForTool validation ─────────────────────────────────────────────


def test_wait_for_tool_mutually_exclusive_raises():
    """WaitForTool rejects both until_timestamp and condition together."""
    from utils.tool_schemas import WaitForTool

    _assert_raises(
        lambda: WaitForTool(
            tool="wait_for",
            description="the task to be ready",
            until_timestamp="2026-01-01T00:00:00Z",
            condition="when ready",
        ),
        "mutually exclusive",
    )


def test_wait_for_tool_neither_raises():
    """WaitForTool requires either until_timestamp or condition."""
    from utils.tool_schemas import WaitForTool

    _assert_raises(
        lambda: WaitForTool(tool="wait_for", description="the wait to finish"),
        "must be provided",
    )


def test_wait_for_tool_with_timestamp_only():
    """WaitForTool accepts until_timestamp alone."""
    from utils.tool_schemas import WaitForTool

    t = WaitForTool(
        tool="wait_for",
        description="midnight on January 1",
        until_timestamp="2026-01-01T00:00:00Z",
    )
    assert t.until_timestamp == "2026-01-01T00:00:00Z"
    assert t.condition is None


def test_wait_for_july_timestamp_without_description_parses():
    """July Fast Mode rows recorded timestamp waits without the later-required UI phrase.

    Live smoke 3c487fdd failed 18 GPs on AgentAction ValidationError:
    ``WaitForTool.description: Field required`` for
    ``{"tool": "wait_for", "until_timestamp": "2026-07-03T17:38:30Z"}``.
    Timestamp-only replay must still parse; condition-without-description must not.
    """
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, WaitForTool, create_agent_action_model

    july = {"tool": "wait_for", "until_timestamp": "2026-07-03T17:38:30Z"}
    t = WaitForTool.model_validate(july)
    assert t.tool == "wait_for"
    assert t.until_timestamp == "2026-07-03T17:38:30Z"
    assert t.condition is None
    assert 3 <= len(t.description) <= 80

    Model = create_agent_action_model(EXECUTE_PHASE_TOOLS)
    parsed = Model.model_validate(
        {
            "reasoning": "",
            "response": "",
            "tool_calls": [july],
        }
    )
    assert parsed.tool_calls[0].tool == "wait_for"
    assert parsed.tool_calls[0].until_timestamp == "2026-07-03T17:38:30Z"

    _assert_raises(
        lambda: WaitForTool.model_validate({"tool": "wait_for", "condition": "When the user replies"}),
        "description",
    )


def test_wait_for_tool_condition_requires_description():
    """Condition mode requires display copy from the original tool call."""
    from utils.tool_schemas import WaitForTool

    _assert_raises(
        lambda: WaitForTool(tool="wait_for", condition="When the user replies"),
        "description",
    )


def test_wait_for_tool_with_condition_and_description():
    """Condition mode accepts concise display copy with the full condition."""
    from utils.tool_schemas import WaitForTool

    t = WaitForTool(
        tool="wait_for",
        description="Bar Shoji to reply",
        condition="When the user replies",
    )
    assert t.condition == "When the user replies"
    assert t.description == "Bar Shoji to reply"
    assert t.until_timestamp is None


# ── WebFetchTool validation ───────────────────────────────────────────


def test_web_fetch_tool_fields_are_url_and_objective_only():
    """WebFetchTool exposes only tool + url + objective after the Firecrawl swap.

    The legacy excerpts/full_content/download_files params were Parallel AI
    artifacts; the Haiku filter on top of Firecrawl now picks files based on
    the objective string, so no extension filter is needed at the tool layer.
    """
    from utils.tool_schemas import WebFetchTool

    fields = set(WebFetchTool.model_fields.keys())
    assert fields == {"tool", "url", "objective"}, fields


def test_web_fetch_tool_drops_removed_params():
    """Legacy params (excerpts/full_content/download_files) are silently dropped.

    Pydantic v2's default is ``extra='ignore'`` — passing legacy fields
    constructs the model fine but the values aren't accessible as attributes.
    Codebase-wide convention; mirrored here to avoid breaking older agents
    that still emit the removed kwargs during the rollout.
    """
    from utils.tool_schemas import WebFetchTool

    t = WebFetchTool(
        tool="web_fetch",
        url="https://example.com",
        objective="x",
        excerpts=True,
        full_content=True,
        download_files=["pdf"],
    )
    for removed in ("excerpts", "full_content", "download_files"):
        assert not hasattr(t, removed), f"{removed} should not be an attribute on the narrowed model"


# ── SpawnAgentTool model_validator ────────────────────────────────────

LONG_GOAL = (
    "Research the topic in depth and produce a structured report covering history, current state, "
    "and future outlook of the technology with citations."
)


def test_spawn_agent_type_description_explains_capability_routing():
    """The execute LLM can distinguish every unified spawn type by capability."""
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, SpawnAgentTool, create_agent_action_model

    description = SpawnAgentTool.model_json_schema()["properties"]["type"]["description"]
    expected_capabilities = {
        "browser": "browser session",
        "code": "coding agent using Claude Code or Codex CLI",
        "general_purpose": "full autonomous agent",
        "explore": "read-only research",
        "for_each": "one general-purpose agent per item",
    }
    for agent_type, capability in expected_capabilities.items():
        assert agent_type in description
        assert capability in description

    rendered_execute_schema = create_agent_action_model(EXECUTE_PHASE_TOOLS).model_json_schema()
    rendered_description = rendered_execute_schema["$defs"]["SpawnAgentTool"]["properties"]["type"]["description"]
    assert rendered_description == description


def test_spawn_agent_browser_missing_url_raises():
    """SpawnAgentTool browser without start_url raises."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            task_name="task_a",
            type="browser",
            goal=LONG_GOAL,
            output_schema=schema,
        ),
        "start_url",
    )


def test_spawn_agent_browser_recovers_start_url_from_goal():
    """A browser spawn whose URL lives only in `goal` is repaired, not rejected.

    Regression: benchmark agent-payment-abandonment (agent
    3e6e3834-44a2-4a2e-84aa-016e8d502280) died after three identical
    `start_url is required when type='browser'` validation failures. The model
    consistently put the checkout URL in `goal` and left `start_url` unset, so
    every blind re-generation reproduced the same omission and no browser agent
    was ever spawned.
    """
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    tool = SpawnAgentTool(
        tool="spawn_agent",
        task_name="task_a",
        type="browser",
        goal=(
            "Navigate to https://example-shop.test/test_payment?benchmark=agentcard-abandonment. "
            "Select exactly these 3 products and no others: Aurora Notebook, Ceramic Mug, and "
            "Canvas Tote. Do not submit payment."
        ),
        output_schema=schema,
    )
    assert tool.start_url == "https://example-shop.test/test_payment?benchmark=agentcard-abandonment"


def test_first_url_in_text_trims_prose_punctuation():
    """URL recovery strips sentence punctuation and unbalanced brackets."""
    from utils.tool_schemas import first_url_in_text

    assert first_url_in_text("go to https://a.test/x.") == "https://a.test/x"
    assert first_url_in_text("see (https://a.test/x) now") == "https://a.test/x"
    assert first_url_in_text("open https://a.test/x?q=1#frag!") == "https://a.test/x?q=1#frag"
    assert first_url_in_text("keep https://a.test/path(1) intact") == "https://a.test/path(1)"
    assert first_url_in_text("no link here") is None
    assert first_url_in_text("bare https:// scheme") is None
    assert first_url_in_text(None) is None


def test_first_url_in_text_requires_a_host():
    """Hostless URLs parse but name no server, so they are not recoverable."""
    from utils.tool_schemas import first_url_in_text

    assert first_url_in_text("go to https:///orders") is None
    assert first_url_in_text("go to https://?next=orders") is None
    assert first_url_in_text("go to https://#frag") is None


def test_first_url_in_text_rejects_invalid_port():
    """urlsplit accepts an out-of-range port; only reading .port validates it."""
    from utils.tool_schemas import first_url_in_text

    assert first_url_in_text("go to https://a.test:99999/checkout") is None
    assert first_url_in_text("go to https://a.test:notaport/checkout") is None
    assert first_url_in_text("go to https://a.test:8443/checkout") == "https://a.test:8443/checkout"


def test_spawn_agent_browser_refuses_to_recover_cleartext_url():
    """An http:// goal still fails loudly; only https is repaired.

    The browser restores authenticated session cookies before navigating, so
    silently promoting a cleartext target inferred from prose would transmit
    that state in the clear (CWE-319).
    """
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    try:
        SpawnAgentTool(
            tool="spawn_agent",
            task_name="task_a",
            type="browser",
            goal="Navigate to http://insecure.test/checkout and pay.",
            output_schema=schema,
        )
    except Exception as exc:  # pydantic wraps the ValueError
        assert "start_url is required" in str(exc)
    else:
        raise AssertionError("cleartext start_url was recovered instead of rejected")


def test_url_origin_for_log_drops_credentials_and_query():
    """Only the origin is logged — never userinfo, path, query, or fragment."""
    from utils.tool_schemas import url_origin_for_log

    redacted = url_origin_for_log("https://u:pw@a.test/p?token=secret#f")
    assert redacted == "https://a.test"
    assert url_origin_for_log("https://a.test:8443/p?token=secret") == "https://a.test:8443"
    for leak in ("pw", "secret", "token", "/p"):
        assert leak not in redacted


def test_spawn_agent_general_purpose_missing_phase_raises():
    """SpawnAgentTool general_purpose without start_phase raises."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            task_name="task_a",
            type="general_purpose",
            goal=LONG_GOAL,
            output_schema=schema,
        ),
        "start_phase",
    )


def test_spawn_agent_for_each_items_and_csv_raises():
    """SpawnAgentTool for_each rejects both items and items_csv."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            task_name="task_a",
            type="for_each",
            goal=LONG_GOAL,
            output_schema=schema,
            start_phase="PLAN",
            items=["a"],
            items_csv="x,y",
        ),
        "mutually exclusive",
    )


def test_spawn_agent_for_each_no_items_raises():
    """SpawnAgentTool for_each requires items or items_csv."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            task_name="task_a",
            type="for_each",
            goal=LONG_GOAL,
            output_schema=schema,
            start_phase="PLAN",
        ),
        "items",
    )


def test_spawn_agent_for_each_accepts_recursive_json_items():
    """SpawnAgentTool for_each accepts nested JSON values as items."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    nested_item = {
        "canonical_name": "Bryan Johnson",
        "approximate_audience_metrics_by_platform": {
            "youtube": {"subscribers": "1M+", "recent_views": [120000, 250000, None]},
            "newsletter": None,
        },
        "platforms": ["YouTube", "Instagram"],
        "active": True,
        "rank": 1,
    }

    tool = SpawnAgentTool(
        tool="spawn_agent",
        task_name="task_a",
        type="for_each",
        goal=LONG_GOAL,
        output_schema=schema,
        start_phase="PLAN",
        items=[nested_item, ["nested", {"ok": True}], None, 42, False, "plain string"],
    )

    assert tool.items == [nested_item, ["nested", {"ok": True}], None, 42, False, "plain string"]


def test_spawn_agent_browser_no_schema_raises():
    """SpawnAgentTool browser/code/general_purpose/for_each requires output_schema."""
    from utils.tool_schemas import SpawnAgentTool

    _assert_raises(
        lambda: SpawnAgentTool(
            tool="spawn_agent",
            task_name="task_a",
            type="browser",
            goal=LONG_GOAL,
            start_url="https://example.com",
        ),
        "output_schema",
    )


def test_spawn_agent_explore_with_schema_dropped():
    """SpawnAgentTool with type='explore' silently drops output_schema rather
    than raising — explore agents return free-form summary and rejecting the
    field forces a costly LLM retry loop (see commit 59ba9d47)."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    t = SpawnAgentTool(
        tool="spawn_agent",
        task_name="task_a",
        type="explore",
        goal=LONG_GOAL,
        output_schema=schema,
    )
    assert t.output_schema is None, "output_schema should be silently dropped for type='explore'"


def test_response_schema_coerces_json_string():
    """ResponseSchemaConfig coerces a JSON-encoded string (Claude Sonnet
    tendency: emits the schema as an escaped string instead of nested JSON)."""
    from utils.tool_schemas import ResponseSchemaConfig

    raw = '[{"name": "tokyo_population", "type": "int", "required": true, "description": "pop count"}]'
    cfg = ResponseSchemaConfig.model_validate(raw)
    assert len(cfg.fields) == 1
    assert cfg.fields[0].name == "tokyo_population"
    assert cfg.fields[0].type == "int"


def test_response_schema_coerces_bare_list():
    """ResponseSchemaConfig coerces a bare list-of-fields (model drops the
    {"fields": ...} wrapper) into the canonical structured form."""
    from utils.tool_schemas import ResponseSchemaConfig

    raw = [{"name": "x", "type": "str", "required": True, "description": "d"}]
    cfg = ResponseSchemaConfig.model_validate(raw)
    assert len(cfg.fields) == 1
    assert cfg.fields[0].name == "x"


def test_response_schema_coerces_flat_dict():
    """ResponseSchemaConfig coerces a flat {field_name: description} dict
    (Gemini, GPT-4 tendency) into the canonical structured form."""
    from utils.tool_schemas import ResponseSchemaConfig

    raw = {"tokyo_population": "the population of Tokyo as a number"}
    cfg = ResponseSchemaConfig.model_validate(raw)
    assert len(cfg.fields) == 1
    assert cfg.fields[0].name == "tokyo_population"
    assert cfg.fields[0].type == "str"
    assert cfg.fields[0].required is True


def test_response_schema_passthrough_canonical():
    """ResponseSchemaConfig passes the canonical {"fields": [...]} form unchanged."""
    from utils.tool_schemas import ResponseSchemaConfig

    raw = {"fields": [{"name": "x", "type": "str", "required": True, "description": "d"}]}
    cfg = ResponseSchemaConfig.model_validate(raw)
    assert len(cfg.fields) == 1
    assert cfg.fields[0].name == "x"


def test_response_schema_coerces_null_properties_for_primitive_fields():
    """Primitive fields may omit properties, but must not serialize JSON null
    because the backend response_schema contract accepts arrays only."""
    from utils.tool_schemas import SpawnAgentTool

    t = SpawnAgentTool(
        tool="spawn_agent",
        task_name="task_a",
        type="general_purpose",
        goal=LONG_GOAL,
        start_phase="EXECUTE",
        output_schema={
            "fields": [
                {
                    "name": "random_org_number",
                    "type": "int",
                    "required": True,
                    "properties": None,
                    "description": "The integer shown on the page.",
                }
            ]
        },
    )

    dumped = t.model_dump()
    field = dumped["output_schema"]["fields"][0]
    assert field["properties"] == []


def test_response_schema_rejects_null_properties_for_object_fields():
    """Object fields still require explicit nested properties."""
    from pydantic import ValidationError
    from utils.tool_schemas import ResponseSchemaConfig

    raw = {
        "fields": [
            {
                "name": "result",
                "type": "object",
                "required": True,
                "properties": None,
            }
        ]
    }
    try:
        ResponseSchemaConfig.model_validate(raw)
        raise AssertionError("expected ValidationError")
    except ValidationError:
        pass


def test_response_schema_constraints_validate_at_tool_boundary():
    from pydantic import ValidationError
    from utils.tool_schemas import ResponseSchemaConfig

    schema = ResponseSchemaConfig.model_validate(
        {
            "fields": [
                {
                    "name": "items",
                    "type": "list[object]",
                    "required": True,
                    "minItems": 2,
                    "maxItems": 2,
                    "properties": [{"name": "note", "type": "str", "required": False, "maxLength": 20}],
                },
            ]
        }
    )
    field = schema.model_dump()["fields"][0]
    assert field["minItems"] == field["maxItems"] == 2
    assert field["properties"][0]["required"] is False
    assert field["properties"][0]["maxLength"] == 20

    invalid = (
        {"name": "items", "type": "list[str]", "required": True, "minItems": 3, "maxItems": 2},
        {"name": "title", "type": "str", "required": True, "minItems": 1},
        {"name": "items", "type": "list[str]", "required": True, "maxLength": 10},
        {"name": "items", "type": "list[str]", "required": True, "minItems": -1},
        {
            "name": "rows",
            "type": "list[object]",
            "required": True,
            "properties": [{"name": "title", "type": "str", "minLength": 8, "maxLength": 2}],
        },
    )
    for item in invalid:
        try:
            ResponseSchemaConfig.model_validate({"fields": [item]})
            raise AssertionError(f"Expected ValidationError for {item}")
        except ValidationError:
            pass


def test_spawn_agent_browser_with_string_output_schema():
    """SpawnAgentTool accepts JSON-stringified output_schema (the exact failure
    mode that broke spawn-sub-agents smoke runs — see agent
    eade933b-fad2-4930-a851-7a9c06c5a162)."""
    from utils.tool_schemas import SpawnAgentTool

    raw_schema = (
        '[{"name": "tokyo_population", "type": "int", "required": true, '
        '"description": "Population of Tokyo as a numeric integer"}]'
    )
    t = SpawnAgentTool(
        tool="spawn_agent",
        task_name="task_a",
        type="browser",
        goal=LONG_GOAL,
        output_schema=raw_schema,
        start_url="https://example.com",
    )
    assert t.output_schema is not None
    assert t.output_schema.fields[0].name == "tokyo_population"


def test_spawn_agent_short_goal_allowed():
    """SpawnAgentTool accepts short goals when other type-specific requirements are met."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="x", type="str", required=True, description="d")]
    )
    t = SpawnAgentTool(
        tool="spawn_agent",
        task_name="task_a",
        type="general_purpose",
        goal="short",
        output_schema=schema,
        start_phase="PLAN",
    )
    assert t.goal == "short"


def test_spawn_agent_browser_valid():
    """SpawnAgentTool browser with all required fields passes."""
    from utils.tool_schemas import (
        ResponseSchemaConfig,
        ResponseSchemaFieldConfig,
        SpawnAgentTool,
    )

    schema = ResponseSchemaConfig(
        fields=[ResponseSchemaFieldConfig(name="result", type="str", required=True, description="d")]
    )
    t = SpawnAgentTool(
        tool="spawn_agent",
        task_name="task_a",
        type="browser",
        goal=LONG_GOAL,
        output_schema=schema,
        start_url="https://example.com",
    )
    assert t.type == "browser"


# ── render_tool_list ──────────────────────────────────────────────────


def test_render_tool_list_empty_registry():
    """render_tool_list returns empty string for empty registry."""
    from utils.tool_schemas import render_tool_list

    assert render_tool_list({}) == ""


def test_render_tool_list_sorted():
    """render_tool_list produces sorted, deterministic output."""
    from utils.tool_schemas import TOOL_MODELS, render_tool_list

    out = render_tool_list(TOOL_MODELS)
    lines = out.split("\n")
    # All non-empty
    assert all(line.startswith("- ") for line in lines)
    # Sorted by name
    names = [line.split(":")[0][2:] for line in lines]
    assert names == sorted(names)


def test_render_tool_list_unsorted():
    """render_tool_list with sort=False preserves insertion order."""
    from utils.tool_schemas import TOOL_MODELS, render_tool_list

    out = render_tool_list(TOOL_MODELS, sort=False)
    lines = out.split("\n")
    names = [line.split(":")[0][2:] for line in lines]
    # Insertion order is the keys order of TOOL_MODELS
    assert names == list(TOOL_MODELS.keys())


def test_render_tool_list_uses_docstring_fallback():
    """render_tool_list falls back to docstring when no PROMPT fragment."""
    from pydantic import BaseModel
    from utils.tool_schemas import render_tool_list

    class _NoDocTool(BaseModel):
        """First line of docstring is used."""

        x: int = 1

    class _NoDocstringTool(BaseModel):
        x: int = 1

    out = render_tool_list({"docked": _NoDocTool, "_silent": _NoDocstringTool}, sort=True)
    lines = out.split("\n")
    # docstring tool line includes "First line"
    assert any("First line of docstring" in line for line in lines)
    # tool with no docstring -> "No description" fallback
    assert any("No description" in line for line in lines)


def test_first_nonempty_line_handles_blank_text():
    """_first_nonempty_line returns '' when input has no non-empty lines."""
    from utils.tool_schemas import _first_nonempty_line

    assert _first_nonempty_line("") == ""
    assert _first_nonempty_line("\n\n") == ""
    assert _first_nonempty_line("   \n  hello  \n") == "hello"


# ── create_agent_action_model edge cases ─────────────────────────────


def test_create_agent_action_model_unknown_tool_skipped():
    """Unknown tool name is skipped (logger.warning), not raised."""
    from utils.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["nope_no_such_tool", "attempt_completion"])
    # Still produces a model
    instance = Model(response="ok", tool_calls=[])
    assert instance.response == "ok"


def test_create_agent_action_model_no_tools_available():
    """Empty/all-unknown tool list yields a model that accepts no tool calls."""
    from utils.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["nope_only"])
    instance = Model(response="thinking", tool_calls=[])
    assert instance.tool_calls == []


def test_create_agent_action_model_custom_registry():
    """Custom registry overrides TOOL_MODELS."""
    from pydantic import BaseModel, Field
    from typing import Literal
    from utils.tool_schemas import create_agent_action_model

    class _CustomTool(BaseModel):
        tool: Literal["custom"]
        name: str = Field(description="x")

    Model = create_agent_action_model(["custom"], tool_registry={"custom": _CustomTool})
    inst = Model(response="ok", tool_calls=[{"tool": "custom", "name": "x"}])
    assert inst.tool_calls[0].name == "x"


def test_agent_action_openai_schema_has_typed_spawn_agent_items():
    """AgentAction schema is accepted by strict OpenAI/GPT response_format."""
    from providers.rose.schema import prepare_schema_for_openai
    from utils.tool_schemas import create_agent_action_model

    Model = create_agent_action_model(["spawn_agent"])
    schema = prepare_schema_for_openai(Model)
    spawn_schema = schema["properties"]["tool_calls"]["items"]
    items_schema = spawn_schema["properties"]["items"]["anyOf"][0]["items"]

    assert items_schema != {}
    assert "anyOf" in items_schema or "type" in items_schema


# ── Rose Desktop flag (utils.rose_desktop) ──
# New-UI-only surfaces (inline views, pinned questions, the rose_user_ui clause
# in spawn_agent) reach Rose Desktop accounts only; every other account keeps
# the stock schema, byte-stable so its cached tool prefix is unchanged.

ROSE_DESKTOP_USER = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
STOCK_USER = "00000000-0000-4000-8000-000000000001"
ROSE_DESKTOP_TERMS = ("inline_view", "rose_user_ui", "Rose app UI", "pinned", "inline view")


def _native_tools(rose_desktop: bool, phase=None):
    from providers.rose.schema import build_anthropic_tools_from_response_model
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS, create_agent_action_model, get_tool_models

    names = PLAN_PHASE_TOOLS if phase == "plan" else EXECUTE_PHASE_TOOLS
    registry = get_tool_models(phase=phase, rose_desktop=rose_desktop)
    tools = build_anthropic_tools_from_response_model(create_agent_action_model(list(names), tool_registry=registry))
    return {tool["name"]: tool for tool in tools}


def test_rose_desktop_flag_defaults_on_for_accounts():
    """All account ids receive the UI; no-user contexts retain stock tools."""
    from utils.rose_desktop import ROSE_DESKTOP_USER_IDS, is_rose_desktop_user

    assert ROSE_DESKTOP_USER_IDS == (ROSE_DESKTOP_USER,)
    assert is_rose_desktop_user(ROSE_DESKTOP_USER)
    for account in (STOCK_USER, ROSE_DESKTOP_USER.upper()):
        assert is_rose_desktop_user(account)
    for other in ("", None, 42):
        assert not is_rose_desktop_user(other), other


def test_stock_tool_schemas_have_no_rose_desktop_surfaces():
    """Unflagged accounts: no inline_view, no pinned placement, no rose_user_ui text in any tool schema."""
    import json

    from utils.tool_schemas import (
        PLAN_TOOL_MODELS,
        TOOL_MODELS,
        DisplayTool,
        SendMessageToUserExecutePhaseTool,
        SendMessageToUserTool,
        SpawnAgentTool,
        create_agent_action_model,
        get_tool_models,
    )

    # The default registries are the stock ones: a caller that never passes the flag is stock.
    assert get_tool_models() == get_tool_models(rose_desktop=False) == dict(TOOL_MODELS)
    assert get_tool_models(phase="plan") == dict(PLAN_TOOL_MODELS)
    assert TOOL_MODELS["send_message_to_user"] is SendMessageToUserTool
    assert TOOL_MODELS["send_message_to_user_execute_phase"] is SendMessageToUserExecutePhaseTool
    assert TOOL_MODELS["display"] is DisplayTool
    assert TOOL_MODELS["spawn_agent"] is SpawnAgentTool
    default_action = create_agent_action_model(["send_message_to_user_execute_phase", "display"])
    assert "inline_view" not in json.dumps(default_action.model_json_schema())

    for phase in (None, "plan"):
        tools = _native_tools(False, phase)
        blob = json.dumps(tools)
        for term in ROSE_DESKTOP_TERMS:
            assert term not in blob, f"stock {phase or 'execute'} tools mention {term!r}"

    execute = _native_tools(False)
    plan = _native_tools(False, "plan")
    assert list(execute["send_message_to_user_execute_phase"]["input_schema"]["properties"]) == ["message"]
    assert list(plan["send_message_to_user"]["input_schema"]["properties"]) == ["message", "is_question"]
    assert list(execute["display"]["input_schema"]["properties"]) == ["paths", "urls", "html", "caption"]
    assert execute["display"]["description"] == "Show images, videos or HTML to the user inline."
    type_description = execute["spawn_agent"]["input_schema"]["properties"]["type"]["description"]
    assert (
        "'code' starts a coding agent using Claude Code or Codex CLI in a persistent sandbox, selected by "
        "available credentials and configuration; 'general_purpose' starts a full autonomous agent for "
    ) in type_description


def test_rose_desktop_tool_schemas_add_only_new_ui_surfaces():
    """Flagged accounts get inline_view, pinned questions and the rose_user_ui clause, and nothing else changes."""
    from utils.tool_schemas import (
        INLINE_VIEW_DESCRIPTION,
        SPAWN_AGENT_TYPE_DESCRIPTION,
        SPAWN_AGENT_TYPE_DESCRIPTION_ROSE_DESKTOP,
    )

    stock, flagged = _native_tools(False), _native_tools(True)
    stock_plan, flagged_plan = _native_tools(False, "plan"), _native_tools(True, "plan")
    assert list(stock) == list(flagged) and list(stock_plan) == list(flagged_plan), "same tools, same order"

    for tools_stock, tools_flagged, name in (
        (stock, flagged, "send_message_to_user_execute_phase"),
        (stock_plan, flagged_plan, "send_message_to_user"),
    ):
        flagged_tool = tools_flagged[name]
        props = dict(flagged_tool["input_schema"]["properties"])
        inline = props.pop("inline_view")
        assert inline["description"] == INLINE_VIEW_DESCRIPTION
        assert props == tools_stock[name]["input_schema"]["properties"], f"{name}: only inline_view is added"
        assert flagged_tool["description"] == tools_stock[name]["description"]

    display = flagged["display"]["input_schema"]["properties"]
    assert list(display) == ["paths", "urls", "html", "caption", "placement", "options", "allow_other"]
    assert display["placement"]["anyOf"][0]["enum"] == ["inline", "pinned"]
    assert "pin a question" in flagged["display"]["description"]

    flagged_type = flagged["spawn_agent"]["input_schema"]["properties"]["type"]["description"]
    assert flagged_type == SPAWN_AGENT_TYPE_DESCRIPTION_ROSE_DESKTOP
    assert "user's Rose app UI (rose_user_ui)" in flagged_type
    assert stock["spawn_agent"]["input_schema"]["properties"]["type"]["description"] == SPAWN_AGENT_TYPE_DESCRIPTION
    other_stock = {k: v for k, v in stock["spawn_agent"]["input_schema"]["properties"].items() if k != "type"}
    other_flagged = {k: v for k, v in flagged["spawn_agent"]["input_schema"]["properties"].items() if k != "type"}
    assert other_stock == other_flagged
    # PLAN's explore-only spawn_agent is the same for both groups.
    assert stock_plan["spawn_agent"] == flagged_plan["spawn_agent"]


def test_tool_schemas_are_byte_stable_within_each_group():
    """Each group's tool declarations are deterministic, so its cached tool prefix holds."""
    import json

    for flag in (False, True):
        for phase in (None, "plan"):
            first = json.dumps(list(_native_tools(flag, phase).values()), sort_keys=False)
            second = json.dumps(list(_native_tools(flag, phase).values()), sort_keys=False)
            assert first == second
    assert json.dumps(_native_tools(False)) != json.dumps(_native_tools(True))


def test_gpa_kill_switch_keeps_no_gp_spawn_for_rose_desktop():
    """The no-general-purpose spawn_agent wins over the Rose Desktop swap."""
    import os

    from domains.spawn_agent.config import ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV
    from utils.tool_schemas import SpawnAgentToolNoGP, get_tool_models

    previous = os.environ.get(ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV)
    os.environ[ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV] = "1"
    try:
        assert get_tool_models(rose_desktop=True)["spawn_agent"] is SpawnAgentToolNoGP
    finally:
        if previous is None:
            os.environ.pop(ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV, None)
        else:
            os.environ[ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV] = previous


async def test_call_llm_activity_declares_tools_for_the_calling_account():
    """The LLM activity declares Rose Desktop schemas only when its user_id is flagged."""
    import json
    from unittest.mock import patch

    from helpers.llm import call_llm_activity
    from providers.rose.schema import build_anthropic_tools_from_response_model

    declared: dict = {}

    async def fake_structured_streaming(**kwargs):
        response_model = kwargs["response_model"]
        declared[kwargs["call_site"]] = build_anthropic_tools_from_response_model(response_model)
        return (
            response_model(response="", tool_calls=[{"tool": "attempt_completion"}]),
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            [],
        )

    with (
        patch("helpers.llm.call_llm_structured_streaming", fake_structured_streaming),
        patch("temporalio.activity.heartbeat"),
    ):
        for site, user_id in (("rose-desktop", ROSE_DESKTOP_USER), ("stock", STOCK_USER), ("no-user", None)):
            await call_llm_activity(
                messages_or_agent_id=[{"role": "user", "content": "Tell the user"}],
                model="rose-labs/rose-1-flash",
                tool_names=["send_message_to_user_execute_phase", "display", "attempt_completion"],
                reasoning_max_tokens=0,
                call_site=site,
                user_id=user_id,
            )

    by_site = {site: {tool["name"]: tool for tool in tools} for site, tools in declared.items()}
    flagged = by_site["rose-desktop"]
    assert "inline_view" in flagged["send_message_to_user_execute_phase"]["input_schema"]["properties"]
    assert "placement" in flagged["display"]["input_schema"]["properties"]
    assert by_site["stock"] == by_site["rose-desktop"]
    for site in ("no-user",):
        blob = json.dumps(by_site[site])
        for term in ROSE_DESKTOP_TERMS:
            assert term not in blob, f"{site} account declared {term!r}"


async def run_all_tests():
    print("tool-schemas blackbox tests:")
    r = BlackboxResult()
    r.record("desktop_display_json_arrays_preserve_validation", test_desktop_display_decodes_json_arrays_without_changing_stock_or_item_validation)
    r.record("tool_models_has_all_tools", test_tool_models_has_all_tools)
    r.record("plan_phase_tools_subset", test_plan_phase_tools_subset)
    r.record("execute_phase_tools_subset", test_execute_phase_tools_subset)
    r.record("execute_phase_excludes_direct_web_search", test_execute_phase_excludes_direct_web_search)
    r.record("create_agent_action_model", test_create_agent_action_model)
    r.record("create_agent_action_model_single_tool", test_create_agent_action_model_single_tool)
    r.record(
        "create_agent_action_model_injects_completion_result_only_when_requested",
        test_create_agent_action_model_injects_completion_result_only_when_requested,
    )
    r.record(
        "explore_agent_action_model_accepts_documents_grep", test_explore_agent_action_model_accepts_documents_grep
    )
    r.record("explore_agent_action_model_accepts_summary_grep", test_explore_agent_action_model_accepts_summary_grep)
    r.record("planner_assignable_tools", test_planner_assignable_tools)
    r.record(
        "gpa_kill_switch_swaps_spawn_schema_and_planner_enums",
        test_gpa_kill_switch_swaps_spawn_schema_and_planner_enums,
    )
    r.record("planner_response_schema_compact", test_planner_response_schema_is_compact)
    r.record("grep_tool_schema_exact_contract", test_grep_tool_schema_exact_contract)
    # WaitForTool validation
    r.record("wait_for_mutually_exclusive", test_wait_for_tool_mutually_exclusive_raises)
    r.record("wait_for_neither", test_wait_for_tool_neither_raises)
    r.record("wait_for_with_timestamp", test_wait_for_tool_with_timestamp_only)
    r.record(
        "wait_for_july_timestamp_without_description",
        test_wait_for_july_timestamp_without_description_parses,
    )
    r.record("wait_for_condition_requires_description", test_wait_for_tool_condition_requires_description)
    r.record("wait_for_with_condition", test_wait_for_tool_with_condition_and_description)
    # WebFetchTool validation
    r.record("web_fetch_fields_url_objective_only", test_web_fetch_tool_fields_are_url_and_objective_only)
    r.record("web_fetch_drops_removed_params", test_web_fetch_tool_drops_removed_params)
    # SpawnAgentTool model_validator
    r.record(
        "spawn_agent_type_description_capability_routing",
        test_spawn_agent_type_description_explains_capability_routing,
    )
    r.record("spawn_agent_browser_no_url", test_spawn_agent_browser_missing_url_raises)
    r.record("spawn_agent_browser_url_from_goal", test_spawn_agent_browser_recovers_start_url_from_goal)
    r.record("first_url_in_text_trims_punctuation", test_first_url_in_text_trims_prose_punctuation)
    r.record("first_url_in_text_requires_host", test_first_url_in_text_requires_a_host)
    r.record("first_url_in_text_rejects_invalid_port", test_first_url_in_text_rejects_invalid_port)
    r.record(
        "spawn_agent_browser_rejects_cleartext_url",
        test_spawn_agent_browser_refuses_to_recover_cleartext_url,
    )
    r.record("url_origin_for_log_redacts", test_url_origin_for_log_drops_credentials_and_query)
    r.record("spawn_agent_general_purpose_no_phase", test_spawn_agent_general_purpose_missing_phase_raises)
    r.record("spawn_agent_for_each_both", test_spawn_agent_for_each_items_and_csv_raises)
    r.record("spawn_agent_for_each_neither", test_spawn_agent_for_each_no_items_raises)
    r.record("spawn_agent_for_each_recursive_json_items", test_spawn_agent_for_each_accepts_recursive_json_items)
    r.record("spawn_agent_browser_no_schema", test_spawn_agent_browser_no_schema_raises)
    r.record("spawn_agent_explore_with_schema", test_spawn_agent_explore_with_schema_dropped)
    r.record("spawn_agent_short_goal", test_spawn_agent_short_goal_allowed)
    r.record("spawn_agent_browser_valid", test_spawn_agent_browser_valid)
    # ResponseSchemaConfig coercion of malformed LLM input
    r.record("response_schema_coerces_json_string", test_response_schema_coerces_json_string)
    r.record("response_schema_coerces_bare_list", test_response_schema_coerces_bare_list)
    r.record("response_schema_coerces_flat_dict", test_response_schema_coerces_flat_dict)
    r.record("response_schema_passthrough_canonical", test_response_schema_passthrough_canonical)
    r.record(
        "response_schema_null_properties_primitive",
        test_response_schema_coerces_null_properties_for_primitive_fields,
    )
    r.record(
        "response_schema_null_properties_object",
        test_response_schema_rejects_null_properties_for_object_fields,
    )
    r.record("response_schema_constraints_validate", test_response_schema_constraints_validate_at_tool_boundary)
    r.record("spawn_agent_string_output_schema", test_spawn_agent_browser_with_string_output_schema)
    # render_tool_list
    r.record("render_tool_list_empty", test_render_tool_list_empty_registry)
    r.record("render_tool_list_sorted", test_render_tool_list_sorted)
    r.record("render_tool_list_unsorted", test_render_tool_list_unsorted)
    r.record("render_tool_list_docstring", test_render_tool_list_uses_docstring_fallback)
    r.record("first_nonempty_line", test_first_nonempty_line_handles_blank_text)
    # create_agent_action_model edges
    r.record("create_action_unknown_tool", test_create_agent_action_model_unknown_tool_skipped)
    r.record("create_action_no_tools", test_create_agent_action_model_no_tools_available)
    r.record("create_action_custom_registry", test_create_agent_action_model_custom_registry)
    r.record("agent_action_openai_schema_spawn_items", test_agent_action_openai_schema_has_typed_spawn_agent_items)
    # Rose Desktop flag
    r.record("rose_desktop_flag_defaults_on_for_accounts", test_rose_desktop_flag_defaults_on_for_accounts)
    r.record("stock_tool_schemas_have_no_rose_desktop_surfaces", test_stock_tool_schemas_have_no_rose_desktop_surfaces)
    r.record(
        "rose_desktop_tool_schemas_add_only_new_ui_surfaces", test_rose_desktop_tool_schemas_add_only_new_ui_surfaces
    )
    r.record("tool_schemas_byte_stable_within_each_group", test_tool_schemas_are_byte_stable_within_each_group)
    r.record(
        "gpa_kill_switch_keeps_no_gp_spawn_for_rose_desktop", test_gpa_kill_switch_keeps_no_gp_spawn_for_rose_desktop
    )
    await r.record_async(
        "call_llm_activity_declares_tools_for_the_calling_account",
        test_call_llm_activity_declares_tools_for_the_calling_account,
    )
    teardown_mock()
    r.record("all_phase_tools_superset", test_all_phase_tools_superset)
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())

def test_desktop_display_decodes_json_arrays_without_changing_stock_or_item_validation():
    from pydantic import ValidationError
    from utils.tool_schemas import DisplayTool, DisplayRoseDesktopTool

    typed = DisplayRoseDesktopTool.model_validate({"tool": "display", "paths": '["game.html"]', "urls": '["https://example.com/game.html"]', "options": '[{"label":"Play"}]', "caption": '["literal caption"]'})
    assert typed.paths == ["game.html"]
    assert typed.urls == ["https://example.com/game.html"]
    assert typed.options[0].label == "Play"
    assert typed.caption == '["literal caption"]'
    for field, value in (("paths", "[1]"), ("urls", "[{}]"), ("options", "[{}]"), ("paths", '{"path":"game.html"}'), ("paths", "[invalid]"), ("paths", '"game.html"')):
        with pytest.raises(ValidationError):
            DisplayRoseDesktopTool.model_validate({"tool": "display", field: value})
    with pytest.raises(ValidationError):
        DisplayTool.model_validate({"tool": "display", "paths": '["game.html"]'})
    assert DisplayRoseDesktopTool.model_validate({"tool": "display", "paths": ["game.html"]}).paths == ["game.html"]
    assert DisplayRoseDesktopTool.model_validate({"tool": "display", "paths": None}).paths is None
    schema = DisplayRoseDesktopTool.model_json_schema()
    assert schema["properties"]["paths"]["anyOf"] == [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}]
