"""Tool schemas and dynamic models used by the LLM orchestration layer."""

import json
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Type, Union

import structlog
from pydantic import BaseModel, ConfigDict, Field, create_model, field_validator, model_validator

from utils.prompts import (
    PLANNER_RESPONSE_JOIN_DESCRIPTION,
    PLANNER_RESPONSE_TASKS_DESCRIPTION,
    PLANNER_RESPONSE_TITLE_DESCRIPTION,
    PLANNER_TASK_DEPENDS_ON_DESCRIPTION,
    PLANNER_TASK_GOAL_DESCRIPTION,
    PLANNER_TASK_IDX_DESCRIPTION,
    PLANNER_TASK_TOOL_NAME_DESCRIPTION,
    SELF_CONTAINED_GOAL_RULE,
)

logger = structlog.get_logger(__name__)


# ============================================================================
# Phase Tool Lists (source of truth for agent phases)
# Must be defined early so PlanActionType can be used in PlannerTask
# ============================================================================

# Tools available during PLAN phase (research + create execution plan)
PLAN_PHASE_TOOLS = [
    "spawn_agent",  # Only type="explore" allowed in PLAN (enforced at runtime)
    "send_message_to_user",
    "set_plan",
    "attempt_completion",
]

# Tools available during EXECUTE phase (run the plan)
EXECUTE_PHASE_TOOLS = [
    "spawn_agent",  # Unified: type=browser|code|general_purpose|explore
    "wait_for",
    "send_message_to_user_execute_phase",
    "call_phone_number",
    "message_person",
    "attempt_completion",
]

# Stable union of PLAN + EXECUTE tools for LLM schema generation.
# Passing the same tool set in every call makes the Anthropic tools array
# identical across phases, enabling cross-phase cache hits on the
# system+tools prefix. The system prompt's ENABLED/DISABLED sections
# control which tools the model actually uses.
ALL_PHASE_TOOLS = list(dict.fromkeys(PLAN_PHASE_TOOLS + EXECUTE_PHASE_TOOLS))

# Tools the planner can assign to tasks (what shows up in task.tool_name)
# These use separate names so the planner doesn't need to understand spawn_agent params.
# The DAG executor converts these to spawn_agent via TOOL_ALIASES.
PLANNER_ASSIGNABLE_TOOLS = [
    "spawn_explore_agent",
    "spawn_browser_agent",
    "spawn_code_agent",
    "spawn_general_purpose_agent",
    "spawn_general_purpose_agent_for_each",
    "wait_for",
    "call_phone_number",
    "message_person",
    "send_message_to_user_execute_phase",
    "reasoning",  # Pure thinking/analysis step (no tool call)
]


class PlanToolName(str, Enum):
    """The tool to execute for this task, or 'reasoning' for thinking/analysis."""

    spawn_explore_agent = "spawn_explore_agent"
    spawn_browser_agent = "spawn_browser_agent"
    spawn_code_agent = "spawn_code_agent"
    spawn_general_purpose_agent = "spawn_general_purpose_agent"
    spawn_general_purpose_agent_for_each = "spawn_general_purpose_agent_for_each"
    wait_for = "wait_for"
    call_phone_number = "call_phone_number"
    message_person = "message_person"
    send_message_to_user_execute_phase = "send_message_to_user_execute_phase"
    reasoning = "reasoning"


# Runtime check to ensure PlanToolName stays in sync with PLANNER_ASSIGNABLE_TOOLS
_plan_tool_values = {e.value for e in PlanToolName}
_expected_tools = set(PLANNER_ASSIGNABLE_TOOLS)
assert _plan_tool_values == _expected_tools, (
    f"PlanToolName enum out of sync with PLANNER_ASSIGNABLE_TOOLS. "
    f"Missing: {_expected_tools - _plan_tool_values}, Extra: {_plan_tool_values - _expected_tools}"
)


# ============================================================================
# Planner LLM Response Models
# ============================================================================


class PlannerTask(BaseModel):
    """A single task in the planner output."""

    task_idx: str = Field(description=PLANNER_TASK_IDX_DESCRIPTION)
    goal: str = Field(description=PLANNER_TASK_GOAL_DESCRIPTION)
    tool_name: PlanToolName = Field(description=PLANNER_TASK_TOOL_NAME_DESCRIPTION)
    depends_on: List[str] = Field(default_factory=list, description=PLANNER_TASK_DEPENDS_ON_DESCRIPTION)


class PlannerResponse(BaseModel):
    """Structured output from the planner LLM."""

    title: str = Field(description=PLANNER_RESPONSE_TITLE_DESCRIPTION)
    tasks: List[PlannerTask] = Field(description=PLANNER_RESPONSE_TASKS_DESCRIPTION)
    join: Literal["all", "any"] = Field(description=PLANNER_RESPONSE_JOIN_DESCRIPTION)


# ============================================================================
# Individual Tool Pydantic Models
# ============================================================================


ResponseSchemaPrimitiveType = Literal[
    "str",
    "int",
    "float",
    "bool",
    "list[str]",
    "list[int]",
    "file_pointer",
    "list[file_pointer]",
]


class ResponseSchemaNestedFieldConfig(BaseModel):
    """Configuration for a nested field in an object output."""

    name: str = Field(description="Field name in snake_case.")
    type: ResponseSchemaPrimitiveType = Field(description="Nested field type.")
    description: str = Field(default="", description="Optional semantic description; not used for object shape.")


class ResponseSchemaFieldConfig(BaseModel):
    """Configuration for a single field in the output schema."""

    name: str = Field(description="Field name in snake_case.")
    type: Literal[
        "str",
        "int",
        "float",
        "bool",
        "list[str]",
        "list[int]",
        "object",
        "list[object]",
        "file_pointer",
        "list[file_pointer]",
    ] = Field(
        description=(
            "Field type. For object/list[object], set properties explicitly instead of describing subfields in prose."
        )
    )
    required: bool = Field(description="Whether this field is required in the output.")
    description: str = Field(default="", description="Optional semantic description; not used for object shape.")
    properties: List[ResponseSchemaNestedFieldConfig] = Field(
        default_factory=list,
        description="Explicit subfields for object/list[object] outputs. Required when type is object or list[object].",
    )

    @field_validator("properties", mode="before")
    @classmethod
    def _coerce_null_properties(cls, value: Any) -> Any:
        return [] if value is None else value

    @model_validator(mode="after")
    def _object_fields_require_properties(self):
        if self.type in ("object", "list[object]") and not self.properties:
            raise ValueError("object and list[object] output_schema fields require explicit properties")
        return self


class ResponseSchemaConfig(BaseModel):
    """Structured output schema defining what data the agent must return when complete."""

    fields: List[ResponseSchemaFieldConfig] = Field(
        description="List of output fields that the agent must return when complete."
    )

    @model_validator(mode="before")
    @classmethod
    def _coerce_malformed_input(cls, value: Any) -> Any:
        # Models reliably emit output_schema in three malformed shapes that the
        # canonical {"fields": [...]} form does not match. Coerce each into the
        # structured form rather than failing validation — failure forces a costly
        # LLM retry loop (cache_hit_pct ~99% repeats the same shape) and burns the
        # entire ~50s timeout on smoke tasks like spawn-sub-agents.
        #
        # 1. JSON-encoded string of the list (Claude Sonnet 4-6 tendency):
        #    output_schema: "[{\"name\": ..., \"type\": ...}]"
        # 2. Bare list of field dicts (no {"fields": ...} wrapper):
        #    output_schema: [{"name": ..., "type": ...}]
        # 3. Flat dict {field_name: description} (Gemini, GPT-4 tendency):
        #    output_schema: {"tokyo_population": "the population of Tokyo"}
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith(("[", "{")):
                try:
                    value = json.loads(stripped)
                except json.JSONDecodeError:
                    return value  # let pydantic raise a clearer error
        if isinstance(value, list):
            return {"fields": value}
        if isinstance(value, dict) and "fields" not in value and value:
            if all(isinstance(v, str) for v in value.values()):
                return {
                    "fields": [
                        {"name": k, "description": v, "type": "str", "required": True}
                        for k, v in value.items()
                    ]
                }
        return value


class WaitForTool(BaseModel):
    """Pause execution until a timestamp or natural-language condition is met."""

    tool: Literal["wait_for"]
    until_timestamp: Optional[str] = Field(
        default=None,
        description="ISO 8601 timestamp to wait until. Mutually exclusive with condition.",
    )
    condition: Optional[str] = Field(
        default=None,
        description="Natural language condition for an explore agent to check on periodically.",
    )
    check_interval_seconds: int = Field(
        default=900,
        ge=60,
        le=86400,
        description="Seconds between condition checks (60-86400, default 900). Only used with condition.",
    )
    max_checks: int = Field(
        default=20,
        ge=1,
        le=100,
        description="Maximum number of condition checks before giving up (1-100, default 20). Only used with condition.",
    )
    @model_validator(mode="after")
    def check_mutual_exclusion(self) -> "WaitForTool":
        if self.until_timestamp and self.condition:
            raise ValueError("until_timestamp and condition are mutually exclusive.")
        if not self.until_timestamp and not self.condition:
            raise ValueError("Either until_timestamp or condition must be provided.")
        return self


class WebSearchTool(BaseModel):
    """Search the web for real-time information."""

    tool: Literal["web_search"]
    query: str = Field(description="Search query or question about current information.")


class PeopleSearchTool(BaseModel):
    """Find or enrich real people on the public web using dedicated people-search providers. Use when web_search is insufficient for a people goal: you need comprehensiveness (a broad list matching criteria) or depth (a field-level profile for a specific person). For a quick one-off people fact, web_search is fine."""

    tool: Literal["people_search"]
    query: str = Field(
        description=(
            "Natural-language people request. For mode='enrich', a specific "
            "person plus disambiguating context (e.g. 'Patrick Collison, "
            "co-founder of Stripe'). For mode='discover', the criteria (e.g. "
            "'partners at AI-infra VC firms in the SF Bay Area')."
        )
    )
    mode: Literal["enrich", "discover"] = Field(
        description=(
            "'enrich': resolve ONE specific person and return a field-level "
            "profile. 'discover': return a LIST of people matching a role, "
            "company, geography, or seniority."
        )
    )
    provider: Literal["exa", "parallel"] = Field(
        description=(
            "Which backend. Exa is strongest for depth/enrichment (structured "
            "work and education history); Parallel is strongest for broad "
            "discovery (high recall). If the chosen provider returns "
            "insufficient or low-quality data, re-call with the other provider. "
            "On a provider rate-limit or error the tool auto-retries the other "
            "provider."
        )
    )
    limit: Optional[int] = Field(
        default=None,
        ge=1,
        le=25,
        description=(
            "mode='discover' ONLY: max number of people to return (1-25, default "
            "10). Not used for 'enrich', which resolves a single person."
        ),
    )
    fields: Optional[List[str]] = Field(
        default=None,
        description=(
            "mode='enrich' ONLY: the attributes to return for the resolved "
            "person. These DEFINE the output params, e.g. ['current_title', "
            "'current_company','location','linkedin_url','email','education']. "
            "Maps to the provider's structured-output/enrichment schema. If "
            "omitted, the provider returns its native default profile and no "
            "field list is imposed."
        ),
    )

    @model_validator(mode="after")
    def _check_mode_params(self) -> "PeopleSearchTool":
        if self.mode == "enrich" and self.limit is not None:
            raise ValueError("limit is only valid for mode='discover'.")
        if self.mode == "discover" and self.fields is not None:
            raise ValueError("fields is only valid for mode='enrich'.")
        return self


class WebFetchTool(BaseModel):
    """Fetch a URL with JavaScript rendering; a small fast model filters the page to your objective."""

    tool: Literal["web_fetch"]
    url: str = Field(description="A fully-formed valid URL to fetch.")
    objective: str = Field(
        description=(
            "What you need from this page. The page is rendered, then a small "
            "fast model produces an objective-focused summary AND picks which "
            "of the page's links to download. If you need files (PDFs, CSVs, "
            "etc.), say so explicitly in the objective, e.g. 'extract the "
            "membership PDFs', 'download the spec sheet'."
        ),
    )


class GrepTool(BaseModel):
    """Search local data sources with regex grep semantics."""

    tool: Literal["grep"]
    pattern: str = Field(
        description=(
            "Regular expression pattern to search for. Plain text works as a literal regex. "
            "Use -i for case-insensitive matching and multiline for cross-line patterns."
        ),
    )
    source: Optional[Literal["messages", "network", "agent_network", "transactions", "documents"]] = Field(
        default=None,
        description=(
            "Optional source bucket. Omit to search messages, network, and the current agent_network. "
            "messages searches user communication records. network searches contact records. "
            "agent_network searches all message roles in the current agent tree and returns role/location metadata. "
            "transactions searches synced Plaid transaction rows. documents searches synced ChatGPT/Claude "
            "exports, Apple Notes, Obsidian vault notes, and generic user documents."
        ),
    )
    before: Optional[int] = Field(
        default=None,
        alias="-B",
        description="Number of logical lines to show before each match.",
    )
    after: Optional[int] = Field(
        default=None,
        alias="-A",
        description="Number of logical lines to show after each match.",
    )
    context_c: Optional[int] = Field(
        default=None,
        alias="-C",
        description="Number of logical lines to show before and after each match. Alias for context.",
    )
    context: Optional[int] = Field(
        default=None,
        description="Number of logical lines to show before and after each match.",
    )
    line_numbers: Optional[bool] = Field(
        default=None,
        alias="-n",
        description="Show logical line numbers in content output. Defaults to true.",
    )
    case_insensitive: Optional[bool] = Field(
        default=None,
        alias="-i",
        description="Enable case-insensitive regex matching.",
    )
    head_limit: Optional[int] = Field(
        default=None,
        description="Maximum number of returned result snippets. Defaults to 20.",
    )
    offset: Optional[int] = Field(
        default=None,
        description="Skip this many matched snippets before applying head_limit.",
    )
    multiline: Optional[bool] = Field(
        default=None,
        description="Allow regex patterns to match across newlines within a record.",
    )
    filters: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Source-specific nested filters. For transactions: since, until, account, min_amount, "
            "max_amount, status ('posted', 'pending', or 'all'), include_pending_in_totals. "
            "For messages: person and since. For documents: document_source, since, until, path, and tag. "
            "Unsupported filters are rejected by the backend for the selected source."
        ),
    )
    person: Optional[str] = Field(
        default=None,
        description=(
            "messages source only: narrow to one contact by email, phone, or full name. "
            "Ignored for network and agent_network."
        ),
    )
    since: Optional[str] = Field(
        default=None,
        description=(
            "messages source only: only return messages at or after this time. "
            "ISO 8601 timestamp or a relative form like 7d, 24h, 30m. Ignored for other sources."
        ),
    )
    model_config = ConfigDict(populate_by_name=True)


class SendMessageToUserTool(BaseModel):
    """Message the user during PLAN phase; optionally block for a reply."""

    tool: Literal["send_message_to_user"]
    message: str = Field(description="User-visible markdown text explaining the question, blocker, or FYI.")
    is_question: bool = Field(
        default=True,
        description=(
            "True to block workflow until the user responds. "
            "False to send a non-blocking FYI."
        ),
    )


class SendMessageToUserExecutePhaseTool(BaseModel):
    """Send a non-blocking informational message to the user during EXECUTE phase."""

    tool: Literal["send_message_to_user_execute_phase"]
    message: str = Field(description="User-visible markdown text explaining what you want them to know.")


class MessagePersonTool(BaseModel):
    """Drafts a personalized message and stages it for user approval. Approval is synchronous."""

    tool: Literal["message_person"]
    person_id: str = Field(
        description=(
            "Person identifier: full name, E.164 phone number, or email address. "
            "Full name must resolve unambiguously to one person."
        )
    )
    channel: Literal["imessage", "email"] = Field(
        description="Communication channel: 'imessage' or 'email'.",
    )
    from_email: Optional[str] = Field(
        default=None,
        description=(
            "Email address to send from (required when channel='email'). "
            "Must match one of the user's connected accounts."
        ),
    )
    intent: str = Field(
        description="What the message must accomplish; the tool drafts the text from this.",
    )
    context_gates: Optional[Dict[str, bool]] = Field(
        default=None,
        description=(
            "Optional gates controlling which user-context chunks are included. "
            "Allowed key: 'recent_communications'."
        ),
    )


ForEachItem = Union[str, Dict[str, Union[str, List[str]]]]


class SpawnAgentTool(BaseModel):
    """Spawn an autonomous agent; type selects capabilities and per-type required fields."""

    tool: Literal["spawn_agent"]
    type: Literal["browser", "code", "general_purpose", "explore", "for_each"] = Field(
        description=(
            "The type of specialized agent you are spawning; this parameter affects what other "
            "parameters are expected. Allowed: 'browser', 'code', 'general_purpose', 'explore', 'for_each'."
        )
    )
    goal: str = Field(
        description=(
            "The self-contained task/prompt and description for the spawned agent. "
            "Spawned agents have no access to ANY of your context by default. "
            "The goal and attachments parameters are their ONLY source of information. "
            "Include all relevant pieces of information. "
            f"{SELF_CONTAINED_GOAL_RULE.strip()}"
        )
    )

    output_schema: Optional[ResponseSchemaConfig] = Field(
        default=None,
        description=(
            "Structured data the agent returns and validates against. The agent will not stop running "
            "until this output_schema is met. Required when type='browser', type='code', "
            "type='general_purpose', or type='for_each'. Ignored when type='explore'."
        ),
    )
    attachments: Optional[List[str]] = Field(
        default=None,
        description=(
            "Optional when the spawned agent needs files from the current context. "
            "Use exact `original_filename` values from file_pointer objects."
        ),
    )

    start_url: Optional[str] = Field(
        default=None,
        description=(
            "User-facing URL the browser navigates to first. Required when type='browser'. "
            "Ignored for every other type."
        ),
    )
    # code only - GitHub repo to clone into sandbox
    github_repo_link: Optional[str] = Field(
        default=None,
        description=(
            "Optional when type='code'. GitHub repository URL to clone and sync to. "
            "Ignored for every other type. Only provide this when the user supplied a real, "
            "accessible repository URL; do not invent placeholder repositories. If omitted, "
            "the GitHub repo defaults to a repo automatically created for this agent tree."
        ),
    )
    start_phase: Optional[Literal["PLAN", "EXECUTE"]] = Field(
        default=None,
        description=(
            "Required when type='general_purpose' or type='for_each'. Ignored for every other type. "
            "The phase that the agent should spawn in as, either 'PLAN' or 'EXECUTE'. "
            "For complex tasks that require planning and more than a few tool calls, use 'PLAN'. "
            "For straightforward tasks that are simple to complete, use 'EXECUTE'. "
            "Prefer 'PLAN' when uncertain."
        ),
    )
    items: Optional[List[ForEachItem]] = Field(
        default=None,
        description=(
            "Optional alternative when type='for_each': provide either items or items_csv. "
            "Ignored for every other type. For each item in the array, "
            "a general-purpose agent will be spawned with the given goal and the item attached to its context."
        ),
    )
    items_csv: Optional[str] = Field(
        default=None,
        description=(
            "Optional alternative when type='for_each': provide either items_csv or items. "
            "Ignored for every other type. CSV string input. "
            "For each row in the CSV, a general-purpose agent will be spawned with the given goal and "
            "the item attached to its context."
        ),
    )
    context_gates: Optional[Dict[str, bool]] = Field(
        default=None,
        description=(
            "Optional when type='explore', type='general_purpose', or type='for_each'. "
            "Ignored when type='browser' or type='code'. Missing keys default to true, "
            "which means that context flows through to the agent. For 'explore', applicable keys "
            "are 'network' and 'recent_communications'. For 'general_purpose' and 'for_each', keys are "
            "'user_profile', 'authenticated_sessions', 'integrations', 'recent_communications', "
            "'network', 'custom_system_prompt', and 'shared_files'. Set a key to false only when "
            "that context is clearly unnecessary."
        ),
    )
    depth: Optional[Literal["quick", "medium", "deep"]] = Field(
        default="quick",
        description=(
            "Optional when type='explore'; ignored for every other type. Controls research "
            "thoroughness as a TURN budget (one turn can batch multiple parallel searches): "
            "'quick' = a basic look (~5 turns), 'medium' = moderate exploration (~20 turns), "
            "'deep' = broad analysis across many sources (~50 turns). Default 'quick'; "
            "only use 'deep' when the task genuinely needs exhaustive research."
        ),
    )

    @model_validator(mode="after")
    def check_spawn_agent_constraints(self) -> "SpawnAgentTool":
        if self.type == "browser" and not self.start_url:
            raise ValueError("start_url is required when type='browser'.")
        if self.type in ("general_purpose", "for_each") and not self.start_phase:
            raise ValueError("start_phase is required when type='general_purpose' or 'for_each'.")
        if self.type == "for_each":
            if self.items and self.items_csv:
                raise ValueError("items and items_csv are mutually exclusive.")
            if not self.items and not self.items_csv:
                raise ValueError("type='for_each' requires either items or items_csv.")
        if self.type in ("browser", "code", "general_purpose", "for_each") and not self.output_schema:
            raise ValueError(f"output_schema is required when type='{self.type}'.")
        # Some models emit output_schema for explore type even though it has no effect
        # downstream (explore agents return free-form summary). Drop it silently rather
        # than failing validation — rejecting forces a costly LLM retry loop.
        if self.type == "explore" and self.output_schema:
            self.output_schema = None
        return self


class SpawnExploreAgentTool(BaseModel):
    """Spawn a read-only explore agent to gather information during PLAN.

    Narrowed variant of SpawnAgentTool: during PLAN only explore agents are
    permitted. Schema-level narrowing is cheaper than a runtime rejection
    loop — the LLM cannot pick an invalid `type` and we drop ~600 tokens of
    per-type field guidance the model would otherwise have to reason past.
    """

    tool: Literal["spawn_agent"]
    type: Literal["explore"] = Field(
        default="explore",
        description=(
            "Must be 'explore'. PLAN is read-only: only explore agents are "
            "legal here. To spawn anything else, finish PLAN with "
            "attempt_completion first."
        ),
    )
    goal: str = Field(
        description=(
            "The self-contained task/prompt and description for the spawned agent. "
            "Spawned agents have no access to ANY of your context by default. "
            "The goal and attachments parameters are their ONLY source of information. "
            "Include all relevant pieces of information. "
            f"{SELF_CONTAINED_GOAL_RULE.strip()}"
        )
    )
    attachments: Optional[List[str]] = Field(
        default=None,
        description=(
            "Optional when the spawned agent needs files from the current context. "
            "Use exact `original_filename` values from file_pointer objects."
        ),
    )
    context_gates: Optional[Dict[str, bool]] = Field(
        default=None,
        description=(
            "Optional. Applicable keys are 'network' and 'recent_communications'. "
            "Missing keys default to true (context flows through to the agent). "
            "Set a key to false only when that context is clearly unnecessary."
        ),
    )
    depth: Optional[Literal["quick", "medium", "deep"]] = Field(
        default="quick",
        description=(
            "Controls research thoroughness as a TURN budget (one turn can batch multiple "
            "parallel searches): 'quick' = a basic look (~5 turns), 'medium' = moderate (~20 turns), "
            "'deep' = broad analysis across many sources (~50 turns). Default 'quick'; only use "
            "'deep' when the task genuinely needs exhaustive research."
        ),
    )


# ============================================================================
# Plan Phase Tools
# ============================================================================


class SetPlanTool(BaseModel):
    """Signal readiness for plan generation; the planner LLM produces the DAG."""

    tool: Literal["set_plan"]
    # No parameters - planner LLM generates the plan internally


# ============================================================================
# Universal Completion Tool (replaces mark_execution_complete and progress_to_autonomous_execution_phase)
# ============================================================================


class AttemptCompletionTool(BaseModel):
    """Trigger completion for verified agent loops."""

    tool: Literal["attempt_completion"]


class AttemptCompletionWithResultTool(BaseModel):
    """Submit your final findings to the parent agent and end your loop.

    The `result` string you submit here is the ONLY payload the parent
    agent receives. There is no future turn after this call returns, so
    your `result` must be complete and self-contained when you emit it.

    Requirements:
    - Complete: do not defer the answer. There is no future turn.
    - Grounded: every claim must be backed by evidence from your prior
      tool results. If a fact cannot be found, report the gap explicitly
      ("No results for [X] after searching [keywords]") rather than
      fabricating it.
    - Token-efficient, punctual, and information-dense. Strip filler;
      every sentence should carry signal.
    - Cite sources inline with [N] tags and end `result` with a
      `Sources:` block mapping each tag to its URL or source identifier.

    Emit a single `attempt_completion_with_result` tool_use block, do
    not batch it with other tool calls.
    """

    tool: Literal["attempt_completion_with_result"]
    result: str = Field(
        description=(
            "The final findings handed to the parent agent. This is the "
            "ONLY payload the parent receives as the spawn_agent tool "
            "result. Must be self-contained and grounded in sources from "
            "prior tool calls."
        ),
    )


# SpawnSubAgentTool removed - unified into SpawnAgentTool above


class CallPhoneNumberTool(BaseModel):
    """Place an outbound voice-AI call that follows system_prompt and extracts structured data."""

    tool: Literal["call_phone_number"]
    to: str = Field(description="Phone number to call in E.164 format.")
    system_prompt: str = Field(
        description=(
            "Instructions for the voice agent's identity, tone, and conversation goals during the call."
        )
    )
    output_schema: ResponseSchemaConfig = Field(
        description=(
            "Fields to extract from the conversation when the call completes."
        )
    )


# Typed alias for the canonical tool registry shape: name -> Pydantic model.
# Use this whenever a function takes "a registry of tools" so callers get
# proper type-checking instead of an untyped Dict.
ToolRegistry = Dict[str, Type[BaseModel]]


# Map tool names to their Pydantic models
TOOL_MODELS: ToolRegistry = {
    "wait_for": WaitForTool,
    "web_search": WebSearchTool,
    "people_search": PeopleSearchTool,
    "web_fetch": WebFetchTool,
    "send_message_to_user": SendMessageToUserTool,
    "send_message_to_user_execute_phase": SendMessageToUserExecutePhaseTool,
    "spawn_agent": SpawnAgentTool,
    "message_person": MessagePersonTool,
    # Plan phase tools
    "set_plan": SetPlanTool,
    # Universal completion tool (available in both phases)
    "attempt_completion": AttemptCompletionTool,
    # Sub-agent (skip_verification=True) completion tool — carries the
    # final handoff payload to the parent in `result`.
    "attempt_completion_with_result": AttemptCompletionWithResultTool,
    # Phone calling tool
    "call_phone_number": CallPhoneNumberTool,
    # Local data search
    "grep": GrepTool,
}

# Phase-specific override registry. PLAN narrows spawn_agent to the explore-only
# variant; everything else inherits from TOOL_MODELS.
PLAN_TOOL_MODELS: ToolRegistry = {
    **TOOL_MODELS,
    "spawn_agent": SpawnExploreAgentTool,
}

# Tools available inside the explore agent (subset of read-only tools)
EXPLORE_AGENT_TOOLS = ["web_search", "people_search", "web_fetch", "grep", "attempt_completion_with_result"]


# ============================================================================
# B7: Deterministic tool-list renderer
# ============================================================================


def _first_nonempty_line(text: str) -> str:
    """Return the first non-empty stripped line of `text`, or '' if there is none."""
    if not text:
        return ""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def render_tool_list(
    registry: ToolRegistry,
    *,
    tool_prompts: Optional[Dict[str, str]] = None,
    sort: bool = True,
) -> str:
    """Render a deterministic, single-line-per-tool listing of `registry`.

    Output format: ``- {tool_name}: {description}`` per tool, joined by
    newlines. The description is the first non-empty line of the matching
    entry in ``tool_prompts`` (when supplied); if absent, it falls back to
    the first line of the Pydantic class docstring. Empty fallbacks render
    as ``"No description"`` so every listed tool produces a non-empty line.

    Determinism guarantee: with the same registry, two calls return the
    exact same string. Tools are sorted by name (when ``sort=True``, the
    default) so registry insertion order can never change the output.

    Args:
        registry: ``{name: Pydantic model}`` map. Use ``TOOL_MODELS`` for
            the canonical agent-tool registry, or pass a subset.
        tool_prompts: Optional ``{name: PROMPT}`` map injected by the caller
            (typically ``tools.prompts.TOOL_PROMPTS``). Pass it from any
            non-utils caller so this utility stays free of ``tools/`` deps.
        sort: When True (default), output lines are alphabetically sorted by
            tool name. Set to False to preserve registry iteration order
            (callers that pass an already-ordered subset).

    Returns:
        A multiline string with one ``- name: description`` line per tool,
        joined by ``\\n``. Returns an empty string if the registry is empty.
    """
    prompts = tool_prompts or {}
    names = sorted(registry.keys()) if sort else list(registry.keys())
    lines = []
    for name in names:
        description = _first_nonempty_line(prompts.get(name, ""))
        if not description:
            model = registry[name]
            description = _first_nonempty_line(model.__doc__ or "")
        if not description:
            description = "No description"
        lines.append(f"- {name}: {description}")
    return "\n".join(lines)

# ============================================================================
# Dynamic AgentAction Model Generation
# ============================================================================


def create_agent_action_model(
    available_tool_names: List[str],
    tool_registry: Optional[Dict[str, Type[BaseModel]]] = None,
) -> Type[BaseModel]:
    """
    Dynamically create an AgentAction Pydantic model based on available tools.

    This ensures:
    - Only available tools are in the schema (better LLM guidance)
    - Type-safe tool calls (Pydantic validates structure)
    - No JSON string parsing hacks needed

    NOTE: reasoning is NOT part of this model anymore. Reasoning is handled via
    OpenRouter's reasoning_details which are extracted from API responses and
    stored in message metadata.

    Args:
        available_tool_names: List of tool names this agent can use
        tool_registry: Optional custom registry (defaults to TOOL_MODELS)

    Returns:
        Pydantic model class for AgentAction with proper tool union
    """
    registry = tool_registry or TOOL_MODELS

    # Build list of tool models for available tools
    tool_types = []
    for name in available_tool_names:
        if name in registry:
            tool_types.append(registry[name])
        else:
            logger.warning(f"Tool '{name}' not found in registry, skipping")

    # Create union type for tool calls
    if not tool_types:
        # No tools available - agent can only communicate
        ToolCallUnion = type(None)  # Empty type
        tool_calls_field = (
            List[ToolCallUnion],
            Field(default_factory=list, description="No tools available for this agent"),
        )
    elif len(tool_types) == 1:
        # Single tool type - no union needed
        ToolCallUnion = tool_types[0]
        tool_calls_field = (
            List[ToolCallUnion],
            Field(default_factory=list, description="List of tools to call in sequence"),
        )
    else:
        # Multiple tools - create union
        ToolCallUnion = Union[tuple(tool_types)]
        tool_calls_field = (
            List[ToolCallUnion],
            Field(default_factory=list, description="List of tools to call in sequence"),
        )

    # Dynamically create the AgentAction model
    # NOTE: reasoning is handled externally via OpenRouter reasoning_details
    AgentAction = create_model(
        "AgentAction",
        response=(
            str,
            Field(
                description="Thinking about what to do next. This IS shown to the user as thinking text, "
                "but is NOT seen by the verifier (verifier only evaluates tool calls and their results). "
                "Write in plain prose. No markup, no bullet prefixes, no special formatting symbols."
            ),
        ),
        tool_calls=tool_calls_field,
        __base__=BaseModel,
    )

    return AgentAction


# ============================================================================
# Static Models (not tool-specific)
# ============================================================================


class ProgressScore(BaseModel):
    """Schema for progress evaluation."""

    reasoning: str = Field(description="Your internal thinking process about the progress")
    score: float = Field(ge=0.0, le=1.0, description="Progress score from 0.0 (no progress) to 1.0 (complete)")


__all__ = [
    "WaitForTool",
    "WebSearchTool",
    "PeopleSearchTool",
    "WebFetchTool",
    "SendMessageToUserTool",
    "SendMessageToUserExecutePhaseTool",
    "MessagePersonTool",
    "SpawnAgentTool",
    "SetPlanTool",
    "AttemptCompletionTool",
    "AttemptCompletionWithResultTool",
    "CallPhoneNumberTool",
    "GrepTool",
    "TOOL_MODELS",
    "ToolRegistry",
    "create_agent_action_model",
    "render_tool_list",
    "ProgressScore",
]
