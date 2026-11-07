"""Structural-enforcement tests codifying lessons from the prompt audit.

Each test asserts a structural invariant that, if violated, would reintroduce
a class of bug we just fixed. Failure messages explain WHAT was violated and
WHY it matters so future contributors don't have to dig for context.

Categories
----------
1. Static system prompts must be byte-identical across calls (cache safety).
2. TOOL_MODELS / phase-list / tools/prompts/ coverage (registry consistency).
3. attempt_completion result is scoped to unverified handoff.
4. Verifier output schema field order (load-bearing for structured outputs).
5. Tool-name hygiene (no deleted tool names; verifier feedback uses
   attempt_completion, not check_progress; verifier path goes through
   check_progress, not _call_llm_verifier directly).
6. Browser-use catalog ↔ v3 prompt sync; envelope-only fields.
7. Render-tool-list is deterministic and well-formed.
8. Verifier static prefix clears Anthropic's 1024-token cache-write threshold.
9. TS-side static prompts have no dynamic dates inside cacheable literals.
10. Spawn-alias prompts document the validator-enforced 50-char minimum.
11. Style guardrails (em-dashes, banned phrases, marketing adjectives).
12. No restating-the-schema patterns / broken cross-refs in tool prompts.
13. ALL-CAPS section labels banned in rendered prompts (use markdown headings).
14. Canonical rule constants imported, not duplicated across files.
15. Cacheable-static prompts mark the dynamic boundary.
16. ALL-CAPS markers (IMPORTANT/CRITICAL/MUST/etc.) capped per prompt.
17. Tool prompts open with a declarative third-person sentence.
18. Tool prompt length stays within the per-call budget.
"""

import ast
import asyncio
import re
import tempfile
from pathlib import Path
from unittest.mock import patch

from _test_utils import BlackboxResult, teardown_mock

# Resolve once. _test_utils inserts agents root onto sys.path; these paths are
# only used for filesystem checks (e.g. tools/prompts/<name>.py exists).
AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
PROMPTS_DIR = AGENTS_ROOT / "tools" / "prompts"


# ============================================================================
# 1. Static system prompts are byte-identical across calls
# ----------------------------------------------------------------------------
# WHY: Anthropic prompt caching reuses bytes-equal prefixes. A `datetime.now()`
# or `time.time()` slipping into the static section silently kills cache hits
# for every downstream LLM call in the workflow. See `prompts.py` —
# `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` separates static (cacheable) from dynamic
# (per-call) sections; nothing above the boundary may vary across calls with
# the same inputs.
# ============================================================================


def test_build_system_prompt_execute_is_static_across_calls():
    """build_system_prompt('EXECUTE', []) must be byte-identical across calls.

    A non-deterministic value (timestamp, random, env-time) above
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY breaks Anthropic prompt caching for the
    main loop.
    """
    from utils.prompts import build_system_prompt

    a = build_system_prompt("EXECUTE", [])
    b = build_system_prompt("EXECUTE", [])
    assert a == b, (
        "build_system_prompt('EXECUTE', []) is non-deterministic across calls. "
        "Inspect prompts.py for datetime.now()/time.time()/etc. above "
        "SYSTEM_PROMPT_DYNAMIC_BOUNDARY. This kills cache hits for every "
        "main-loop LLM call."
    )


def test_build_system_prompt_plan_is_static_across_calls():
    """build_system_prompt('PLAN', []) must be byte-identical across calls."""
    from utils.prompts import build_system_prompt

    a = build_system_prompt("PLAN", [])
    b = build_system_prompt("PLAN", [])
    assert a == b, (
        "build_system_prompt('PLAN', []) is non-deterministic across calls. "
        "PLAN-phase prompt is non-cacheable — fix the time/random call."
    )


def test_build_system_prompt_static_prefix_shared_across_phases():
    """Static prefix (above SYSTEM_PROMPT_DYNAMIC_BOUNDARY) must match across PLAN/EXECUTE.

    The whole point of the boundary is that the byte-identical static prefix
    is shared across phases — that's how the cache prefix is reused.
    """
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY, build_system_prompt

    plan = build_system_prompt("PLAN", [])
    execute = build_system_prompt("EXECUTE", [])

    plan_static = plan.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)[0]
    execute_static = execute.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)[0]
    assert plan_static == execute_static, (
        "Static prefix differs between PLAN and EXECUTE. Anything that varies "
        "by phase MUST live below SYSTEM_PROMPT_DYNAMIC_BOUNDARY. Diff the "
        "two strings and move the differing chunk into the dynamic section."
    )


def test_build_system_prompt_splits_static_user_context_and_phase_blocks():
    """Main-agent prompts must keep user context out of the static cache prefix."""
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY, build_system_prompt

    prompt = build_system_prompt(
        "EXECUTE",
        [],
        user_context_section="Name: Alice",
        response_schema={"fields": [{"name": "done", "type": "bool", "required": True}]},
    )
    parts = [part.strip() for part in prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) if part.strip()]

    assert len(parts) == 3
    assert "You are a Rose Labs Agent" in parts[0]
    assert "# User Context" not in parts[0]
    assert "Alice" not in parts[0]
    assert "# User Context" in parts[1]
    assert "Alice" in parts[1]
    assert "# Current Phase" in parts[2]
    assert "# Required Output Schema" in parts[2]


def test_build_planner_system_prompt_is_static_across_calls():
    """build_planner_system_prompt with same inputs must be byte-identical."""
    from utils.prompts import build_planner_system_prompt

    a = build_planner_system_prompt("tool descriptions here")
    b = build_planner_system_prompt("tool descriptions here")
    assert a == b, (
        "build_planner_system_prompt is non-deterministic across calls. "
        "The planner prompt is cached on the static path — fix any "
        "time/random/env-derived content."
    )


def test_planner_is_told_explore_can_search_calendar_and_drive():
    """The planner only sends work to explore for data it knows explore can search.

    Without calendar and Drive named here, a real run planned authenticated
    browser sessions on calendar.google.com and drive.google.com for a question
    the synced sources answer directly.
    """
    from utils.prompts import MAIN_SYSTEM_PROMPT, build_planner_system_prompt

    for name, prompt in (
        ("main", MAIN_SYSTEM_PROMPT),
        ("planner", build_planner_system_prompt("tool descriptions here")),
    ):
        sentence = next(
            (line for line in prompt.splitlines() if 'spawn_agent(type="explore")' in line and "grep" in line),
            "",
        )
        for source in ("email", "Google Calendar", "Google Drive"):
            assert source in sentence, f"{name} prompt does not say explore can search {source}"


def test_explore_agent_system_prompt_template_is_constant():
    """EXPLORE_AGENT_SYSTEM_PROMPT must be a constant string with NO placeholders.

    The prompt is sent verbatim. Contact + message-thread context is fetched
    on-demand inside the explore agent via the grep tool's network /
    agent_network_* / messages source modes, NOT via prefetched
    system-prompt blocks. We confirm the module-level constant is
    string-equal across imports — i.e. it's not generated dynamically.

    NOTE: ``{current_timestamp}`` is also REMOVED. A timestamp in the
    system prompt breaks Anthropic prompt caching for every explore
    sub-agent call. The current time is injected as a per-call ``[STATE:
    now=...]`` line on the user message at ``spawn_agent/service.py``,
    not via this template. If anyone re-introduces dynamic placeholders,
    the cache will silently break across all explore agents.
    """
    from utils.prompts import EXPLORE_AGENT_SYSTEM_PROMPT as a
    from utils.prompts import EXPLORE_AGENT_SYSTEM_PROMPT as b

    assert a == b, "EXPLORE_AGENT_SYSTEM_PROMPT is not stable across imports"
    assert "{current_timestamp}" not in a, (
        "EXPLORE_AGENT_SYSTEM_PROMPT must NOT include a {current_timestamp} "
        "placeholder. A timestamp in the static system prompt kills cache "
        "hits for every explore sub-agent."
    )
    assert "{network_metadata}" not in a, (
        "EXPLORE_AGENT_SYSTEM_PROMPT must NOT include {network_metadata}. "
        "Contact data is fetched on-demand via grep(source='network')."
    )
    assert "{local_data_summary}" not in a, (
        "EXPLORE_AGENT_SYSTEM_PROMPT must NOT include {local_data_summary}. "
        "Message threads are fetched on-demand via grep(source='messages')."
    )


def test_explore_agent_system_prompt_is_static_across_calls():
    """EXPLORE_AGENT_SYSTEM_PROMPT must be byte-identical across reads.

    The explore agent system prompt is sent on every iteration of every
    explore sub-agent. A timestamp slipping in here would kill cache hits
    across all explore steps. This test imports it twice and asserts
    byte-equality, mirroring the v3 browser-agent invariant.
    """
    from utils.prompts import EXPLORE_AGENT_SYSTEM_PROMPT

    a = EXPLORE_AGENT_SYSTEM_PROMPT
    b = EXPLORE_AGENT_SYSTEM_PROMPT
    assert a == b, (
        "EXPLORE_AGENT_SYSTEM_PROMPT is non-deterministic across reads. "
        "The explore-agent prompt is cached per-spawn — any "
        "datetime.now()/time.time() call in the template breaks the cache. "
        "Per-step state must live in a [STATE: ...] line on the user "
        "message, not in this template."
    )
    # Sanity: per-call time must not bleed into the static prefix.
    assert "Current timestamp:" not in a, "Current timestamp leaked into EXPLORE_AGENT_SYSTEM_PROMPT static prefix"


def test_get_browser_system_prompt_is_static_across_calls():
    """get_browser_system_prompt with same inputs must be byte-identical.

    The v3 browser system prompt is sent on every browser-use iteration. A
    timestamp slipping in here would kill cache hits across all browser steps.
    """
    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt

    a = get_browser_system_prompt("buy a book", "be quick", available_files=["x.pdf"])
    b = get_browser_system_prompt("buy a book", "be quick", available_files=["x.pdf"])
    assert a == b, (
        "get_browser_system_prompt is non-deterministic across calls. The "
        "v3 browser prompt is cached per-spawn — any datetime.now()/time.time() "
        "call inside this function breaks the cache."
    )
    # Sanity: per-step state must not bleed into the static prefix.
    assert "Current time:" not in a, "Current time leaked into get_browser_system_prompt static prefix"
    assert "CURRENT URL:" not in a, "Current URL leaked into get_browser_system_prompt static prefix"


# ============================================================================
# 2. TOOL_MODELS ↔ phase-list ↔ tools/prompts/ coverage
# ----------------------------------------------------------------------------
# WHY: A registered Pydantic tool model with no usage is dead weight that
# inflates the union type. A phase-list entry with no model crashes at
# runtime when `create_agent_action_model` tries to dereference it. A tool
# with no prompt fragment in tools/prompts/ silently sends an empty
# description to the LLM. All three are silent footguns.
# ============================================================================


# Planner-only aliases that resolve to spawn_agent (or no tool at all).
# These deliberately appear in PLANNER_ASSIGNABLE_TOOLS but NOT in TOOL_MODELS.
_PLANNER_ALIASES = {
    "spawn_explore_agent",
    "spawn_browser_agent",
    "spawn_code_agent",
    "spawn_general_purpose_agent",
    "spawn_general_purpose_agent_for_each",
    "reasoning",  # "no tool call" sentinel — pure thinking step.
}


def test_every_tool_model_appears_in_at_least_one_phase_list():
    """Every TOOL_MODELS entry must appear in at least one phase list.

    Otherwise the model is dead — registered but never enabled for any agent.
    """
    from utils.tool_schemas import (
        EXECUTE_PHASE_TOOLS,
        EXPLORE_AGENT_TOOLS,
        PLAN_PHASE_TOOLS,
        PLANNER_ASSIGNABLE_TOOLS,
        ROOT_ONLY_TOOLS,
        TOOL_MODELS,
    )

    union = set(PLAN_PHASE_TOOLS) | set(EXECUTE_PHASE_TOOLS) | set(EXPLORE_AGENT_TOOLS) | set(PLANNER_ASSIGNABLE_TOOLS)
    # Root-only tools reach both phases through the workflow, for eligible agents only.
    union |= set(ROOT_ONLY_TOOLS)

    # This exact-goal benchmark tool is injected into the root workflow's
    # execute list only for the Google OAuth video task. Adding it to a shared
    # phase list would expose the fixture to unrelated agents.
    exact_goal_tools = {"google_workspace_run"}
    orphans = set(TOOL_MODELS.keys()) - union - exact_goal_tools
    assert not orphans, (
        f"Tool model(s) {sorted(orphans)} are registered in TOOL_MODELS but "
        f"do not appear in any phase list (PLAN_PHASE_TOOLS, "
        f"EXECUTE_PHASE_TOOLS, EXPLORE_AGENT_TOOLS, PLANNER_ASSIGNABLE_TOOLS). "
        f"Either add them to a phase list or delete the model. If you have a "
        f"deliberate exemption, add the name to the explicit exempt set in "
        f"this test."
    )


def test_every_phase_list_entry_exists_in_tool_models_or_is_alias():
    """Every phase-list entry must exist in TOOL_MODELS, or be an explicit alias."""
    from utils.tool_schemas import (
        EXECUTE_PHASE_TOOLS,
        EXPLORE_AGENT_TOOLS,
        PLAN_PHASE_TOOLS,
        PLANNER_ASSIGNABLE_TOOLS,
        TOOL_MODELS,
    )

    union = set(PLAN_PHASE_TOOLS) | set(EXECUTE_PHASE_TOOLS) | set(EXPLORE_AGENT_TOOLS) | set(PLANNER_ASSIGNABLE_TOOLS)

    missing = union - set(TOOL_MODELS.keys()) - _PLANNER_ALIASES
    assert not missing, (
        f"Phase list(s) reference tool name(s) {sorted(missing)} that do NOT "
        f"exist in TOOL_MODELS and are not in the planner-alias exempt set. "
        f"This will crash at runtime when create_agent_action_model tries to "
        f"build the union. Either add a Pydantic model to TOOL_MODELS or "
        f"add the name to _PLANNER_ALIASES if it's a legitimate alias."
    )


def test_every_tool_model_has_prompt_fragment():
    """Every TOOL_MODELS entry must have a corresponding tools/prompts/<name>.py."""
    from utils.tool_schemas import TOOL_MODELS

    missing = []
    for tool_name in TOOL_MODELS.keys():
        path = PROMPTS_DIR / f"{tool_name}.py"
        if not path.exists():
            missing.append(tool_name)

    assert not missing, (
        f"Tool model(s) {missing} have no prompt fragment file under "
        f"tools/prompts/. Without a fragment, the LLM sees an empty "
        f"description for that tool. Create tools/prompts/<name>.py "
        f"exporting a `PROMPT` string and register it in "
        f"tools/prompts/__init__.py:TOOL_PROMPTS."
    )


def test_spawn_agent_subtype_params_use_required_optional_ignored_taxonomy():
    """Subtype-scoped spawn_agent fields must distinguish required vs applicable."""
    from utils.tool_schemas import SpawnAgentTool

    fields = SpawnAgentTool.model_fields
    descriptions = {name: field.description or "" for name, field in fields.items()}
    combined = "\n".join(descriptions.values())

    assert "Required for type" not in combined
    assert "Required when type='browser'" in descriptions["start_url"]
    assert "Required when type='general_purpose' or type='for_each'" in descriptions["start_phase"]
    assert (
        "Required when type='browser', type='code', type='general_purpose', or type='for_each'"
        in descriptions["output_schema"]
    )
    assert "Optional alternative when type='for_each'" in descriptions["items"]
    assert "Optional alternative when type='for_each'" in descriptions["items_csv"]
    assert "Optional when type='code'" in descriptions["github_repo_link"]
    assert "do not invent placeholder repositories" in descriptions["github_repo_link"]
    assert "Optional when type='explore', type='general_purpose', or type='for_each'" in descriptions["context_gates"]
    assert "Optional when the spawned agent needs files" in descriptions["attachments"]


def test_spawn_agent_prompt_defines_param_wording_taxonomy():
    """The canonical spawn_agent prompt must define required/optional/ignored wording."""
    from tools.prompts.spawn_agent import PROMPT

    assert "Parameter wording:" in PROMPT
    assert "Required when type='X'" in PROMPT
    assert "Optional when type='X'" in PROMPT
    assert "Ignored for type='X'" in PROMPT


def test_general_purpose_faulty_tool_retry_warns_recursion():
    """GP may retry faulty tools, but prompts must warn against GP→GP recursion."""
    from tools.prompts.spawn_agent import PROMPT
    from utils.prompts import MAIN_SYSTEM_PROMPT
    from utils.tool_schemas import SpawnAgentTool

    retry_rule = (
        "When using one as an intelligent retry for a faulty tool, instruct it not "
        "to spawn more general_purpose sub-agents"
    )
    recursion_rule = "Be wary of infinite recursion"
    doc = SpawnAgentTool.__doc__ or ""
    type_desc = SpawnAgentTool.model_fields["type"].description or ""
    assert recursion_rule in " ".join(doc.split())
    assert retry_rule in " ".join(doc.split())
    assert recursion_rule in type_desc
    assert retry_rule in type_desc
    assert recursion_rule in PROMPT
    assert "intelligent retry for a faulty tool" in PROMPT
    assert "not to spawn more general_purpose sub-agents" in PROMPT
    assert "intelligent retry for a faulty tool" not in MAIN_SYSTEM_PROMPT
    assert "circumvent faulty tools" not in doc
    assert "circumvent faulty tools" not in type_desc
    assert "circumvent faulty tools" not in PROMPT
    assert "circumvent faulty tools" not in MAIN_SYSTEM_PROMPT


def test_code_agent_advertises_rose_user_ui_and_agent_display():
    """Rose Desktop root and planner learn that coding and Rose-app changes belong to a code agent.

    The code sandbox holds the user's rose_user_ui and its `rose-ui publish`
    CLI. Without saying so, the root explored and drove a browser against
    roselabs.ai to change the user's Rose background, and a game was returned
    only as a file. Execute-phase tools see the `type` description; the planner
    also sees the spawn_agent prompt. Both must advertise the capability, and
    the display tool must remain declared and name the Agent Display panel. These are Rose
    Desktop surfaces (utils.rose_desktop), so the flagged variants carry them.
    """
    from domains.set_plan.service import get_planner_tools_description
    from tools.prompts.spawn_agent import PROMPT_ROSE_DESKTOP as PROMPT
    from utils.tool_schemas import (
        INLINE_VIEW_DESCRIPTION,
    )
    from utils.tool_schemas import (
        SendMessageToUserExecutePhaseRoseDesktopTool as SendMessageToUserExecutePhaseTool,
    )
    from utils.tool_schemas import (
        SpawnAgentRoseDesktopTool as SpawnAgentTool,
    )

    type_desc = " ".join((SpawnAgentTool.model_fields["type"].description or "").split())
    for phrase in (
        "Delegate all code writing to it",
        "except one HTML page you can write yourself, such as a chart or scorecard, which you show with display html",
        "user's Rose app UI (rose_user_ui)",
        "how Rose looks or behaves for the user",
        "in Agent Display",
        "rose display",
    ):
        assert phrase in type_desc, f"spawn_agent type description lost {phrase!r}"

    code_line = next(line for line in PROMPT.splitlines() if line.startswith("- code:"))
    for phrase in (
        "give it all code writing",
        "except one HTML page you can write yourself, such as a chart or scorecard, which you show with display html",
        "user's Rose app UI",
        "show it in Agent Display using rose display",
        "return the display receipt",
    ):
        assert phrase in code_line, f"spawn_agent prompt code line lost {phrase!r}"
    # A chart or scorecard is the caller's own display html: no clause routes it to the code agent.
    for text in (type_desc, code_line):
        assert text.count("chart") == 1 and "visual" not in text, text
    from tools.prompts.display import PROMPT_ROSE_DESKTOP as display_prompt

    assert "tool is named display" in display_prompt
    assert "Agent Display" in display_prompt
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS

    assert "display" in EXECUTE_PHASE_TOOLS
    assert "Anthropic's Claude Code" not in code_line, "code agents also run Codex CLI"

    planner_tools = get_planner_tools_description(rose_desktop=True)
    assert code_line in planner_tools, "planner must render the spawn_agent code line"
    assert "user's Rose app UI (rose_user_ui)" in " ".join(planner_tools.split())

    assert "a code agent published" in INLINE_VIEW_DESCRIPTION
    inline_field = SendMessageToUserExecutePhaseTool.model_fields["inline_view"]
    assert inline_field.description == INLINE_VIEW_DESCRIPTION


STOCK_SPAWN_CODE_LINE = (
    "- code: An agent specialized in executing code commands. It lives in a persistent E2B sandbox and uses "
    "Anthropic's Claude Code. It syncs results to a GitHub repo initialized to this agent network after "
    "completion. The task should be tightly scoped and self-sufficient. Send video generation or editing "
    "to a code agent; tell it to make real footage with `rose video` and edit with ffmpeg."
)
ROSE_DESKTOP_PROMPT_TERMS = ("inline_view", "rose_user_ui", "Rose app UI", "pinned", "inline view")


def test_stock_planner_and_tool_prompts_omit_rose_desktop_surfaces():
    """Unflagged accounts: the planner tool text and tool prompts carry no new-UI surface.

    The stock spawn_agent `code` line is main's line with the persistent-sandbox
    wording (W5b); display documents inline media only. The Rose Desktop prompt
    differs from the stock one only in that `code` line.
    """
    from domains.set_plan.service import get_planner_tools_description
    from tools.prompts import TOOL_PROMPTS, get_tool_prompts, tool_prompts_for
    from tools.prompts.display import PROMPT as DISPLAY_PROMPT
    from tools.prompts.display import PROMPT_ROSE_DESKTOP as DISPLAY_PROMPT_ROSE_DESKTOP
    from tools.prompts.spawn_agent import PROMPT, PROMPT_ROSE_DESKTOP

    stock = get_planner_tools_description()
    assert stock == get_planner_tools_description(rose_desktop=False), "the default is the stock text"
    for term in ROSE_DESKTOP_PROMPT_TERMS:
        assert term not in stock, f"stock planner tools mention {term!r}"
    assert STOCK_SPAWN_CODE_LINE in stock.splitlines()

    assert tool_prompts_for() == dict(TOOL_PROMPTS) == tool_prompts_for(rose_desktop=False)
    assert get_tool_prompts()["spawn_agent"] == PROMPT
    for name, prompt in TOOL_PROMPTS.items():
        for term in ROSE_DESKTOP_PROMPT_TERMS:
            assert term not in prompt, f"stock {name} prompt mentions {term!r}"

    stock_lines, flagged_lines = PROMPT.splitlines(), PROMPT_ROSE_DESKTOP.splitlines()
    assert len(stock_lines) == len(flagged_lines)
    changed = [(a, b) for a, b in zip(stock_lines, flagged_lines) if a != b]
    assert len(changed) == 1 and changed[0][0] == STOCK_SPAWN_CODE_LINE, changed
    assert DISPLAY_PROMPT_ROSE_DESKTOP.startswith(DISPLAY_PROMPT + "\n- The tool is named display")
    assert "pinned" not in DISPLAY_PROMPT_ROSE_DESKTOP, "display never asks a question"

    flagged = get_planner_tools_description(rose_desktop=True)
    assert flagged != stock
    assert tool_prompts_for(rose_desktop=True)["display"] == DISPLAY_PROMPT_ROSE_DESKTOP
    assert "inline_view" in flagged
    # The planner lists only DAG-assignable tools (PLANNER_EXECUTE_TOOLS); display is one,
    # so the flagged planner text carries its Rose Desktop prompt and the stock one does not.
    # Neither offers a pinned question.
    assert "Agent Display" in flagged and "Agent Display" not in stock
    assert 'placement "pinned"' not in flagged and 'placement "pinned"' not in stock


async def test_planner_tools_description_follows_the_workflow_account():
    """set_plan renders the planner tool text for the workflow's own account."""
    import datetime
    from unittest.mock import patch

    from domains.set_plan.handler import SetPlanManager

    captured: list = []

    def fake_description(*, rose_desktop: bool = False) -> str:
        captured.append(rose_desktop)
        return "tools"

    async def fake_attempt(**kwargs):
        raise RuntimeError("stop after the description is built")

    class _Wf:
        context: list = []
        user_context_section = ""
        output_schema = None

        def __init__(self, user_id):
            self.user_id = user_id

    for user_id in ("1f85ff25-6e29-4c1b-8739-f917bd101a30", "00000000-0000-4000-8000-000000000001", None):
        with (
            patch("domains.set_plan.handler.get_planner_tools_description", fake_description),
            patch("domains.set_plan.handler.run_planner_attempt", fake_attempt),
            patch("domains.set_plan.handler.workflow") as wf_mod,
        ):
            wf_mod.now.return_value = datetime.datetime(2026, 10, 20)
            async for _event in SetPlanManager().execute_tool(_Wf(user_id), {"tool": "set_plan"}, "call-1"):
                pass
    assert captured == [True, True, False]


def test_root_agent_routes_video_requests_to_a_code_agent():
    """User-directed (Andy, 2026-10-28): video generation/editing goes to a code agent.

    The rule lives in the spawn_agent ``code`` line for both account groups, so the root
    planner sees it; the code agent's side is the talk-to-user skill's ``video.md``
    (`rose video`, back-end rose-skills structural test).
    """
    from domains.set_plan.service import get_planner_tools_description
    from tools.prompts.spawn_agent import CODE_LINE, CODE_LINE_ROSE_DESKTOP, CODE_VIDEO_SENTENCE

    rule = "Send video generation or editing to a code agent; tell it to make real footage with `rose video`"
    assert CODE_VIDEO_SENTENCE.startswith(rule)
    for line in (CODE_LINE, CODE_LINE_ROSE_DESKTOP):
        assert line.endswith(" " + CODE_VIDEO_SENTENCE), line
    for rose_desktop in (False, True):
        planner = get_planner_tools_description(rose_desktop=rose_desktop)
        assert planner.count(rule) == 1, f"planner (rose_desktop={rose_desktop}) states the video rule once"

    # Prod 2026-10-28 (root 74c5b166): with the rule only on the spawn_agent code line,
    # an un-hinted "make a video" goal went to browser agents on Replicate. The root
    # system prompt's tool section must route video to a code agent in both phases.
    from utils.prompts import build_system_prompt

    root_rule = 'Video: to make or edit a video, use spawn_agent(type="code").'
    for phase in ("PLAN", "EXECUTE"):
        prompt = build_system_prompt(phase, [])
        assert prompt.count(root_rule) == 1, f"root {phase} prompt states the video routing rule once"
        assert "do not use a browser on third-party video sites" in prompt


def test_planner_spawn_aliases_documented_in_prompt():
    """Spawn planner aliases are documented by the planner prompt, not prompt files."""
    from utils.prompts import PLANNER_SPAWN_AGENT_ALIAS_TABLE

    expected = {
        "spawn_explore_agent": 'spawn_agent(type="explore")',
        "spawn_browser_agent": 'spawn_agent(type="browser")',
        "spawn_code_agent": 'spawn_agent(type="code")',
        "spawn_general_purpose_agent": 'spawn_agent(type="general_purpose")',
        "spawn_general_purpose_agent_for_each": 'spawn_agent(type="for_each")',
    }

    for alias, runtime in expected.items():
        assert alias in PLANNER_SPAWN_AGENT_ALIAS_TABLE
        assert runtime in PLANNER_SPAWN_AGENT_ALIAS_TABLE

    assert "Raw spawn_agent with no type alias is not allowed" in PLANNER_SPAWN_AGENT_ALIAS_TABLE


# ============================================================================
# 3. attempt_completion result contract
# ----------------------------------------------------------------------------
# WHY: The verifier reads prior tool RESULTS, not attempt_completion.result.
# The `result` arg must be injected only for unverified loops (for example
# explore agents); verified loops should not expose the arg at all.
# ============================================================================


def test_attempt_completion_base_schema_has_no_result_field():
    """Verified attempt_completion takes only an OPTIONAL authored result.

    The verifier reads it as the agent's own writing (a draft, message or
    summary), never as proof (tree-feedback-routing b056f571: a drafter had no
    other way to show its draft). It must never be required, so a verified
    loop is never forced to restate tool evidence as a payload.
    """
    from utils.tool_schemas import AttemptCompletionTool

    fields = AttemptCompletionTool.model_fields
    assert set(fields) == {"tool", "result"}, f"AttemptCompletionTool.model_fields = {set(fields)}"
    assert not fields["result"].is_required(), "verified attempt_completion.result must stay optional"
    assert "own work" in (fields["result"].description or ""), fields["result"].description


def test_attempt_completion_result_schema_is_skip_verification_variant():
    """Required result exists only on the explicit unverified handoff variant."""
    from utils.tool_schemas import AttemptCompletionWithResultTool

    fields = set(AttemptCompletionWithResultTool.model_fields.keys())
    assert fields == {"tool", "result"}, (
        f"AttemptCompletionWithResultTool.model_fields = {fields}, expected {{'tool', 'result'}}."
    )
    # The sub-agent handoff payload MUST be required — an empty result means
    # the parent receives no evidence and either hallucinates or re-spawns.
    assert AttemptCompletionWithResultTool.model_fields["result"].is_required() is True


def test_attempt_completion_result_read_is_skip_verification_scoped():
    """Production reads of attempt_completion result must stay in the skip-verification path."""
    path = AGENTS_ROOT / "loop" / "run_agent.py"
    text = path.read_text()
    assert 'tool_args.get("result")' in text

    result_read = text.index('tool_args.get("result")')
    skip_gate = text.rfind("if skip_verification:", 0, result_read)
    final_verifier_gate = text.find("if verifier_prompt_generator and not skip_verification", result_read)

    assert skip_gate != -1, "attempt_completion.result must be read only under the skip_verification branch"
    assert final_verifier_gate != -1, "expected final verifier gate after result handling"


# ============================================================================
# 4. Verifier output schema field order
# ----------------------------------------------------------------------------
# WHY: Structured-output models populate fields in declaration order. The
# verifier MUST commit to `output` and `reasoning` BEFORE `score`, otherwise
# the score becomes the anchor instead of the conclusion. `score_reasoning`
# was a legacy field — we now use `reasoning` only.
# ============================================================================


def test_verifier_schema_no_response_schema_field_order():
    """Without response_schema: keys must be ['reasoning', 'score'] in order."""
    from helpers.llm import _build_verifier_json_schema

    schema = _build_verifier_json_schema(None)
    keys = list(schema["json_schema"]["schema"]["properties"].keys())
    assert keys == ["reasoning", "score"], (
        f"Verifier schema (no response_schema) keys are {keys}, expected "
        f"['reasoning', 'score']. Field ORDER is load-bearing — structured-"
        f"output models populate fields in declaration order. The score "
        f"must come LAST so it's the conclusion of the analysis, not the "
        f"anchor."
    )


def test_verifier_schema_with_response_schema_field_order():
    """With response_schema: keys must be ['output', 'reasoning', 'score'] in order."""
    from helpers.llm import _build_verifier_json_schema

    schema = _build_verifier_json_schema({"fields": [{"name": "address", "type": "str", "description": "Address"}]})
    keys = list(schema["json_schema"]["schema"]["properties"].keys())
    assert keys == ["output", "reasoning", "score"], (
        f"Verifier schema (with response_schema) keys are {keys}, expected "
        f"['output', 'reasoning', 'score']. The verifier MUST populate "
        f"`output` from tool evidence FIRST, write `reasoning` SECOND, then "
        f"commit to `score` LAST. Reordering breaks the evidence-first "
        f"evaluation pattern."
    )


def test_verifier_schema_no_score_reasoning_field():
    """`score_reasoning` was removed — only `reasoning` is correct now."""
    import json

    from helpers.llm import _build_verifier_json_schema

    for response_schema in (
        None,
        {"fields": [{"name": "x", "type": "str", "description": "x"}]},
    ):
        schema = _build_verifier_json_schema(response_schema)
        serialized = json.dumps(schema)
        assert "score_reasoning" not in serialized, (
            "Verifier schema contains the legacy `score_reasoning` field. "
            "We renamed it to `reasoning`. Update the schema and any code "
            "reading `score_reasoning` to read `reasoning` instead."
        )


# ============================================================================
# 5. Tool-name hygiene
# ----------------------------------------------------------------------------
# WHY:
#  - check_progress is the function name AND the legacy toolName for verifier
#    feedback. Verifier feedback is now tagged toolName="attempt_completion"
#    instead — see workflow.blackbox.py and the legacy migration in
#    summarize.blackbox.py. Anywhere that emits a TOOL message with
#    toolName="check_progress" is wrong.
#  - Deleted tool names must never reappear; they were removed because of
#    overlap, security, or rolled into spawn_agent.
#  - _call_llm_verifier is the implementation; check_progress is the canonical
#    activity. Bypassing check_progress means missing the rose-1-ultra forcing
#    + telemetry.
# ============================================================================


# Tools we deleted in the rewrite. Should not appear as a tool-name string in
# any production code path.
_DELETED_TOOLS = (
    "add_memory",
    "read_memories",
    "deep_research",
    "find_all",
    "enrich",
    "monitor",
    "check_monitor_events",
    "x402_bazaar",
    "enable_write_permissions",
    "send_sms",
    "send_email",
    "send_sms_as_user",
    "search_user_network_for_people",
)


def _iter_production_py_files():
    """Yield .py files under agents/ that should be scanned for invariant violations.

    Excludes: tests/, benchmarks/runs/, .venv, __pycache__, scripts/.
    """
    skip_dirs = {"tests", "venv", ".venv", "__pycache__", "htmlcov"}
    skip_path_substrings = ("benchmarks/runs/", "/tests/")

    for path in AGENTS_ROOT.rglob("*.py"):
        # Reject anything under a skip dir.
        if any(part in skip_dirs for part in path.parts):
            continue
        rel = str(path.relative_to(AGENTS_ROOT))
        if any(s in rel for s in skip_path_substrings):
            continue
        # Top-level agents/scripts/ holds offline maintenance tools (documented above).
        if rel.startswith("scripts/"):
            continue
        # Pytest regression modules also live beside the benchmark producers.
        if rel.startswith("benchmarks/") and (path.name.endswith("_test.py") or path.name.startswith("test_")):
            continue
        yield path


def test_no_deleted_tool_names_in_tool_registries():
    """No deleted tool name should appear in TOOL_MODELS, phase lists, or TOOL_PROMPTS.

    These are the tool-name registries that drive what the LLM can dispatch.
    A deleted name appearing in any registry would re-enable the tool.
    """
    from tools.prompts import TOOL_PROMPTS
    from utils.tool_schemas import (
        EXECUTE_PHASE_TOOLS,
        EXPLORE_AGENT_TOOLS,
        PLAN_PHASE_TOOLS,
        PLANNER_ASSIGNABLE_TOOLS,
        TOOL_MODELS,
    )

    registries = {
        "TOOL_MODELS": set(TOOL_MODELS.keys()),
        "PLAN_PHASE_TOOLS": set(PLAN_PHASE_TOOLS),
        "EXECUTE_PHASE_TOOLS": set(EXECUTE_PHASE_TOOLS),
        "EXPLORE_AGENT_TOOLS": set(EXPLORE_AGENT_TOOLS),
        "PLANNER_ASSIGNABLE_TOOLS": set(PLANNER_ASSIGNABLE_TOOLS),
        "TOOL_PROMPTS": set(TOOL_PROMPTS.keys()),
    }
    offenders: list[str] = []
    for registry_name, members in registries.items():
        for deleted in _DELETED_TOOLS:
            if deleted in members:
                offenders.append(f"{registry_name} contains '{deleted}'")
    assert not offenders, (
        "Deleted tool name(s) found in tool registries. These tools were "
        "removed in the prompt audit; re-registering them undoes the audit "
        "decision. Offenders:\n  " + "\n  ".join(offenders)
    )


# Some "deleted" tool names are also common English words / generic
# field names (e.g. "monitor" appears as a Vapi response field, "enrich" /
# "find_all" might appear in unrelated contexts). For string-literal
# scanning we restrict to UNAMBIGUOUS deleted names so we catch tool-name
# string drift without firing on unrelated identifiers.
_DELETED_TOOLS_UNAMBIGUOUS = (
    "add_memory",
    "read_memories",
    "deep_research",
    "check_monitor_events",
    "x402_bazaar",
    "enable_write_permissions",
    "send_sms_as_user",
    "search_user_network_for_people",
)


def _inert_forbidden_literal_spans(text: str) -> set[tuple[int, int, int, int]]:
    """Recognize only a top-level immutable literal deny-list declaration."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return set()
    nodes = list(ast.walk(tree))
    if any(
        isinstance(node, ast.Name)
        and isinstance(node.ctx, ast.Store)
        and node.id == "frozenset"
        or isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and node.name == "frozenset"
        or isinstance(node, ast.alias)
        and (node.asname or node.name) == "frozenset"
        for node in nodes
    ):
        return set()
    bindings = [
        node
        for node in nodes
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and node.id == "DEFAULT_FORBIDDEN"
    ]
    if len(bindings) != 1:
        return set()
    for statement in tree.body:
        if not (
            isinstance(statement, ast.Assign)
            and len(statement.targets) == 1
            and isinstance(statement.targets[0], ast.Name)
            and statement.targets[0].id == "DEFAULT_FORBIDDEN"
        ):
            continue
        value = statement.value
        if (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Name)
            and value.func.id == "frozenset"
            and not value.keywords
            and len(value.args) == 1
            and isinstance(value.args[0], ast.Set)
            and all(isinstance(item, ast.Constant) and isinstance(item.value, str) for item in value.args[0].elts)
        ):
            return {(item.lineno, item.col_offset, item.end_lineno, item.end_col_offset) for item in value.args[0].elts}
    return set()


def test_no_deleted_tool_names_as_string_literals_in_production_code():
    """No unambiguous deleted tool name should appear as a string literal in code.

    This catches cases like:
        toolName="read_memories", "tool": "deep_research", await call("add_memory").
    Restricted to unambiguous tool names (see _DELETED_TOOLS_UNAMBIGUOUS) to
    avoid false positives on common English words that overlap with deleted
    tools (e.g. "monitor", "enrich", "find_all").
    """
    patterns = {name: re.compile(rf"""['"`]{re.escape(name)}['"`]""") for name in _DELETED_TOOLS_UNAMBIGUOUS}

    offenders: list[str] = []
    for path in _iter_production_py_files():
        try:
            text = path.read_text()
        except OSError:
            continue
        rel = str(path.relative_to(AGENTS_ROOT))
        inert_spans = _inert_forbidden_literal_spans(text)
        for lineno, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            # Skip pure-comment lines — referencing deleted names in comments
            # (e.g. "# read_memories was removed") is fine.
            if stripped.startswith("#"):
                continue
            for name, pat in patterns.items():
                if any(
                    not any(
                        (start_line, start_col) <= (lineno, len(line[: match.start()].encode("utf-8")))
                        and (lineno, len(line[: match.end()].encode("utf-8"))) <= (end_line, end_col)
                        for start_line, start_col, end_line, end_col in inert_spans
                    )
                    for match in pat.finditer(line)
                ):
                    offenders.append(f"{rel}:{lineno}: {name!r} -> {stripped}")

    assert not offenders, (
        "Found deleted tool name(s) referenced as string literals in "
        "production code. These tools were intentionally removed (see prompt "
        "audit plan). If you genuinely need the behaviour, route it through "
        "spawn_agent or the surviving tool. Offending lines:\n  " + "\n  ".join(offenders)
    )


def test_deleted_tool_scanner_distinguishes_inert_denylists_from_dispatch():
    """Offline deny-list data is allowed; dispatch and dynamic data stay guarded."""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        evaluator = root / "benchmarks" / "offline_evaluator.py"
        evaluator.parent.mkdir()
        inert = 'DEFAULT_FORBIDDEN = frozenset({"deep_research"})\n'
        with patch.dict(globals(), {"AGENTS_ROOT": root}):
            evaluator.write_text(inert)
            test_no_deleted_tool_names_as_string_literals_in_production_code()
            for relative in ("tools/runtime.py", "benchmarks/runner.py", "benchmarks/offline_evaluator.py"):
                candidate = root / relative
                candidate.parent.mkdir(exist_ok=True)
                candidate.write_text(inert + 'dispatch("deep_research")\n')
                try:
                    test_no_deleted_tool_names_as_string_literals_in_production_code()
                except AssertionError as error:
                    assert relative in str(error)
                else:
                    raise AssertionError(f"Dispatch escaped scanner: {relative}")
                candidate.unlink()
            for declaration in (
                'DEFAULT_FORBIDDEN = {"deep_research"}\n',
                'DEFAULT_FORBIDDEN = frozenset({dispatch("deep_research")})\n',
                'DEFAULT_FORBIDDEN = frozenset({"deep_research"}, dynamic=True)\n',
                'DEFAULT_FORBIDDEN = frozenset({"deep_research"}) +\n',
                'DEFAULT_FORBIDDEN = frozenset({"deep_research"}); dispatch("deep_research")\n',
                'frozenset = dispatch\nDEFAULT_FORBIDDEN = frozenset({"deep_research"})\n',
                'DEFAULT_FORBIDDEN = frozenset({"deep_research"})\nDEFAULT_FORBIDDEN = dispatch\n',
            ):
                evaluator.write_text(declaration)
                try:
                    test_no_deleted_tool_names_as_string_literals_in_production_code()
                except AssertionError:
                    pass
                else:
                    raise AssertionError(f"Unsafe declaration escaped scanner: {declaration}")


def test_no_check_progress_tool_name_in_production_code():
    """No production code emits a TOOL message with toolName='check_progress'.

    Verifier feedback is now tagged toolName='attempt_completion'. The string
    'check_progress' is fine as a function name, span name, or import; only
    its use as a toolName VALUE is forbidden.
    """
    # Look for toolName: 'check_progress', "toolName": "check_progress",
    # or {"toolName": "check_progress"} variants.
    pat = re.compile(r"""toolName['"]?\s*[:=]\s*['"]check_progress['"]""")

    offenders: list[str] = []
    for path in _iter_production_py_files():
        try:
            text = path.read_text()
        except OSError:
            continue
        rel = str(path.relative_to(AGENTS_ROOT))
        for lineno, line in enumerate(text.splitlines(), start=1):
            if pat.search(line):
                offenders.append(f"{rel}:{lineno}: {line.strip()}")

    assert not offenders, (
        "Found production code emitting toolName='check_progress'. The "
        "verifier feedback message is now tagged toolName='attempt_completion' "
        "(see run_agent.py:1267 and workflow.blackbox.py). Replace the value "
        "with 'attempt_completion'.\n  " + "\n  ".join(offenders)
    )


def test_check_progress_is_canonical_verifier_entrypoint():
    """No production code calls _call_llm_verifier outside helpers/llm.py.

    `check_progress` is the canonical activity; it forces rose-1-ultra and
    handles telemetry. Calling `_call_llm_verifier` directly bypasses both.
    Only `helpers/llm.py` (where it's defined) and tests may reference it.
    """
    # Allow only direct attribute references that can't possibly be calls
    # — but we keep this simple: any reference outside helpers/llm.py and
    # tests/ is suspect. Comments and docstrings allowed in helpers/.
    pat = re.compile(r"\b_call_llm_verifier\b")

    offenders: list[str] = []
    for path in _iter_production_py_files():
        rel = str(path.relative_to(AGENTS_ROOT))
        # helpers/llm.py defines it, helpers/observability.py + providers/rose/streaming.py
        # mention it in module docstrings — allow those.
        if rel in {"helpers/llm.py", "helpers/observability.py", "providers/rose/streaming.py"}:
            continue
        try:
            text = path.read_text()
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if pat.search(line):
                offenders.append(f"{rel}:{lineno}: {line.strip()}")

    assert not offenders, (
        "Found production code referencing `_call_llm_verifier` outside "
        "helpers/llm.py. The canonical entrypoint is `check_progress` — it "
        "forces rose-1-ultra + telemetry. Direct `_call_llm_verifier` calls "
        "bypass both. Migrate to `check_progress` activity calls.\n  " + "\n  ".join(offenders)
    )


def test_production_scanner_excludes_only_registered_test_module_patterns():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for name in ("benchmarks/fixture_test.py", "benchmarks/test_fixture.py",
                     "benchmarks/producer.py", "helpers/producer_test.py"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("_call_llm_verifier()\n")
        previous = globals()["AGENTS_ROOT"]
        try:
            globals()["AGENTS_ROOT"] = root
            found = {str(path.relative_to(root)) for path in _iter_production_py_files()}
        finally:
            globals()["AGENTS_ROOT"] = previous
        assert found == {"benchmarks/producer.py", "helpers/producer_test.py"}


# ============================================================================
# 6. Browser-use catalog ↔ v3 prompt are in sync; envelope is {thinking, action}
# ----------------------------------------------------------------------------
# WHY: AVAILABLE_ACTIONS comes from the canonical Pydantic tool registry while
# BROWSER_USE_TOOLS carries rich provider-facing descriptions. Every registered
# action needs description metadata so the model is not given a valid schema
# with an empty or misleading explanation. Conversely, the model's
# JSON envelope is `{thinking, action}` only — the legacy fields
# (evaluation_previous_goal, memory, next_goal) inflate the response and were
# dropped.
# ============================================================================


def test_browser_use_v3_actions_in_catalog():
    """Every action listed in the v3 system prompt must exist in BROWSER_USE_TOOLS."""
    from providers.rose.browser_use import BROWSER_USE_TOOLS

    from browser_tools.schemas import AVAILABLE_ACTIONS

    missing = set(AVAILABLE_ACTIONS) - set(BROWSER_USE_TOOLS.keys())
    assert not missing, (
        f"AVAILABLE_ACTIONS contains action(s) {sorted(missing)} that are NOT "
        f"in BROWSER_USE_TOOLS catalog. The v3 prompt will advertise actions "
        f"with no description. Add them to BROWSER_USE_TOOLS in "
        f"providers/rose/browser_use.py."
    )


# Catalog-only actions that the v3 executor intentionally does NOT implement
# (and that therefore correctly do not appear in AVAILABLE_ACTIONS). Maintain
# this set explicitly so additions are conscious decisions.
_BROWSER_CATALOG_ONLY = {
    # `find_text` is in the rose-1-browser-use prompt for non-v3 callers but
    # not implemented by the v3 executor. Add it to AVAILABLE_ACTIONS or
    # remove from BROWSER_USE_TOOLS to drop this exemption.
    "find_text",
}


def test_browser_use_catalog_matches_v3_actions_or_is_exempt():
    """Every BROWSER_USE_TOOLS action must be in AVAILABLE_ACTIONS or explicitly exempt.

    Forces a conscious decision when adding to the catalog: either implement
    it in the v3 executor (preferred) or add it to the exempt set with a
    code comment explaining why.
    """
    from providers.rose.browser_use import BROWSER_USE_TOOLS

    from browser_tools.schemas import AVAILABLE_ACTIONS

    catalog_only = set(BROWSER_USE_TOOLS.keys()) - set(AVAILABLE_ACTIONS) - _BROWSER_CATALOG_ONLY
    assert not catalog_only, (
        f"BROWSER_USE_TOOLS contains action(s) {sorted(catalog_only)} that "
        f"are NOT in AVAILABLE_ACTIONS and NOT in the explicit "
        f"_BROWSER_CATALOG_ONLY exempt set. Either implement in the v3 "
        f"executor (browser_tools/schemas.py) and add to AVAILABLE_ACTIONS, "
        f"or add to _BROWSER_CATALOG_ONLY with a comment explaining why."
    )


def test_browser_use_prompt_requires_native_tool_call():
    """Browser-use must use native browser-action tool calls, not JSON envelopes."""
    from providers.rose.browser_use import build_browser_use_system_prompt

    prompt = build_browser_use_system_prompt([])
    assert "Return one or more browser action tool calls to execute sequentially." in prompt
    assert "Stop at first failure." in prompt
    assert "Use observation_ref only for targets bound by read_browser_state in the same response." in prompt
    assert "<output>" not in prompt
    forbidden = ("evaluation_previous_goal", "memory", "next_goal")
    for legacy in forbidden:
        legacy_key_pat = re.compile(rf'"{re.escape(legacy)}"\s*:')
        assert not legacy_key_pat.search(prompt), (
            f"Browser-use prompt advertises legacy required field '{legacy}'. Browser-use now uses native tools."
        )


# ============================================================================
# 7. Tool registry render is deterministic (B7)
# ----------------------------------------------------------------------------
# WHY: `render_tool_list(registry)` is the canonical way to stringify a tool
# registry for prompts that want a one-line-per-tool summary. Calling it twice
# with the same input MUST yield identical output (otherwise any prompt that
# embeds it becomes non-cacheable). Output is sorted-by-name and every
# registered tool produces a non-empty line.
# ============================================================================


def test_render_tool_list_is_deterministic():
    """render_tool_list(TOOL_MODELS) is byte-identical across calls.

    Anthropic prompt caching only reuses bytes-equal prefixes. If
    render_tool_list ever became non-deterministic (e.g. relying on
    dict insertion order, datetime, random), every prompt that embeds
    its output would lose cache hits.
    """
    from utils.tool_schemas import TOOL_MODELS, render_tool_list

    a = render_tool_list(TOOL_MODELS)
    b = render_tool_list(TOOL_MODELS)
    assert a == b, (
        "render_tool_list(TOOL_MODELS) is non-deterministic across calls. "
        "Inspect utils/tool_schemas.py:render_tool_list — its output must "
        "depend only on the registry contents, not insertion order, time, "
        "or any external state."
    )


def test_render_tool_list_is_sorted_by_name():
    """Output lines are alphabetically sorted by tool name.

    Sort order is what makes the renderer order-independent of dict
    insertion. If a future edit changes the default to insertion order
    (or reverses the sort), prompts may flip between cache-equivalent
    forms and bust the cache the first time the registry mutates.
    """
    from utils.tool_schemas import TOOL_MODELS, render_tool_list

    rendered = render_tool_list(TOOL_MODELS)
    names = [line.split(":", 1)[0].removeprefix("- ").strip() for line in rendered.splitlines()]
    assert names == sorted(names), (
        f"render_tool_list output is not sorted by tool name: {names}. "
        "Default behavior must be `sort=True` so the listing is "
        "registry-insertion-order-independent."
    )


def test_render_tool_list_every_tool_produces_a_nonempty_line():
    """Every tool in the registry produces a non-empty `- name: description` line.

    A missing/empty description silently shrinks the listing and makes
    debugging hard. The renderer falls back through TOOL_PROMPTS first
    line -> Pydantic docstring first line -> "No description"; this
    test enforces that the chain always yields something for every tool.
    """
    from utils.tool_schemas import TOOL_MODELS, render_tool_list

    rendered = render_tool_list(TOOL_MODELS)
    lines = rendered.splitlines()
    assert len(lines) == len(TOOL_MODELS), (
        f"render_tool_list emitted {len(lines)} lines for "
        f"{len(TOOL_MODELS)} registered tools. Every tool must produce "
        "exactly one line."
    )
    for line in lines:
        assert line.startswith("- "), (
            f"render_tool_list line does not start with '- ': {line!r}. "
            "Format must be '- {tool_name}: {description}'."
        )
        # Each line must have a `:` separating name from description and
        # a non-empty description after it.
        assert ":" in line, f"render_tool_list line is missing ':': {line!r}"
        _, description = line.split(":", 1)
        assert description.strip(), (
            f"render_tool_list line has empty description: {line!r}. "
            "The TOOL_PROMPTS / docstring / fallback chain must always "
            "produce a non-empty description."
        )


# ============================================================================
# 8. _VERIFIER_STATIC_PROMPT clears Anthropic's 1024-token cache-write threshold
# ----------------------------------------------------------------------------
# WHY: Anthropic prompt caching only writes a cache entry for prefixes that
# meet a minimum token count (1024 tokens for non-extended cache, per their
# docs). The verifier's static block is INTENTIONALLY padded above this
# threshold so every check_progress call shares one cached prefix. If a
# future trim drops the static block below ~4096 chars (a conservative
# estimate for 1024 tokens — a token averages ~4 characters across English
# prose), every verifier call regresses from cache-read to cache-write, and
# the workflow burns an extra cache-creation charge per phase.
# ============================================================================


def test_verifier_static_prompt_clears_anthropic_cache_threshold():
    """_VERIFIER_STATIC_PROMPT must be ≥ 4096 chars (the 1024-token cache-write floor).

    Anthropic prompt-cache write minimum is 1024 tokens. The verifier static
    block is intentionally padded above this threshold so every verifier call
    site shares one cached prefix. If a future edit drops below ~4096 chars
    (rough conservative estimate for 1024 tokens), every verifier call
    becomes a cache-write — regressing cost and latency tree-wide.
    """
    from utils.prompts import _VERIFIER_STATIC_PROMPT

    chars = len(_VERIFIER_STATIC_PROMPT)
    assert chars >= 4096, (
        f"_VERIFIER_STATIC_PROMPT shrunk to {chars} chars; below the ~4096 "
        f"safe threshold for Anthropic's 1024-token cache write minimum. "
        f"Add content or accept that every verifier call writes a fresh cache."
    )


def test_verifier_credits_completed_sub_agent_results_as_evidence():
    """A delegating agent's verifier treats a child's reported findings as evidence.

    The execute verifier never receives a sub-agent's own tool rows (they are
    scoped out of the parent's context), so the child's spawn_agent result /
    FINAL_ANSWER notification is the only evidence a delegating agent can have.
    Replay of the explore-agent-mid-run-message b1cff031 verifier call: with
    the old "do not treat this as evidence for a positive fact" wording it
    scored 0.0 twice out of three ("only the agent's summary"); with this rule
    it scored 1.0 three out of three.
    """
    from utils.prompts import _VERIFIER_STATIC_PROMPT

    assert "grounded evidence for positive facts" in _VERIFIER_STATIC_PROMPT
    assert "sub-agent's own tool\n   calls are never shown to you" in _VERIFIER_STATIC_PROMPT
    assert "Do not treat this as evidence for a positive fact" not in _VERIFIER_STATIC_PROMPT


# ============================================================================
# 9. TS-side static system prompts have no dynamic dates inside their template
#    literal (cache-killer mirror of the Python invariant in section 1).
# ----------------------------------------------------------------------------
# WHY: TS prompt builders mark their cacheable prefix with the
# `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel. Anything BEFORE the boundary
# inside a backtick template literal is supposed to be byte-identical across
# calls — same rule as the Python side. A `${new Date()}` or `${Date.now()}`
# interpolation before the boundary kills the cache for every call site that
# uses the prompt. Timing variables outside template literals (e.g.
# `const startTime = Date.now()`) are fine and ignored.
# ============================================================================


def test_ts_prompt_files_have_no_dynamic_dates_in_system_blocks():
    """No `${new Date(...)}` or `${Date.now()}` inside a STATIC system-prompt
    template literal (one that ends in SYSTEM_PROMPT_DYNAMIC_BOUNDARY — the
    explicit "this is a cacheable prefix" sentinel).

    A timestamp interpolated into a backtick prompt prefix breaks Anthropic
    prompt caching for every downstream LLM call. Per-call state belongs in
    a separately-built USER message (e.g. `assembleContextUserMessage` in
    contextBuilder.ts builds a per-SMS user-role message and is intentionally
    dynamic — that's NOT a violation), not in the cacheable static prefix.

    We only flag literals that explicitly tag themselves cacheable via the
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker, so user-message builders in the
    same file (like `assembleContextUserMessage`) are correctly skipped.
    """
    repo = AGENTS_ROOT.parent
    suspicious_files = [
        repo / "back-end/src/providers/smsSupervisor/contextBuilder.ts",
        repo / "back-end/src/providers/chat/chatPrompts.ts",
        repo / "back-end/src/providers/chat/routerLlm.ts",
        repo / "back-end/src/providers/chat/generatorLlm.ts",
    ]
    # Match `${...new Date(...)...}` or `${...Date.now()...}` inside a `${...}`
    # interpolation. We don't fully parse template literals — we look for the
    # interpolation marker followed by a date construct. Bare timing variables
    # OUTSIDE template literals (e.g. `const startTime = Date.now()`) are not
    # cache-killers and are not matched.
    interp_date_pat = re.compile(r"\$\{[^}]*(?:new Date\(|Date\.now\()")
    # Sentinel that marks the end of the cacheable static prefix. We only
    # treat literals that contain this sentinel as cache-relevant.
    boundary_marker = "SYSTEM_PROMPT_DYNAMIC_BOUNDARY"

    bad: list[str] = []
    for fp in suspicious_files:
        if not fp.exists():
            continue
        text = fp.read_text()
        # Walk the file char-by-char, skipping comments, and capture each
        # backtick template literal with its starting line number. We only
        # flag interpolations that occur BEFORE the boundary marker inside a
        # literal that DOES contain the marker (i.e. literals explicitly
        # marked as cacheable system-prompt prefixes).
        i = 0
        line_no = 1
        n = len(text)
        while i < n:
            ch = text[i]
            if ch == "\n":
                line_no += 1
            # Skip line comments.
            if ch == "/" and i + 1 < n and text[i + 1] == "/":
                while i < n and text[i] != "\n":
                    i += 1
                continue
            # Skip block comments.
            if ch == "/" and i + 1 < n and text[i + 1] == "*":
                i += 2
                while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                    if text[i] == "\n":
                        line_no += 1
                    i += 1
                i += 2
                continue
            # Enter a template literal.
            if ch == "`":
                start_line = line_no
                start = i + 1
                i += 1
                depth = 0
                while i < n:
                    c = text[i]
                    if c == "\n":
                        line_no += 1
                    # Nested expression via ${...} — track to find the matching `.
                    if c == "$" and i + 1 < n and text[i + 1] == "{":
                        depth += 1
                        i += 2
                        continue
                    if c == "}" and depth > 0:
                        depth -= 1
                        i += 1
                        continue
                    if c == "\\" and i + 1 < n:
                        i += 2
                        continue
                    if c == "`" and depth == 0:
                        break
                    i += 1
                literal = text[start:i]
                # Only enforce on cacheable system-prompt literals (those
                # marked with SYSTEM_PROMPT_DYNAMIC_BOUNDARY). Other backtick
                # literals (per-call user messages, log strings, etc.) are
                # off-topic and should not be flagged.
                if boundary_marker in literal:
                    cacheable_prefix = literal.split(boundary_marker)[0]
                    if interp_date_pat.search(cacheable_prefix):
                        bad.append(
                            f"{fp.name}:{start_line} static system-prompt "
                            f"template literal contains a "
                            f"`${{... new Date(...) ...}}` or "
                            f"`${{... Date.now() ...}}` interpolation BEFORE "
                            f"SYSTEM_PROMPT_DYNAMIC_BOUNDARY. Move the "
                            f"timestamp into the per-call USER message "
                            f"(below the boundary) — interpolating it into "
                            f"the cacheable prefix kills prompt-cache hits."
                        )
                i += 1  # consume the closing backtick
                continue
            i += 1

    assert not bad, (
        "Found dynamic dates inside static system-prompt template literals "
        "in TS prompt files. Same rule as the Python side — timestamps belong "
        "on per-call USER messages, not in the cacheable system prefix.\n  " + "\n  ".join(bad)
    )


# ============================================================================
# 11. Style guardrails: em-dashes, banned phrases, marketing adjectives
# ----------------------------------------------------------------------------
# WHY: The main agent system prompt explicitly bans em-dashes in agent output
# ("Do not use em dashes"). Honoring that ban is impossible if the prompt
# source files themselves use em-dashes. Same for marketing adjectives
# ("powerful", "advanced", "comprehensive", etc.) which the team tagged as
# noise-words during the prompt audit, and hedge phrases that bias the
# planner/agent toward indecision ("Feel free to", "Consider whether",
# "you may want to"). "superintelligence" framing was dropped during the
# rebrand so it cannot creep back into prompt copy.
#
# These checks are deliberately tolerant: they parse files with `ast` so
# that docstrings, code comments, and log/exception messages are NOT flagged.
# Only string literals that are LITERAL prompt content (Field(description=...),
# top-level prompt constants, dedent() blocks) are inspected. False-negatives
# are preferred over false-positives — a sensational adjective that slips
# through is much less harmful than a passing test that fails on a logger
# string and forces a bypass.
# ============================================================================


# Files in scope for the style guardrails. These are the files the prompt
# audit listed as containing live prompt content (system prompts, tool
# prompts, Pydantic Field descriptions that surface in tool schemas).
def _style_check_paths() -> list[Path]:
    paths = [
        AGENTS_ROOT / "utils" / "prompts.py",
        AGENTS_ROOT / "utils" / "tool_schemas.py",
        AGENTS_ROOT / "providers" / "rose" / "browser_use.py",
        AGENTS_ROOT / "domains" / "spawn_browser_agent_v3" / "service.py",
        AGENTS_ROOT / "domains" / "spawn_claude_code_agent" / "service.py",
        AGENTS_ROOT / "domains" / "message_person" / "repo.py",
        AGENTS_ROOT / "domains" / "param_populator" / "service.py",
        AGENTS_ROOT / "domains" / "param_populator" / "config.py",
    ]
    paths += sorted(PROMPTS_DIR.glob("*.py"))
    return [p for p in paths if p.exists()]


def _docstring_line_ranges(tree: ast.AST) -> list[tuple[int, int]]:
    """Return (start, end) line ranges for every docstring in `tree`.

    A docstring is the first statement in a module/function/class body that
    is an `ast.Expr` wrapping an `ast.Constant(str)`. Multi-line triple-quoted
    docstrings span many lines; we use `lineno..end_lineno` so callers can
    test "is this line inside a docstring."
    """
    ranges: list[tuple[int, int]] = []

    def _walk(node: ast.AST) -> None:
        body = getattr(node, "body", None)
        if isinstance(body, list) and body:
            first = body[0]
            if (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
            ):
                end = first.end_lineno or first.lineno
                ranges.append((first.lineno, end))
        for child in ast.iter_child_nodes(node):
            _walk(child)

    _walk(tree)
    return ranges


# Function names whose string-literal arguments are NOT prompt content
# (logger calls, error/exception messages, print). When a string lives
# inside one of these calls, skip it for style checks.
_NON_PROMPT_CALL_FUNCS = {
    "error",
    "info",
    "warning",
    "debug",
    "critical",
    "exception",
    "log",
}
_NON_PROMPT_CALL_NAMES = {"print"}


def _is_non_prompt_call(node: ast.Call) -> bool:
    """True if a Call's string arguments are log/print/exception messages, not prompts."""
    func = node.func
    # logger.error(...), self.logger.info(...), structlog.get_logger().info(...)
    if isinstance(func, ast.Attribute):
        if func.attr in _NON_PROMPT_CALL_FUNCS:
            return True
        # Common pattern: msg.format(...), str.format() — keep these checked
    # print(...)
    if isinstance(func, ast.Name) and func.id in _NON_PROMPT_CALL_NAMES:
        return True
    return False


def _iter_prompt_string_literals(text: str):
    """Yield (lineno, value) for every string literal that is plausibly prompt content.

    Skips:
      - Docstrings (first statement of module/function/class body)
      - String args inside logger.* / print / exception-raise calls
      - Strings on lines starting with `#` (whole-line comments, defensive
        — AST shouldn't produce comment-as-string anyway)

    Yields all other string constants — these are the strings users actually
    see in LLM prompts (Field descriptions, dedent blocks, top-level
    PROMPT/_PROMPT/SYSTEM constants).
    """
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return
    docstring_ranges = _docstring_line_ranges(tree)

    def _in_docstring(line_no: int) -> bool:
        return any(s <= line_no <= e for s, e in docstring_ranges)

    # Build a set of node ids whose subtree is "non-prompt context"
    # (logger / print / raise). We track via a NodeVisitor walk that
    # marks a Call's children with "skip" while recursing.
    skip_strings: set[int] = set()

    class _ContextWalker(ast.NodeVisitor):
        def __init__(self):
            self.skip_depth = 0

        def visit(self, node: ast.AST) -> None:
            push = False
            if isinstance(node, ast.Call) and _is_non_prompt_call(node):
                push = True
                self.skip_depth += 1
            if isinstance(node, ast.Raise):
                push = True
                self.skip_depth += 1
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if self.skip_depth > 0:
                    skip_strings.add(id(node))
            self.generic_visit(node)
            if push:
                self.skip_depth -= 1

    _ContextWalker().visit(tree)

    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
            continue
        if id(node) in skip_strings:
            continue
        if _in_docstring(node.lineno):
            continue
        yield node.lineno, node.value


def test_no_em_dashes_in_prompt_strings():
    """No em-dash (U+2014) or en-dash (U+2013) in prompt-source string literals.

    The main system prompt instructs the agent: "Do not use em dashes in any
    output. Use hyphens (-) or commas instead." That instruction can only be
    enforced if the prompt SOURCE FILES themselves don't use em-dashes —
    otherwise the agent reads em-dashes in its own system prompt and learns
    they're acceptable.

    Tolerant by design: docstrings, comments, and log/exception messages are
    skipped (they never reach the LLM). Only string literals that are
    plausibly prompt content (Field descriptions, dedent blocks, PROMPT
    constants) are inspected.
    """
    bad: list[str] = []
    for path in _style_check_paths():
        text = path.read_text()
        for lineno, value in _iter_prompt_string_literals(text):
            if "—" in value or "–" in value:
                # Find the first offending substring for a tight error message.
                snippet = value.replace("\n", " ")[:120]
                rel = path.relative_to(AGENTS_ROOT)
                bad.append(f"{rel}:{lineno}: {snippet!r}")

    assert not bad, (
        "Em-dashes (— or –) found in prompt-source string literals. "
        "The main agent system prompt bans em-dashes in output; the ban only "
        "holds if the prompt sources themselves use hyphens or commas. "
        "Replace each em-dash with ' - ' or ', '. Offenders:\n  " + "\n  ".join(bad[:40])
    )


# (phrase, case_sensitive) — full-string match performed case-INSENSITIVELY
# unless explicitly marked. Marketing adjectives use a strict-word-boundary
# regex (defined inline in the test) so hyphenated negations like
# "non-comprehensive" are NOT flagged.
_BANNED_HEDGE_PHRASES = (
    "as currently wired",
    "this is very important",
    "feel free to",
    "consider whether",
    "you may want to",
)
_BANNED_BRAND_TERMS = ("superintelligence", "superintelligent")
# Marketing adjectives. Tolerated only inside docstrings/comments/log strings
# (filtered out by _iter_prompt_string_literals); flagged in actual prompts.
_BANNED_MARKETING_ADJECTIVES = (
    "powerful",
    "advanced",
    "comprehensive",
    "robust",
    "seamless",
)


_ENV_SIZE_SKILL = (
    AGENTS_ROOT.parent / "back-end" / "src" / "assets" / "rose-skills" / "change-environment-size" / "SKILL.md"
)


def test_change_environment_size_skill_guards_against_runaways():
    """C16: the change-environment-size skill says when NOT to resize, not only when to.

    A bigger sandbox hides a runaway process, an infinite loop or a leak. The
    skill must send the code agent to kill, fix or clean up first, to look at
    `rose env status` before asking, and to downsize after the heavy phase.
    It is read by the code-agent CLI, so it follows the prompt style rules.
    """
    text = _ENV_SIZE_SKILL.read_text()
    front = re.match(r"^---\nname: change-environment-size\ndescription: (Use [^\n]+)\n---\n", text)
    assert front, "SKILL.md needs frontmatter: name change-environment-size and a one-line 'Use ...' description"
    assert len(front.group(1)) < 160, f"description must stay one short line: {front.group(1)!r}"
    lower = text.lower()
    for needle in (
        "## when to use",
        "## when not to use",
        "runaway",
        "leak",
        "kill",
        "rose env status",
        "rose env size",
        "--reason",
        "downsize",
        "continues automatically",
    ):
        assert needle in lower, f"SKILL.md must cover {needle!r}"
    assert "\u2014" not in text and "\u2013" not in text, "no em-dashes or en-dashes in the skill"
    for phrase in _BANNED_HEDGE_PHRASES + _BANNED_BRAND_TERMS:
        assert phrase not in lower, f"banned phrase {phrase!r} in the skill"


_AGENT_GRAPH_SKILL = AGENTS_ROOT.parent / "back-end" / "src" / "assets" / "rose-skills" / "agent-graph" / "SKILL.md"


def test_agent_graph_skill_states_when_messages_reach_a_code_agent():
    """The agent-graph skill matches the ws-server delivery contract.

    ws-server.mjs merges a message that arrives while the CLI works into the
    running turn, and ends stdin when an autonomous turn finishes (a later
    turn is rejected session_ended). The skill promised the opposite
    ("arrive as a new user turn after your current turn"), so a code agent
    that asked its parent a question and ended its turn never got the answer.
    """
    text = _AGENT_GRAPH_SKILL.read_text()
    lower = " ".join(text.lower().split())
    assert "after your current turn" not in lower, "a finished turn receives no later messages"
    for needle in ("while you are still working", "added to your current turn", "your run is over"):
        assert needle in lower, f"agent-graph SKILL.md must say {needle!r}"
    assert "\u2014" not in text and "\u2013" not in text, "no em-dashes or en-dashes in the skill"


def test_no_banned_phrases_in_prompt_strings():
    """Banned phrases must not appear in prompt-source string literals.

    Three classes of forbidden content:

    1. Hedge phrases ("Feel free to", "Consider whether", "you may want to",
       "as currently wired", "This is very important") — these bias the
       agent toward indecision or import private engineering context into
       its public-facing system prompt.
    2. "superintelligence" / "superintelligent" — dropped during the rebrand;
       "agent" / "spawn_agent" are the correct terms.
    3. Marketing adjectives ("powerful", "advanced", "comprehensive", "robust",
       "seamless") — agreed-on noise-words during the prompt audit.

    Tolerant by design: docstrings, comments, and log strings are skipped.
    Marketing adjectives use a strict word-boundary regex so legitimate
    compounds (e.g. "non-comprehensive") are NOT flagged.
    """
    # Hedge / brand: simple substring (case-insensitive) is fine because
    # they don't have natural compound forms.
    hedge_pats = [(re.compile(re.escape(p), re.IGNORECASE), p) for p in _BANNED_HEDGE_PHRASES]
    brand_pats = [(re.compile(re.escape(p), re.IGNORECASE), p) for p in _BANNED_BRAND_TERMS]
    # Marketing adjectives: require word-boundary that EXCLUDES hyphens, so
    # "non-comprehensive" / "high-performance" doesn't trip the check. The
    # boundary chars are whitespace, punctuation, or string start/end —
    # but NOT a hyphen.
    bdry = r"(?:^|(?<=[\s,.;:!?\"'()/\[\]]))"
    bdry_end = r"(?=[\s,.;:!?\"'()/\[\]]|$)"
    marketing_pats = [
        (
            re.compile(rf"{bdry}{re.escape(adj)}{bdry_end}", re.IGNORECASE),
            adj,
        )
        for adj in _BANNED_MARKETING_ADJECTIVES
    ]

    bad: list[str] = []
    for path in _style_check_paths():
        text = path.read_text()
        rel = path.relative_to(AGENTS_ROOT)
        for lineno, value in _iter_prompt_string_literals(text):
            for pat, phrase in hedge_pats + brand_pats + marketing_pats:
                if pat.search(value):
                    snippet = value.replace("\n", " ")[:120]
                    bad.append(f"{rel}:{lineno} [{phrase}]: {snippet!r}")
                    break  # one hit per string is enough to report the file

    assert not bad, (
        "Banned phrases / marketing adjectives found in prompt-source string "
        "literals. Hedge phrases bias the agent toward indecision; brand-term "
        "drift undoes the rebrand; marketing adjectives are noise words. "
        "Rewrite the offending strings.\n  " + "\n  ".join(bad[:40])
    )


# ============================================================================
# 12. No restating-the-schema / broken cross-refs in tool prompts
# ----------------------------------------------------------------------------
# WHY: Each tool's Pydantic model is the source of truth for its parameter
# schema. Tool-level prompts that restate the schema ("REQUIRED ARGS: None")
# duplicate information and create drift opportunities — the planner reads
# the duplicated copy and can mis-call when the Pydantic schema evolves.
# Similarly, "DIFFERS FROM spawn_agent IN: ..." sections in alias prompts
# reference a sibling prompt the planner audience never sees: the audience
# only loads the alias prompt, not the unified spawn_agent prompt.
# ============================================================================


def test_no_required_args_none_in_tool_prompts():
    """Tool prompts must not restate the empty-schema phrase 'REQUIRED ARGS: None.'

    `attempt_completion` and similar parameterless tools have their
    no-args contract documented in the Pydantic model. Restating
    "REQUIRED ARGS: None." in the prompt fragment duplicates the schema
    and creates drift surface. Per gold-standard rule 10.
    """
    bad: list[str] = []
    for p in PROMPTS_DIR.glob("*.py"):
        text = p.read_text()
        for lineno, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if "REQUIRED ARGS: None" in line or "TAKES NO PARAMETERS" in line:
                bad.append(f"{p.name}:{lineno}: {stripped[:120]}")
    assert not bad, (
        "Tool prompts restate empty-schema phrasings ('REQUIRED ARGS: None' "
        "/ 'TAKES NO PARAMETERS'). The Pydantic model is the source of truth "
        "for parameter requirements; restating it in the prompt creates "
        "drift surface. Remove these phrases — the LLM sees the empty model "
        "schema directly.\n  " + "\n  ".join(bad)
    )


def test_no_differs_from_spawn_agent_cross_refs():
    """Planner-alias prompts must not reference the unified spawn_agent prompt.

    Aliases like spawn_browser_agent and spawn_code_agent are loaded for the
    PLANNER audience, which never sees the unified spawn_agent prompt
    fragment. A 'DIFFERS FROM spawn_agent IN: ...' section is therefore
    a broken cross-reference that confuses the planner without adding
    information.
    """
    bad: list[str] = []
    for p in PROMPTS_DIR.glob("*.py"):
        text = p.read_text()
        if "DIFFERS FROM spawn_agent" in text:
            bad.append(str(p.relative_to(AGENTS_ROOT)))
    assert not bad, (
        "Planner-alias prompts reference 'DIFFERS FROM spawn_agent' but the "
        "planner audience never sees the unified spawn_agent prompt. The "
        "cross-reference is broken. Either drop the section or move the "
        "differentiating content into the alias prompt directly.\n  " + "\n  ".join(bad)
    )


# ============================================================================
# 13. ALL-CAPS underlined section labels banned in rendered prompts
# ----------------------------------------------------------------------------
# WHY: Markdown headings (`# Section Name`) are the canonical layout for
# every prompt the agent sees. ALL-CAPS labels followed by `----` underlines
# (RST/asciidoc style) are visually noisy, easier to mistakenly match in
# logger output, and harder to nest. Per gold-standard rule C1.
# ============================================================================


def test_no_all_caps_underlined_section_labels_in_prompts():
    """Rendered prompts must not contain ALL-CAPS lines followed by `----` underlines.

    Section headers must use markdown heading syntax (`# H1`, `## H2`).
    ALL-CAPS labels followed by a `----` (or `====`) underline are an old
    asciidoc/RST convention that escaped from the historical prompt files;
    removed during the audit.
    """
    from providers.rose.browser_use import build_browser_use_system_prompt

    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt
    from utils.prompts import (
        EXPLORE_AGENT_SYSTEM_PROMPT,
        build_planner_system_prompt,
        build_system_prompt,
        build_verifier_prompt,
    )

    # Pattern: ALL-CAPS line of >=3 chars, followed by a line of >=4 dashes
    # or equals signs. The label must be uppercase letters/spaces/slashes/
    # dashes — disallow lowercase.
    label_pat = re.compile(r"^[A-Z][A-Z0-9\s/_\-]{2,40}$")
    underline_pat = re.compile(r"^[-=]{4,}$")

    bad: list[str] = []
    rendered = {
        "main": build_system_prompt("EXECUTE", ["attempt_completion"]),
        "planner": build_planner_system_prompt("desc"),
        "verifier": build_verifier_prompt(),
        "explore": EXPLORE_AGENT_SYSTEM_PROMPT,
        "browser_use": build_browser_use_system_prompt(["click"]),
        "browser_v3": get_browser_system_prompt("a" * 60, custom_instructions="", available_files=[]),
    }
    for name, prompt in rendered.items():
        lines = prompt.splitlines()
        for i in range(len(lines) - 1):
            label = lines[i].strip()
            under = lines[i + 1].strip()
            if label_pat.match(label) and underline_pat.match(under):
                bad.append(f"{name}: line {i + 1}: {label!r} / {under!r}")

    assert not bad, (
        "Rendered prompts contain ALL-CAPS labels followed by `----` / `====` "
        "underlines. Use markdown headings (`# Section`, `## Subsection`) "
        "instead. Offenders:\n  " + "\n  ".join(bad)
    )


# ============================================================================
# 14. Canonical rule constants are imported, not duplicated
# ----------------------------------------------------------------------------
# WHY: SELF_CONTAINED_GOAL_RULE / EPHEMERAL_SESSION_RULE / etc. are defined
# once in agents/utils/prompts.py and imported by every site that needs
# them. Reproducing the same prose verbatim in another file is drift surface:
# editing one copy doesn't fix the other, and the planner / verifier / tool
# prompts can quietly disagree on the rule. Per gold-standard rule B1.
# ============================================================================


# (constant name, distinctive substring) — the substring is long enough that
# it can't appear by chance and short enough that it survives minor edits to
# the surrounding rule body.
_CANONICAL_RULE_FINGERPRINTS: tuple[tuple[str, str], ...] = (
    ("SELF_CONTAINED_GOAL_RULE", "Spawned agents have NO access to your conversation"),
    ("EPHEMERAL_SESSION_RULE", "spawn_agent(type=browser/code) sessions are ephemeral"),
    ("CONTEXT_POINTERS_RULE", "Reference: @ref:message:"),
    ("FILE_HANDLING_RULE", "Use type='file_pointer' for file outputs"),
    ("CRITICAL_CONSTRAINTS_RULE", "PARALLEL EXECUTION: tool calls in one response"),
)


def test_canonical_rules_not_duplicated():
    """Canonical rule prose must not be reproduced verbatim outside utils/prompts.py.

    Each rule is defined as a module-level constant in agents/utils/prompts.py.
    Other prompt sites must IMPORT the constant — never copy the prose. If
    a file contains the distinctive substring of a rule and does NOT import
    the constant, that's drift waiting to happen.
    """
    bad: list[str] = []
    canonical_file = AGENTS_ROOT / "utils" / "prompts.py"
    for path in _style_check_paths():
        if path == canonical_file:
            continue  # The source of truth is allowed to contain its own rules.
        text = path.read_text()
        rel = path.relative_to(AGENTS_ROOT)
        for const_name, fingerprint in _CANONICAL_RULE_FINGERPRINTS:
            if fingerprint not in text:
                continue
            # Allow if the constant is imported from utils.prompts.
            import_pat = re.compile(
                rf"from\s+utils\.prompts\s+import\s+\([^)]*\b{re.escape(const_name)}\b[^)]*\)"
                rf"|from\s+utils\.prompts\s+import\s+[^()\n]*\b{re.escape(const_name)}\b"
            )
            if import_pat.search(text):
                continue
            bad.append(f"{rel}: contains {const_name!r} prose without importing it")

    assert not bad, (
        "Canonical rule prose duplicated outside utils/prompts.py without "
        "importing the constant. Every site must import the canonical "
        "constant — copy/paste creates drift surface. Add a "
        "`from utils.prompts import <CONST>` line and reference it via "
        "f-string interpolation.\n  " + "\n  ".join(bad)
    )


# ============================================================================
# 15. Cacheable-static prompts mark the dynamic boundary
# ----------------------------------------------------------------------------
# WHY: Anthropic prompt caching only reuses bytes-equal prefixes. We mark
# the end of the cacheable prefix with SYSTEM_PROMPT_DYNAMIC_BOUNDARY in
# every prompt that mixes static (cacheable) and per-call dynamic content.
# Without the boundary, `transform_messages_for_anthropic` cannot split the
# system prompt into static_system + dynamic_system, and per-call data
# poisons the cache.
# ============================================================================


def test_system_prompt_boundary_marker_present():
    """Prompts that mix static + dynamic data must contain the boundary marker.

    `build_system_prompt`, `build_planner_system_prompt`, `build_verifier_prompt`,
    and `get_browser_system_prompt` all interpolate per-call data (phase,
    user context, goal, custom instructions). Each MUST split via
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY so the static prefix is cacheable.

    `EXPLORE_AGENT_SYSTEM_PROMPT` and `build_browser_use_system_prompt` are
    permitted to be entirely static (no per-call interpolation) — they're
    only included here so a regression that adds dynamic data without a
    boundary trips this test.
    """
    from providers.rose.browser_use import build_browser_use_system_prompt

    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt
    from utils.prompts import (
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        build_planner_system_prompt,
        build_system_prompt,
        build_verifier_prompt,
    )

    boundary = SYSTEM_PROMPT_DYNAMIC_BOUNDARY.strip()

    must_have_boundary = {
        "main_execute": build_system_prompt("EXECUTE", ["attempt_completion"]),
        "main_plan": build_system_prompt("PLAN", ["set_plan"]),
        "planner": build_planner_system_prompt("desc"),
        "verifier": build_verifier_prompt(),
        "browser_v3": get_browser_system_prompt("a" * 60, custom_instructions="", available_files=[]),
    }
    missing = [name for name, p in must_have_boundary.items() if boundary not in p]
    assert not missing, (
        f"System prompts {missing} are missing SYSTEM_PROMPT_DYNAMIC_BOUNDARY. "
        f"Each prompt that interpolates per-call data must split via the "
        f"boundary marker so the static prefix can be served from "
        f"Anthropic's prompt cache. Without the boundary, "
        f"transform_messages_for_anthropic cannot separate static_system "
        f"from dynamic_system, and every call writes a fresh cache entry."
    )

    # Browser-use catalog prompt is allowed to be fully static (it has no
    # per-call interpolation by design); only assert it doesn't try to mix
    # dynamic data into a static prompt without marking the boundary.
    fully_static = {
        "browser_use_catalog": build_browser_use_system_prompt(["click"]),
    }
    for name, p in fully_static.items():
        if boundary in p:
            continue
        # If no boundary, the prompt must be entirely static. Spot-check
        # that no obvious per-call placeholders survived (e.g. literal
        # "{goal}" / "{custom_instructions}" tokens).
        for placeholder in ("{goal}", "{custom_instructions}", "{user_context}"):
            assert placeholder not in p, (
                f"{name} appears static (no SYSTEM_PROMPT_DYNAMIC_BOUNDARY) but "
                f"still contains placeholder {placeholder!r}. Either render "
                f"the placeholder before returning OR add a boundary marker "
                f"and split the dynamic section below it."
            )


# ============================================================================
# 16. ALL-CAPS markers (IMPORTANT/CRITICAL/MUST/etc.) capped per prompt
# ----------------------------------------------------------------------------
# WHY: ALL-CAPS markers are a finite resource. The first few catch the
# reader's eye; sprinkling them across every paragraph dilutes attention
# and trains the agent to ignore them. Gold-standard policy: reserve them
# for true correctness gates ("MUST be the only tool in that turn").
# ============================================================================


def test_all_caps_marker_count_under_limit():
    """Each rendered system prompt has <=10 ALL-CAPS markers.

    We tolerate up to 10 per prompt. The audit averaged ~4 per prompt; the
    limit is generous to allow legitimate correctness gates without forcing
    a constant grooming chore.
    """
    from providers.rose.browser_use import build_browser_use_system_prompt

    from domains.spawn_browser_agent_v3.service import get_browser_system_prompt
    from utils.prompts import (
        EXPLORE_AGENT_SYSTEM_PROMPT,
        build_planner_system_prompt,
        build_system_prompt,
        build_verifier_prompt,
    )

    pat = re.compile(r"\b(IMPORTANT|CRITICAL|MUST|NEVER|ALWAYS)\b")
    LIMIT = 10

    rendered = {
        "main_execute": build_system_prompt("EXECUTE", ["attempt_completion"]),
        "main_plan": build_system_prompt("PLAN", ["set_plan"]),
        "planner": build_planner_system_prompt("desc"),
        "verifier": build_verifier_prompt(),
        "explore": EXPLORE_AGENT_SYSTEM_PROMPT,
        "browser_use": build_browser_use_system_prompt(["click"]),
        "browser_v3": get_browser_system_prompt("a" * 60, custom_instructions="", available_files=[]),
    }
    too_many = []
    for name, prompt in rendered.items():
        matches = pat.findall(prompt)
        if len(matches) > LIMIT:
            too_many.append(f"{name}: {len(matches)} markers ({sorted(set(matches))})")

    assert not too_many, (
        f"Rendered prompts have >{LIMIT} ALL-CAPS markers (IMPORTANT, CRITICAL, "
        f"MUST, NEVER, ALWAYS). Caps are a scarce attention resource — reserve "
        f"them for true correctness gates. Either rewrite the bullet without "
        f"a marker, or fold related rules into a single bullet.\n  " + "\n  ".join(too_many)
    )


def test_planner_depends_on_schema_matches_prompt_contract():
    """Planner task dependency IDs are strings in both prompt text and response schema."""
    from helpers.llm import prepare_schema_for_openai
    from utils.prompts import (
        PLANNER_OUTPUT_ARG_DESCRIPTIONS,
        PLANNER_TASK_DEPENDS_ON_DESCRIPTION,
        PLANNER_TASK_IDX_DESCRIPTION,
        build_planner_system_prompt,
    )
    from utils.tool_schemas import PlannerResponse

    prompt = build_planner_system_prompt("tool descriptions here")
    assert "tasks[i].task_idx is the 0-based array index encoded as a string" in prompt
    assert "tasks[i].depends_on lists indices of tasks that must complete first" in prompt
    assert "If one task needs another task's output, state, credentials, artifact, or decision" in prompt
    assert "Empty depends_on means the task can start immediately" in prompt
    assert "Causal handoff: Step 0 gather facts" in prompt
    assert 'Use 0-based indices as strings ("0", "1", ...)' in prompt
    assert "dependencies_graph" not in prompt
    assert "# Output Field Descriptions" in prompt
    assert PLANNER_OUTPUT_ARG_DESCRIPTIONS in prompt
    assert "Use an empty list only when the task can start immediately" in PLANNER_TASK_DEPENDS_ON_DESCRIPTION

    schema = prepare_schema_for_openai(PlannerResponse)
    assert "reasoning" not in schema["properties"]
    assert "content" not in schema["properties"]
    assert "dependencies_graph" not in schema["properties"]
    task_schema = schema["properties"]["tasks"]["items"]
    task_idx = task_schema["properties"]["task_idx"]
    assert "task_idx" in task_schema["required"]
    assert task_idx["type"] == "string"
    assert task_idx["description"] == PLANNER_TASK_IDX_DESCRIPTION
    depends_on = task_schema["properties"]["depends_on"]
    assert depends_on["type"] == "array"
    assert depends_on["items"]["type"] == "string"
    assert depends_on["description"] == PLANNER_TASK_DEPENDS_ON_DESCRIPTION


def test_planner_routes_retrieval_before_stateful_execution():
    """Planner and runtime tool descriptions share the explore-before-browser contract."""
    from tools.prompts.spawn_agent import PROMPT as SPAWN_AGENT_PROMPT
    from utils.prompts import build_planner_system_prompt

    prompt = build_planner_system_prompt(SPAWN_AGENT_PROMPT)
    assert "Plan information retrieval and discovery in spawn_explore_agent before dependent execution." in prompt
    assert "spawn_browser_agent may read pages only while executing a known stateful trajectory" in prompt
    assert (
        "Step 0 spawn_explore_agent retrieves the public target or route; "
        "Step 1 spawn_browser_agent executes the complete stateful flow" in prompt
    )
    assert "explore: The agent for information retrieval and discovery." in prompt
    assert "Public research, target discovery, and route discovery belong in explore first." in prompt
    assert "entry_point_source" not in prompt


# ============================================================================
# 17. Tool prompts open with a declarative third-person sentence
# ----------------------------------------------------------------------------
# WHY: Tool prompts get rendered into a `**name**\n<prompt>` block in the
# main system prompt. The first line is the model's "what does this tool do"
# anchor. Second-person leads ("You should call this tool when ...") frame
# the tool as instructions to the agent rather than describing the tool's
# capability — which makes the LLM more likely to call the tool gratuitously
# (because it reads as a directive rather than a capability description).
# ============================================================================


def test_tool_prompts_open_with_declarative_sentence():
    """Each tool prompt's first non-empty line is a declarative third-person sentence.

    Rules per gold standard:
      - MUST NOT start with 'You ' (second person)
      - MUST end with '.' (declarative)
      - MUST be at least 3 words (full sentence, not a fragment)
    """
    from tools.prompts import TOOL_PROMPTS

    bad: list[str] = []
    for name, prompt in TOOL_PROMPTS.items():
        first_line = prompt.lstrip().split("\n", 1)[0].strip()
        if not first_line:
            bad.append(f"{name}: empty first line")
            continue
        if first_line.startswith("You "):
            bad.append(f"{name}: opens with second-person 'You ': {first_line[:80]!r}")
            continue
        if not first_line.endswith("."):
            bad.append(f"{name}: opening line not declarative (no period): {first_line[:80]!r}")
            continue
        if len(first_line.split()) < 3:
            bad.append(f"{name}: opening line too short (<3 words): {first_line!r}")

    assert not bad, (
        "Tool prompts must open with a declarative third-person sentence. "
        "Second-person ('You should ...') reframes capability as directive, "
        "biasing the LLM toward gratuitous calls. Rewrite to lead with the "
        "verb describing what the tool DOES.\n  " + "\n  ".join(bad)
    )


# ============================================================================
# 18. Tool prompt length stays within the per-call budget
# ----------------------------------------------------------------------------
# WHY: Tool prompts are concatenated into the main system prompt for every
# enabled tool every call. A bloated tool prompt steals tokens from
# verification/conversation and hurts cache density. Gold-standard target
# is ~80-600 tokens per tool prompt; we use a char-based loose proxy
# (200-3000 chars) so the test doesn't depend on a tokenizer.
# ============================================================================


# spawn_agent carries an empirically-justified BAD/GOOD example pair that
# teaches the stateful-vs-stateless browser partition (see comment at the top
# of agents/tools/prompts/spawn_agent.py). It also embeds the canonical
# EPHEMERAL_SESSION_RULE (Session Semantics) inline so the model sees the
# session-isolation contract on every call without a cross-reference. The
# prompt also defines the canonical Required/Optional/Ignored subtype-field
# wording, so the local cap is intentionally higher than ordinary tool prompts.
# The recursive same-goal GP rule (distinct goal + <½ complexity) plus the
# faulty-tool intelligent-retry recursion warning are load-bearing
# anti-recursion text on the wire.
#
# grep carries load-bearing source/filter guidance for documents and
# transactions so local-data benchmarks use the scoped DB search path instead
# of public web tools or generic unfiltered searches.
_TOOL_PROMPT_CHAR_CAP_OVERRIDES = {
    "grep": 1600,
    # +50: explore's one-line code-inspection hint (a code_session_id → inspect_code).
    "spawn_agent": 3650,
}
_TOOL_PROMPT_CHAR_CAP_DEFAULT = 1500
_TOOL_PROMPT_CHAR_FLOOR = 100


def test_tool_prompt_length_budget():
    """Each tool prompt sits within the per-call char budget.

    Target ~80-400 tokens (rough char-based proxy: 100-1500 chars). The
    audit keeps spawn_agent bigger because it inlines session-isolation
    guidance; that's exempt via _TOOL_PROMPT_CHAR_CAP_OVERRIDES.

    A FLOOR is enforced so a tool prompt can't shrink to a one-liner that
    omits "when to use" / "do not use" guidance.
    """
    from tools.prompts import TOOL_PROMPTS

    bad: list[str] = []
    for name, prompt in TOOL_PROMPTS.items():
        cap = _TOOL_PROMPT_CHAR_CAP_OVERRIDES.get(name, _TOOL_PROMPT_CHAR_CAP_DEFAULT)
        n = len(prompt)
        if n < _TOOL_PROMPT_CHAR_FLOOR:
            bad.append(
                f"{name}: {n} chars below floor {_TOOL_PROMPT_CHAR_FLOOR}; add 'when to use' / 'do not use' guidance"
            )
        elif n > cap:
            bad.append(
                f"{name}: {n} chars above cap {cap}; trim guidance or "
                f"add an override in _TOOL_PROMPT_CHAR_CAP_OVERRIDES with a comment"
            )

    assert not bad, (
        "Tool prompts outside the per-call char budget. Either trim the prose "
        "or, if the size is intentional (e.g. inlines a load-bearing rule "
        "block like VERIFICATION_RULES), add an override in "
        "_TOOL_PROMPT_CHAR_CAP_OVERRIDES with a comment.\n  " + "\n  ".join(bad)
    )


# ============================================================================
# Test runner registration
# ============================================================================


def test_output_schema_states_attempt_completion_takes_no_arguments():
    """The required-output-schema block must state the zero-argument contract.

    `attempt_completion` is declared with an EMPTY input schema (no properties,
    additionalProperties=False), while this block lists required fields. Without
    an explicit statement that the fields are read from tool history rather than
    passed as arguments, the model reads "required" as tool parameters, finds no
    tool that accepts them, and substitutes a stalling call instead of
    completing. Measured by replaying the real diverging call (agent 476ffdfb,
    execute_loop turn 3, gptAuth + reasoning_effort=xhigh): 10/17 wait_for
    without this sentence, 0/23 with it.
    """
    from utils.prompts import format_required_output_schema_user_message

    schema = {"fields": [{"name": "order_confirmation_id", "type": "str", "required": True, "description": "id"}]}
    rendered = format_required_output_schema_user_message(schema)

    assert "takes no arguments" in rendered, (
        "The required-output-schema prompt no longer states that "
        "attempt_completion takes no arguments. That sentence is what stops the "
        "model treating the schema fields as tool parameters and stalling "
        "instead of completing."
    )
    assert "extracted from your tool history" in rendered, (
        "The required-output-schema prompt no longer explains where the fields "
        "come from. Without it the model looks for a completion tool that "
        "accepts a payload, does not find one, and stalls."
    )
    assert "Gather this data before calling attempt_completion:" not in rendered, (
        "The ambiguous pre-fix wording is back; it reads as a list of tool arguments for a tool that accepts none."
    )


# ============================================================================
# 21. Write-lock approval is requested by the commit click
# ----------------------------------------------------------------------------
# WHY: The browser write lock intercepts the final commit click (Place order,
# Pay, Send, Post) and asks the user before replaying it. No tool requests
# approval. Prod agent 5c8b0ca4 stalled at the Amazon review page because its
# parent wrote "do not click Place order without approval" and the browser
# agent, told only that it "may be asked to confirm", stopped there or called
# generate_write_lock_notification / request_payment_card / attempt_completion
# as if they were the approval tool. Live replay of that decision point
# (benchmarks/run_write_lock_approval_scenarios.py, pre and post run
# concurrently, 10 trials x 5 scenarios): 7/50 trials passed before these
# prompts, 39/50 after.
# ============================================================================


def test_browser_prompt_says_commit_click_requests_approval():
    """The browser prompt states that the commit click is the approval request."""
    from providers.rose.browser_use import build_browser_use_system_prompt

    from browser_tools.schemas import AVAILABLE_ACTIONS

    prompt = build_browser_use_system_prompt(AVAILABLE_ACTIONS)
    assert "Clicking the commit control is how approval is requested; no tool requests it." in prompt, (
        "The browser prompt no longer says the commit click is the approval request. Without it the "
        "model stops at the review page or calls a non-approval tool when the goal asks for approval."
    )
    assert "The runtime intercepts the click, shows the user what the action will do, and asks for approval." in prompt
    assert "finish every earlier step, then click the commit control" in prompt
    assert "you may be asked to confirm with the user first" not in prompt, (
        "The vague pre-fix wording is back; it does not tell the model how approval is requested."
    )


def test_parent_prompts_route_browser_approval_through_commit_click():
    """Main-loop and planner prompts tell parents not to forbid the commit click."""
    from tools.prompts.spawn_agent import PROMPT as SPAWN_AGENT_PROMPT
    from utils.prompts import build_planner_system_prompt, build_system_prompt
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS

    sentence = (
        "In browser sessions the approval prompt fires when the browser agent clicks the final commit "
        "control itself (Place order, Pay, Send, Post, etc.), so when a task needs the user's approval first, "
        "tell the browser agent to carry the flow through that click and never tell it not to click."
    )
    prompts = {
        "EXECUTE": build_system_prompt("EXECUTE", list(EXECUTE_PHASE_TOOLS)),
        "planner": build_planner_system_prompt(SPAWN_AGENT_PROMPT),
    }
    for name, prompt in prompts.items():
        assert sentence in prompt, (
            f"The {name} prompt no longer tells parents that browser approval fires on the commit "
            "click. Parents then write 'do not click Place order' and the approval prompt never fires."
        )


# ============================================================================
# 24. Browser sign-up identity facts
# ----------------------------------------------------------------------------
# WHY: the spawn_agent goal description said spawned agents get no context and
# to include names/addresses, so the root restated the user's email in a
# browser goal; the browser signed up with an inbox it cannot read and later
# handed the unreadable code to a human (run e0c401c1). Browser agents receive
# the profile and Auth Options themselves, and sign-up identities come from
# Auth Options.
# ============================================================================


def test_browser_identity_facts_in_spawn_goal_and_auth_contract():
    from utils.browser_auth_contract import build_authentication_contract
    from utils.tool_schemas import SpawnAgentTool, SpawnAgentToolNoGP, SpawnExploreAgentTool

    note = "a browser agent also receives the user's profile"
    for tool in (SpawnAgentTool, SpawnAgentToolNoGP):
        goal = tool.model_json_schema()["properties"]["goal"]["description"]
        assert note in goal and "do not restate the user's profile" in goal, tool.__name__
    explore_goal = SpawnExploreAgentTool.model_json_schema()["properties"]["goal"]["description"]
    assert note not in explore_goal
    rule = "Sign in or sign up only with identities listed in Auth Options."
    for recover in (True, False):
        assert rule in build_authentication_contract(recover_enabled=recover)


_CODE_AGENT_NAME = re.compile(r"spawn_code_agent|spawn_claude_code_agent|code agent|type='code'|type=\"code\"", re.I)
_LIFETIME_WORD = re.compile(r"lifetime|deadline|time limit|time-limit|timeout|expires|at most", re.I)
_DURATION = re.compile(r"(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|min|hours?|hrs?|h|days?|d)\b", re.I)
_DURATION_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def _stated_durations(line):
    for amount, unit in _DURATION.findall(line):
        key = unit.lower()[0] if not unit.lower().startswith("mi") else "m"
        yield float(amount) * _DURATION_UNIT_SECONDS[key]


def test_planner_prompt_states_no_code_agent_lifetime_shorter_than_runtime():
    """The planner prompt must not give code agents a lifetime the runtime does not enforce.

    The code-agent activity runs with CODE_AGENT_ACTIVITY_NO_DEADLINE (C11: no
    runtime limit, liveness is the heartbeat; an idle session pauses and
    resumes). The planner prompt said "spawn_code_agent has a 10 min lifetime",
    so plans cut multi-day code work into 10-minute pieces. Any line of the
    prompt the planner receives that names a code agent together with a
    lifetime/deadline word may only state a duration at least that long.
    """
    from domains.set_plan.service import get_planner_tools_description
    from domains.spawn_claude_code_agent.config import CODE_AGENT_ACTIVITY_NO_DEADLINE
    from utils.prompts import build_planner_system_prompt

    runtime_seconds = CODE_AGENT_ACTIVITY_NO_DEADLINE.total_seconds()
    assert runtime_seconds >= 365 * 86400, "the code-agent activity has no practical deadline (C11)"
    for rose_desktop in (False, True):
        prompt = build_planner_system_prompt(get_planner_tools_description(rose_desktop=rose_desktop))
        for line in prompt.splitlines():
            if not (_CODE_AGENT_NAME.search(line) and _LIFETIME_WORD.search(line)):
                continue
            for seconds in _stated_durations(line):
                assert seconds >= runtime_seconds, (
                    f"planner prompt states a {seconds:.0f}s code-agent lifetime; the runtime deadline is "
                    f"{runtime_seconds:.0f}s (CODE_AGENT_ACTIVITY_NO_DEADLINE): {line!r}"
                )


def test_wait_for_timeout_description_points_long_waits_to_until_timestamp():
    """WaitForTool.timeout_seconds names the event-driven long wait the runtime implements.

    agents-mode waits are capped at WAIT_FOR_AGENTS_MAX_TIMEOUT_SECONDS (Codex
    wait_agent parity). A longer wait is one until_timestamp wait (up to
    MAX_WAIT_SECONDS) that ends early on GENERAL_WAKE_KINDS: a background agent
    finishing (agent_notification) or an agent message (agent_message). The
    runtime behavior is proven by wait_for.blackbox.py
    test_wait_for_multi_day_timestamp_wakes_when_a_background_agent_finishes.
    """
    import importlib.util

    from domains.wait_for.config import MAX_WAIT_SECONDS
    from helpers.wait_wake import GENERAL_WAKE_KINDS
    from utils.tool_schemas import WaitForTool
    from utils.wait_for_bounds import WAIT_FOR_AGENTS_MAX_TIMEOUT_SECONDS

    # The runtime the text describes.
    assert MAX_WAIT_SECONDS > WAIT_FOR_AGENTS_MAX_TIMEOUT_SECONDS, "until_timestamp must outlast the agents cap"
    assert {"agent_notification", "agent_message"} <= set(GENERAL_WAKE_KINDS), GENERAL_WAKE_KINDS
    spec = importlib.util.spec_from_file_location(
        "wait_for_blackbox_for_invariant", AGENTS_ROOT / "tests" / "blackbox" / "wait_for.blackbox.py"
    )
    wait_tests = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wait_tests)
    assert callable(
        getattr(wait_tests, "test_wait_for_multi_day_timestamp_wakes_when_a_background_agent_finishes", None)
    )

    description = " ".join(WaitForTool.model_json_schema()["properties"]["timeout_seconds"]["description"].split())
    assert f"at most {WAIT_FOR_AGENTS_MAX_TIMEOUT_SECONDS}" in description, description
    lower = description.lower()
    assert "for a longer wait use until_timestamp" in lower, description
    assert "ends early" in lower, "the description must state the early wake"
    assert "background agents finishes" in lower, "agent_notification wake must be described"
    assert "messages you" in lower, "agent_message wake must be described"


async def run_all_tests():
    print("prompt-invariants blackbox tests:")
    r = BlackboxResult()

    # 1. Static system prompts
    r.record(
        "build_system_prompt_execute_static_across_calls",
        test_build_system_prompt_execute_is_static_across_calls,
    )
    r.record(
        "build_system_prompt_plan_static_across_calls",
        test_build_system_prompt_plan_is_static_across_calls,
    )
    r.record(
        "build_system_prompt_static_prefix_shared_across_phases",
        test_build_system_prompt_static_prefix_shared_across_phases,
    )
    r.record(
        "build_system_prompt_splits_static_user_context_and_phase_blocks",
        test_build_system_prompt_splits_static_user_context_and_phase_blocks,
    )
    r.record(
        "build_planner_system_prompt_static_across_calls",
        test_build_planner_system_prompt_is_static_across_calls,
    )
    r.record(
        "planner_is_told_explore_can_search_calendar_and_drive",
        test_planner_is_told_explore_can_search_calendar_and_drive,
    )
    r.record(
        "explore_agent_system_prompt_template_constant",
        test_explore_agent_system_prompt_template_is_constant,
    )
    r.record(
        "explore_agent_system_prompt_static_across_calls",
        test_explore_agent_system_prompt_is_static_across_calls,
    )
    r.record(
        "get_browser_system_prompt_static_across_calls",
        test_get_browser_system_prompt_is_static_across_calls,
    )

    # 2. TOOL_MODELS / phase / tools/prompts/ coverage
    r.record(
        "every_tool_model_in_a_phase_list",
        test_every_tool_model_appears_in_at_least_one_phase_list,
    )
    r.record(
        "every_phase_entry_in_tool_models_or_alias",
        test_every_phase_list_entry_exists_in_tool_models_or_is_alias,
    )
    r.record(
        "every_tool_model_has_prompt_fragment",
        test_every_tool_model_has_prompt_fragment,
    )
    r.record(
        "spawn_agent_subtype_param_taxonomy",
        test_spawn_agent_subtype_params_use_required_optional_ignored_taxonomy,
    )
    r.record(
        "spawn_agent_prompt_param_wording_taxonomy",
        test_spawn_agent_prompt_defines_param_wording_taxonomy,
    )
    r.record(
        "general_purpose_faulty_tool_retry_warns_recursion",
        test_general_purpose_faulty_tool_retry_warns_recursion,
    )
    r.record(
        "planner_spawn_aliases_documented_in_prompt",
        test_planner_spawn_aliases_documented_in_prompt,
    )

    # 3. attempt_completion result contract
    r.record(
        "attempt_completion_base_schema_has_no_result_field",
        test_attempt_completion_base_schema_has_no_result_field,
    )
    r.record(
        "attempt_completion_result_schema_is_skip_verification_variant",
        test_attempt_completion_result_schema_is_skip_verification_variant,
    )
    r.record(
        "attempt_completion_result_read_skip_verification_scoped",
        test_attempt_completion_result_read_is_skip_verification_scoped,
    )
    # 4. Verifier schema field order
    r.record(
        "verifier_schema_no_response_schema_field_order",
        test_verifier_schema_no_response_schema_field_order,
    )
    r.record(
        "verifier_schema_with_response_schema_field_order",
        test_verifier_schema_with_response_schema_field_order,
    )
    r.record(
        "verifier_schema_no_score_reasoning_field",
        test_verifier_schema_no_score_reasoning_field,
    )

    # 5. Tool-name hygiene
    r.record(
        "no_deleted_tool_names_in_tool_registries",
        test_no_deleted_tool_names_in_tool_registries,
    )
    r.record(
        "no_deleted_tool_names_as_string_literals_in_production_code",
        test_no_deleted_tool_names_as_string_literals_in_production_code,
    )
    r.record(
        "deleted_tool_scanner_distinguishes_inert_denylists_from_dispatch",
        test_deleted_tool_scanner_distinguishes_inert_denylists_from_dispatch,
    )
    r.record(
        "no_check_progress_tool_name_in_production_code",
        test_no_check_progress_tool_name_in_production_code,
    )
    r.record(
        "check_progress_is_canonical_verifier_entrypoint",
        test_check_progress_is_canonical_verifier_entrypoint,
    )
    r.record("production_scanner_test_module_patterns", test_production_scanner_excludes_only_registered_test_module_patterns)

    # 6. Browser-use catalog ↔ v3 prompt
    r.record(
        "browser_use_v3_actions_in_catalog",
        test_browser_use_v3_actions_in_catalog,
    )
    r.record(
        "browser_use_catalog_matches_v3_actions_or_exempt",
        test_browser_use_catalog_matches_v3_actions_or_is_exempt,
    )
    r.record(
        "browser_use_native_tool_prompt",
        test_browser_use_prompt_requires_native_tool_call,
    )

    # 7. render_tool_list is the canonical, deterministic, typed renderer (B7)
    r.record(
        "render_tool_list_is_deterministic",
        test_render_tool_list_is_deterministic,
    )
    r.record(
        "render_tool_list_is_sorted_by_name",
        test_render_tool_list_is_sorted_by_name,
    )
    r.record(
        "render_tool_list_every_tool_produces_a_nonempty_line",
        test_render_tool_list_every_tool_produces_a_nonempty_line,
    )

    # 8. Verifier static-prompt cache-write threshold (B19)
    r.record(
        "verifier_static_prompt_clears_anthropic_cache_threshold",
        test_verifier_static_prompt_clears_anthropic_cache_threshold,
    )

    r.record(
        "verifier_credits_completed_sub_agent_results_as_evidence",
        test_verifier_credits_completed_sub_agent_results_as_evidence,
    )

    # 9. TS-side static prompts have no dynamic dates (E1)
    r.record(
        "ts_prompt_files_have_no_dynamic_dates_in_system_blocks",
        test_ts_prompt_files_have_no_dynamic_dates_in_system_blocks,
    )

    # 11. Style guardrails (B6 + banned phrases + marketing adjectives)
    r.record(
        "no_em_dashes_in_prompt_strings",
        test_no_em_dashes_in_prompt_strings,
    )
    r.record(
        "no_banned_phrases_in_prompt_strings",
        test_no_banned_phrases_in_prompt_strings,
    )
    r.record(
        "change_environment_size_skill_guards_against_runaways",
        test_change_environment_size_skill_guards_against_runaways,
    )
    r.record(
        "agent_graph_skill_states_when_messages_reach_a_code_agent",
        test_agent_graph_skill_states_when_messages_reach_a_code_agent,
    )
    r.record(
        "planner_prompt_no_code_agent_lifetime_shorter_than_runtime",
        test_planner_prompt_states_no_code_agent_lifetime_shorter_than_runtime,
    )
    r.record(
        "wait_for_timeout_description_points_long_waits_to_until_timestamp",
        test_wait_for_timeout_description_points_long_waits_to_until_timestamp,
    )

    # 12. No restating-the-schema patterns / broken cross-refs (C6, C7)
    r.record(
        "no_required_args_none_in_tool_prompts",
        test_no_required_args_none_in_tool_prompts,
    )
    r.record(
        "no_differs_from_spawn_agent_cross_refs",
        test_no_differs_from_spawn_agent_cross_refs,
    )

    # 13. ALL-CAPS underlined section labels banned (C1)
    r.record(
        "no_all_caps_underlined_section_labels_in_prompts",
        test_no_all_caps_underlined_section_labels_in_prompts,
    )

    # 14. Canonical rule constants imported, not duplicated (B1)
    r.record(
        "canonical_rules_not_duplicated",
        test_canonical_rules_not_duplicated,
    )

    # 15. Cacheable-static prompts mark the dynamic boundary
    r.record(
        "system_prompt_boundary_marker_present",
        test_system_prompt_boundary_marker_present,
    )

    # 16. ALL-CAPS markers capped per prompt
    r.record(
        "all_caps_marker_count_under_limit",
        test_all_caps_marker_count_under_limit,
    )

    # 17. Tool prompts open with declarative third-person sentence
    r.record(
        "tool_prompts_open_with_declarative_sentence",
        test_tool_prompts_open_with_declarative_sentence,
    )

    # 18. Planner dependency schema matches prompt contract
    r.record(
        "planner_depends_on_schema_matches_prompt_contract",
        test_planner_depends_on_schema_matches_prompt_contract,
    )
    r.record(
        "planner_routes_retrieval_before_stateful_execution",
        test_planner_routes_retrieval_before_stateful_execution,
    )

    # 19. Tool prompt length stays within budget
    r.record(
        "tool_prompt_length_budget",
        test_tool_prompt_length_budget,
    )

    # 20. Output-schema block states the attempt_completion zero-arg contract
    r.record(
        "output_schema_states_attempt_completion_takes_no_arguments",
        test_output_schema_states_attempt_completion_takes_no_arguments,
    )

    # 21. Write-lock approval is requested by the commit click
    r.record(
        "browser_prompt_says_commit_click_requests_approval",
        test_browser_prompt_says_commit_click_requests_approval,
    )
    r.record(
        "parent_prompts_route_browser_approval_through_commit_click",
        test_parent_prompts_route_browser_approval_through_commit_click,
    )

    # 22. Code agents advertise rose_user_ui + inline views to root and planner
    r.record(
        "code_agent_advertises_rose_user_ui_and_inline_views",
        test_code_agent_advertises_rose_user_ui_and_agent_display,
    )

    # 23. Rose Desktop gate: stock accounts get no new-UI prompt text
    r.record(
        "stock_planner_and_tool_prompts_omit_rose_desktop_surfaces",
        test_stock_planner_and_tool_prompts_omit_rose_desktop_surfaces,
    )
    await r.record_async(
        "planner_tools_description_follows_the_workflow_account",
        test_planner_tools_description_follows_the_workflow_account,
    )
    # 23b. Video generation/editing routes to a code agent (user-directed 2026-10-28)
    r.record(
        "root_agent_routes_video_requests_to_a_code_agent",
        test_root_agent_routes_video_requests_to_a_code_agent,
    )
    # 24. Browser sign-up identity facts (RCA Q3b, run e0c401c1)
    r.record(
        "browser_identity_facts_in_spawn_goal_and_auth_contract",
        test_browser_identity_facts_in_spawn_goal_and_auth_contract,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
