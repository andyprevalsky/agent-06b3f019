"""LLM tool for agent reasoning and decision making."""

import asyncio
import base64
import contextlib
import json
import random
import re
import time  # Import at module level for Temporal workflow sandbox compatibility
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, Tuple, Type, TypeVar

import httpx  # Used with instructor
import instructor  # Import at module level for Temporal workflow sandbox compatibility
import structlog
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, create_model, model_validator
from temporalio import activity
from temporalio.exceptions import ApplicationError

from config import load_config
from helpers.attachments import (
    FilePointer,
    build_attachment_metadata_text,
    get_cached_file,
    get_file_from_pointer,
)
from helpers.context_compaction import is_excluded_from_model
from helpers.context_pointers import annotate_with_pointer, resolve_pointers_in_messages
from helpers.context_scope import is_internal_subagent_message
from helpers.messages import (
    CoalescingStreamBroadcaster,
    stream_assistant_chunk,
    stream_plan_event,
    stream_tool_event,
)
from helpers.tracing import backend_api_headers, current_request_id, traced
from helpers.workflow_generation import workflow_generation_headers
from providers.fast_cache import client as fast_cache_client
from providers.fast_cache.client import (
    ensure_position_context as ensure_fast_cache_position_context,
)
from providers.fast_cache.context import (
    FastCacheContext,
    write_through_enabled_for_user,
)
from providers.fast_cache.context import (
    current_context as current_fast_cache_context,
)
from providers.fast_cache.context import (
    set_context as set_fast_cache_context,
)
from providers.rose import (
    ClaudeAuthContext,
    ComputeAuthContext,
    GptAuthContext,
    RoseClient,
    RoseError,
    claude_auth_from_token,
    gpt_auth_from_token,
    pool_for_model,
)
from providers.rose.policy import anthropic_family_excluded, benchmark_compute_token_type
from providers.rose.schema import (
    SYNTHETIC_OUTPUT_TOOL_NAME,
    build_openai_response_format,
)
from providers.rose.structured_output import StructuredOutputAccumulator
from providers.rose.transforms import reconstruct_agent_response
from utils.error_utils import extract_error_message
from utils.tool_schemas import (
    create_agent_action_model,
)

logger = structlog.get_logger()

CLOUD_AGENT_TOOL_NAME = "cloud_agent"


class LLMStructuredOutputError(ValueError):
    """The provider completed, but its structured output violated our contract."""


# A malformed / schema-invalid structured output is non-deterministic (the model
# occasionally emits an incomplete tool call, e.g. {"tool": "think"} with no
# fields). Re-generate up to this many extra times before surfacing the error — a
# fresh call almost always parses.
MAX_STRUCTURED_PARSE_RETRIES = 2


class ResponseSchemaPersistenceError(RuntimeError):
    """A generated response schema could not be saved durably."""


TRAILING_MESSAGE_REFERENCE_RE = re.compile(
    r"(?P<prefix>(?:^|\n\n)Reference:\s*)"
    r"(?P<ref>@ref:message:[a-f0-9-]{36}(?:\[start=\"[^\"]+\"\|end=\"[^\"]+\"\])?)"
    r"(?P<trailing>\s*)$"
)


def _split_trailing_message_reference(text: str) -> tuple[str, str]:
    """Split the trailing context-pointer annotation from message text."""
    match = TRAILING_MESSAGE_REFERENCE_RE.search(text)
    if not match:
        return text, ""
    return text[: match.start()], f"{match.group('prefix')}{match.group('ref')}{match.group('trailing')}"


def _append_llm_context_sections_preserving_reference(text: str, sections: List[str]) -> str:
    """Append LLM-only sections before the terminal Reference annotation."""
    body, reference = _split_trailing_message_reference(text)
    parts = [body.rstrip()] if body.strip() else []
    parts.extend(section for section in sections if section)
    result = "\n\n".join(parts)
    if reference:
        result = f"{result}\n\n{reference.strip()}" if result else reference.strip()
    return result


def _self_close_trailing_message_reference(text: str) -> str:
    """Render a terminal Reference annotation as a non-expanding pointer tag."""
    match = TRAILING_MESSAGE_REFERENCE_RE.search(text)
    if not match:
        return text
    return (
        text[: match.start()]
        + f'{match.group("prefix")}<resolved-ref pointer="{match.group("ref")}"/>'
        + match.group("trailing")
    )


def _extract_browser_recording_dump_extra(context: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    """Return the latest browser recording metadata present in agent messages."""
    if not context:
        return {}

    for message in reversed(context):
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        if metadata.get("action_type") != "recording":
            continue

        recording_path = metadata.get("recording_path")
        if not recording_path:
            continue

        index_path = Path(str(recording_path))
        return {
            "browser_recording_path": str(index_path),
            "browser_recording_manifest_path": str(index_path.with_name("manifest.json")),
            "browser_recording_task_id": metadata.get("task_id") or metadata.get("subAgentId"),
            "browser_session_metadata": metadata.get("browser_session_metadata") or {},
        }

    return {}


class VerifierSessionFilePointer(BaseModel):
    """Remote-session file pointer extracted before upload to storage."""

    path: str = Field(..., description="Absolute file path in the remote session, starting with /.")


def _is_cloud_agent_lifecycle_tool(metadata: Dict[str, Any]) -> bool:
    return metadata.get("toolName") == CLOUD_AGENT_TOOL_NAME


# Same-machine optimization: passes large LLM context without Temporal serialization.
# On cross-machine miss, call_llm_activity falls back to fetching from backend API.
_pending_llm_context: Dict[str, Any] = {}  # agent_id -> (context, system_prompt, pre_resolved_ids)


def _add_cache_breakpoint_before_extra_user_message(messages: List[Dict[str, Any]]) -> bool:
    """Mark the latest stable conversational block before a per-call suffix.

    The caller invokes this before appending ``extra_user_message``. That keeps
    the full system+tools+conversation prefix identical across param-populator
    calls while the task-specific suffix remains outside the cached prefix.
    """
    for message in reversed(messages):
        if message.get("role") in {"system", "tool"}:
            continue
        content = message.get("content")
        if isinstance(content, str) and content:
            message["content"] = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
            return True
        if isinstance(content, list):
            for block in reversed(content):
                if isinstance(block, dict):
                    block["cache_control"] = {"type": "ephemeral"}
                    return True
    return False


def _safe_heartbeat(message: str) -> None:
    """Call activity.heartbeat() if we're in an activity context, otherwise silently skip."""
    with contextlib.suppress(Exception):
        activity.heartbeat(message)


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0  # Workflow sandbox - TTFT logging will show 0ms


T = TypeVar("T", bound=BaseModel)


_RESPONSE_SCHEMA_SYSTEM_PROMPT = """You are an expert at analyzing agent goals and producing the MINIMAL output schema needed to verify the goal was completed.

Your output is consumed by an automated verifier that scores 1.0 IFF every field in the schema can be populated accurately from tool-result evidence. Therefore:
  - EVERY field you add must be populatable for the goal to count as done.
  - Adding optional / nice-to-have fields PENALIZES the agent — keep it strict.
  - Field names must be SPECIFIC to the goal, not generic catch-alls.
  - You MUST return AT LEAST ONE field. A schema with zero fields is invalid — every goal that warrants a verifier must produce at least one verifiable output.

# CORE PRINCIPLES

1. MUST-HAVE ONLY, AT LEAST ONE. Generate ONLY the fields strictly required to fully answer the user's goal — but ALWAYS at least one field. Skip nice-to-haves. Do NOT add fields like 'reasoning', 'sources', 'confidence', 'notes', or other meta-fields unless the goal explicitly asks for them. The minimum is 1 field; the maximum should still be tight (typically 1-5).

2. SPECIFIC NAMES. Field names must be anchored in the goal. If the goal asks for Tokyo's population, the field is `population` or `tokyo_population` — not `result`. If the goal asks for an email + LinkedIn URL, the fields are `email` and `linkedin_url` — not `output`.

3. SINGLE-VALUE GOALS ARE FINE. If the goal is intrinsically about ONE value, emit EXACTLY ONE field with a precise name. Don't pad the schema, but never drop below one.

4. CONCRETE TYPES. Pick the most precise type the goal allows. `int` beats `str` for a population. `list[object]` beats `str` for a comparison table.

5. EXPLICIT OBJECT PROPERTIES. Never encode object subfields in prose. For `object` and `list[object]`, put every required nested field in `properties`. The verifier enforces those properties as the object shape.

# BANNED FIELD NAMES

Do NOT use these catch-all names: result, output, answer, data, value, response.

Always replace with a goal-anchored name. Examples:
  - "the answer to the math problem" -> `product`, `sum`, `final_int` (whichever fits)
  - "the chosen venue" -> `selected_venue_name` + `selected_venue_url`
  - "the email I should send" -> `final_email_body` + `final_email_subject`

# SUPPORTED TYPES

  - str: String value
  - int: Integer number
  - float: Decimal number
  - bool: True/false
  - list[str]: List of strings
  - list[int]: List of integers
  - object: Nested object — MUST include properties: [{ name, type }]
  - list[object]: List of objects — MUST include properties describing each item shape
  - file_pointer: Reference to a file produced by the agent
  - list[file_pointer]: List of file references
  - session_file_pointer: Internal remote-session file reference
  - list[session_file_pointer]: List of internal remote-session file references

# WORKED EXAMPLES

Goal: "What is Tokyo's current population?"
GOOD fields: [{ "name": "population", "type": "int" }]
BAD fields: [{ "name": "result", "type": "str" }]

Goal: "Find this person's email and LinkedIn URL."
GOOD fields: [{ "name": "email", "type": "str" }, { "name": "linkedin_url", "type": "str" }]
BAD fields: [{ "name": "data", "type": "str" }]

Goal: "Multiply Tokyo's population by NYC's population."
GOOD fields: [{ "name": "tokyo_population", "type": "int" }, { "name": "nyc_population", "type": "int" }, { "name": "product", "type": "int" }]

Goal: "Compare three cities by cost of living and rank them."
GOOD fields: [{ "name": "cities", "type": "list[object]", "properties": [{ "name": "name", "type": "str" }, { "name": "cost_of_living_index", "type": "float" }, { "name": "rank", "type": "int" }] }]

Goal: "Generate a logo as a PNG."
GOOD fields: [{ "name": "logo", "type": "file_pointer" }]

Goal: "Buy me a black beanie on Amazon that costs less than $35 and looks well-made."
GOOD fields: [{ "name": "selected_beanie_url", "type": "str" }, { "name": "selected_beanie_price_usd", "type": "float" }, { "name": "purchase_completion_evidence", "type": "str" }]
BAD fields: [{ "name": "selected_beanie_url", "type": "str" }, { "name": "selected_beanie_price_usd", "type": "float" }]
BAD fields: [{ "name": "selected_beanie_url", "type": "str" }, { "name": "selected_beanie_price_usd", "type": "float" }, { "name": "added_to_cart", "type": "bool" }, { "name": "checkout_status", "type": "str" }]
BAD fields: [{ "name": "selected_beanie_url", "type": "str" }, { "name": "selected_beanie_price_usd", "type": "float" }, { "name": "item_acquired", "type": "bool" }]

For shopping goals phrased as "buy", "purchase", "order", or "complete checkout",
the schema MUST require grounded provider-native purchase completion evidence proving that the item was actually
acquired. Accept a labeled order/confirmation/receipt identifier when the provider displays one, OR an explicit
provider confirmation/status page showing that the purchase was placed or completed. Do not require a specific
identifier unless the user explicitly asks for that identifier.
Selecting a product URL, adding an item to cart, or reaching checkout is not enough to verify a purchase goal.

# YOUR JOB

Given a goal, return JSON with:
  - reasoning: 1-3 sentences on what concrete outputs the goal requires.
  - fields: the minimal MUST-HAVE list, with AT LEAST ONE field. Specific names and concrete types. For object/list[object], include explicit `properties`; never put subfields in prose. A zero-length `fields` array is invalid and will be rejected.

Output JSON only. Do not include prose outside the JSON envelope."""


_SchemaFieldType = Literal[
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
    "session_file_pointer",
    "list[session_file_pointer]",
]

_SchemaNestedFieldType = Literal[
    "str",
    "int",
    "float",
    "bool",
    "list[str]",
    "list[int]",
    "file_pointer",
    "list[file_pointer]",
    "session_file_pointer",
    "list[session_file_pointer]",
]


class _GeneratedResponseSchemaNestedField(BaseModel):
    name: str = Field(description="Nested field name in snake_case.")
    type: _SchemaNestedFieldType = Field(description="Nested field type.")


class _GeneratedResponseSchemaField(BaseModel):
    name: str = Field(description="Field name in snake_case.")
    type: _SchemaFieldType = Field(description="Field type.")
    properties: Optional[List[_GeneratedResponseSchemaNestedField]] = Field(
        default=None,
        description="Required for object/list[object]. Explicit nested fields; do not encode subfields in prose.",
    )

    @model_validator(mode="after")
    def _object_fields_require_properties(self):
        if self.type in ("object", "list[object]") and not self.properties:
            raise ValueError("object and list[object] schema fields require explicit properties")
        return self


class _GeneratedResponseSchema(BaseModel):
    reasoning: str = Field(description="Analysis of what concrete outputs the goal requires.")
    fields: List[_GeneratedResponseSchemaField] = Field(
        min_length=1,
        description="List of MUST-HAVE output fields. At least one field is required.",
    )


def _build_claude_auth_context(
    claude_token: Optional[str],
    *,
    source: Optional[str] = None,
    user_id: Optional[str] = None,
    pool_token_id: Optional[str] = None,
    lineage_key: Optional[str] = None,
    agent_id: Optional[str] = None,
    root_agent_id: Optional[str] = None,
    fast_cache_affinity_key: Optional[str] = None,
    max_rotations: int = 2,
) -> Optional[ClaudeAuthContext]:
    """Build the rotation-capable claudeAuth context RoseClient.complete needs."""
    if not claude_token:
        return None

    if source not in ("user", "pool") or not user_id:
        return claude_auth_from_token(claude_token)

    async def _mark_rate_limited(
        ctx: ClaudeAuthContext,
        cooldown_seconds: int,
        rate_limited_until: Optional[str] = None,
        failure_reason: Optional[str] = None,
    ) -> bool:
        return await mark_compute_token_rate_limited_activity(
            "claude",
            ctx.source,
            user_id=ctx.user_id,
            pool_token_id=ctx.pool_token_id,
            cooldown_seconds=cooldown_seconds,
            rate_limited_until=rate_limited_until,
            failure_reason=failure_reason,
        )

    async def _fetch_fresh(fetch_user_id: str) -> Optional[ComputeAuthContext]:
        result = await fetch_compute_token_activity(
            fetch_user_id,
            lineage_key=lineage_key,
            agent_id=agent_id,
            root_agent_id=root_agent_id,
            fast_cache_affinity_key=fast_cache_affinity_key,
        )
        if not result or not result.get("accessToken"):
            return None
        return _build_compute_auth_context(
            result,
            fetch_user_id,
            agent_id=agent_id,
            root_agent_id=root_agent_id,
            fast_cache_affinity_key=fast_cache_affinity_key,
            max_rotations=max_rotations,
        )

    async def _heartbeat_lease(ctx: ComputeAuthContext) -> None:
        await heartbeat_compute_token_lineage_activity(ctx.lineage_key or "")

    return ClaudeAuthContext(
        token=claude_token,
        source=source,
        user_id=user_id,
        pool_token_id=pool_token_id if source == "pool" else None,
        lineage_key=lineage_key,
        mark_rate_limited=_mark_rate_limited,
        fetch_fresh=_fetch_fresh if max_rotations > 0 else None,
        heartbeat_lease=_heartbeat_lease if lineage_key else None,
        max_rotations=max_rotations,
    )


def _build_gpt_auth_context(
    gpt_token: Optional[str],
    *,
    account_id: Optional[str] = None,
    source: Optional[str] = None,
    user_id: Optional[str] = None,
    pool_token_id: Optional[str] = None,
    lineage_key: Optional[str] = None,
    agent_id: Optional[str] = None,
    root_agent_id: Optional[str] = None,
    fast_cache_affinity_key: Optional[str] = None,
    max_rotations: int = 2,
) -> Optional[GptAuthContext]:
    """Build the gptAuth context RoseClient.complete needs."""
    if not gpt_token:
        return None

    if source not in ("user", "pool") or not user_id:
        return gpt_auth_from_token(gpt_token, account_id)

    async def _mark_rate_limited(
        ctx: GptAuthContext,
        cooldown_seconds: int,
        rate_limited_until: Optional[str] = None,
        failure_reason: Optional[str] = None,
    ) -> bool:
        return await mark_compute_token_rate_limited_activity(
            "gpt",
            ctx.source,
            user_id=ctx.user_id,
            pool_token_id=ctx.pool_token_id,
            cooldown_seconds=cooldown_seconds,
            rate_limited_until=rate_limited_until,
            failure_reason=failure_reason,
        )

    async def _fetch_fresh(fetch_user_id: str) -> Optional[ComputeAuthContext]:
        result = await fetch_compute_token_activity(
            fetch_user_id,
            lineage_key=lineage_key,
            agent_id=agent_id,
            root_agent_id=root_agent_id,
            fast_cache_affinity_key=fast_cache_affinity_key,
        )
        if not result or not result.get("accessToken"):
            return None
        return _build_compute_auth_context(
            result,
            fetch_user_id,
            agent_id=agent_id,
            root_agent_id=root_agent_id,
            fast_cache_affinity_key=fast_cache_affinity_key,
            max_rotations=max_rotations,
        )

    async def _heartbeat_lease(ctx: ComputeAuthContext) -> None:
        await heartbeat_compute_token_lineage_activity(ctx.lineage_key or "")

    return GptAuthContext(
        token=gpt_token,
        source=source,
        user_id=user_id,
        account_id=account_id,
        pool_token_id=pool_token_id if source == "pool" else None,
        lineage_key=lineage_key,
        mark_rate_limited=_mark_rate_limited,
        fetch_fresh=_fetch_fresh,
        heartbeat_lease=_heartbeat_lease if lineage_key else None,
        max_rotations=max_rotations,
    )


def _build_compute_auth_context(
    result: Dict[str, Any],
    user_id: str,
    *,
    agent_id: Optional[str] = None,
    root_agent_id: Optional[str] = None,
    fast_cache_affinity_key: Optional[str] = None,
    max_rotations: int = 2,
) -> Optional[ComputeAuthContext]:
    """Build a direct auth context from the unified compute-token endpoint."""
    token = result.get("accessToken")
    provider_type = result.get("type")
    if not token or provider_type not in ("claude", "gpt"):
        return None
    if provider_type == "claude":
        return _build_claude_auth_context(
            token,
            source=result.get("source"),
            user_id=user_id,
            pool_token_id=result.get("poolTokenId"),
            lineage_key=result.get("lineageKey"),
            agent_id=agent_id,
            root_agent_id=root_agent_id,
            fast_cache_affinity_key=fast_cache_affinity_key or result.get("fastCacheAffinityKey"),
            max_rotations=max_rotations,
        )
    return _build_gpt_auth_context(
        token,
        account_id=result.get("accountId"),
        source=result.get("source"),
        user_id=user_id,
        pool_token_id=result.get("poolTokenId"),
        lineage_key=result.get("lineageKey"),
        agent_id=agent_id,
        root_agent_id=root_agent_id,
        fast_cache_affinity_key=fast_cache_affinity_key or result.get("fastCacheAffinityKey"),
        max_rotations=max_rotations,
    )


def _build_compute_auth_context_from_payload(
    compute_auth: Optional[Dict[str, Any]],
) -> Tuple[Optional[ClaudeAuthContext], Optional[GptAuthContext]]:
    if not isinstance(compute_auth, dict):
        return None, None

    token_type = compute_auth.get("type")
    access_token = compute_auth.get("accessToken")
    if token_type not in ("claude", "gpt") or not isinstance(access_token, str) or not access_token:
        return None, None

    user_id = compute_auth.get("userId")
    if isinstance(user_id, str) and user_id:
        ctx = _build_compute_auth_context(
            compute_auth,
            user_id,
            agent_id=compute_auth.get("agentId"),
            root_agent_id=compute_auth.get("rootAgentId"),
            fast_cache_affinity_key=compute_auth.get("fastCacheAffinityKey"),
        )
        if isinstance(ctx, ClaudeAuthContext):
            return ctx, None
        if isinstance(ctx, GptAuthContext):
            return None, ctx

    if token_type == "claude":
        return claude_auth_from_token(access_token), None
    return None, gpt_auth_from_token(access_token, compute_auth.get("accountId"))


def _schema_from_generated_model(generated: _GeneratedResponseSchema) -> Dict[str, Any]:
    fields: List[Dict[str, Any]] = []
    for field in generated.fields:
        item: Dict[str, Any] = {
            "name": field.name,
            "type": field.type,
            "required": True,
        }
        if field.properties:
            item["properties"] = [prop.model_dump() for prop in field.properties]
        fields.append(item)
    return {"fields": fields}


_PURCHASE_GOAL_MARKERS = (
    "buy me",
    "purchase",
    "order",
    "place an order",
    "complete checkout",
    "checkout",
)


def _is_purchase_goal(goal: str) -> bool:
    normalized = f" {goal.lower()} "
    return any(marker in normalized for marker in _PURCHASE_GOAL_MARKERS)


def _schema_has_purchase_confirmation_identifier(schema: Dict[str, Any]) -> bool:
    fields = schema.get("fields", []) if isinstance(schema, dict) else []
    for field in fields:
        name = str(field.get("name", "")).lower()
        description = str(field.get("description", "")).lower()
        searchable = f"{name} {description}"
        if any(
            token in searchable
            for token in (
                "order_id",
                "order id",
                "order number",
                "order_confirmation_id",
                "order confirmation id",
                "order confirmation number",
                "confirmation_id",
                "confirmation id",
                "confirmation number",
                "receipt_number",
                "receipt number",
                "purchase_confirmation_id",
                "purchase confirmation id",
                "purchase confirmation number",
            )
        ):
            return True
    return False


def _goal_explicitly_requests_purchase_confirmation_identifier(goal: str) -> bool:
    normalized = " ".join(goal.lower().replace("_", " ").replace("-", " ").split())
    return any(
        phrase in normalized
        for phrase in (
            "order id",
            "order number",
            "confirmation id",
            "confirmation number",
            "receipt id",
            "receipt number",
            "purchase confirmation id",
            "purchase confirmation number",
        )
    )


def _is_purchase_confirmation_identifier_field(field: Dict[str, Any]) -> bool:
    return _schema_has_purchase_confirmation_identifier({"fields": [field]})


def _normalize_response_schema_for_goal(goal: str, schema: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure goal-critical fields are present when the model under-specifies a schema."""
    if not _is_purchase_goal(goal):
        return schema

    normalized = {**schema, "fields": list(schema.get("fields", []))}
    if _goal_explicitly_requests_purchase_confirmation_identifier(goal):
        if _schema_has_purchase_confirmation_identifier(normalized):
            return normalized
        normalized["fields"].append(
            {
                "name": "order_confirmation_id",
                "type": "str",
                "required": True,
                "description": "Grounded order id, confirmation id, receipt number, or purchase confirmation number explicitly requested by the user.",
            }
        )
        return normalized

    normalized["fields"] = [
        field
        for field in normalized["fields"]
        if not _is_purchase_confirmation_identifier_field(field)
    ]
    field_names = {str(field.get("name", "")).lower() for field in normalized["fields"]}

    if "purchase_completion_evidence" not in field_names:
        normalized["fields"].append(
            {
                "name": "purchase_completion_evidence",
                "type": "str",
                "required": True,
                "description": "Grounded provider-native proof that the purchase was placed or completed: a labeled order, confirmation, or receipt identifier when displayed, or explicit confirmation/status-page evidence when no identifier is displayed.",
            }
        )

    return normalized


async def _generate_response_schema_with_rose(
    goal: str,
    *,
    agent_id: str,
    compute_auth: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], Dict[str, int]]:
    claude_auth_context, gpt_auth_context = _build_compute_auth_context_from_payload(compute_auth)
    messages = [
        {"role": "system", "content": _RESPONSE_SCHEMA_SYSTEM_PROMPT},
        {"role": "user", "content": f"Goal: {goal}"},
    ]
    client = RoseClient()
    max_generation_attempts = 3
    last_error: Optional[Exception] = None

    for attempt in range(1, max_generation_attempts + 1):
        for max_tokens in (2000, 4000):
            try:
                response = await client.collect(
                    pool="rose-1-lite",
                    messages=messages,
                    response_model=_GeneratedResponseSchema,
                    temperature=0.3,
                    max_tokens=max_tokens,
                    skip_cache_write=True,
                    claude_auth=claude_auth_context,
                    gpt_auth=gpt_auth_context,
                    agent_id=agent_id,
                    request_id=current_request_id() or str(uuid.uuid4())[:8],
                    call_site="response_schema",
                    deadline_s=90.0,
                )
                usage = response.usage or {}
                if usage.get("finish_reason") == "length" and max_tokens < 4000:
                    logger.warning(
                        "Response schema generation hit max_tokens; escalating",
                        agent_id=agent_id,
                        max_tokens=max_tokens,
                    )
                    continue

                content = (
                    _content_from_structured_rose_response(response.tool_calls, _GeneratedResponseSchema)
                    or response.content
                )
                if not content:
                    raise ValueError("LLM returned no response schema content")
                generated = _GeneratedResponseSchema.model_validate_json(content)
                prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
                completion_tokens = int(usage.get("completion_tokens", 0) or 0)
                total_tokens = int(usage.get("total_tokens", prompt_tokens + completion_tokens) or 0)
                schema = _normalize_response_schema_for_goal(goal, _schema_from_generated_model(generated))
                return schema, {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": total_tokens or prompt_tokens + completion_tokens,
                }
            except RoseError as exc:
                last_error = exc
                break
            except Exception as exc:
                last_error = exc
                if max_tokens < 4000 and "finish_reason=length" in str(exc):
                    continue
                break

        if attempt < max_generation_attempts:
            await asyncio.sleep(0.2 * (2 ** (attempt - 1)))

    raise last_error or ValueError("Unknown error generating response schema")


def prepare_schema_for_openai(pydantic_model: Type[BaseModel]) -> Dict[str, Any]:
    """
    Convert a Pydantic model to a JSON schema ready for OpenAI strict structured outputs.

    OpenAI's strict mode requires:
    1. `additionalProperties: false` on EVERY object (root and nested)
    2. All properties must be in the `required` array (no optional fields)
    3. No $ref references (some providers like Azure don't resolve them properly)

    This function recursively transforms the schema to meet these requirements,
    including inlining all $ref references.

    Args:
        pydantic_model: A Pydantic BaseModel class

    Returns:
        JSON schema dict ready for OpenAI's response_format
    """
    schema = pydantic_model.model_json_schema()

    # Extract $defs for reference resolution
    defs = schema.get("$defs", {})

    def resolve_ref(ref: str) -> Dict[str, Any]:
        """Resolve a $ref string to its definition."""
        # Format: "#/$defs/DefinitionName"
        if ref.startswith("#/$defs/"):
            def_name = ref[8:]  # Remove "#/$defs/" prefix
            if def_name in defs:
                # Return a deep copy to avoid mutation issues
                import copy

                return copy.deepcopy(defs[def_name])
        raise ValueError(f"Cannot resolve reference: {ref}")

    def inline_refs(obj: Any) -> Any:
        """Recursively inline all $ref references."""
        if not isinstance(obj, dict):
            return obj

        # If this object contains a $ref, resolve it and merge with other properties
        if "$ref" in obj:
            resolved = resolve_ref(obj["$ref"])
            # Recursively inline any refs in the resolved definition
            resolved = inline_refs(resolved)

            # Merge other properties (like 'default') into the resolved schema
            for key, value in obj.items():
                if key != "$ref":
                    resolved[key] = inline_refs(value) if isinstance(value, (dict, list)) else value
            return resolved

        # Otherwise, recursively process all values
        result = {}
        for key, value in obj.items():
            if isinstance(value, dict):
                result[key] = inline_refs(value)
            elif isinstance(value, list):
                result[key] = [inline_refs(item) for item in value]
            else:
                result[key] = value
        return result

    def add_strict_properties(obj: Dict[str, Any]) -> None:
        """Recursively add additionalProperties: false to all objects."""
        if not isinstance(obj, dict):
            return

        # If this is an object type, handle additionalProperties
        if obj.get("type") == "object":
            existing_additional = obj.get("additionalProperties")

            # If additionalProperties is already a schema (dict), it's a Dict[K,V] type
            # Preserve it and recurse into the schema to add strict properties there
            if isinstance(existing_additional, dict):
                add_strict_properties(existing_additional)
            else:
                # For regular objects, set additionalProperties: false
                obj["additionalProperties"] = False

            # Ensure all properties are required
            if "properties" in obj:
                obj["required"] = list(obj["properties"].keys())

                # Recurse into each property
                for prop in obj["properties"].values():
                    add_strict_properties(prop)

        # Handle anyOf/oneOf/allOf (union types)
        for key in ["anyOf", "oneOf", "allOf"]:
            if key in obj:
                for item in obj[key]:
                    add_strict_properties(item)

        # Handle array items
        if obj.get("type") == "array" and "items" in obj:
            add_strict_properties(obj["items"])

        # Handle $defs (schema definitions for nested models)
        if "$defs" in obj:
            for definition in obj["$defs"].values():
                add_strict_properties(definition)

    # First, inline all $ref references
    schema = inline_refs(schema)

    # Remove $defs since all refs are now inlined
    if "$defs" in schema:
        del schema["$defs"]

    # Then add strict properties
    add_strict_properties(schema)
    return schema


def build_verifier_context_messages(
    context: List[Dict[str, Any]],
    system_prompt: str,
    verifier_file_evidence_by_message: Optional[Dict[str, List[Dict[str, Any]]]] = None,
) -> List[Dict[str, Any]]:
    """Build verifier messages with compressed tool results and progressive cache.

    Strips ASSISTANT and SYSTEM messages. Compresses USER + TOOL messages into
    user-role batches, split by prior verifier responses (which become the
    assistant turns to maintain user/assistant alternation).

    Sequential verifier calls share a growing cached prefix:
      call N reads [sys, user_batch1, asst_v1, ..., user_batchN-1, asst_vN-1]
      and writes only user_batchN (the new tool results).

    Multimodal: when a TOOL message carries `metadata.screenshot_b64`, the
    current text batch is flushed and a separate multimodal user message is
    emitted containing a text description plus an Anthropic-shaped image
    content block. Anthropic + OpenAI both accept content arrays mixed with
    plain-string messages, so the rest of the conversation remains text-only.
    """
    context = _filter_superseded_browser_protocol_failures(context)
    sorted_context = sorted(
        context,
        key=lambda m: m.get("timestamp", "1970-01-01"),
    )

    messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    current_batch: List[str] = []

    def _flush_batch() -> None:
        """Emit current_batch as a single user-role message and reset it."""
        nonlocal current_batch
        if current_batch:
            messages.append({"role": "user", "content": "\n\n".join(current_batch)})
            current_batch = []

    def _append_file_evidence(msg: Dict[str, Any]) -> None:
        if not verifier_file_evidence_by_message:
            return
        for payload in verifier_file_evidence_by_message.get(_verifier_file_evidence_key(msg), []):
            current_batch.append("TOOL_RESULT " + json.dumps(payload, ensure_ascii=False, default=str))

    for msg in sorted_context:
        role = msg.get("role", "")
        text = _self_close_trailing_message_reference(msg.get("text", ""))
        metadata = msg.get("metadata", {}) or {}

        if is_internal_subagent_message(msg):
            continue
        if role == "SYSTEM":
            continue

        if role == "ASSISTANT":
            if metadata.get("plannedToolName") == "reasoning":
                reasoning_payload = {
                    "tool_name": "reasoning",
                    "result": text,
                }
                dag_task_index = metadata.get("dagTaskIndex")
                if isinstance(dag_task_index, int):
                    reasoning_payload["dag_task_index"] = dag_task_index
                current_batch.append("TOOL_RESULT " + json.dumps(reasoning_payload, ensure_ascii=False, default=str))
            _append_file_evidence(msg)
            continue

        if role == "USER":
            current_batch.append(text)
            _append_file_evidence(msg)
            continue

        if role == "TOOL":
            if _is_cloud_agent_lifecycle_tool(metadata):
                continue

            if metadata.get("toolStatus") == "IN_PROGRESS":
                continue

            if metadata.get("verifierMessage"):
                _flush_batch()
                verifier_text = text
                if metadata.get("title"):
                    verifier_text = f"{metadata['title']}: {text}"
                messages.append({"role": "assistant", "content": verifier_text})
                continue

            structured_result = metadata.get("structured_response")
            if structured_result is None:
                structured_result = metadata.get("structuredResponse")

            tool_payload = {
                "tool_name": metadata.get("toolName", "tool"),
                "tool_call_id": metadata.get("toolCallId"),
                "result": structured_result if structured_result is not None else text,
            }
            if metadata.get("title"):
                tool_payload["title"] = metadata["title"]
            tool_text = "TOOL_RESULT " + json.dumps(tool_payload, ensure_ascii=False, default=str)

            screenshot_b64 = metadata.get("screenshot_b64")
            if screenshot_b64:
                # Multimodal path. The text body must NOT include the b64 blob —
                # we already emit it as an image block. spawn_browser_agent_v3
                # currently sets `text` to a description ("Final-state screenshot
                # available …"); guard here regardless in case future callers
                # mistakenly inline the b64 into text.
                if tool_text.find(screenshot_b64) != -1:
                    tool_text = tool_text.replace(
                        screenshot_b64,
                        "<screenshot moved to image content block>",
                    )

                # Flush any pending text first so the image is its own user turn,
                # keeping the alternation clean and the cache prefix stable for
                # text-only batches.
                _flush_batch()
                media_type = metadata.get("screenshot_media_type", "image/png")
                messages.append(
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": tool_text},
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": screenshot_b64,
                                },
                            },
                        ],
                    }
                )
                continue

            current_batch.append(tool_text)
            _append_file_evidence(msg)

    current_batch.append("Evaluate the agent's progress as JSON.")
    _flush_batch()

    return messages


def _verifier_file_evidence_key(msg: Dict[str, Any]) -> str:
    message_id = msg.get("message_id") or msg.get("id")
    if message_id:
        return str(message_id)
    return str(id(msg))


def _file_pointers_from_message(msg: Dict[str, Any]) -> List[FilePointer]:
    metadata = msg.get("metadata", {}) or {}
    if not isinstance(metadata, dict):
        metadata = {}

    attachments_data: List[Any] = []
    file_pointer = msg.get("file_pointer") or msg.get("filePointer")
    if isinstance(file_pointer, dict):
        attachments_data.append(file_pointer)

    metadata_attachments = metadata.get("attachments")
    if isinstance(metadata_attachments, list):
        attachments_data.extend(metadata_attachments)

    file_pointers: List[FilePointer] = []
    seen: set[str] = set()
    for item in attachments_data:
        if not isinstance(item, dict):
            continue
        fp = FilePointer.from_dict(item)
        if not fp.id or not fp.storage_path or fp.id in seen:
            continue
        seen.add(fp.id)
        file_pointers.append(fp)
    return file_pointers


def _verifier_file_metadata(fp: FilePointer) -> Dict[str, Any]:
    return {
        "id": fp.id,
        "storage_path": fp.storage_path,
        "original_filename": fp.original_filename,
        "mime_type": fp.mime_type,
        "size_bytes": fp.size_bytes,
        "created_at": fp.created_at,
    }


async def _resolve_verifier_file_evidence(
    context: List[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    """Resolve small readable file pointers into verifier-visible tool evidence.

    This mirrors the main-agent attachment loading policy: use the module cache
    first, download only from activity context, inline small text files, and
    fall back to metadata for large/binary/unavailable files.
    """
    evidence_by_message: Dict[str, List[Dict[str, Any]]] = {}
    for msg in context:
        if not isinstance(msg, dict) or is_internal_subagent_message(msg):
            continue
        if msg.get("role") == "SYSTEM":
            continue

        payloads: List[Dict[str, Any]] = []
        for fp in _file_pointers_from_message(msg):
            result_text = build_attachment_metadata_text(fp)
            content_inlined = False

            if fp.is_small_enough_for_llm() and fp.can_be_read_by_llm():
                file_content = None
                cached = get_cached_file(fp.id)
                if cached:
                    file_content = cached[0]
                elif activity.in_activity():
                    try:
                        file_content, _ = await get_file_from_pointer(fp)
                    except Exception as e:
                        logger.warning(
                            "Failed to resolve verifier attachment",
                            file_id=fp.id,
                            filename=fp.original_filename,
                            error=str(e),
                        )

                if file_content is not None and fp.is_text():
                    try:
                        text_content = file_content.decode("utf-8")
                        result_text = f"[File: {fp.original_filename}]\n```\n{text_content}\n```"
                        content_inlined = True
                    except UnicodeDecodeError:
                        result_text = build_attachment_metadata_text(fp)

            payloads.append(
                {
                    "tool_name": "artifact_file",
                    "artifact": _verifier_file_metadata(fp),
                    "content_inlined": content_inlined,
                    "result": result_text,
                }
            )

        if payloads:
            evidence_by_message[_verifier_file_evidence_key(msg)] = payloads
    return evidence_by_message


def _message_phase(msg: Dict[str, Any]) -> Optional[str]:
    metadata = msg.get("metadata", {}) or {}
    phase = metadata.get("phase") or metadata.get("_phase")
    if isinstance(phase, str) and phase.strip():
        return phase.strip().upper()
    return None


def _is_execute_boundary_message(msg: Dict[str, Any]) -> bool:
    metadata = msg.get("metadata", {}) or {}
    tool_name = metadata.get("toolName")
    title = metadata.get("title")
    status = metadata.get("toolStatus")
    if tool_name == "set_plan" and status == "FINISHED":
        return True
    if tool_name == "attempt_completion" and title == "Beginning Execute Phase":
        return True
    return False


def _filter_context_for_execute_verifier(context: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return only execute-phase context for final-task verification.

    The main workflow can have an earlier PLAN/RESEARCH phase with explore
    calls, set_plan, and planning verifier feedback. Execute verifiers must
    judge only evidence produced after the execute boundary. If no boundary or
    phase metadata is present, keep the context unchanged; execute-only agents
    and local browser/code verifier contexts have no planning phase to remove.
    """
    sorted_context = sorted(context, key=lambda m: m.get("timestamp", "1970-01-01"))

    first_execute_idx: Optional[int] = None
    for idx, msg in enumerate(sorted_context):
        if _message_phase(msg) == "EXECUTE":
            first_execute_idx = idx
            break

    if first_execute_idx is None:
        boundary_idx: Optional[int] = None
        for idx, msg in enumerate(sorted_context):
            if _is_execute_boundary_message(msg):
                boundary_idx = idx
        if boundary_idx is None:
            return context
        first_execute_idx = boundary_idx + 1

    execute_context: List[Dict[str, Any]] = []
    for msg in sorted_context[first_execute_idx:]:
        if _message_phase(msg) in ("PLAN", "RESEARCH"):
            continue
        execute_context.append(msg)
    return execute_context


def _context_timestamp(msg: Dict[str, Any]) -> datetime:
    ts = msg.get("timestamp") or msg.get("created_at") or msg.get("createdAt")
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    if isinstance(ts, str) and ts:
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime(1970, 1, 1, tzinfo=timezone.utc)


def _is_successful_browser_tool_result(msg: Dict[str, Any]) -> bool:
    metadata = msg.get("metadata", {}) or {}
    if msg.get("role") != "TOOL":
        return False
    if metadata.get("toolName") != "spawn_browser_agent":
        return False
    if metadata.get("toolStatus") != "FINISHED":
        return False
    title = str(metadata.get("title") or "")
    text = str(msg.get("text") or "")
    if "SUCCESS" in text and title in {"Browser automation complete", "✓ Task Completed"}:
        return True
    return isinstance(metadata.get("structured_response"), dict) or isinstance(metadata.get("structuredResponse"), dict)


def _is_superseded_browser_protocol_failure(msg: Dict[str, Any]) -> bool:
    metadata = msg.get("metadata", {}) or {}
    text = str(msg.get("text") or "")
    title = str(metadata.get("title") or "")
    if "unsupported protocol" not in text:
        return False
    if metadata.get("toolName") == "spawn_browser_agent":
        return True
    if metadata.get("toolName") == "attempt_completion" and metadata.get("verifierMessage"):
        return "browser agent failed to initialize" in text.lower() or "spawn_browser_agent" in text
    return "browser agent failed to initialize" in text.lower() and "Verifier rejected" in title


def _filter_superseded_browser_protocol_failures(context: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop stale browser-init protocol failures after later browser success.

    Local browser/proxy initialization can intermittently emit
    "unsupported protocol" failures. Once a later browser-agent result has
    completed successfully, that stale failure is no longer useful evidence and
    can cause both the verifier and the next agent turn to rerun completed work.
    """
    successful_browser_times = [_context_timestamp(msg) for msg in context if _is_successful_browser_tool_result(msg)]
    if not successful_browser_times:
        return context

    latest_success = max(successful_browser_times)
    return [
        msg
        for msg in context
        if not (_is_superseded_browser_protocol_failure(msg) and _context_timestamp(msg) < latest_success)
    ]


def _verifier_context_has_successful_browser_result(context: List[Dict[str, Any]]) -> bool:
    return any(_is_successful_browser_tool_result(msg) for msg in context)


def convert_context_to_messages(
    context: List[Dict[str, Any]],
    include_system: bool = True,
    # Default False: including assistant messages is prone to reward hacking
    # (agent can bias verifier with its own reasoning)
    include_assistant: bool = False,
) -> List[Dict[str, Any]]:
    """
    Convert workflow context to OpenAI/OpenRouter message format.

    Handles:
    - SYSTEM messages (blueprints): included if include_system=True
    - ASSISTANT messages: included if include_assistant=True (default False to prevent reward hacking)
    - ASSISTANT messages with tool_calls metadata: converted to proper OpenAI format
    - TOOL messages with verifierMessage=True: converted to ASSISTANT role for conversation flow
    - TOOL messages: converted to tool role only if preceded by matching ASSISTANT tool_call,
      otherwise converted to SYSTEM role
    - Skips IN_PROGRESS tool messages (only sends FINISHED results)
    - Sorts messages by timestamp to ensure chronological order
    - FINISHED tool messages use their IN_PROGRESS timestamp for sorting, ensuring tool results
      stay grouped with their ASSISTANT tool_call even if USER messages arrive in between

    Args:
        context: List of message dicts with role/text/metadata
        include_system: Whether to include SYSTEM messages (e.g. blueprints)
        include_assistant: Whether to include ASSISTANT messages (default False to prevent reward hacking)

    Returns:
        List of OpenAI-formatted messages in chronological order
    """
    messages = []

    # Sort context by timestamp to ensure chronological order
    # This is critical after polling for new user messages or continue-as-new
    def parse_timestamp(ts: str) -> datetime:
        """Parse ISO timestamp, defaulting to epoch if missing/invalid."""
        if not ts:
            return datetime(1970, 1, 1)
        try:
            # Handle both with and without timezone
            if ts.endswith("Z"):
                ts = ts[:-1] + "+00:00"
            return datetime.fromisoformat(ts)
        except (ValueError, AttributeError):
            return datetime(1970, 1, 1)

    # Build map of tool_call_id -> IN_PROGRESS timestamp
    # This allows FINISHED messages to use the IN_PROGRESS timestamp for sorting,
    # ensuring tool results stay grouped with their declaring ASSISTANT message
    # even if a USER message arrives before the tool completes
    tool_start_times: Dict[str, str] = {}
    for msg in context:
        meta = msg.get("metadata", {}) or {}
        if msg.get("role") == "TOOL" and meta.get("toolStatus") == "IN_PROGRESS":
            tool_call_id = meta.get("toolCallId")
            if tool_call_id:
                tool_start_times[tool_call_id] = msg.get("timestamp", "")

    def get_timestamp(msg: Dict[str, Any]) -> datetime:
        """Get timestamp for sorting. FINISHED tool messages use their IN_PROGRESS timestamp."""
        meta = msg.get("metadata", {}) or {}

        # For FINISHED tool messages, use the IN_PROGRESS timestamp if available
        # This keeps tool results grouped with their ASSISTANT tool_call, not separated by USER messages
        if msg.get("role") == "TOOL" and meta.get("toolStatus") == "FINISHED":
            tool_call_id = meta.get("toolCallId")
            if tool_call_id and tool_call_id in tool_start_times:
                return parse_timestamp(tool_start_times[tool_call_id])

        return parse_timestamp(msg.get("timestamp", ""))

    # Sort with SYSTEM messages first (but chronological among themselves),
    # then all other messages chronologically
    def sort_key(msg: Dict[str, Any]) -> tuple:
        """Sort key: (is_not_system, timestamp) so SYSTEM messages come first."""
        is_system = msg.get("role") == "SYSTEM"
        timestamp = get_timestamp(msg)
        return (not is_system, timestamp)  # False sorts before True, so SYSTEM first

    sorted_context = sorted(context, key=sort_key)

    # Track which tool_call_ids have been declared by ASSISTANT messages
    declared_tool_ids = set()

    for msg in sorted_context:
        role = msg.get("role", "ASSISTANT")
        content = msg.get("text", "")
        metadata = msg.get("metadata", {}) or {}  # Handle explicit None values

        if is_excluded_from_model(msg):
            continue

        # Skip ALL sub-agent internal messages regardless of role
        if is_internal_subagent_message(msg):
            continue

        if role == "SYSTEM":
            if include_system:
                messages.append({"role": "system", "content": content})

        elif role == "USER":
            messages.append({"role": "user", "content": content})

        elif role == "ASSISTANT":
            if not include_assistant:
                continue

            if metadata.get("tool_calls"):
                for tc in metadata["tool_calls"]:
                    tc_id = str(tc.get("tool_call_id", uuid.uuid4()))
                    declared_tool_ids.add(tc_id)

            # Include tool_calls if present in metadata
            assistant_msg = {"role": "assistant", "content": content}
            if metadata.get("tool_calls"):
                # Convert our tool call format to OpenAI format
                tool_calls = []
                for tc in metadata["tool_calls"]:
                    # Get or generate tool_call_id
                    tc_id = str(tc.get("tool_call_id", uuid.uuid4()))
                    tool_calls.append(
                        {
                            "id": tc_id,
                            "type": "function",
                            "function": {
                                "name": tc.get("tool"),
                                "arguments": json.dumps(
                                    {k: v for k, v in tc.items() if k not in ["tool", "tool_call_id"]}
                                ),
                            },
                        }
                    )
                assistant_msg["tool_calls"] = tool_calls

            messages.append(assistant_msg)

        elif role == "TOOL":
            if _is_cloud_agent_lifecycle_tool(metadata):
                continue

            # Skip IN_PROGRESS messages - only send FINISHED results to LLM
            if metadata.get("toolStatus") == "IN_PROGRESS":
                continue

            # Special handling for verifier messages: convert to ASSISTANT
            # These need to be in the conversation flow for the agent to see them
            if metadata.get("verifierMessage"):
                assistant_content = content
                if metadata.get("title"):
                    assistant_content = f"{metadata['title']}: {content}"
                messages.append({"role": "assistant", "content": assistant_content})
                continue

            tool_call_id = str(metadata.get("toolCallId", ""))

            # Only use tool role if this tool_call_id was declared by a preceding ASSISTANT message
            if tool_call_id and tool_call_id in declared_tool_ids:
                # Use proper tool role with tool_call_id and name
                # Prefix content with title (what user sees in UI) for context
                tool_content = content
                if metadata.get("title"):
                    tool_content = f"{metadata['title']}: {content}"
                sections = []
                if metadata.get("structured_response"):
                    sections.append(f"Structured Response: {json.dumps(metadata['structured_response'])}")
                tool_content = _append_llm_context_sections_preserving_reference(tool_content, sections)
                tool_msg = {"role": "tool", "content": tool_content}
                tool_msg["tool_call_id"] = tool_call_id
                if metadata.get("toolName"):
                    tool_msg["name"] = metadata["toolName"]
                messages.append(tool_msg)
            else:
                # No matching ASSISTANT tool_call - convert to SYSTEM message
                # This handles workflow activities like query_blueprints that post TOOL messages
                # but aren't user-declared tool calls
                system_content = content
                if metadata.get("title"):
                    system_content = f"{metadata['title']}: {content}"
                sections = []
                if metadata.get("structured_response"):
                    sections.append(f"Structured Response: {json.dumps(metadata['structured_response'])}")
                system_content = _append_llm_context_sections_preserving_reference(system_content, sections)
                messages.append({"role": "system", "content": system_content})

    return messages


def inject_llm_only_user_preamble(
    messages: List[Dict[str, Any]],
    preamble: str,
) -> List[Dict[str, Any]]:
    """Prepend LLM-only text to the first user message without touching persisted context."""
    text = preamble.strip()
    if not text:
        return messages

    for msg in messages:
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            msg["content"] = f"{text}\n\n{content}" if content else text
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    existing = block.get("text") or ""
                    block["text"] = f"{text}\n\n{existing}" if existing else text
                    break
            else:
                content.insert(0, {"type": "text", "text": text})
        else:
            msg["content"] = text
        return messages

    messages.append({"role": "user", "content": text})
    return messages


async def build_llm_messages(
    context: List[Dict],
    system_prompt: str,
    pre_resolved_ids: Optional[set] = None,
    llm_only_user_preamble: str = "",
    user_id: Optional[str] = None,
) -> List[Dict]:
    """Build messages list for LLM from context, with attachment support.

    This is the primary function for building LLM messages across the codebase.
    It handles:
    - System prompt injection
    - USER messages with file attachments (images, PDFs, text files)
    - ASSISTANT messages
    - TOOL/SYSTEM messages (converted to user role for context)
    - Filters TOOL messages: skips IN_PROGRESS, keeps only latest FINISHED per toolCallId

    For attachments:
    - Small files (<20MB) are downloaded from storage and resolved to multimodal content
    - Large files (>=20MB) are shown as metadata only (LLM can't process large files anyway)
    - Binary files are shown as metadata only

    Downloads are cached within the module to avoid re-downloading the same file.

    Args:
        context: List of message dicts from agent context (role, text, metadata, file_pointer)
        system_prompt: System prompt to prepend

    Returns:
        List of OpenAI-compatible messages ready for LLM
    """
    # Pointer annotations are an LLM-boundary representation, not canonical DB
    # state. Initial workflow context already carries them, but a cross-worker
    # activity rebuilds from unannotated DB rows. Normalize a copy here so worker
    # placement cannot change request bytes (or the provider cache prefix).
    context = [dict(msg) for msg in context]
    for msg in context:
        annotate_with_pointer(msg)

    # Filter TOOL messages: skip IN_PROGRESS, keep only latest terminal message
    # (FINISHED/ERROR) per toolCallId.
    context = _filter_superseded_browser_protocol_failures(context)

    def parse_timestamp(ts) -> datetime:
        """Parse timestamp to datetime, return epoch for invalid/missing."""
        from datetime import timezone

        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
        if not ts:
            return epoch
        if isinstance(ts, datetime):
            if ts.tzinfo is None:
                return ts.replace(tzinfo=timezone.utc)
            return ts
        try:
            # ISO format: 2024-01-15T10:30:00.000Z
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return epoch

    tool_messages_by_id: Dict[str, Dict] = {}  # toolCallId -> latest terminal message
    filtered_context = []

    for msg in context:
        role = msg.get("role", "").upper()
        metadata = msg.get("metadata", {}) or {}

        if is_excluded_from_model(msg):
            continue

        # Skip ALL sub-agent internal messages regardless of role
        if is_internal_subagent_message(msg):
            continue

        if role == "TOOL":
            tool_status = metadata.get("toolStatus")
            tool_call_id = metadata.get("toolCallId")

            if _is_cloud_agent_lifecycle_tool(metadata):
                continue

            # Skip IN_PROGRESS messages
            if tool_status == "IN_PROGRESS":
                continue

            # For terminal tool messages, keep only the latest per toolCallId
            if tool_status in ("FINISHED", "ERROR") and tool_call_id:
                existing = tool_messages_by_id.get(tool_call_id)
                if existing:
                    # Compare timestamps properly, keep the later one
                    existing_ts = parse_timestamp(existing.get("timestamp"))
                    new_ts = parse_timestamp(msg.get("timestamp"))
                    if new_ts > existing_ts:
                        tool_messages_by_id[tool_call_id] = msg
                else:
                    tool_messages_by_id[tool_call_id] = msg
                continue

            # TOOL messages without toolCallId or non-FINISHED status - include as-is
            filtered_context.append(msg)
        else:
            # Non-TOOL messages - include as-is
            filtered_context.append(msg)

    # Add the deduplicated TOOL FINISHED messages back
    filtered_context.extend(tool_messages_by_id.values())

    # Sort by timestamp to maintain order (using proper parsing)
    filtered_context.sort(key=lambda x: parse_timestamp(x.get("timestamp")))

    # Use filtered context for the rest of the function
    context = filtered_context

    # NOTE: "Available Files" section was previously appended to system_prompt here,
    # but this mutated the system prompt every time a new file appeared, breaking
    # Anthropic prompt caching (cache is prefix-based, system prompt change = full miss).
    # Files are already embedded as multimodal content in their respective messages,
    # and the static system prompt already has guidance on passing files via attachments.

    def _ts_header(msg: Dict) -> str:
        """Format message timestamp as a short header the LLM can use for temporal context."""
        ts = msg.get("timestamp")
        if not ts:
            return ""
        dt = parse_timestamp(ts)
        if dt.year == 1970:
            return ""
        return f"[{dt.isoformat(timespec='minutes')}] "

    messages = [{"role": "system", "content": system_prompt}]
    declared_tool_call_ids: set[str] = set()

    for msg in context:
        role = msg.get("role", "").upper()
        text = msg.get("text", "")
        metadata = msg.get("metadata", {}) or {}

        # Check for file attachments in multiple places:
        # 1. file_pointer / filePointer - top-level field from DB (OAI-style: each file is a separate message)
        # 2. metadata.attachments - legacy format
        file_pointer = msg.get("file_pointer") or msg.get("filePointer")
        attachments_data = metadata.get("attachments", []) if isinstance(metadata, dict) else []

        # If this message has a file_pointer, treat it as an attachment
        if file_pointer and isinstance(file_pointer, dict):
            attachments_data = [file_pointer] + list(attachments_data)

        # Resolve file attachments (all roles — USER, ASSISTANT, TOOL, SYSTEM)
        content = []  # multimodal content blocks (images, PDFs)
        metadata_texts = []  # text-based content (inline text files, metadata fallbacks)

        for att_data in attachments_data:
            fp = FilePointer.from_dict(att_data) if isinstance(att_data, dict) else None
            if not fp:
                continue

            # Large files or binary files -> metadata only
            if not fp.is_small_enough_for_llm() or not fp.can_be_read_by_llm():
                metadata_texts.append(build_attachment_metadata_text(fp))
                continue

            # Resolve file content: cache first, then live download, then metadata fallback
            file_content = None
            cached = get_cached_file(fp.id) if (pre_resolved_ids and fp.id in pre_resolved_ids) else None
            if cached:
                file_content = cached[0]
            elif activity.in_activity():
                # Live download (activity context — e.g., reasoning, param_populator)
                try:
                    file_content, _ = await get_file_from_pointer(fp)
                except Exception as e:
                    logger.warning(f"Failed to download attachment {fp.original_filename}: {e}")
            else:
                logger.debug(f"Skipping attachment (not cached, not in activity): {fp.original_filename}")

            if file_content is None:
                metadata_texts.append(build_attachment_metadata_text(fp))
                continue

            try:
                base64_data = base64.b64encode(file_content).decode("utf-8")

                if fp.is_image():
                    content.append(
                        {"type": "image_url", "image_url": {"url": f"data:{fp.mime_type};base64,{base64_data}"}}
                    )
                elif fp.is_pdf():
                    content.append(
                        {
                            "type": "file",
                            "file": {
                                "filename": fp.original_filename,
                                "file_data": f"data:{fp.mime_type};base64,{base64_data}",
                            },
                        }
                    )
                elif fp.is_text():
                    try:
                        text_content = file_content.decode("utf-8")
                        metadata_texts.append(f"[File: {fp.original_filename}]\n```\n{text_content}\n```")
                    except UnicodeDecodeError:
                        metadata_texts.append(build_attachment_metadata_text(fp))
            except Exception as e:
                logger.warning(f"Failed to process attachment {fp.original_filename}: {e}")
                metadata_texts.append(build_attachment_metadata_text(fp))

        # Determine LLM role and base text
        ts_prefix = _ts_header(msg)
        if role == "USER":
            llm_role = "user"
            full_text = ts_prefix + text

            if metadata_texts:
                full_text = full_text + "\n\n" + "\n\n".join(metadata_texts)

            if content:
                # Has multimodal content - use content array format
                content.insert(0, {"type": "text", "text": full_text})
                messages.append({"role": llm_role, "content": content})
            else:
                messages.append({"role": llm_role, "content": full_text})
            continue

        if role == "ASSISTANT":
            llm_role = "assistant"
            full_text = ts_prefix + text

            if metadata_texts:
                full_text = full_text + "\n\n" + "\n\n".join(metadata_texts)

            raw_tool_calls = metadata.get("tool_calls")

            # File-output ASSISTANT rows: empty text, no tool_calls, only an
            # attachment (e.g. browser screenshots posted as AssistantEvent
            # between two TOOL FINISHED rows in spawn_browser_agent_v3 /
            # spawn_claude_code_agent / spawn_sub_agents). The LLM API
            # discards image blocks on assistant role anyway, so the row
            # contributes nothing semantically — but emitting it splits an
            # otherwise contiguous tool_result run, which means the
            # FOLLOWING tool_result no longer "immediately follows" the
            # tool_use that declared it. Anthropic rejects that with
            # "tool_use ids ... have no matching tool_result in the next
            # message" (see context_validator._check_tool_result_pairing).
            # Skip these rows entirely so the tool_use/tool_result chain
            # stays intact.
            has_attachment = bool(file_pointer) or bool(metadata.get("attachments"))
            if not text.strip() and not raw_tool_calls and has_attachment:
                continue

            if content:
                # LLM APIs reject multimodal blocks in assistant messages.
                # Convert image/PDF blocks to metadata text so content isn't silently lost.
                for block in content:
                    if block.get("type") == "image_url":
                        full_text += "\n\n[Attached image]"
                    elif block.get("type") == "file":
                        fname = block.get("file", {}).get("filename", "file")
                        full_text += f"\n\n[Attached file: {fname}]"

            assistant_msg: Dict[str, Any] = {"role": llm_role, "content": full_text}
            codex_reasoning_items = metadata.get("codex_reasoning_items")
            if isinstance(codex_reasoning_items, list):
                assistant_msg["codex_reasoning_items"] = codex_reasoning_items
            codex_message_items = metadata.get("codex_message_items")
            if isinstance(codex_message_items, list):
                assistant_msg["codex_message_items"] = codex_message_items
            if raw_tool_calls:
                if not isinstance(raw_tool_calls, list):
                    raise ValueError(
                        f"ASSISTANT message metadata.tool_calls must be a list (got {type(raw_tool_calls).__name__})"
                    )
                parsed_tool_calls = []
                for idx, tc in enumerate(raw_tool_calls):
                    if not isinstance(tc, dict):
                        raise ValueError(
                            f"ASSISTANT metadata.tool_calls[{idx}] must be an object (got {type(tc).__name__})"
                        )
                    tool_name = tc.get("tool")
                    tool_call_id = tc.get("tool_call_id")
                    if not tool_name:
                        raise ValueError(f"ASSISTANT metadata.tool_calls[{idx}] missing 'tool'")
                    if not tool_call_id:
                        raise ValueError(
                            f"ASSISTANT metadata.tool_calls[{idx}] missing 'tool_call_id' for tool '{tool_name}'"
                        )
                    declared_tool_call_ids.add(str(tool_call_id))
                    args = {k: v for k, v in tc.items() if k not in ("tool", "tool_call_id")}
                    parsed_tool_calls.append(
                        {
                            "id": str(tool_call_id),
                            "type": "function",
                            "function": {
                                "name": str(tool_name),
                                "arguments": json.dumps(args),
                            },
                        }
                    )
                assistant_msg["tool_calls"] = parsed_tool_calls

            messages.append(assistant_msg)
            continue

        if role == "TOOL":
            if _is_cloud_agent_lifecycle_tool(metadata):
                continue

            tool_status = metadata.get("toolStatus")
            if tool_status == "IN_PROGRESS":
                continue

            tool_call_id = metadata.get("toolCallId")
            tool_name = metadata.get("toolName")

            # Terminal tool messages should match a declared assistant tool_call_id.
            # DAG-created tasks (spawn_agent, reasoning) produce TOOL results with
            # toolCallIds that no ASSISTANT message declares — these are converted to
            # user messages to preserve context without breaking tool_result pairing.
            if tool_status in ("FINISHED", "ERROR"):
                if not tool_call_id:
                    raise ValueError(
                        f"Terminal TOOL message missing toolCallId (toolName={tool_name}, message_id={msg.get('message_id')})"
                    )
                if str(tool_call_id) not in declared_tool_call_ids:
                    # DAG-created tool result — include as user message for context
                    tool_content = text
                    if metadata.get("title"):
                        tool_content = f"{metadata['title']}: {tool_content}"
                    sections = []
                    if metadata.get("structured_response"):
                        sections.append("Structured Response: " + json.dumps(metadata["structured_response"]))
                    if metadata_texts:
                        sections.extend(metadata_texts)
                    if content:
                        for block in content:
                            if block.get("type") == "image_url":
                                sections.append("[Attached image]")
                            elif block.get("type") == "file":
                                fname = block.get("file", {}).get("filename", "file")
                                sections.append(f"[Attached file: {fname}]")
                    tool_content = _append_llm_context_sections_preserving_reference(tool_content, sections)
                    label = tool_name or "tool"
                    messages.append({"role": "user", "content": f"{ts_prefix}[{label} result]: {tool_content}"})
                    continue

                tool_content = ts_prefix + text
                if metadata.get("title"):
                    tool_content = f"{ts_prefix}{metadata['title']}: {text}"
                sections = []
                if metadata.get("structured_response"):
                    sections.append(f"Structured Response: {json.dumps(metadata['structured_response'])}")
                if metadata_texts:
                    sections.extend(metadata_texts)
                if content:
                    for block in content:
                        if block.get("type") == "image_url":
                            sections.append("[Attached image]")
                        elif block.get("type") == "file":
                            fname = block.get("file", {}).get("filename", "file")
                            sections.append(f"[Attached file: {fname}]")
                tool_content = _append_llm_context_sections_preserving_reference(tool_content, sections)

                tool_msg: Dict[str, Any] = {
                    "role": "tool",
                    "content": tool_content,
                    "tool_call_id": str(tool_call_id),
                }
                if tool_name:
                    tool_msg["name"] = tool_name
                messages.append(tool_msg)
                continue

            # Non-terminal TOOL messages are passed as context text.
            full_text = f"{ts_prefix}[TOOL]: {text}"
            if metadata_texts:
                full_text = full_text + "\n\n" + "\n\n".join(metadata_texts)
            if content:
                content.insert(0, {"type": "text", "text": full_text})
                messages.append({"role": "user", "content": content})
            else:
                messages.append({"role": "user", "content": full_text})
            continue

        if role == "SYSTEM":
            llm_role = "user"
            full_text = f"{ts_prefix}[SYSTEM]: {text}"
        else:
            llm_role = "user"
            full_text = ts_prefix + text

        if metadata_texts:
            full_text = full_text + "\n\n" + "\n\n".join(metadata_texts)

        if content:
            content.insert(0, {"type": "text", "text": full_text})
            messages.append({"role": llm_role, "content": content})
        else:
            messages.append({"role": llm_role, "content": full_text})

    # Merge consecutive assistant messages.  This can happen when the LLM
    # returns bare text (no tool_calls) in one iteration, then tool_calls in the
    # next — both get posted as separate ASSISTANT rows in the DB.
    i = 1
    while i < len(messages):
        if messages[i].get("role") == "assistant" and messages[i - 1].get("role") == "assistant":
            prev = messages[i - 1]
            curr = messages[i]
            merged = (prev.get("content", "") + "\n\n" + curr.get("content", "")).strip()
            prev["content"] = merged
            # Carry forward tool_calls, de-duplicating by ID to protect against
            # dual-write corruption (same tool_call_id in both rows → Anthropic 400).
            prev_tc = prev.get("tool_calls", [])
            curr_tc = curr.get("tool_calls", [])
            if prev_tc or curr_tc:
                seen_ids: set = set()
                merged_tc: list = []
                for tc in prev_tc + curr_tc:
                    tc_id = tc.get("id")
                    if tc_id and tc_id in seen_ids:
                        continue
                    if tc_id:
                        seen_ids.add(tc_id)
                    merged_tc.append(tc)
                prev["tool_calls"] = merged_tc
            messages.pop(i)
        else:
            i += 1

    if llm_only_user_preamble:
        messages = inject_llm_only_user_preamble(messages, llm_only_user_preamble)

    # Defensive: pair every assistant tool_call with a tool result before sending
    # to the LLM. Mirrors claude-code-src's ensureToolResultPairing — when an
    # activity (set_plan, spawn_agent, spawn_claude_code_agent, …) crashes or
    # times out before the parent TOOL terminal row is written, the assistant's
    # tool_use ends up orphaned in DB. Anthropic rejects with 400 (or stalls)
    # if a tool_use lacks a matching tool_result. We fill the gap with a
    # synthetic error tool_result so the loop can continue.
    messages = _ensure_tool_result_pairing(messages)

    # Resolve context pointers to <resolved-ref> blocks
    messages = await resolve_pointers_in_messages(
        messages,
        local_context=context,
        user_id=user_id,
    )

    return messages


SYNTHETIC_TOOL_RESULT_PLACEHOLDER = "[Tool result missing due to internal error]"


def _ensure_tool_result_pairing(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ensure every assistant tool_call has a matching tool message.

    OpenAI-format invariants the Anthropic transform relies on:
    - Every assistant.tool_calls[i].id has a tool message with that tool_call_id
      somewhere after it (and before the next assistant turn).
    - No two assistant messages declare the same tool_call_id.
    - tool messages whose tool_call_id is not declared by any preceding assistant
      are dropped (build_llm_messages already converts those to user text upstream
      — this is the belt-and-suspenders pass for any that slipped through).

    Repairs the message list in place by:
    1. Stripping duplicate tool_call ids that appear in a later assistant.
    2. Inserting synthetic error tool messages for any tool_call id with no
       matching tool message before the next assistant.
    3. Dropping orphaned tool messages whose tool_call_id has no preceding
       declaration.

    Idempotent — running it twice on its own output is a no-op.
    """
    seen_ids: set[str] = set()
    repaired = False

    # Pass 1: dedupe tool_call ids across assistant messages. Anthropic rejects
    # duplicate tool_use ids in the same conversation; the in-message merge above
    # only catches consecutive assistants.
    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        tcs = msg.get("tool_calls")
        if not tcs:
            continue
        deduped: list = []
        for tc in tcs:
            tc_id = tc.get("id")
            if tc_id and tc_id in seen_ids:
                repaired = True
                continue
            if tc_id:
                seen_ids.add(tc_id)
            deduped.append(tc)
        if deduped:
            msg["tool_calls"] = deduped
        else:
            msg.pop("tool_calls", None)

    # Pass 2: walk the list, fill in missing tool messages, drop orphan tool
    # messages. We rebuild a fresh list to keep insertion logic simple.
    result: List[Dict[str, Any]] = []
    declared_at_or_before: set[str] = set()
    i = 0
    while i < len(messages):
        msg = messages[i]
        role = msg.get("role")

        if role == "assistant":
            tcs = msg.get("tool_calls") or []
            for tc in tcs:
                tc_id = tc.get("id")
                if tc_id:
                    declared_at_or_before.add(tc_id)
            result.append(msg)

            # Collect every tool message that follows this assistant up to the
            # next assistant, and check coverage.
            covered: set[str] = set()
            j = i + 1
            tool_run: List[Dict[str, Any]] = []
            non_tool_run: List[Dict[str, Any]] = []
            while j < len(messages) and messages[j].get("role") != "assistant":
                m2 = messages[j]
                if m2.get("role") == "tool":
                    tcid = m2.get("tool_call_id")
                    if tcid and tcid in declared_at_or_before:
                        if tcid in covered:
                            # Duplicate tool result for the same id — drop second.
                            repaired = True
                        else:
                            covered.add(tcid)
                            tool_run.append(m2)
                    else:
                        # Orphaned tool message — drop.
                        repaired = True
                else:
                    non_tool_run.append(m2)
                j += 1

            # Synthesize missing tool messages for any declared id not covered.
            tc_ids = [tc.get("id") for tc in tcs if tc.get("id")]
            tc_names = {tc.get("id"): tc.get("function", {}).get("name") for tc in tcs}
            for tc_id in tc_ids:
                if tc_id not in covered:
                    repaired = True
                    synthetic: Dict[str, Any] = {
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
                    }
                    name = tc_names.get(tc_id)
                    if name:
                        synthetic["name"] = name
                    tool_run.append(synthetic)

            # Tool messages first (so tool_use→tool_result pairing is contiguous),
            # then any non-tool messages (user text, etc.) that lived in this gap.
            result.extend(tool_run)
            result.extend(non_tool_run)
            i = j
            continue

        if role == "tool":
            # Tool message at the head of the list (no preceding assistant) or
            # following a non-assistant — both are orphans.
            tcid = msg.get("tool_call_id")
            if tcid and tcid in declared_at_or_before:
                # Belongs to a prior assistant we already emitted (rare — would
                # mean an assistant→tool→user→tool sequence). Keep it.
                result.append(msg)
            else:
                repaired = True
            i += 1
            continue

        # system, user, etc. — pass through.
        result.append(msg)
        i += 1

    if repaired:
        try:
            logger.warning(
                "tool_result_pairing.repaired",
                original_count=len(messages),
                repaired_count=len(result),
            )
        except Exception:
            # Logger may be unavailable inside Temporal sandbox during replay.
            pass

    return result


async def call_llm_structured_streaming(
    messages: List[Dict[str, Any]],
    model: Optional[str],
    temperature: float,
    max_tokens: int,
    response_model: type[T],
    on_chunk: Callable[[str, int], Awaitable[None]],
    reasoning_max_tokens: Optional[int] = None,
    model_preference: Optional[str] = None,
    model_seed: Optional[int] = None,  # Index into Rose model pool (pins to one waterfall step)
    agent_id: Optional[str] = None,  # For cancellation checking
    on_tool_detected: Optional[
        Callable[[str, str], Awaitable[None]]
    ] = None,  # Called when any tool detected (tool_name, tool_call_id)
    on_attention_stream: Optional[
        Callable[[str, str, bool], Awaitable[None]]
    ] = None,  # Called with (tool_call_id, message, is_question) for send_message_to_user
    on_raw_progress: Optional[
        Callable[[int], Awaitable[None]]
    ] = None,  # Called with total accumulated bytes (reasoning + json)
    claude_token: Optional[str] = None,  # User's Claude OAuth token — passed to Rose endpoint for direct Anthropic call
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    compute_token_lineage_key: Optional[str] = None,
    compute_token_fast_cache_affinity_key: Optional[str] = None,
    cache_sequence_id: Optional[str] = None,
    on_model_detected: Optional[Callable[[str], None]] = None,  # Called with actual_model when first chunk reveals it
    skip_cache_write: bool = False,  # Skip prompt caching (for single-use calls like planner)
    call_site: str = "unknown",  # Label identifying the caller (e.g., plan_loop, execute_loop, planner)
    thinking: Optional[Dict[str, Any]] = None,  # Override thinking config (e.g. {"type": "adaptive"})
    effort: Optional[str] = None,  # Anthropic effort level ("low", "medium", "high", "max")
    tool_choice: Any = None,  # Optional native-tool choice, including a forced {"name": ...} selection
    deadline_s: Optional[float] = None,  # Override Rose top-level deadline; None uses Rose default
    ttft_timeout_s: Optional[float] = None,  # Override Rose TTFT timeout
    idle_timeout_s: Optional[float] = None,  # Override Rose idle/inter-chunk timeout (-1 disables)
    _exclude_anthropic_family: bool = False,  # Internal: refusal retry skips Anthropic direct/waterfall routes
    _is_escalation: bool = False,  # Internal: prevents infinite recursion on max_tokens escalation
    _parse_retry_attempt: int = 0,  # Internal: bounds re-generation on a malformed/schema-invalid structured output
) -> Tuple[T, Dict, List[tuple]]:
    """
    Call LLM with structured outputs using streaming, emitting partial text via callback.

    This variant streams the response and calls `on_chunk` when 18+ new characters have
    accumulated since the last emit. A final flush is done at the end for any remaining content.

    Args:
        messages: List of message dicts with 'role' and 'content'
        model: Model to use
        temperature: Sampling temperature
        max_tokens: Maximum tokens
        response_model: Pydantic model class for response structure
        on_chunk: Async callback(text_so_far, token_count) called at streaming intervals
        reasoning_max_tokens: Optional max tokens for reasoning (default 256)
        model_preference: Optional Rose model preference ("SMART", "FAST", "CHEAP")
        agent_id: Optional agent ID for cancellation checking (stops streaming if agent is paused)
        on_tool_detected: Optional callback(tool_name, tool_call_id) when any tool is first detected
        on_raw_progress: Optional callback(total_bytes) called on every chunk with total accumulated bytes

    Returns:
        Tuple of (response_model instance, usage dict with token counts, plan_tool_call_id or None, detected_tools_ordered list)
        Usage dict includes 'cancelled': True if streaming was stopped early
        detected_tools_ordered: List of (tool_name, tool_call_id, timestamp) tuples in detection order
    """
    config = load_config()

    # Check if this is a Rose model — route in-process via RoseClient (replaces
    # the Supabase edge function).
    pool = pool_for_model(model) if model else None

    if pool is not None:
        # Prefer the request_id already bound to the trace context so research
        # spans nest under the caller; only mint when nothing is bound.
        request_id = current_request_id() or str(uuid.uuid4())[:8]
        logger.info(
            f"📤 [{request_id}] [{call_site}] Streaming Rose model in-process: {model} pool={pool} skip_cache_write={skip_cache_write}"
        )

        # Stream state
        accumulated_reasoning = ""  # Reasoning/thinking text (displayed before response)
        codex_reasoning_items: List[Dict[str, Any]] = []  # Encrypted GPT reasoning state for replay only
        accumulated_json = ""  # JSON content for parsing (waterfall path) or filled at end (claudeAuth)
        structured_output = StructuredOutputAccumulator()
        last_emitted_text = ""  # Track last emitted text to avoid duplicate sends
        last_emitted_for_chunk = ""  # Track what we've actually sent to on_chunk (for 18-char batching)
        token_count = 0
        actual_model = "unknown"
        pool_name = "unknown"
        pool_size = 0  # No longer surfaced by RoseClient; preserved in usage shape for compat
        claude_token_error: Optional[str] = None  # Set when claudeAuth fell through to waterfall
        gpt_token_error: Optional[str] = None  # Set when gptAuth fell through to waterfall
        final_finish_reason = ""  # From usage chunk (parsers normalize to OpenAI vocabulary)
        chunk_count = 0
        stream_usage: Optional[Dict[str, Any]] = None

        # claudeAuth-vs-waterfall path tracking. When the active path is
        # claudeAuth (Anthropic native tools), `text_buffer` collects the raw
        # assistant text and `tool_use_blocks` collects native tool_use payloads;
        # we rebuild the {reasoning, response, tool_calls} envelope into
        # `accumulated_json` after the stream so the existing parser works.
        using_claude_auth = False
        using_native_direct_tools = False
        text_buffer = ""
        tool_use_blocks: List[Dict[str, Any]] = []

        # Tool detection tracking (for early IN_PROGRESS messages)
        detected_tools_ordered: List[tuple] = []  # (tool_name, tool_call_id, timestamp)
        detected_tool_positions: Dict[str, int] = {}

        # State transition tracking for debugging
        first_reasoning_chunk: Optional[int] = None
        first_response_chunk: Optional[int] = None
        first_tool_calls_chunk: Optional[int] = None

        # Attention message streaming tracking (for send_message_to_user — waterfall only)
        attention_tool_call_id: Optional[str] = None
        last_attention_message = ""

        SKIP_EARLY_PROGRESS = {"send_message_to_user", "attempt_completion"}

        _safe_heartbeat("Starting Rose LLM stream...")
        request_start_time = _safe_time()
        ttft_logged = False

        rose_client = RoseClient()
        claude_auth_context = _build_claude_auth_context(
            claude_token,
            source=claude_token_source,
            user_id=claude_token_user_id,
            pool_token_id=claude_token_pool_id,
            lineage_key=compute_token_lineage_key,
            agent_id=agent_id,
            root_agent_id=agent_id,
            fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
        )
        gpt_auth_context = _build_gpt_auth_context(
            gpt_token,
            account_id=gpt_account_id,
            source=gpt_token_source,
            user_id=gpt_token_user_id,
            pool_token_id=gpt_token_pool_id,
            lineage_key=compute_token_lineage_key,
            agent_id=agent_id,
            root_agent_id=agent_id,
            fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
        )

        def _native_visible_text() -> str:
            reasoning = accumulated_reasoning.strip()
            if reasoning and text_buffer:
                return reasoning + "\n\n" + text_buffer
            return reasoning or text_buffer

        rose_kwargs: Dict[str, Any] = {}
        if deadline_s is not None:
            rose_kwargs["deadline_s"] = deadline_s
        if ttft_timeout_s is not None:
            rose_kwargs["ttft_timeout_s"] = ttft_timeout_s
        if idle_timeout_s is not None:
            rose_kwargs["idle_timeout_s"] = None if idle_timeout_s < 0 else idle_timeout_s

        deferred_fast_cache_key: Optional[str] = None
        deferred_fast_cache_goal_hash: Optional[str] = None
        deferred_fast_cache_goal_str: Optional[str] = None
        deferred_fast_cache_acc: Optional[Dict[str, Any]] = None
        fast_cache_accumulate = None
        try:
            from providers.fast_cache.rose_cache import (
                accumulate_chunk as fast_cache_accumulate,
            )
            from providers.fast_cache.rose_cache import (
                empty_response as fast_cache_empty_response,
            )
            from providers.fast_cache.rose_cache import (
                request_key_material as fast_cache_request_key_material,
            )

            fast_cache_context = current_fast_cache_context()
            if fast_cache_context is not None and fast_cache_context.active and fast_cache_context.should_write:
                fast_cache_complete_kwargs: Dict[str, Any] = {
                    "pool": pool,
                    "messages": messages,
                    "response_model": response_model,
                    "tool_choice": tool_choice,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "seed": model_seed,
                    "skip_cache_write": skip_cache_write,
                    "claude_auth": claude_auth_context,
                    "gpt_auth": gpt_auth_context,
                    "agent_id": agent_id,
                    "request_id": request_id,
                    "thinking": thinking,
                    "effort": effort,
                    "provider_fast_mode": bool(fast_cache_context.provider_fast_mode),
                    "cache_namespace": cache_sequence_id,
                    **rose_kwargs,
                }
                deferred_fast_cache_key = fast_cache_context.llm_key(
                    call_site,
                    fast_cache_request_key_material(fast_cache_complete_kwargs),
                )
                deferred_fast_cache_goal_hash = fast_cache_context.goal_hash
                deferred_fast_cache_goal_str = fast_cache_context.goal
                deferred_fast_cache_acc = fast_cache_empty_response()
        except Exception as exc:
            logger.warning("fast_cache.defer_setup_error", call_site=call_site, error=str(exc))

        # Per-stream wall-time profiler: splits stream duration into time spent in
        # inline per-chunk callbacks (broadcasts / tool-progress events, which do
        # network round-trips) vs everything else (socket wait + parse). Attributes
        # a slow stream to a specific cause instead of guessing.
        _prof = {"on_chunk": 0.0, "raw_progress": 0.0, "tool_detected": 0.0}
        _prof_calls = {"on_chunk": 0, "raw_progress": 0, "tool_detected": 0}
        _await_s = 0.0  # cumulative time awaiting the next chunk (byte-wait / event-loop)
        _stream_t0 = _safe_time()
        # Manual __anext__ drive (vs `async for`) so we can time byte-wait separately
        # from per-chunk processing, regardless of the `continue`s in the body.
        # Fast Mode record/replay: transparent passthrough when off; on a cache
        # hit this re-streams the stored response without touching Rose/Anthropic.
        from providers.fast_cache.rose_cache import cached_complete

        _stream_iter = cached_complete(
            rose_client,
            call_site=call_site,
            pool=pool,
            messages=messages,
            response_model=response_model,
            tool_choice=tool_choice,
            temperature=temperature,
            max_tokens=max_tokens,
            seed=model_seed,
            skip_cache_write=skip_cache_write,
            claude_auth=claude_auth_context,
            gpt_auth=gpt_auth_context,
            agent_id=agent_id,
            request_id=request_id,
            thinking=thinking,
            effort=effort,
            cache_namespace=cache_sequence_id,
            _exclude_anthropic_family=_exclude_anthropic_family,
            **rose_kwargs,
        ).__aiter__()
        try:
            while True:
                _t_await = _safe_time()
                try:
                    chunk = await _stream_iter.__anext__()
                except StopAsyncIteration:
                    break
                _await_s += _safe_time() - _t_await
                chunk_count += 1
                if deferred_fast_cache_acc is not None and fast_cache_accumulate is not None:
                    fast_cache_accumulate(deferred_fast_cache_acc, chunk)

                if not ttft_logged:
                    ttft_ms = int((_safe_time() - request_start_time) * 1000)
                    logger.info(f"⏱️ Rose structured TTFT: {ttft_ms}ms")
                    ttft_logged = True

                kind = chunk.kind

                if kind == "metadata":
                    if chunk.data.get("actual_model"):
                        actual_model = chunk.data["actual_model"]
                        using_claude_auth = actual_model.endswith("-claude")
                        using_native_direct_tools = using_claude_auth or actual_model.endswith("-gpt")
                        logger.info(f"🎯 Rose model selected: {actual_model} (claudeAuth={using_claude_auth})")
                        if on_model_detected:
                            on_model_detected(actual_model)
                    if chunk.data.get("pool_name"):
                        pool_name = chunk.data["pool_name"]
                    if chunk.data.get("claude_token_error") and not claude_token_error:
                        claude_token_error = chunk.data["claude_token_error"]
                        logger.warning(f"⚠️ Claude token error from Rose: {claude_token_error}")
                    if chunk.data.get("gpt_token_error") and not gpt_token_error:
                        gpt_token_error = chunk.data["gpt_token_error"]
                        logger.warning(f"⚠️ GPT token error from Rose: {gpt_token_error}")
                    continue

                if kind == "usage":
                    stream_usage = dict(chunk.data)
                    final_finish_reason = stream_usage.get("finish_reason", "") or final_finish_reason
                    # llm.cache event is emitted from RoseClient.complete (single source).
                    continue

                if kind == "done":
                    continue

                if kind == "tool_call":
                    # Native direct-token tool call — buffer for envelope rebuild.
                    # Fast Mode replays stored provider streams, and retained
                    # provider labels may be "-anthropic" even though the chunks
                    # are native tool_use blocks. Classify by the stream shape
                    # itself so replayed tool-only responses do not fall through
                    # to the JSON-content parser with an empty accumulated_json.
                    using_native_direct_tools = True
                    args_raw = chunk.data.get("arguments", "")
                    try:
                        parsed_args = json.loads(args_raw) if args_raw else {}
                    except json.JSONDecodeError:
                        parsed_args = {}
                    if not isinstance(parsed_args, dict):
                        parsed_args = {}
                    tool_name = chunk.data.get("name", "") or ""
                    tool_use_blocks.append({"name": tool_name, "input": parsed_args})

                    if first_tool_calls_chunk is None:
                        first_tool_calls_chunk = chunk_count
                        logger.info(f"🔧 C{chunk_count} TOOL_CALLS started (native)")

                    # Fire on_tool_detected for non-attention tools.
                    if on_tool_detected and tool_name and tool_name not in SKIP_EARLY_PROGRESS:
                        tool_call_id = chunk.data.get("id") or str(uuid.uuid4())
                        detected_tools_ordered.append((tool_name, tool_call_id, _safe_time()))
                        position = detected_tool_positions.get(tool_name, 0)
                        detected_tool_positions[tool_name] = position + 1
                        logger.info(
                            f"🔧 Tool detected (native): {tool_name} #{position + 1}, tool_call_id={tool_call_id}"
                        )
                        _t = _safe_time()
                        await on_tool_detected(tool_name, tool_call_id)
                        _prof["tool_detected"] += _safe_time() - _t
                        _prof_calls["tool_detected"] += 1

                    # send_message_to_user on the native direct-token path arrives complete; emit
                    # the full message immediately rather than streaming partials.
                    if on_attention_stream and tool_name == "send_message_to_user":
                        attention_tool_call_id = chunk.data.get("id") or str(uuid.uuid4())
                        detected_tools_ordered.append(("send_message_to_user", attention_tool_call_id, _safe_time()))
                        message_text = parsed_args.get("message", "") or ""
                        is_question = parsed_args.get("is_question", True)
                        if not isinstance(is_question, bool):
                            is_question = True
                        if message_text:
                            await on_attention_stream(attention_tool_call_id, message_text, is_question)
                            last_attention_message = message_text
                    continue

                if kind == "codex_reasoning_item":
                    codex_reasoning_items.append(dict(chunk.data))
                    continue

                reasoning_delta = chunk.data.get("text", "") if kind == "reasoning" else ""
                content = chunk.data.get("text", "") if kind == "content" else ""

                if reasoning_delta:
                    if first_reasoning_chunk is None:
                        first_reasoning_chunk = chunk_count
                        logger.info(f"🧠 C{chunk_count} REASONING started")
                    accumulated_reasoning += reasoning_delta

                if content:
                    if using_native_direct_tools:
                        # Native direct-token text precedes any tool_use blocks; treat as
                        # the eventual response text and emit incrementally.
                        text_buffer += content
                        if first_response_chunk is None:
                            first_response_chunk = chunk_count
                            logger.info(f"💬 C{chunk_count} RESPONSE started (native text)")
                    else:
                        structured_output.add_chunk(chunk)
                        accumulated_json = structured_output.current_text()
                        if first_response_chunk is None and '"response"' in accumulated_json:
                            first_response_chunk = chunk_count
                            logger.info(f"💬 C{chunk_count} RESPONSE started")
                        if first_tool_calls_chunk is None and '"tool_calls"' in accumulated_json:
                            first_tool_calls_chunk = chunk_count
                            logger.info(f"🔧 C{chunk_count} TOOL_CALLS started")

                token_count = (len(accumulated_reasoning) + len(accumulated_json) + len(text_buffer)) // 4

                # Periodic state log (every 50 chunks).
                if chunk_count % 50 == 0:
                    has_tool_calls = bool(tool_use_blocks) or '"tool_calls"' in accumulated_json
                    has_response = bool(text_buffer) or '"response"' in accumulated_json
                    state = (
                        "reasoning"
                        if reasoning_delta
                        else ("tool_call" if has_tool_calls else ("response" if has_response else "json"))
                    )
                    logger.info(
                        f"🔍 C{chunk_count} state={state} r_len={len(accumulated_reasoning)} "
                        f"json_len={len(accumulated_json)} text_buf={len(text_buffer)} "
                        f"has_tools={has_tool_calls}"
                    )

                # Tool detection on waterfall path — regex-scan accumulated_json.
                if not using_native_direct_tools and on_tool_detected and '"tool_calls"' in accumulated_json:
                    tool_matches = re.findall(r'"tool"\s*:\s*"([^"]+)"', accumulated_json)
                    for tool_name in tool_matches:
                        if tool_name in SKIP_EARLY_PROGRESS:
                            continue
                        current_position = detected_tool_positions.get(tool_name, 0)
                        existing_count = sum(1 for t, _, _ in detected_tools_ordered if t == tool_name)
                        if existing_count < tool_matches.count(tool_name) and existing_count == current_position:
                            if len(detected_tools_ordered) > 0:
                                completed_tools = _extract_completed_tool_calls(accumulated_json)
                                prev_tool_idx = len(detected_tools_ordered) - 1
                                if prev_tool_idx < len(completed_tools):
                                    prev_tool = completed_tools[prev_tool_idx]
                                    logger.info(
                                        f"📋 Tool #{prev_tool_idx + 1} params captured before tool "
                                        f"#{len(detected_tools_ordered) + 1} IN_PROGRESS: "
                                        f"name={prev_tool.get('tool')} params={prev_tool}"
                                    )
                                else:
                                    logger.warning(
                                        f"⚠️ Could not parse tool #{prev_tool_idx + 1} params "
                                        f"before tool #{len(detected_tools_ordered) + 1} detection. "
                                        f"accumulated_json_tail={accumulated_json[-500:] if len(accumulated_json) > 500 else accumulated_json}"
                                    )
                            tool_call_id = str(uuid.uuid4())
                            detected_tools_ordered.append((tool_name, tool_call_id, _safe_time()))
                            detected_tool_positions[tool_name] = current_position + 1
                            logger.info(
                                f"🔧 Tool detected: {tool_name} #{current_position + 1}, tool_call_id={tool_call_id}"
                            )
                            _t = _safe_time()
                        await on_tool_detected(tool_name, tool_call_id)
                        _prof["tool_detected"] += _safe_time() - _t
                        _prof_calls["tool_detected"] += 1

                # Attention streaming on waterfall path — progressive partial emit.
                if (
                    not using_native_direct_tools
                    and on_attention_stream
                    and '"send_message_to_user"' in accumulated_json
                ):
                    if not attention_tool_call_id:
                        attention_tool_call_id = str(uuid.uuid4())
                        detected_tools_ordered.append(("send_message_to_user", attention_tool_call_id, _safe_time()))
                        logger.info(f"📢 Attention message detected, tool_call_id={attention_tool_call_id}")

                    msg_match = re.search(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)"?', accumulated_json)
                    if msg_match:
                        try:
                            attention_message = json.loads(f'"{msg_match.group(1)}"')
                        except json.JSONDecodeError:
                            attention_message = msg_match.group(1)
                        is_question = True
                        iq_match = re.search(r'"is_question"\s*:\s*(true|false)', accumulated_json)
                        if iq_match:
                            is_question = iq_match.group(1) == "true"
                        if attention_message and attention_message != last_attention_message:
                            last_attention_message = attention_message
                            await on_attention_stream(attention_tool_call_id, attention_message, is_question)

                # Streaming text deltas to caller.
                if using_native_direct_tools:
                    # Native direct-token path: stream visible reasoning summaries
                    # and response text through the same monotonically growing buffer.
                    visible_text = _native_visible_text()
                    if visible_text and visible_text != last_emitted_text:
                        last_emitted_text = visible_text
                        pending_delta = len(visible_text) - len(last_emitted_for_chunk)
                        if pending_delta >= 18:
                            _t = _safe_time()
                            await on_chunk(visible_text, token_count)
                            _prof["on_chunk"] += _safe_time() - _t
                            _prof_calls["on_chunk"] += 1
                            last_emitted_for_chunk = visible_text
                else:
                    response_text = _extract_response_from_partial_json(accumulated_reasoning, accumulated_json)
                    if response_text and response_text != last_emitted_text:
                        last_emitted_text = response_text
                        pending_delta = len(response_text) - len(last_emitted_for_chunk)
                        if pending_delta >= 18:
                            _t = _safe_time()
                            await on_chunk(response_text, token_count)
                            _prof["on_chunk"] += _safe_time() - _t
                            _prof_calls["on_chunk"] += 1
                            last_emitted_for_chunk = response_text

                if chunk_count % 5 == 0:
                    if reasoning_delta:
                        phase = "reasoning"
                    elif detected_tools_ordered:
                        phase = f"tool:{detected_tools_ordered[-1][0]}"
                    elif using_native_direct_tools and text_buffer:
                        phase = "response"
                    elif '"response"' in accumulated_json:
                        phase = "response"
                    else:
                        phase = "json"
                    _safe_heartbeat(
                        f"C{chunk_count} [{phase}] r={len(accumulated_reasoning)} "
                        f"j={len(accumulated_json)} t={len(text_buffer)}"
                    )

                if on_raw_progress:
                    _t = _safe_time()
                    await on_raw_progress(len(accumulated_reasoning) + len(accumulated_json) + len(text_buffer))
                    _prof["raw_progress"] += _safe_time() - _t
                    _prof_calls["raw_progress"] += 1
        except asyncio.CancelledError:
            logger.info("⏹️ Rose streaming cancelled (asyncio.CancelledError)")
            raise
        except RoseError as exc:
            logger.error(f"❌ [{request_id}] [{call_site}] Rose streaming failed: {type(exc).__name__}: {exc}")
            raise ValueError(f"Rose streaming failed: {exc}") from exc
        finally:
            with contextlib.suppress(Exception):
                await _stream_iter.aclose()  # manual __anext__ drive → close explicitly
            # Attribute the stream's wall-time three ways:
            #   callbacks  = inline per-chunk network round-trips (broadcasts/tool-events)
            #   await      = time blocked awaiting the next chunk (provider/network OR
            #                event-loop starvation — distinguish via worker CPU)
            #   parse      = per-chunk CPU processing (json accumulate, tool detect, etc.)
            _total = _safe_time() - _stream_t0
            _cb = _prof["on_chunk"] + _prof["raw_progress"] + _prof["tool_detected"]
            _parse = max(0.0, _total - _cb - _await_s)
            logger.info(
                "stream.profile",
                request_id=request_id,
                call_site=call_site,
                actual_model=actual_model,
                chunk_count=chunk_count,
                total_s=round(_total, 2),
                await_s=round(_await_s, 2),
                parse_s=round(_parse, 2),
                callbacks_s=round(_cb, 2),
                on_chunk_s=round(_prof["on_chunk"], 2),
                raw_progress_s=round(_prof["raw_progress"], 2),
                tool_detected_s=round(_prof["tool_detected"], 2),
                raw_progress_calls=_prof_calls["raw_progress"],
                tool_detected_calls=_prof_calls["tool_detected"],
            )

        # On the native direct-token path, rebuild the response-model JSON once the
        # stream is fully drained. The shape depends on the caller's schema:
        #   - Agent envelope `{reasoning, response, tool_calls}`: merge native
        #     text + tool_use blocks via reconstruct_agent_response.
        #   - Any other schema (PlannerResponse, ReasoningResponse, etc.): serialize
        #     the first tool's `input` dict directly. The verifier path at
        #     `_call_llm_verifier` does the same.
        if using_native_direct_tools:
            model_fields = set(response_model.model_fields.keys())
            is_agent_envelope = {"response", "tool_calls"}.issubset(model_fields)
            if tool_use_blocks:
                if is_agent_envelope:
                    accumulated_json = reconstruct_agent_response(text_buffer, tool_use_blocks)
                else:
                    first_input = tool_use_blocks[0].get("input")
                    if not isinstance(first_input, dict):
                        raise ValueError(
                            "Native tool payload must be an object "
                            f"(got {type(first_input).__name__}) for non-envelope schema "
                            f"{response_model.__name__}"
                        )
                    accumulated_json = json.dumps(first_input)
            elif text_buffer:
                # Native text only (no tool_use) — treat as the JSON envelope
                # body; existing markdown/balanced-brace extraction handles it.
                accumulated_json = text_buffer
        elif structured_output.has_content():
            accumulated_json = structured_output.final_text()

        logger.info(
            f"🏁 [{call_site}] Rose streaming complete, received {chunk_count} chunks, "
            f"reasoning={len(accumulated_reasoning)} json={len(accumulated_json)} chars, "
            f"finish_reason={final_finish_reason}"
        )

        # Escalate max_tokens on truncation (finish_reason=length) — retry once with 32768
        # Guard: skip escalation if not enough time remains for another streaming call (need 120s headroom)
        elapsed = _safe_time() - request_start_time if request_start_time else 0
        if final_finish_reason == "length" and max_tokens < 32768 and not _is_escalation and elapsed < 180:
            logger.warning(
                f"⚠️ [{call_site}] Response truncated at max_tokens={max_tokens}, retrying with 32768 (elapsed={elapsed:.1f}s)"
            )

            # Known limitation: the retry restarts text_so_far from "" but callers that
            # track delta state (e.g. last_text[0] in run_agent.py) still hold the first
            # attempt's accumulated text. This causes the caller to emit empty deltas until
            # the retry response exceeds the first attempt's length, then only the tail is
            # shown. The final parsed result is correct — only the live-streaming display
            # is affected. A proper fix requires a stream-reset signal in the on_chunk
            # callback contract (or buffering the first attempt and not calling on_chunk
            # until we know there's no escalation, which defeats streaming).
            first_attempt_chars = len(last_emitted_for_chunk)
            logger.info(
                f"⚠️ [{call_site}] Escalation retry starting — first attempt streamed "
                f"{first_attempt_chars} chars to caller; live-streaming of retry may show "
                f"a content jump on the frontend"
            )

            return await call_llm_structured_streaming(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=32768,
                response_model=response_model,
                on_chunk=on_chunk,
                reasoning_max_tokens=reasoning_max_tokens,
                model_preference=model_preference,
                model_seed=model_seed,
                agent_id=agent_id,
                on_tool_detected=on_tool_detected,
                on_attention_stream=on_attention_stream,
                on_raw_progress=on_raw_progress,
                claude_token=claude_token,
                claude_token_source=claude_token_source,
                claude_token_pool_id=claude_token_pool_id,
                claude_token_user_id=claude_token_user_id,
                gpt_token=gpt_token,
                gpt_account_id=gpt_account_id,
                gpt_token_source=gpt_token_source,
                gpt_token_pool_id=gpt_token_pool_id,
                gpt_token_user_id=gpt_token_user_id,
                compute_token_lineage_key=compute_token_lineage_key,
                compute_token_fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
                cache_sequence_id=cache_sequence_id,
                on_model_detected=on_model_detected,
                skip_cache_write=skip_cache_write,
                call_site=call_site,
                tool_choice=tool_choice,
                _is_escalation=True,
            )
        elif final_finish_reason == "length" and max_tokens < 32768 and not _is_escalation and elapsed >= 180:
            logger.warning(
                f"⚠️ [{call_site}] Response truncated but skipping escalation — not enough time "
                f"(elapsed={elapsed:.1f}s, need <180s). Returning truncated result."
            )

        # Final emit - flush any remaining content that wasn't sent (under 18 chars)
        # The native direct-token path streams text_buffer directly (no reasoning prefix),
        # so the final flush must match: otherwise delta-tracking consumers (e.g.
        # call_llm_activity) see the final chunk jump to "reasoning + text" and
        # compute the wrong slice offset.
        if using_native_direct_tools:
            response_text = _native_visible_text() or None
        else:
            response_text = _extract_response_from_partial_json(accumulated_reasoning, accumulated_json)
        if response_text and response_text != last_emitted_for_chunk:
            await on_chunk(response_text, token_count)

        # Parse final JSON and validate with Pydantic
        # Rose models output: [explanation text]```json\n{...}\n```
        # We need to extract the JSON from within the markdown code block
        try:
            if not accumulated_json and accumulated_reasoning:
                # Thinking models (GPT-5.2, Kimi-K2.5) may put structured JSON
                # in reasoning tokens instead of content tokens.
                # Use balanced-brace extraction with JSON validation to skip
                # non-JSON brace blocks, then remove from reasoning to prevent leaking.
                search_pos = 0
                while search_pos < len(accumulated_reasoning) and not accumulated_json:
                    json_start = accumulated_reasoning.find("{", search_pos)
                    if json_start == -1:
                        break
                    depth = 0
                    in_string = False
                    escape_next = False
                    matched_end = -1
                    for i in range(json_start, len(accumulated_reasoning)):
                        ch = accumulated_reasoning[i]
                        if escape_next:
                            escape_next = False
                            continue
                        if ch == "\\" and in_string:
                            escape_next = True
                            continue
                        if ch == '"':
                            in_string = not in_string
                            continue
                        if in_string:
                            continue
                        if ch == "{":
                            depth += 1
                        elif ch == "}":
                            depth -= 1
                            if depth == 0:
                                matched_end = i
                                break
                    if matched_end == -1:
                        break
                    candidate = accumulated_reasoning[json_start : matched_end + 1]
                    try:
                        json.loads(candidate)
                        accumulated_json = candidate
                        accumulated_reasoning = (
                            accumulated_reasoning[:json_start] + accumulated_reasoning[matched_end + 1 :]
                        ).strip()
                        logger.info(f"📦 Extracted JSON from reasoning (thinking model, {len(accumulated_json)} chars)")
                    except json.JSONDecodeError:
                        search_pos = matched_end + 1

            if not accumulated_json:
                logger.error(
                    "❌ No JSON content received in Rose response",
                    chunk_count=chunk_count,
                    accumulated_reasoning_len=len(accumulated_reasoning),
                    actual_model=actual_model,
                    pool_name=pool_name,
                )
                raise ValueError(f"No JSON content received in response (chunks={chunk_count}, model={actual_model})")

            # Extract JSON from markdown code block if present
            # Look for ```json ... ``` pattern, or just raw JSON
            json_content = accumulated_json
            explanation_text = ""

            # Check for markdown code block: ```json ... ```
            code_block_match = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", accumulated_json)
            if code_block_match:
                json_content = code_block_match.group(1)
                # Everything before the code block is explanation
                explanation_text = accumulated_json[: code_block_match.start()].strip()
                logger.info(f"📦 Extracted JSON from markdown code block, explanation={len(explanation_text)} chars")
            else:
                # No code block - try to find raw JSON object using balanced braces
                json_start = accumulated_json.find("{")
                if json_start != -1:
                    explanation_text = accumulated_json[:json_start].strip()
                    # Walk forward to find matching closing brace (handles nested braces)
                    depth = 0
                    in_string = False
                    escape_next = False
                    json_end = -1
                    for i in range(json_start, len(accumulated_json)):
                        c = accumulated_json[i]
                        if escape_next:
                            escape_next = False
                            continue
                        if c == "\\" and in_string:
                            escape_next = True
                            continue
                        if c == '"' and not escape_next:
                            in_string = not in_string
                            continue
                        if in_string:
                            continue
                        if c == "{":
                            depth += 1
                        elif c == "}":
                            depth -= 1
                            if depth == 0:
                                json_end = i
                                break
                    if json_end != -1:
                        json_content = accumulated_json[json_start : json_end + 1]
                        logger.info(f"📦 Extracted raw JSON, explanation={len(explanation_text)} chars")

            parsed_content = json.loads(json_content)

            # Defensive recovery path: malformed upstream streams can sometimes wrap
            # another agent JSON payload inside response text. If outer tool_calls are
            # empty but nested tool_calls exist, unwrap and recover them.
            outer_tool_calls = parsed_content.get("tool_calls")
            outer_response = parsed_content.get("response")
            if (not outer_tool_calls) and isinstance(outer_response, str):
                nested = _extract_nested_agent_json_blob(outer_response)
                if isinstance(nested, dict) and isinstance(nested.get("tool_calls"), list):
                    normalized_nested_tools = []
                    for tc in nested.get("tool_calls", []):
                        if not isinstance(tc, dict):
                            continue
                        if isinstance(tc.get("tool"), str):
                            normalized_nested_tools.append(tc)
                            continue
                        # Legacy/wrapped shape: {"name":"tool_name","arguments":{...}}
                        if isinstance(tc.get("name"), str):
                            args = tc.get("arguments")
                            if isinstance(args, dict):
                                normalized_nested_tools.append({"tool": tc["name"], **args})
                            else:
                                normalized_nested_tools.append({"tool": tc["name"]})

                    if normalized_nested_tools:
                        parsed_content["tool_calls"] = normalized_nested_tools
                        nested_response = nested.get("response")
                        if isinstance(nested_response, str):
                            parsed_content["response"] = nested_response
                        nested_reasoning = nested.get("reasoning")
                        if isinstance(nested_reasoning, str) and nested_reasoning.strip():
                            existing_reasoning = parsed_content.get("reasoning")
                            if not isinstance(existing_reasoning, str) or not existing_reasoning.strip():
                                parsed_content["reasoning"] = nested_reasoning
                        logger.warning(
                            f"Recovered nested tool_calls from wrapped response text: {len(normalized_nested_tools)} call(s)"
                        )

            # Prepend explanation/reasoning to response so it shows in the same section.
            # Direct GPT/Codex mirrors claudeAuth here: visible reasoning summaries
            # are part of the assistant response, while encrypted replay state stays
            # separate in codex_reasoning_items metadata.
            combined_reasoning_parts = []
            if accumulated_reasoning and accumulated_reasoning.strip():
                combined_reasoning_parts.append(accumulated_reasoning.strip())

            json_reasoning = parsed_content.get("reasoning")
            if (
                isinstance(json_reasoning, str)
                and json_reasoning.strip()
                and (not combined_reasoning_parts or json_reasoning.strip() != combined_reasoning_parts[0])
            ):
                combined_reasoning_parts.append(json_reasoning.strip())

            if explanation_text:
                combined_reasoning_parts.append(explanation_text)

            combined_reasoning = "\n\n".join(part for part in combined_reasoning_parts if part)

            if combined_reasoning and "response" in parsed_content:
                parsed_content["response"] = combined_reasoning + "\n\n" + parsed_content["response"]

            response = response_model.model_validate(parsed_content)
        except (json.JSONDecodeError, Exception) as e:
            error_message = extract_error_message(e)
            # A malformed / schema-invalid structured output is non-deterministic,
            # so re-generate a bounded number of times before surfacing the error —
            # a fresh call almost always parses. Mirrors the max_tokens escalation
            # retry above (recursive, capped, time-guarded so we keep deadline
            # headroom for another streaming call).
            parse_elapsed = (_safe_time() - request_start_time) if request_start_time else 0
            if _parse_retry_attempt < MAX_STRUCTURED_PARSE_RETRIES and parse_elapsed < 180:
                logger.warning(
                    f"⚠️ [{call_site}] Failed to parse Rose response as "
                    f"{response_model.__name__} (parse attempt "
                    f"{_parse_retry_attempt + 1}/{MAX_STRUCTURED_PARSE_RETRIES + 1}); "
                    f"re-generating. error={error_message}",
                )
                return await call_llm_structured_streaming(
                    messages=messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    response_model=response_model,
                    on_chunk=on_chunk,
                    reasoning_max_tokens=reasoning_max_tokens,
                    model_preference=model_preference,
                    model_seed=model_seed,
                    agent_id=agent_id,
                    on_tool_detected=on_tool_detected,
                    on_attention_stream=on_attention_stream,
                    on_raw_progress=on_raw_progress,
                    claude_token=claude_token,
                    claude_token_source=claude_token_source,
                    claude_token_pool_id=claude_token_pool_id,
                    claude_token_user_id=claude_token_user_id,
                    gpt_token=gpt_token,
                    gpt_account_id=gpt_account_id,
                    gpt_token_source=gpt_token_source,
                    gpt_token_pool_id=gpt_token_pool_id,
                    gpt_token_user_id=gpt_token_user_id,
                    compute_token_lineage_key=compute_token_lineage_key,
                    compute_token_fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
                    cache_sequence_id=cache_sequence_id,
                    on_model_detected=on_model_detected,
                    skip_cache_write=skip_cache_write,
                    call_site=call_site,
                    thinking=thinking,
                    effort=effort,
                    tool_choice=tool_choice,
                    deadline_s=deadline_s,
                    ttft_timeout_s=ttft_timeout_s,
                    idle_timeout_s=idle_timeout_s,
                    _exclude_anthropic_family=_exclude_anthropic_family,
                    _is_escalation=_is_escalation,
                    _parse_retry_attempt=_parse_retry_attempt + 1,
                )
            logger.error(
                f"Failed to parse streaming Rose response: json={accumulated_json[:500]}",
                error=error_message,
            )
            raise LLMStructuredOutputError(
                f"Failed to parse streaming Rose response as {response_model.__name__}: {error_message}"
            ) from e

        # Use captured stream usage if available, otherwise fall back to estimates
        if stream_usage:
            usage = {
                "prompt_tokens": stream_usage.get("prompt_tokens", 0),
                "completion_tokens": stream_usage.get("completion_tokens", 0),
                "total_tokens": stream_usage.get("total_tokens", 0),
                "actual_model": actual_model,
                "pool_name": pool_name,
                "pool_size": pool_size,
                "claude_token_error": claude_token_error,
                "gpt_token_error": gpt_token_error,
                "claude_token_rotated": stream_usage.get("claude_token_rotated", False),
                "gpt_token_rotated": stream_usage.get("gpt_token_rotated", False),
                "compute_token_rotated": stream_usage.get("compute_token_rotated", False),
                "compute_token_used": stream_usage.get("compute_token_used"),
                "cancelled": False,
                "from_fast_cache": stream_usage.get("from_fast_cache", False),
                # Cache metrics from Anthropic prompt caching
                "cache_creation_input_tokens": stream_usage.get("cache_creation_input_tokens", 0),
                "cache_read_input_tokens": stream_usage.get("cache_read_input_tokens", 0),
                "cache_sequence_id": stream_usage.get("cache_sequence_id") or cache_sequence_id,
            }
        else:
            usage = {
                "prompt_tokens": 0,  # Fallback if stream_options not supported
                "completion_tokens": token_count,
                "total_tokens": token_count,
                "actual_model": actual_model,
                "pool_name": pool_name,
                "pool_size": pool_size,
                "claude_token_error": claude_token_error,
                "gpt_token_error": gpt_token_error,
                "claude_token_rotated": False,
                "gpt_token_rotated": False,
                "compute_token_rotated": False,
                "compute_token_used": None,
                "cancelled": False,
                "from_fast_cache": False,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
                "cache_sequence_id": cache_sequence_id,
            }

        if (
            deferred_fast_cache_key
            and deferred_fast_cache_goal_hash
            and deferred_fast_cache_acc is not None
            and not usage.get("from_fast_cache")
        ):
            try:
                stored_ok = await fast_cache_client.cache_set(
                    deferred_fast_cache_key,
                    "llm",
                    deferred_fast_cache_goal_hash,
                    deferred_fast_cache_acc,
                )
                # Diagnostic: the goal STRING behind the goal_hash. A trajectory whose
                # terminal call caches under a run-unique goal (timestamp/uuid leaking
                # into the goal) never replays — see explore-final-call-cache-miss.
                goal_preview = (deferred_fast_cache_goal_str or "")[:160]
                if stored_ok:
                    logger.info(
                        "llm.cache.stored",
                        call_site=call_site,
                        key=deferred_fast_cache_key,
                        goal_hash=deferred_fast_cache_goal_hash,
                        goal_preview=goal_preview,
                    )
                else:
                    # cache_set returns False (never raises) on a non-200/timeout write.
                    # Previously we logged "stored" unconditionally, masking dropped writes.
                    logger.warning(
                        "fast_cache.write_dropped",
                        call_site=call_site,
                        key=deferred_fast_cache_key,
                        goal_hash=deferred_fast_cache_goal_hash,
                        goal_preview=goal_preview,
                    )
            except Exception as exc:
                logger.warning("fast_cache.set_error", key=deferred_fast_cache_key, error=str(exc))

        # Deduplicate single-call-per-step tools (keep only first occurrence)
        # These tools should never be called more than once in the same response
        SINGLE_CALL_TOOLS = {"send_message_to_user", "send_message_to_user_execute_phase"}
        if hasattr(response, "tool_calls") and response.tool_calls:
            seen_single_call = set()
            deduplicated_tools = []
            for tc in response.tool_calls:
                if tc and tc.tool in SINGLE_CALL_TOOLS:
                    if tc.tool in seen_single_call:
                        logger.info(f"🔇 Deduplicated {tc.tool} (only one allowed per step)")
                        continue
                    seen_single_call.add(tc.tool)
                deduplicated_tools.append(tc)

            if len(deduplicated_tools) != len(response.tool_calls):
                # Also deduplicate from detected_tools_ordered
                seen_for_detection = set()
                new_detected = []
                for name, tid, ts in detected_tools_ordered:
                    if name in SINGLE_CALL_TOOLS:
                        if name in seen_for_detection:
                            continue
                        seen_for_detection.add(name)
                    new_detected.append((name, tid, ts))
                detected_tools_ordered = new_detected

            response.tool_calls = deduplicated_tools

        object.__setattr__(response, "codex_reasoning_items", codex_reasoning_items)

        return response, usage, detected_tools_ordered

    # The direct OpenRouter/Instructor path below parses JSON content and does
    # not consume provider-native tool calls. Dispatching it with a forced tool
    # choice would therefore pretend to constrain generation while only
    # validating the result after the fact. Fail closed before the provider
    # request; Rose models project AgentAction into native tools and are the
    # supported path for required-tool calls.
    if tool_choice is not None:
        raise LLMStructuredOutputError(
            "Required native tool selection is unsupported for direct OpenRouter models; use a Rose model"
        )

    # For OpenRouter models, use Instructor's partial streaming
    base_client = AsyncOpenAI(api_key=config.openrouter.api_key, base_url=config.openrouter.base_url)

    # Use Instructor's partial streaming mode
    client = instructor.from_openai(base_client, mode=instructor.Mode.JSON)

    extra_args = {}
    if reasoning_max_tokens:
        extra_args["extra_body"] = {"reasoning": {"max_tokens": reasoning_max_tokens}}

    last_emitted_text = ""
    last_emitted_for_chunk = ""  # Track what we've actually sent to on_chunk (for 18-char batching)
    accumulated_text = ""
    final_response = None
    chunk_count = 0

    # Use create_partial for streaming
    try:
        async for partial in client.chat.completions.create_partial(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_model=response_model,
            **extra_args,
        ):
            chunk_count += 1

            # Heartbeat every 5 chunks - when activity is cancelled, this raises CancelledError
            if chunk_count % 5 == 0:
                _safe_heartbeat(f"OpenRouter streaming chunk {chunk_count}")

            # Extract response text from partial object
            if hasattr(partial, "response") and partial.response:
                current_text = partial.response
                if current_text != last_emitted_text:
                    accumulated_text = current_text
                    last_emitted_text = current_text

                    # Only emit when 18+ new chars since last emit
                    pending_delta = len(accumulated_text) - len(last_emitted_for_chunk)
                    if pending_delta >= 18:
                        token_count = len(accumulated_text) // 4
                        await on_chunk(accumulated_text, token_count)
                        last_emitted_for_chunk = accumulated_text

            final_response = partial

        # Final emit - flush any remaining content that wasn't sent (under 18 chars)
        if accumulated_text and accumulated_text != last_emitted_for_chunk:
            await on_chunk(accumulated_text, len(accumulated_text) // 4)

    except asyncio.CancelledError:
        logger.info("⏹️ OpenRouter streaming cancelled (asyncio.CancelledError)")
        raise
    except Exception as e:
        logger.error(f"Streaming LLM call failed: {str(e)}", model=model)
        raise

    if final_response is None:
        raise ValueError(f"Streaming LLM returned no response (model={model})")

    # Deduplicate single-call-per-step tools (keep only first occurrence)
    # These tools should never be called more than once in the same response
    SINGLE_CALL_TOOLS = {"send_message_to_user", "send_message_to_user_execute_phase"}
    if hasattr(final_response, "tool_calls") and final_response.tool_calls:
        seen_single_call = set()
        deduplicated_tools = []
        for tc in final_response.tool_calls:
            if tc and tc.tool in SINGLE_CALL_TOOLS:
                if tc.tool in seen_single_call:
                    logger.info(f"🔇 Deduplicated {tc.tool} (only one allowed per step)")
                    continue
                seen_single_call.add(tc.tool)
            deduplicated_tools.append(tc)
        final_response.tool_calls = deduplicated_tools

    # Usage not available in Instructor streaming, estimate from content
    estimated_tokens = len(accumulated_text) // 4
    usage = {
        "prompt_tokens": 0,
        "completion_tokens": estimated_tokens,
        "total_tokens": estimated_tokens,
        "cancelled": False,
    }

    return final_response, usage, []  # No tool detection in OpenRouter path


def _extract_completed_tool_calls(accumulated_json: str) -> List[Dict[str, Any]]:
    """
    Extract fully-formed tool call objects from partial JSON stream.
    Returns list of tool calls that have complete params (closed braces).
    """
    completed = []

    # Find tool_calls array start
    tc_match = re.search(r'"tool_calls"\s*:\s*\[', accumulated_json)
    if not tc_match:
        return completed

    # Extract content after tool_calls: [
    array_start = tc_match.end()
    content = accumulated_json[array_start:]

    # Find complete objects by tracking brace depth
    depth = 0
    obj_start = None

    for i, char in enumerate(content):
        if char == "{":
            if depth == 0:
                obj_start = i
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0 and obj_start is not None:
                # Complete object found
                obj_str = content[obj_start : i + 1]
                try:
                    obj = json.loads(obj_str)
                    completed.append(obj)
                except json.JSONDecodeError:
                    pass  # Incomplete or malformed
                obj_start = None

    return completed


def _extract_response_from_partial_json(reasoning: str, json_content: str) -> Optional[str]:
    """
    Extract streamable text from reasoning and partial JSON content.

    Rose models output: [explanation text]```json\n{...}\n```
    We extract explanation text plus JSON `reasoning` and `response` fields.

    Note: send_message_to_user.message is NOT streamed here because it creates
    a separate TOOL message in the DB - streaming it would cause duplicate display.

    Args:
        reasoning: Accumulated reasoning/thinking text (may be empty for Rose)
        json_content: Accumulated content which may include explanation + markdown code block

    Returns:
        Combined text: "reasoning\n\nexplanation\n\nresponse" (whichever parts exist)
    """
    reasoning = reasoning.strip() if reasoning else ""

    # No content yet, just return reasoning
    if not json_content:
        return reasoning if reasoning else None

    # Extract explanation text (everything before the JSON/markdown block)
    explanation = ""
    json_only = json_content

    # Check for markdown code block start
    code_block_start = json_content.find("```")
    if code_block_start > 0:
        explanation = json_content[:code_block_start].strip()
        json_only = json_content[code_block_start:]
    else:
        # Look for raw JSON start
        json_start = json_content.find("{")
        if json_start > 0:
            explanation = json_content[:json_start].strip()
            json_only = json_content[json_start:]

    response_text = ""
    json_reasoning = ""

    # Try to extract response field from the JSON portion
    # First try complete JSON parse
    try:
        # Strip markdown delimiters if present
        clean_json = re.sub(r"^```(?:json)?\s*", "", json_only)
        clean_json = re.sub(r"\s*```$", "", clean_json)
        data = json.loads(clean_json)
        if isinstance(data, dict):
            json_reasoning = data.get("reasoning", "") or ""
            response_text = data.get("response", "") or ""
    except json.JSONDecodeError:
        # Try regex extraction for partial reasoning
        reasoning_match = re.search(r'"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"?', json_only)
        if reasoning_match:
            try:
                json_reasoning = json.loads(f'"{reasoning_match.group(1)}"')
            except json.JSONDecodeError:
                json_reasoning = reasoning_match.group(1)

        # Try regex extraction for partial JSON
        match = re.search(r'"response"\s*:\s*"((?:[^"\\]|\\.)*)"?', json_only)
        if match:
            try:
                response_text = json.loads(f'"{match.group(1)}"')
            except json.JSONDecodeError:
                response_text = match.group(1)

    # Combine all parts: stream reasoning + json reasoning + explanation + response
    parts = []
    if reasoning:
        parts.append(reasoning)
    if json_reasoning:
        json_reasoning_str = str(json_reasoning) if not isinstance(json_reasoning, str) else json_reasoning
        if not reasoning or json_reasoning_str.strip() != reasoning.strip():
            parts.append(json_reasoning_str)
    if explanation:
        parts.append(explanation)
    if response_text:
        # response_text may be a float (e.g., verifier score 0.0-1.0) - convert to string
        parts.append(str(response_text) if not isinstance(response_text, str) else response_text)

    return "\n\n".join(parts) if parts else None


def _extract_nested_agent_json_blob(text: Any) -> Optional[Dict[str, Any]]:
    """
    Best-effort extraction of a nested agent JSON object from text.
    Handles raw JSON and markdown-fenced ```json blocks.
    """
    if not isinstance(text, str) or not text.strip():
        return None

    trimmed = text.strip()
    candidates: List[str] = [trimmed]

    fence_match = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", trimmed)
    if fence_match:
        candidates.insert(0, fence_match.group(1))
    else:
        start = trimmed.find("{")
        end = trimmed.rfind("}")
        if start != -1 and end != -1 and end > start:
            candidates.append(trimmed[start : end + 1])

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    return None


@activity.defn
@traced("call_llm")
async def call_llm(
    messages: List[Dict[str, Any]],
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    response_format: Optional[Dict] = None,
    response_model: Optional[Type[BaseModel]] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    compute_token_lineage_key: Optional[str] = None,
    compute_token_fast_cache_affinity_key: Optional[str] = None,
    cache_sequence_id: Optional[str] = None,
    skip_cache_write: bool = False,
    call_site: str = "unknown",
    agent_id: Optional[str] = None,
    local_context: Optional[List[Dict[str, Any]]] = None,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Call OpenRouter LLM for agent reasoning.

    Args:
        messages: List of message dicts with 'role' and 'content'
        model: Model to use (defaults to config)
        temperature: Sampling temperature (0-2)
        max_tokens: Maximum tokens to generate
        response_format: Optional response format (e.g., {"type": "json_object"})
        call_site: Label identifying the caller (e.g., message_person, context_compression)

    Returns:
        Dict with 'content', 'model', 'usage', etc.
    """
    try:
        _safe_heartbeat(f"Calling LLM with {len(messages)} messages")

        # Resolve context pointers
        messages = await resolve_pointers_in_messages(
            messages,
            local_context=local_context,
            user_id=user_id or claude_token_user_id or gpt_token_user_id,
        )

        config = load_config()
        model = model or config.openrouter.model

        if response_format is not None and response_model is not None:
            raise ValueError("call_llm accepts either response_model or response_format, not both")

        effective_response_format = response_format
        if response_model is not None:
            effective_response_format = build_openai_response_format(response_model)

        # Check if this is a Rose model — route directly to Anthropic / OpenRouter
        # via the in-process RoseClient (replaces the Supabase edge function).
        pool = pool_for_model(model) if model else None

        if pool is not None:
            request_id = current_request_id() or str(uuid.uuid4())[:8]
            logger.info(
                f"📤 [{request_id}] [{call_site}] Routing Rose model in-process: {model} pool={pool} skip_cache_write={skip_cache_write}"
            )

            rose_client = RoseClient()
            claude_auth_context = _build_claude_auth_context(
                claude_token,
                source=claude_token_source,
                user_id=claude_token_user_id,
                pool_token_id=claude_token_pool_id,
                lineage_key=compute_token_lineage_key,
                agent_id=agent_id,
                root_agent_id=agent_id,
                fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
            )
            gpt_auth_context = _build_gpt_auth_context(
                gpt_token,
                account_id=gpt_account_id,
                source=gpt_token_source,
                user_id=gpt_token_user_id,
                pool_token_id=gpt_token_pool_id,
                lineage_key=compute_token_lineage_key,
                agent_id=agent_id,
                root_agent_id=agent_id,
                fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
            )
            try:
                rose_response = await rose_client.collect(
                    pool=pool,
                    messages=messages,
                    response_model=response_model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    skip_cache_write=skip_cache_write,
                    claude_auth=claude_auth_context,
                    gpt_auth=gpt_auth_context,
                    agent_id=agent_id,
                    request_id=request_id,
                    call_site=call_site,
                    cache_namespace=cache_sequence_id,
                )
            except RoseError as exc:
                logger.error(
                    f"❌ [{request_id}] Rose call failed: {type(exc).__name__}: {exc}",
                    request_id=request_id,
                    call_site=call_site,
                )
                raise ValueError(f"Rose call failed: {exc}") from exc

            content = rose_response.content
            if response_model is not None:
                content = (
                    _content_from_structured_rose_response(
                        rose_response.tool_calls,
                        response_model,
                    )
                    or content
                )
                content = response_model.model_validate_json(content).model_dump_json()
            usage = rose_response.usage or {}

            result = {
                "content": content,
                "model": rose_response.actual_model or model,
                # Preserve Rose's real finish signal so callers can detect
                # max_tokens truncation; prior code hardcoded "stop" and lost
                # that distinction.
                "finish_reason": usage.get("finish_reason", "stop"),
                "usage": {
                    "prompt_tokens": usage.get("prompt_tokens", 0),
                    "completion_tokens": usage.get("completion_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0),
                    "actual_model": rose_response.actual_model or model,
                    "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
                    "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
                    "claude_token_error": rose_response.claude_token_error,
                    "gpt_token_error": rose_response.gpt_token_error,
                    "claude_token_rotated": usage.get("claude_token_rotated", False),
                    "gpt_token_rotated": usage.get("gpt_token_rotated", False),
                    "compute_token_rotated": usage.get("compute_token_rotated", False),
                    "compute_token_used": usage.get("compute_token_used"),
                    "from_fast_cache": usage.get("from_fast_cache", False),
                    "cache_sequence_id": usage.get("cache_sequence_id") or cache_sequence_id,
                },
            }

            logger.info(
                f"📥 [{request_id}] LLM call complete (Rose)",
                request_id=request_id,
                model=rose_response.actual_model or model,
                pool=rose_response.pool_name or pool,
                tokens=result["usage"]["total_tokens"],
                content_length=len(content),
                content_preview=content[:100] if content else "EMPTY",
            )

            if response_model is not None and not skip_cache_write and not usage.get("from_fast_cache"):
                ctx = current_fast_cache_context()
                if ctx is not None and ctx.active and ctx.should_write:
                    from providers.fast_cache.rose_cache import request_key_material as fast_cache_request_key_material

                    fast_cache_kwargs = {
                        "pool": pool,
                        "messages": messages,
                        "response_model": response_model,
                        "temperature": temperature,
                        "max_tokens": max_tokens,
                        "provider_fast_mode": bool(ctx.provider_fast_mode),
                        "cache_namespace": cache_sequence_id,
                    }
                    key = ctx.llm_key(call_site, fast_cache_request_key_material(fast_cache_kwargs))
                    stored_ok = await fast_cache_client.cache_set(
                        key,
                        "llm",
                        ctx.goal_hash,
                        {
                            "actual_model": rose_response.actual_model or model,
                            "pool_name": rose_response.pool_name or pool,
                            "request_id": rose_response.request_id or request_id,
                            "content": content,
                            "reasoning": rose_response.reasoning,
                            "tool_calls": rose_response.tool_calls,
                            "codex_reasoning_items": rose_response.codex_reasoning_items,
                            "usage": usage,
                        },
                    )
                    if stored_ok:
                        logger.info(
                            "llm.cache.stored",
                            call_site=call_site,
                            key=key,
                            structured=True,
                            goal_hash=ctx.goal_hash,
                            goal_preview=(ctx.goal or "")[:160],
                        )
                    else:
                        logger.warning(
                            "fast_cache.write_dropped",
                            call_site=call_site,
                            key=key,
                            structured=True,
                            goal_hash=ctx.goal_hash,
                            goal_preview=(ctx.goal or "")[:160],
                        )

            return result

        # Use OpenRouter for all other models
        client = AsyncOpenAI(api_key=config.openrouter.api_key, base_url=config.openrouter.base_url)

        # Call OpenRouter
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=effective_response_format,
        )

        # Log full response to debug
        logger.info(
            "Raw LLM response",
            has_choices=len(response.choices) > 0,
            message_dict=response.choices[0].message.model_dump() if response.choices else None,
            finish_reason=response.choices[0].finish_reason if response.choices else None,
        )

        content = response.choices[0].message.content or ""
        if response_model is not None and content:
            content = response_model.model_validate_json(content).model_dump_json()

        result = {
            "content": content,
            "model": response.model,
            "finish_reason": response.choices[0].finish_reason,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
            },
        }

        logger.info(
            "LLM call complete",
            model=model,
            tokens=result["usage"]["total_tokens"],
            content_length=len(content),
            content_preview=content[:100] if content else "EMPTY",
        )

        return result

    except Exception as e:
        logger.error("LLM call failed", error=extract_error_message(e))
        raise


def _content_from_structured_rose_response(
    tool_calls: List[Dict[str, Any]],
    response_model: Type[BaseModel],
) -> Optional[str]:
    for tool_call in tool_calls:
        if tool_call.get("name") != SYNTHETIC_OUTPUT_TOOL_NAME:
            continue
        arguments = tool_call.get("arguments") or ""
        if not isinstance(arguments, str) or not arguments:
            continue
        try:
            validated = response_model.model_validate_json(arguments)
            return validated.model_dump_json()
        except Exception:
            try:
                parsed = json.loads(arguments)
                if isinstance(parsed, dict) and set(parsed) == {"value"}:
                    validated = response_model.model_validate(parsed["value"])
                    return validated.model_dump_json()
            except Exception:
                pass
            return arguments
    return None


# NOTE: decide_next_action was removed - it was dead code (never called)
# The run_agent loop handles LLM calls directly via call_llm_structured_streaming


async def _call_llm_verifier(
    messages: List[Dict[str, Any]],
    model: str,
    config: Any,
    response_schema: Optional[Dict[str, Any]] = None,
    claude_token: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    compute_token_lineage_key: Optional[str] = None,
    compute_token_fast_cache_affinity_key: Optional[str] = None,
    call_site: str = "verifier",
    agent_id: Optional[str] = None,
    dump_extra: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Sole LLM helper for the verifier — no streaming UI, no tool detection.

    All verifier code paths route through this helper via the ``check_progress``
    activity. The activity forces ``model="rose-labs/rose-1-ultra"`` so the
    pool resolution below is guaranteed to succeed; the assertion guards against
    misuse if a future caller skips ``check_progress``.

    Args:
        messages: Chat messages for the LLM
        model: Model to use (must resolve to a Rose pool)
        config: Application config
        response_schema: Optional response schema to include output extraction
        claude_token: Optional Claude OAuth token for direct Anthropic calls
        call_site: Cache-logging tag (e.g. "verifier_plan", "verifier_execute",
            "verifier_post_dag", "verifier_browser", "verifier_claude_code").
        agent_id: Optional agent ID for tracing.

    Returns:
        Tuple of (parsed JSON dict with reasoning, score, and optionally output), usage dict)
    """
    pool = pool_for_model(model)
    # The check_progress activity always forces a Rose model. Assertion guards
    # against direct misuse — there is no non-Rose verifier fallback.
    assert pool is not None, (
        f"_call_llm_verifier requires a Rose model (got {model!r}); "
        f"all verifier paths must go through check_progress, which forces rose-1-ultra."
    )

    response_model = _build_verifier_response_model(response_schema)

    accumulated_reasoning = ""
    accumulated_json = ""
    structured_output = StructuredOutputAccumulator()
    actual_model = "unknown"
    pool_name = "unknown"
    claude_token_error: Optional[str] = None
    gpt_token_error: Optional[str] = None
    tool_use_blocks: List[Dict[str, Any]] = []
    chunk_count = 0
    stream_usage: Optional[Dict[str, Any]] = None

    verifier_request_id = current_request_id() or str(uuid.uuid4())[:8]
    rose_client = RoseClient()
    claude_auth_context = _build_claude_auth_context(
        claude_token,
        source=claude_token_source,
        user_id=claude_token_user_id,
        pool_token_id=claude_token_pool_id,
        lineage_key=compute_token_lineage_key,
        agent_id=agent_id,
        root_agent_id=agent_id,
        fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
    )
    gpt_auth_context = _build_gpt_auth_context(
        gpt_token,
        account_id=gpt_account_id,
        source=gpt_token_source,
        user_id=gpt_token_user_id,
        pool_token_id=gpt_token_pool_id,
        lineage_key=compute_token_lineage_key,
        agent_id=agent_id,
        root_agent_id=agent_id,
        fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
    )
    deferred_fast_cache_key: Optional[str] = None
    deferred_fast_cache_goal_hash: Optional[str] = None
    deferred_fast_cache_goal_str: Optional[str] = None
    deferred_fast_cache_acc: Optional[Dict[str, Any]] = None
    fast_cache_accumulate = None
    try:
        from providers.fast_cache.rose_cache import (
            accumulate_chunk as fast_cache_accumulate,
        )
        from providers.fast_cache.rose_cache import (
            cached_complete,
        )
        from providers.fast_cache.rose_cache import (
            empty_response as fast_cache_empty_response,
        )
        from providers.fast_cache.rose_cache import (
            request_key_material as fast_cache_request_key_material,
        )

        fast_cache_context = current_fast_cache_context()
        if fast_cache_context is not None and fast_cache_context.active and fast_cache_context.should_write:
            fast_cache_complete_kwargs: Dict[str, Any] = {
                "pool": pool,
                "messages": messages,
                "response_model": response_model,
                "temperature": 0.3,
                "max_tokens": VERIFIER_MAX_TOKENS,
                "claude_auth": claude_auth_context,
                "gpt_auth": gpt_auth_context,
                "agent_id": agent_id,
                "request_id": verifier_request_id,
                "dump_extra": dump_extra,
                "provider_fast_mode": bool(fast_cache_context.provider_fast_mode),
            }
            deferred_fast_cache_key = fast_cache_context.llm_key(
                call_site,
                fast_cache_request_key_material(fast_cache_complete_kwargs),
            )
            deferred_fast_cache_goal_hash = fast_cache_context.goal_hash
            deferred_fast_cache_goal_str = fast_cache_context.goal
            deferred_fast_cache_acc = fast_cache_empty_response()
    except Exception as exc:
        logger.warning("fast_cache.defer_setup_error", call_site=call_site, error=str(exc))
        from providers.fast_cache.rose_cache import cached_complete

    try:
        # Fast Mode record/replay (verifier path).
        async for chunk in cached_complete(
            rose_client,
            call_site=call_site,
            pool=pool,
            messages=messages,
            response_model=response_model,
            temperature=0.3,
            max_tokens=VERIFIER_MAX_TOKENS,
            claude_auth=claude_auth_context,
            gpt_auth=gpt_auth_context,
            agent_id=agent_id,
            request_id=verifier_request_id,
            dump_extra=dump_extra,
            deadline_s=VERIFIER_ATTEMPT_DEADLINE_S,
            ttft_timeout_s=VERIFIER_TTFT_TIMEOUT_S,
            idle_timeout_s=VERIFIER_IDLE_TIMEOUT_S,
        ):
            chunk_count += 1
            if deferred_fast_cache_acc is not None and fast_cache_accumulate is not None:
                fast_cache_accumulate(deferred_fast_cache_acc, chunk)
            if chunk_count % 10 == 0:
                _safe_heartbeat(f"Verifier streaming... {chunk_count} chunks")

            kind = chunk.kind
            if kind == "metadata":
                actual_model = chunk.data.get("actual_model", actual_model)
                pool_name = chunk.data.get("pool_name", pool_name)
                if chunk.data.get("claude_token_error") and not claude_token_error:
                    claude_token_error = chunk.data["claude_token_error"]
                    logger.warning(f"⚠️ Verifier claude token error: {claude_token_error}")
                if chunk.data.get("gpt_token_error") and not gpt_token_error:
                    gpt_token_error = chunk.data["gpt_token_error"]
                    logger.warning(f"⚠️ Verifier GPT token error: {gpt_token_error}")
            elif kind == "content":
                structured_output.add_chunk(chunk)
                accumulated_json = structured_output.current_text()
            elif kind == "reasoning":
                accumulated_reasoning += chunk.data.get("text", "")
            elif kind == "tool_call":
                # claudeAuth path uses native tools — buffer them and rebuild
                # the {"reasoning","response","tool_calls"} envelope at the end.
                args_raw = chunk.data.get("arguments", "")
                try:
                    parsed_args = json.loads(args_raw) if args_raw else {}
                except json.JSONDecodeError:
                    parsed_args = {}
                if not isinstance(parsed_args, dict):
                    parsed_args = {}
                tool_use_blocks.append(
                    {
                        "name": chunk.data.get("name", ""),
                        "input": parsed_args,
                    }
                )
            elif kind == "usage":
                stream_usage = dict(chunk.data)
            elif kind == "done":
                pass
    except RoseError as e:
        logger.warning(
            f"Verifier RoseClient error after {chunk_count} chunks, "
            f"accumulated json={len(accumulated_json)} chars, reasoning={len(accumulated_reasoning)} chars: {e}"
        )

    # Native tool_use blocks from claudeAuth → rebuild the verifier JSON envelope
    # so the existing parser (which expects a single {reasoning, score, ...} blob)
    # finds it via accumulated_json. Note the verifier schema is
    # {reasoning, score, ...}, NOT the agent-envelope shape
    # {reasoning, response, tool_calls} that `reconstruct_agent_response`
    # produces — serialize the first tool's `input` dict directly.
    if tool_use_blocks:
        first_input = tool_use_blocks[0].get("input")
        if not isinstance(first_input, dict):
            raise ValueError(f"Verifier native tool payload must be an object (got {type(first_input).__name__})")
        accumulated_json = json.dumps(first_input)
    elif structured_output.has_content():
        accumulated_json = structured_output.final_text()

    # llm.cache event is emitted from RoseClient.complete (single source).
    # Still need these locally for the returned usage dict consumed by callers.
    cache_read = stream_usage.get("cache_read_input_tokens", 0) if stream_usage else 0
    cache_write = stream_usage.get("cache_creation_input_tokens", 0) if stream_usage else 0
    prompt_toks = stream_usage.get("prompt_tokens", 0) if stream_usage else 0

    # Parse JSON - handle thinking models that put JSON in reasoning
    json_content = accumulated_json

    if not json_content and accumulated_reasoning:
        # Thinking models might put JSON in reasoning
        json_match = re.search(r"\{[\s\S]*\}", accumulated_reasoning)
        if json_match:
            json_content = json_match.group(0)
            logger.info("📦 Extracted JSON from reasoning (thinking model)")

    if not json_content:
        raise ValueError(f"No JSON content received (chunks={chunk_count}, model={actual_model})")

    parsed_json = json.loads(json_content)
    parsed_json = _fill_missing_verifier_output_from_messages(
        parsed_json,
        response_schema,
        messages,
    )
    parsed = response_model.model_validate(parsed_json).model_dump()

    usage = {
        "prompt_tokens": prompt_toks,
        "completion_tokens": stream_usage.get("completion_tokens", chunk_count) if stream_usage else chunk_count,
        "total_tokens": stream_usage.get("total_tokens", chunk_count) if stream_usage else chunk_count,
        "actual_model": actual_model,
        "pool_name": pool_name,
        "claude_token_error": claude_token_error,
        "gpt_token_error": gpt_token_error,
        "claude_token_rotated": stream_usage.get("claude_token_rotated", False) if stream_usage else False,
        "gpt_token_rotated": stream_usage.get("gpt_token_rotated", False) if stream_usage else False,
        "compute_token_rotated": stream_usage.get("compute_token_rotated", False) if stream_usage else False,
        "compute_token_used": stream_usage.get("compute_token_used") if stream_usage else None,
        "from_fast_cache": stream_usage.get("from_fast_cache", False) if stream_usage else False,
        "cache_creation_input_tokens": cache_write,
        "cache_read_input_tokens": cache_read,
    }

    if (
        deferred_fast_cache_key
        and deferred_fast_cache_goal_hash
        and deferred_fast_cache_acc is not None
        and not usage.get("from_fast_cache")
    ):
        try:
            stored_ok = await fast_cache_client.cache_set(
                deferred_fast_cache_key,
                "llm",
                deferred_fast_cache_goal_hash,
                deferred_fast_cache_acc,
            )
            goal_preview = (deferred_fast_cache_goal_str or "")[:160]
            if stored_ok:
                logger.info(
                    "llm.cache.stored",
                    call_site=call_site,
                    key=deferred_fast_cache_key,
                    goal_hash=deferred_fast_cache_goal_hash,
                    goal_preview=goal_preview,
                )
            else:
                logger.warning(
                    "fast_cache.write_dropped",
                    call_site=call_site,
                    key=deferred_fast_cache_key,
                    goal_hash=deferred_fast_cache_goal_hash,
                    goal_preview=goal_preview,
                )
        except Exception as exc:
            logger.warning("fast_cache.set_error", key=deferred_fast_cache_key, error=str(exc))

    return parsed, usage


def _extract_structured_responses_from_verifier_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Extract JSON objects copied into verifier context as `Structured Response` blocks."""
    decoder = json.JSONDecoder()
    responses: List[Dict[str, Any]] = []

    def iter_text_parts(content: Any) -> List[str]:
        if isinstance(content, str):
            return [content]
        if isinstance(content, list):
            parts: List[str] = []
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    parts.append(block["text"])
            return parts
        return []

    for message in messages:
        parts = iter_text_parts(message.get("content"))
        if isinstance(message.get("text"), str):
            parts.append(message["text"])
        for text in parts:
            start = 0
            while True:
                marker_index = text.find("Structured Response:", start)
                if marker_index == -1:
                    break
                json_start = marker_index + len("Structured Response:")
                try:
                    candidate, consumed = decoder.raw_decode(text[json_start:].lstrip())
                except json.JSONDecodeError:
                    start = json_start
                    continue
                if isinstance(candidate, dict):
                    responses.append(candidate)
                start = json_start + consumed

    return responses


def _fill_missing_verifier_output_from_messages(
    parsed_json: Any,
    response_schema: Optional[Dict[str, Any]],
    messages: List[Dict[str, Any]],
) -> Any:
    """Fill missing verifier output fields from grounded tool structured responses.

    The verifier is still required to return valid JSON. This only completes
    fields it omitted when the same field is present in a prior tool result
    serialized into the verifier context.
    """
    if not response_schema or not response_schema.get("fields") or not isinstance(parsed_json, dict):
        return parsed_json

    required_names = [
        field.get("name")
        for field in response_schema.get("fields", [])
        if isinstance(field, dict) and isinstance(field.get("name"), str)
    ]
    if not required_names:
        return parsed_json

    output = parsed_json.get("output")
    if not isinstance(output, dict):
        output = {}
        parsed_json["output"] = output

    missing_names = [name for name in required_names if name not in output]
    if not missing_names:
        return parsed_json

    candidates = _extract_structured_responses_from_verifier_messages(messages)
    filled: List[str] = []
    for name in missing_names:
        for candidate in reversed(candidates):
            source = candidate.get("output") if isinstance(candidate.get("output"), dict) else candidate
            if isinstance(source, dict) and name in source:
                output[name] = source[name]
                filled.append(name)
                break
    if filled:
        logger.info(
            "Filled missing verifier output fields from structured tool response",
            fields=filled,
        )

    return parsed_json


def _schema_field_names(response_schema: Optional[Dict[str, Any]]) -> List[str]:
    if not response_schema or not isinstance(response_schema.get("fields"), list):
        return []
    return [
        field.get("name")
        for field in response_schema.get("fields", [])
        if isinstance(field, dict) and isinstance(field.get("name"), str) and field.get("name")
    ]


def _has_schema_value(value: Any, field_type: Optional[str] = None) -> bool:
    if value is None:
        return False
    if field_type in ("file_pointer", "session_file_pointer"):
        return isinstance(value, dict) and any(value.get(key) for key in ("id", "path", "storage_path"))
    if field_type in ("list[file_pointer]", "list[session_file_pointer]"):
        return isinstance(value, list) and all(_has_schema_value(item, "file_pointer") for item in value)
    return True


def _normalize_schema_field_type(field_type: Any) -> Optional[str]:
    if not isinstance(field_type, str):
        return None
    normalized = field_type.strip().lower()
    aliases = {
        "string": "str",
        "integer": "int",
        "number": "float",
        "boolean": "bool",
    }
    return aliases.get(normalized, normalized)


def _nested_fields_for_object_field(field: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return explicitly declared subfields for object outputs."""
    explicit = field.get("properties")
    if isinstance(explicit, list):
        fields: List[Dict[str, Any]] = []
        for item in explicit:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            field_type = _normalize_schema_field_type(item.get("type"))
            if isinstance(name, str) and name and field_type:
                fields.append(
                    {
                        "name": name,
                        "type": field_type,
                        "description": item.get("description", ""),
                    }
                )
        if fields:
            return fields
    if isinstance(explicit, dict):
        fields = []
        for name, spec in explicit.items():
            if isinstance(spec, dict):
                field_type = _normalize_schema_field_type(spec.get("type"))
                description = spec.get("description", "")
            else:
                field_type = _normalize_schema_field_type(spec)
                description = ""
            if isinstance(name, str) and name and field_type:
                fields.append({"name": name, "type": field_type, "description": description})
        if fields:
            return fields
    return []


def _structured_response_satisfies_schema(
    structured_response: Any,
    response_schema: Optional[Dict[str, Any]],
) -> bool:
    if not isinstance(structured_response, dict):
        return False
    fields = response_schema.get("fields", []) if isinstance(response_schema, dict) else []
    if not fields:
        return False
    for field in fields:
        if not isinstance(field, dict):
            return False
        name = field.get("name")
        if not isinstance(name, str) or name not in structured_response:
            return False
        if not _has_schema_value(structured_response.get(name), field.get("type")):
            return False
    return True


def _completed_child_task_structured_response(
    context: List[Dict[str, Any]],
    response_schema: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Return a completed child task's structured output when it covers the schema.

    This is deliberately narrow: only finished child task completion messages
    from tools that already ran their own verifier qualify. The parent verifier
    can then accept grounded structured output instead of retrying work it
    already delegated successfully.
    """
    if not context or not response_schema:
        return None

    for message in reversed(context):
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict):
            continue
        tool_name = metadata.get("toolName")
        if tool_name not in {"spawn_claude_code_agent", "spawn_browser_agent"}:
            continue
        if metadata.get("toolStatus") != "FINISHED":
            continue
        if tool_name == "spawn_claude_code_agent" and metadata.get("action_type") != "task_complete":
            continue
        if tool_name == "spawn_claude_code_agent" and metadata.get("success") is not True:
            continue
        structured_response = metadata.get("structured_response")
        if isinstance(structured_response, dict) and isinstance(structured_response.get("output"), dict):
            structured_response = structured_response["output"]
        if _structured_response_satisfies_schema(structured_response, response_schema):
            return structured_response

    return None


def _build_verifier_response_model(
    response_schema: Optional[Dict[str, Any]] = None,
) -> Type[BaseModel]:
    """Build the verifier's Pydantic contract for RoseClient.complete."""
    fields: Dict[str, Any] = {}
    openai_strict = True

    if response_schema and response_schema.get("fields"):
        output_fields: Dict[str, Any] = {}
        for field in response_schema["fields"]:
            if field.get("type") in ("object", "list[object]") and not _nested_fields_for_object_field(field):
                openai_strict = False
            annotation = _verifier_field_annotation_for_field(field)
            output_fields[field["name"]] = (
                annotation,
                Field(..., description=field.get("description", "")),
            )
        output_model = create_model("VerifierOutput", **output_fields)
        fields["output"] = (output_model, ...)

    fields["reasoning"] = (
        str,
        Field(
            ...,
            description=(
                "Detailed walk-through anchored in tool messages. When score < 1.0, "
                "name the missing fields or missing goal evidence."
            ),
        ),
    )
    fields["score"] = (
        float,
        Field(..., description="Final numeric commitment from 0.0 to 1.0."),
    )

    name = "ProgressScoreWithOutput" if response_schema else "ProgressScore"
    model = create_model(name, **fields)
    setattr(model, "rose_openai_strict", openai_strict)
    return model


def _verifier_field_annotation_for_field(field: Dict[str, Any]) -> Any:
    field_type = field.get("type")
    nested_fields = _nested_fields_for_object_field(field)
    if field_type == "object" and nested_fields:
        return _build_nested_verifier_model(field.get("name") or "object", nested_fields)
    if field_type == "list[object]" and nested_fields:
        return List[_build_nested_verifier_model(field.get("name") or "item", nested_fields)]
    return _verifier_field_annotation(field_type)


def _build_nested_verifier_model(name: str, nested_fields: List[Dict[str, Any]]) -> Type[BaseModel]:
    safe_name = re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_") or "Object"
    model_fields: Dict[str, Any] = {}
    for nested in nested_fields:
        nested_name = nested.get("name")
        if not isinstance(nested_name, str) or not nested_name:
            continue
        model_fields[nested_name] = (
            _verifier_field_annotation(nested.get("type")),
            Field(..., description=nested.get("description", "")),
        )
    return create_model(f"Verifier{safe_name.title().replace('_', '')}", **model_fields)


def _json_schema_for_response_field(field: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
    """Return JSON Schema for one response field and whether it is open-shape."""
    field_type = field.get("type")

    if field_type == "str":
        return {"type": "string"}, False
    if field_type == "int":
        return {"type": "integer"}, False
    if field_type == "float":
        return {"type": "number"}, False
    if field_type == "bool":
        return {"type": "boolean"}, False
    if field_type == "list[str]":
        return {"type": "array", "items": {"type": "string"}}, False
    if field_type == "list[int]":
        return {"type": "array", "items": {"type": "integer"}}, False
    if field_type in ("object", "list[object]"):
        nested_fields = _nested_fields_for_object_field(field)
        if nested_fields:
            nested_properties: Dict[str, Any] = {}
            nested_required: List[str] = []
            nested_open = False
            for nested in nested_fields:
                nested_name = nested.get("name")
                if not isinstance(nested_name, str) or not nested_name:
                    continue
                nested_schema, is_open = _json_schema_for_response_field(nested)
                nested_properties[nested_name] = nested_schema
                nested_required.append(nested_name)
                nested_open = nested_open or is_open
            object_schema = {
                "type": "object",
                "properties": nested_properties,
                "required": nested_required,
                "additionalProperties": False,
            }
            if field_type == "object":
                return object_schema, nested_open
            return {"type": "array", "items": object_schema}, nested_open

        # Legacy stored schemas may predate explicit object properties. New
        # schemas are validated at generation/API boundaries, but old rows
        # should still run without inventing nested requirements from prose.
        open_schema = {
            "type": "object",
            "additionalProperties": True,
        }
        if field.get("description"):
            open_schema["description"] = field["description"]
        if field_type == "object":
            return open_schema, True
        array_schema = {"type": "array", "items": open_schema}
        if field.get("description"):
            array_schema["description"] = field["description"]
        return array_schema, True
    if field_type == "file_pointer":
        file_pointer_schema = {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "File UUID. MUST copy exactly from Structured Response.",
                },
                "storage_path": {
                    "type": "string",
                    "description": "Supabase storage path. MUST copy exactly from Structured Response.",
                },
                "original_filename": {
                    "type": "string",
                    "description": "Original filename.",
                },
                "mime_type": {
                    "type": "string",
                    "description": "MIME type (e.g., image/jpeg).",
                },
                "size_bytes": {
                    "type": "integer",
                    "description": "File size in bytes.",
                },
                "created_at": {
                    "type": "string",
                    "description": "ISO timestamp.",
                },
            },
            "required": ["id", "storage_path", "original_filename", "mime_type", "size_bytes", "created_at"],
            "additionalProperties": False,
        }
        return file_pointer_schema, False
    if field_type == "list[file_pointer]":
        item_schema, _ = _json_schema_for_response_field({"type": "file_pointer"})
        return {"type": "array", "items": item_schema}, False
    if field_type == "session_file_pointer":
        session_file_pointer_schema = {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "ABSOLUTE file path starting with /.",
                }
            },
            "required": ["path"],
            "additionalProperties": False,
        }
        return session_file_pointer_schema, False
    if field_type == "list[session_file_pointer]":
        item_schema, _ = _json_schema_for_response_field({"type": "session_file_pointer"})
        return {"type": "array", "items": item_schema}, False
    return {"type": "string"}, False


def _verifier_field_annotation(field_type: Optional[str]) -> Any:
    if field_type == "str":
        return str
    if field_type == "int":
        return int
    if field_type == "float":
        return float
    if field_type == "bool":
        return bool
    if field_type == "list[str]":
        return List[str]
    if field_type == "list[int]":
        return List[int]
    if field_type == "object":
        return Dict[str, Any]
    if field_type == "list[object]":
        return List[Dict[str, Any]]
    if field_type == "file_pointer":
        return FilePointer
    if field_type == "list[file_pointer]":
        return List[FilePointer]
    if field_type == "session_file_pointer":
        return VerifierSessionFilePointer
    if field_type == "list[session_file_pointer]":
        return List[VerifierSessionFilePointer]
    return str


def _build_verifier_json_schema(response_schema: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Build a JSON schema for the verifier response.

    Field order is load-bearing — structured-output models populate fields in the
    order they appear in the schema. We force commitment in this sequence:

      With response_schema:
        1. ``output``     — extract the schema fields from tool results FIRST.
        2. ``reasoning``  — detailed feedback to the agent, anchored in tool evidence.
        3. ``score``      — final numeric commitment (0.0–1.0).

      Without response_schema:
        1. ``reasoning`` — analysis of whether the goal is accomplished.
        2. ``score``     — final numeric commitment (0.0–1.0).

    The rubric: score = 1.0 iff every field in ``output`` can be accurately
    populated from real, extracted tool-result evidence. Without a response
    schema, score = 1.0 iff the goal is accomplished by visible tool results.

    Args:
        response_schema: Optional response schema with fields definition

    Returns:
        JSON schema dict for use with OpenAI structured outputs
    """
    # Build properties in the canonical commitment order.
    properties: Dict[str, Any] = {}
    required: List[str] = []

    # When the schema contains an open-object field ("object" / "list[object]"),
    # we MUST relax the OpenAI strict-mode flag — strict mode forbids
    # `additionalProperties: true` (open shapes). Anthropic + claudeAuth paths
    # accept open shapes regardless. Tracked here so the JSON-schema envelope
    # at the bottom can flip `strict` accordingly.
    has_open_object = False

    # If response_schema provided, the verifier extracts schema fields FIRST.
    if response_schema and response_schema.get("fields"):
        output_properties = {}
        output_required = []

        for field in response_schema["fields"]:
            field_name = field["name"]
            json_type, is_open = _json_schema_for_response_field(field)
            has_open_object = has_open_object or is_open

            output_properties[field_name] = json_type

            # All fields are required in the output for strict mode
            output_required.append(field_name)

        properties["output"] = {
            "type": "object",
            "properties": output_properties,
            "required": output_required,
            "additionalProperties": False,
        }
        required.append("output")

    # Reasoning before score — text first, numeric commit last so the score is
    # the conclusion of the analysis rather than its anchor.
    properties["reasoning"] = {
        "type": "string",
        "description": (
            "Detailed walk-through anchored in tool messages. When score < 1.0, "
            "this is shown to the agent as feedback — name the missing fields "
            "(or missing goal evidence) and what would unblock them."
        ),
    }
    required.append("reasoning")

    properties["score"] = {
        "type": "number",
        "description": "Final numeric commitment from 0.0 to 1.0.",
    }
    required.append("score")

    return {
        "type": "json_schema",
        "json_schema": {
            "name": "ProgressScoreWithOutput" if response_schema else "ProgressScore",
            "schema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
            # OpenAI strict mode forbids `additionalProperties: true`. When the
            # schema contains an open-object field (`object` / `list[object]`),
            # we drop strict so the open shape is accepted. Anthropic +
            # claudeAuth paths are unaffected (they always accept open shapes).
            "strict": not has_open_object,
        },
    }


# The verifier always uses Rose Ultra. Every code path — main loop, post-DAG,
# browser, claude_code — routes through the check_progress activity below, so
# this constant is the single source of truth for the verifier model.
VERIFIER_MODEL = "rose-labs/rose-1-ultra"
VERIFIER_MAX_TOKENS = 16000
# A verifier is advisory and must never outlive the agent benchmark/activity
# that requested it. Keep each provider attempt short enough to fall through,
# while also fencing the entire retry loop so six individually bounded attempts
# cannot accumulate into a multi-minute zombie.
VERIFIER_ATTEMPT_DEADLINE_S = 75.0
VERIFIER_TTFT_TIMEOUT_S = 45.0
VERIFIER_IDLE_TIMEOUT_S = 45.0
VERIFIER_TOTAL_TIMEOUT_S = 180.0


@activity.defn
@traced("check_progress")
async def check_progress(
    context: List[Dict[str, Any]],
    verifier_system_prompt: str,
    model: str = VERIFIER_MODEL,  # IGNORED — verifier always forces rose-1-ultra. Kept for backward compat.
    response_schema: Optional[Dict[str, Any]] = None,
    claude_token: Optional[str] = None,
    call_site: str = "verifier",
    agent_id: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    compute_token_lineage_key: Optional[str] = None,
    compute_token_fast_cache_affinity_key: Optional[str] = None,
    dump_extra: Optional[Dict[str, Any]] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_step: int = 0,
) -> Dict[str, Any]:
    """
    Use LLM judge to check progress toward goal. Canonical entry point — all
    verifier paths (main loop, post-DAG, browser, claude_code) MUST call this
    activity rather than `_call_llm_verifier` directly.

    Verifier model is **mandatory** — the ``model`` arg is accepted for
    backward compatibility with positional callers but always overridden to
    ``rose-labs/rose-1-ultra``. ``claude_token`` is passed through verbatim
    (the workflow owns rotation; rotation is not done here).

    Context scoping: the verifier judges only the calling agent's own visible
    context. For main-loop execute and post-DAG verification, PLAN/RESEARCH
    messages are also removed before judging final task completion.

    - Main loop / post-DAG / sub-agent verifier: callers pass a context that
      has already removed spawned-agent work rows tagged with
      ``metadata.subAgentId`` and fanout tree rows tagged with plural
      ``metadata.subAgentIds`` plus suffixed child toolCallIds. The parent sees
      the aggregate for_each result under the original toolCallId instead.
    - Browser sub-agent verifier: ``verifier_context`` is built locally from
      the browser session's action history, DOM, and final-state screenshot —
      nothing from the parent reaches it.
    - Claude-code sub-agent verifier: ``verifier_context`` is built locally
      from the sandbox terminal output and the run's action summary —
      nothing from the parent reaches it.
    - Explore sub-agent: runs with ``skip_verification=True`` — no verifier
      executes at all.

    Do NOT add a broad "drop messages whose agent_id != this agent" filter here
    — that would mask a real leak rather than fix it. If a leak shows up, fix
    the upstream call site so it builds an agent-scoped context, and add an
    invariant test instead.

    Args:
        context: Message history (first USER message is the goal). MUST be
            agent-scoped by the caller — see scoping notes above.
        verifier_system_prompt: Pre-built verifier system prompt
            (from ``utils.prompts.build_verifier_prompt``).
        model: IGNORED. Always forced to ``rose-labs/rose-1-ultra`` (B2).
        response_schema: Optional response schema for structured output
            extraction. Pass ``None`` (or omit) to score the goal without an
            output-extraction rubric — the prompt-builder is expected to
            simplify accordingly.
        claude_token: Optional Claude OAuth token for direct Anthropic calls.
        call_site: Cache-logging tag. Use the appropriate variant:
            ``verifier_plan``, ``verifier_execute``, ``verifier_post_dag``,
            ``verifier_browser``, ``verifier_claude_code``.
        agent_id: Optional agent ID for tracing.

    Returns:
        Dict with:
        - ``score`` (float 0.0-1.0)
        - ``reasoning`` (str)
        - ``message`` (str, formatted "{reasoning}\\n\\nScore: {score}")
        - ``usage`` (dict): contains ``prompt_tokens``, ``completion_tokens``,
            ``total_tokens``, ``actual_model``, ``pool_name``,
            ``cache_creation_input_tokens``, ``cache_read_input_tokens``,
            ``claude_token_error``. Callers (e.g. post-DAG verifier) can use
            these for token-cost tracking.
        - ``structured_response`` (dict | None): always returned as
            ``result["output"]`` regardless of score — callers decide what
            to do with partial output (C2).
    """
    # Fast Mode: set the cache context so the verifier's Rose call (via
    # _call_llm_verifier → cached_complete) records/replays by canonical request
    # fingerprint. Prompt/schema/message changes intentionally miss.
    write_through_enabled = write_through_enabled_for_user(claude_token_user_id or gpt_token_user_id)
    fast_cache_should_write = fast_mode_cache_enabled or write_through_enabled
    if fast_mode_goal and fast_cache_should_write:
        set_fast_cache_context(
            FastCacheContext(
                enabled=fast_mode_cache_enabled,
                goal=fast_mode_goal,
                base_step=fast_mode_step,
                write_enabled=fast_cache_should_write,
            )
        )

    # B2: Force verifier model and ignore the caller-passed model arg.
    forced_model = VERIFIER_MODEL
    if model != forced_model:
        logger.debug(
            "check_progress overriding caller model",
            requested_model=model,
            forced_model=forced_model,
        )

    # C7: Pass response_schema=None through unchanged when not provided. Do NOT
    # default to an empty {"fields": []} dict — the prompt-side simplification
    # (utils/prompts.py:build_verifier_prompt) decides how to handle missing
    # schema. _build_verifier_json_schema also branches on this directly.
    schema_for_call = response_schema if response_schema else None

    try:
        # DEBUG: Log what we received
        logger.info(
            "🔍 DEBUG: check_progress received",
            context_type=type(context).__name__,
            context_len=len(context) if context else 0,
            none_count=sum(1 for m in context if m is None) if context else 0,
        )
        if context:
            for i, m in enumerate(context):
                if m is None:
                    logger.error(f"❌ context[{i}] is None!")
                elif not isinstance(m, dict):
                    logger.error(f"❌ context[{i}] is {type(m).__name__}, not dict: {str(m)[:200]}")

        original_context_len = len(context) if context else 0
        if call_site in ("verifier_execute", "verifier_post_dag"):
            context = _filter_context_for_execute_verifier(context)
            if len(context) != original_context_len:
                logger.info(
                    "Filtered verifier context to execute phase",
                    call_site=call_site,
                    before=original_context_len,
                    after=len(context),
                )

        browser_success_context = call_site in (
            "verifier_execute",
            "verifier_post_dag",
        ) and _verifier_context_has_successful_browser_result(context)
        if browser_success_context and fast_mode_goal and fast_cache_should_write:
            set_fast_cache_context(
                FastCacheContext(
                    enabled=False,
                    goal=fast_mode_goal,
                    base_step=fast_mode_step,
                    write_enabled=True,
                )
            )
            logger.info(
                "Verifier fast-cache read disabled for browser-success context",
                call_site=call_site,
                fast_mode_step=fast_mode_step,
            )

        _safe_heartbeat("Checking progress with LLM judge")

        if call_site == "verifier_execute" and schema_for_call:
            completed_child_output = _completed_child_task_structured_response(context, schema_for_call)
            if completed_child_output is not None:
                field_names = _schema_field_names(schema_for_call)
                reasoning = (
                    "A completed child task returned a grounded structured response "
                    f"covering the required fields: {', '.join(field_names)}."
                )
                logger.info(
                    "Progress satisfied by completed child task structured response",
                    fields=field_names,
                    call_site=call_site,
                )
                return {
                    "score": 1.0,
                    "reasoning": reasoning,
                    "message": f"{reasoning}\n\nScore: 1.0",
                    "usage": {
                        "prompt_tokens": 0,
                        "completion_tokens": 0,
                        "total_tokens": 0,
                        "actual_model": "structured_response",
                        "pool_name": "completed_child_task",
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 0,
                        "claude_token_error": None,
                        "gpt_token_error": None,
                    },
                    "structured_response": completed_child_output,
                }

        config = load_config()
        system_prompt = verifier_system_prompt
        verifier_dump_extra = {
            **_extract_browser_recording_dump_extra(context),
            **(dump_extra or {}),
        }

        verifier_file_evidence = await _resolve_verifier_file_evidence(context)
        messages = build_verifier_context_messages(
            context,
            system_prompt,
            verifier_file_evidence_by_message=verifier_file_evidence,
        )

        # Resolve context pointers
        messages = await resolve_pointers_in_messages(messages, local_context=context)

        # Debug: Log context size to detect contamination
        logger.info(
            "Verifier context",
            total_messages=len(context),
            agent_messages=len([m for m in context if m.get("role") == "ASSISTANT"]),
            system_messages_excluded=len([m for m in context if m.get("role") == "SYSTEM"]),
            context_summary=[f"{m.get('role')}: {m.get('text', '')[:50]}..." for m in context[-5:]],  # Last 5 messages
        )

        # === RAW CONTEXT LOG: Full original context for debugging ===
        logger.debug(
            "📦 Verifier raw context (pre-conversion)",
            raw_context_json=json.dumps(context, ensure_ascii=False, default=str),
        )

        # Use dedicated verifier LLM call (simple, no streaming UI)
        # Pass response_schema so the verifier includes output extraction in same call
        # Retry with exponential backoff + jitter on transient failures (e.g. malformed JSON from streaming)
        max_retries = 5
        base_delay = 0.2  # 0.2s -> 0.4s -> 0.8s -> 1.6s -> 3.2s
        last_error = None
        verifier_deadline = asyncio.get_running_loop().time() + VERIFIER_TOTAL_TIMEOUT_S
        for attempt in range(max_retries + 1):
            try:
                remaining_s = verifier_deadline - asyncio.get_running_loop().time()
                if remaining_s <= 0:
                    raise TimeoutError(f"Verifier exceeded {VERIFIER_TOTAL_TIMEOUT_S:.0f}s total deadline")
                result, usage = await asyncio.wait_for(
                    _call_llm_verifier(
                        messages,
                        forced_model,
                        config,
                        schema_for_call,
                        claude_token=claude_token,
                        claude_token_source=claude_token_source,
                        claude_token_pool_id=claude_token_pool_id,
                        claude_token_user_id=claude_token_user_id,
                        gpt_token=gpt_token,
                        gpt_account_id=gpt_account_id,
                        gpt_token_source=gpt_token_source,
                        gpt_token_pool_id=gpt_token_pool_id,
                        gpt_token_user_id=gpt_token_user_id,
                        compute_token_lineage_key=compute_token_lineage_key,
                        compute_token_fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
                        call_site=call_site,
                        agent_id=agent_id,
                        dump_extra=verifier_dump_extra or None,
                    ),
                    timeout=remaining_s,
                )
                break
            except Exception as e:
                last_error = e
                if attempt < max_retries:
                    if fast_mode_goal and fast_cache_should_write:
                        set_fast_cache_context(
                            FastCacheContext(
                                enabled=False,
                                goal=fast_mode_goal,
                                base_step=fast_mode_step,
                                write_enabled=True,
                            )
                        )
                    delay = base_delay * (2**attempt)
                    jitter = random.uniform(0, delay * 0.5)
                    sleep_s = delay + jitter
                    remaining_s = verifier_deadline - asyncio.get_running_loop().time()
                    if remaining_s <= sleep_s:
                        raise TimeoutError(f"Verifier exceeded {VERIFIER_TOTAL_TIMEOUT_S:.0f}s total deadline") from e
                    logger.warning(
                        "Verifier call failed, retrying",
                        attempt=attempt + 1,
                        max_retries=max_retries,
                        delay=round(sleep_s, 3),
                        fast_cache_read_enabled=False if fast_mode_goal and fast_cache_should_write else None,
                        error=extract_error_message(e),
                    )
                    await asyncio.sleep(sleep_s)
                else:
                    raise last_error

        score = result["score"]
        # C3: score_reasoning is gone. Read only `reasoning` now.
        reasoning = result.get("reasoning", "")

        logger.info(
            "Progress checked",
            progress=score,
            reasoning=reasoning,
            tokens=usage.get("total_tokens", 0),
            actual_model=usage.get("actual_model"),
            pool_name=usage.get("pool_name"),
            has_output="output" in result,
        )

        # C2: Always return whatever `output` the verifier produced — let
        # downstream callers decide what to do with partial output. Even at
        # score < 1.0 the partial extraction is useful for the agent's next
        # iteration (it sees what fields are already grounded).
        structured_response = result.get("output")

        return {
            "score": score,
            "reasoning": reasoning,
            "message": f"{reasoning}\n\nScore: {score}",
            "usage": usage,
            "structured_response": structured_response,
        }
    except Exception as e:
        error_message = extract_error_message(e)
        logger.error("Failed to check progress", error=error_message)
        # Return 0.5 on error to keep agent running, with empty usage
        error_message = f"Progress check failed: {error_message}"
        return {
            "score": 0.5,
            "reasoning": error_message,
            "message": f"{error_message}\n\nScore: 0.5",
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "actual_model": None,
                "pool_name": None,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
                "claude_token_error": None,
                "gpt_token_error": None,
            },
            "structured_response": None,
        }


@activity.defn
@traced("call_llm_activity")
async def call_llm_activity(
    messages_or_agent_id: Any,
    model: str,
    tool_names: List[str],
    reasoning_max_tokens: int = 256,
    agent_id: Optional[str] = None,
    stream_id: Optional[str] = None,
    task_id: Optional[str] = None,
    claude_token: Optional[str] = None,
    call_site: str = "unknown",
    system_prompt: Optional[str] = None,
    extra_user_message: Optional[str] = None,
    required_tool: Optional[str] = None,
    skip_cache_write: bool = False,
    llm_only_user_preamble: str = "",
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    compute_token_lineage_key: Optional[str] = None,
    compute_token_fast_cache_affinity_key: Optional[str] = None,
    user_id: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_step: Optional[int] = None,
    force_backend_context: bool = False,
    cache_before_extra_user_message: bool = False,
    cache_sequence_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Activity wrapper for LLM calls with structured output and streaming.

    Used by run_agent when called from workflow context (not inside activity).
    Provides proper Temporal activity retries, heartbeating, and streaming to Supabase Realtime.

    Args:
        messages_or_agent_id: Either pre-built messages list OR an agent_id string.
            When agent_id string: reads context from _pending_llm_context shared state,
            builds messages inside the activity (so file downloads work and base64
            content never crosses the Temporal 2MB payload boundary).
            On a cross-machine miss, or when force_backend_context is set, fetches
            context from the backend API.
        model: Model to use
        tool_names: List of tool names for dynamic AgentAction model
        reasoning_max_tokens: Max reasoning tokens (0 disables)
        agent_id: Agent ID for streaming (optional)
        stream_id: Stream session ID for ordering (optional)
        task_id: Sub-agent task ID for routing to browser panel (optional)
        system_prompt: System prompt for cross-machine fallback. When the activity
            runs on a different worker, _pending_llm_context is empty; the activity
            fetches messages from the backend API and uses this prompt.
        extra_user_message: Optional user message appended after building messages.
            Used for param population — prompts the LLM to call a specific tool
            without changing system prompt/tools (preserves cache prefix).
        required_tool: If set, validates the LLM called this tool. Raises ValueError
            if the tool is not in the response.
        skip_cache_write: If True, skips the automatic trailing message cache
            breakpoint. Explicit prefix markers are preserved.
        force_backend_context: If True, bypasses process-global pending context
            and fetches the canonical agent messages from the backend.
        cache_before_extra_user_message: Mark the latest stable conversation
            block before appending extra_user_message. This lets productive
            param calls create/read one shared prefix without caching the unique
            task instruction.

    Returns:
        Dict with:
        - response: Assistant response text
        - tool_calls: List of tool call dicts
        - usage: Token usage dict
    """
    # Fast Mode: set the per-activity cache context so the Rose wrapper (deep
    # inside call_llm_structured_streaming) records/replays. Each Temporal activity
    # runs as its own asyncio task, so this contextvar is naturally scoped to it.
    # Keys are canonical request fingerprints, so prompt/schema/message changes miss.
    write_through_enabled = write_through_enabled_for_user(user_id)
    if fast_mode_goal and (fast_mode_cache_enabled or write_through_enabled):
        set_fast_cache_context(
            FastCacheContext(
                enabled=fast_mode_cache_enabled,
                goal=fast_mode_goal,
                base_step=fast_mode_step,
                write_enabled=fast_mode_cache_enabled or write_through_enabled,
            )
        )
    elif fast_mode_step is not None:
        await ensure_fast_cache_position_context(agent_id, fast_mode_step)

    try:
        _safe_heartbeat("Calling LLM for structured output")

        # Resolve messages: either pre-built or build from shared context
        _context_key = None
        if isinstance(messages_or_agent_id, str):
            _context_key = messages_or_agent_id
            pending = None if force_backend_context else _pending_llm_context.get(_context_key)
            if pending is None and not force_backend_context:
                await asyncio.sleep(0.5)
                pending = _pending_llm_context.get(_context_key)
            if pending is not None:
                if len(pending) >= 4:
                    context, _sys_prompt, pre_resolved_ids, pending_user_id = pending
                else:
                    context, _sys_prompt, pre_resolved_ids = pending
                    pending_user_id = user_id
                messages = await build_llm_messages(
                    context,
                    _sys_prompt,
                    pre_resolved_ids=pre_resolved_ids,
                    llm_only_user_preamble=llm_only_user_preamble,
                    user_id=pending_user_id or user_id,
                )
            elif system_prompt:
                # Cross-machine fallback: activity landed on a different worker.
                # Fetch messages from backend; files download live via activity.in_activity().
                from helpers.fetch_config import _fetch_agent_data_impl

                logger.info(
                    "Backend LLM context fetch",
                    agent_id=_context_key,
                    forced=force_backend_context,
                )
                data = await _fetch_agent_data_impl(_context_key)
                context = data.get("messages", [])
                messages = await build_llm_messages(
                    context,
                    system_prompt,
                    pre_resolved_ids=None,
                    llm_only_user_preamble=llm_only_user_preamble,
                    user_id=user_id,
                )
                if not force_backend_context:
                    _pending_llm_context[_context_key] = (context, system_prompt, None, user_id)
            else:
                raise ValueError(f"No pending LLM context for agent {_context_key} and no system_prompt provided")
        else:
            # Legacy: pre-built messages list passed directly
            messages = messages_or_agent_id
            if llm_only_user_preamble:
                messages = inject_llm_only_user_preamble(messages, llm_only_user_preamble)

        if cache_before_extra_user_message and extra_user_message:
            _add_cache_breakpoint_before_extra_user_message(messages)

        if extra_user_message:
            messages.append({"role": "user", "content": extra_user_message})

        # Create dynamic action model
        AgentActionModel = create_agent_action_model(tool_names)

        # Direct-token mode is detected from actual_model in stream response, not from input token presence.
        _is_claude = [False]  # Mutable list so closures can update it
        _is_gpt = [False]

        def on_model_detected(actual_model: str):
            # "-claude" suffix = user's own Claude token ($0, skipped the waterfall)
            # e.g. "claude-sonnet-4-6-claude", "claude-opus-4-7-claude"
            is_user_claude = actual_model.endswith("-claude")
            is_user_gpt = actual_model.endswith("-gpt")
            _is_claude[0] = is_user_claude
            _is_gpt[0] = is_user_gpt
            logger.info(
                "🎨 Direct-token detection",
                actual_model=actual_model,
                is_claude=is_user_claude,
                is_gpt=is_user_gpt,
            )

        # Streaming callback - posts directly to Supabase Realtime
        sequence = [0]
        last_text = [""]
        llm_started_at_ms = int(time.time() * 1000)
        if agent_id and stream_id:
            await stream_assistant_chunk(
                agent_id=agent_id,
                stream_id=stream_id,
                delta="",
                done=False,
                sequence=sequence[0],
                sub_agent_id=task_id,
                is_claude=_is_claude[0],
                is_gpt=_is_gpt[0],
                llm_started_at_ms=llm_started_at_ms,
            )
            sequence[0] += 1

        # Decouple Supabase broadcasting from the token-read loop. Awaiting a
        # broadcast per chunk inline (the old behavior here) blocked token reading
        # under high sub-agent fan-out — per-turn LLM time spiked to ~190s at
        # 50-wide because round_trip includes the inline broadcast wait. The
        # broadcaster accepts deltas non-blocking and flushes them coalesced in
        # the background. is_claude/is_gpt are passed as refs since they're only
        # detected mid-stream (on_model_detected).
        broadcaster = (
            CoalescingStreamBroadcaster(
                agent_id=agent_id,
                stream_id=stream_id,
                sub_agent_id=task_id,
                llm_started_at_ms=llm_started_at_ms,
                is_claude=lambda: _is_claude[0],
                is_gpt=lambda: _is_gpt[0],
            )
            if agent_id and stream_id
            else None
        )

        async def on_chunk(text_so_far: str, tokens: int):
            _safe_heartbeat(f"LLM streaming... {len(text_so_far)} chars")
            if broadcaster is not None:
                delta = text_so_far[len(last_text[0]) :]
                if delta:
                    broadcaster.update(delta, sequence[0])  # non-blocking
                    sequence[0] += 1
                last_text[0] = text_so_far

        # Callback for early tool detection IN_PROGRESS messages
        latest_raw_chars = [0]
        current_streaming_tool: List[Optional[str]] = [None, None]  # [tool_name, tool_call_id]
        last_tool_progress_chars = [0]

        async def on_tool_detected_callback(tool_name: str, tool_call_id: str):
            current_streaming_tool[0] = tool_name
            current_streaming_tool[1] = tool_call_id
            last_tool_progress_chars[0] = latest_raw_chars[0]
            if agent_id and stream_id:
                await stream_tool_event(
                    agent_id=agent_id,
                    stream_id=stream_id,
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    title=f"Starting {tool_name}...",
                    char_count=latest_raw_chars[0],
                    is_claude=_is_claude[0],
                    is_gpt=_is_gpt[0],
                    llm_started_at_ms=llm_started_at_ms,
                )

        async def on_raw_progress(total_chars: int):
            latest_raw_chars[0] = total_chars
            tool_name, tool_call_id = current_streaming_tool
            if not (agent_id and stream_id and tool_name and tool_call_id):
                return
            if total_chars - last_tool_progress_chars[0] < 50:
                return
            last_tool_progress_chars[0] = total_chars
            await stream_tool_event(
                agent_id=agent_id,
                stream_id=stream_id,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                title=f"Starting {tool_name}...",
                char_count=total_chars,
                is_claude=_is_claude[0],
                is_gpt=_is_gpt[0],
                llm_started_at_ms=llm_started_at_ms,
            )

        try:
            result, usage, detected_tools_ordered = await call_llm_structured_streaming(
                messages=messages,
                model=model,
                temperature=1.0,
                max_tokens=8192,
                response_model=AgentActionModel,
                on_chunk=on_chunk,
                reasoning_max_tokens=reasoning_max_tokens if reasoning_max_tokens > 0 else None,
                agent_id=agent_id,
                on_tool_detected=on_tool_detected_callback,
                on_raw_progress=on_raw_progress,
                claude_token=claude_token,
                claude_token_source=claude_token_source,
                claude_token_pool_id=claude_token_pool_id,
                claude_token_user_id=claude_token_user_id,
                gpt_token=gpt_token,
                gpt_account_id=gpt_account_id,
                gpt_token_source=gpt_token_source,
                gpt_token_pool_id=gpt_token_pool_id,
                gpt_token_user_id=gpt_token_user_id,
                compute_token_lineage_key=compute_token_lineage_key,
                compute_token_fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
                on_model_detected=on_model_detected,
                call_site=call_site,
                skip_cache_write=skip_cache_write,
                cache_sequence_id=cache_sequence_id,
                tool_choice={"name": required_tool} if required_tool else None,
            )
        finally:
            # Guarantee the background drainer never leaks if streaming raises.
            if broadcaster is not None:
                await broadcaster.adispose()

        # Send final done=True chunk via the broadcaster (flushes remainder + done).
        if broadcaster is not None:
            try:
                final_delta = ""
                if hasattr(result, "response") and result.response:
                    final_delta = result.response[len(last_text[0]) :]
                await broadcaster.aclose(final_delta=final_delta, final_sequence=sequence[0])
            except Exception as e:
                logger.warning(f"Final stream chunk failed (non-fatal): {e}")

        # Validate result
        if result is None:
            raise LLMStructuredOutputError(f"LLM returned None result (model={model})")

        if not hasattr(result, "response") or not hasattr(result, "tool_calls"):
            raise LLMStructuredOutputError(f"LLM result missing required fields (model={model})")

        # Convert tool calls to dicts
        tool_calls_dict = []
        if result.tool_calls:
            for tc in result.tool_calls:
                if tc is not None:
                    tc_dict = tc.model_dump() if hasattr(tc, "model_dump") else tc.dict()
                    tool_calls_dict.append(tc_dict)

        if required_tool:
            got = [tc.get("tool") for tc in tool_calls_dict]
            if len(tool_calls_dict) != 1 or got[0] != required_tool:
                raise LLMStructuredOutputError(f"LLM must call exactly one tool, '{required_tool}'. Got: {got}")

        logger.info(
            "LLM activity completed",
            response_len=len(result.response) if result.response else 0,
            tool_calls=len(tool_calls_dict),
            tokens=usage.get("total_tokens", 0),
        )

        # Clean up shared state on success
        if _context_key and not force_backend_context:
            _pending_llm_context.pop(_context_key, None)

        return {
            "response": result.response if result.response else "",
            "tool_calls": tool_calls_dict,
            "codex_reasoning_items": getattr(result, "codex_reasoning_items", []),
            "usage": usage,
            "detected_tools_ordered": detected_tools_ordered,  # [(tool_name, tool_call_id, timestamp), ...]
        }

    except Exception as e:
        # Do NOT clean up _pending_llm_context here — Temporal may retry the activity,
        # and the retry needs the shared state to still be present.
        # Cleanup happens on success (above) or when the workflow finishes/cancels.
        logger.error("LLM activity failed", error=extract_error_message(e))
        if isinstance(e, LLMStructuredOutputError):
            # A provider response that violates the requested schema is not an
            # infrastructure failure. The owning agent loop may choose to ask the
            # model again, but Temporal must not multiply that semantic retry.
            raise ApplicationError(
                str(e),
                type="LLMStructuredOutputError",
                non_retryable=True,
            ) from e
        raise


@activity.defn
@traced("set_response_schema_activity")
async def set_response_schema_activity(
    agent_id: str,
    user_messages: List[str],
    compute_auth: Optional[Dict[str, Any]] = None,
    fast_mode_cache_enabled: bool = False,
) -> Optional[Dict[str, Any]]:
    """
    Generate and save a structured response schema for an agent.

    Takes all user messages from the conversation context and squashes them
    into a single goal string for schema generation.

    Args:
        agent_id: Agent ID to generate schema for
        user_messages: List of user message texts from conversation context
        compute_auth: Optional selected compute token from the workflow cache

    Returns:
        The generated schema dict with 'fields' array, or None on failure
    """
    import time

    activity_start = time.perf_counter()

    config = load_config()
    backend_url = config.backend.api_url.rstrip("/")
    api_key = config.backend.api_key

    if not api_key:
        logger.error("BACKEND_API_KEY not configured - cannot generate response schema")
        return None

    # Squash all user messages into one goal string
    goal = "\n\n".join(user_messages) if user_messages else ""

    if not goal:
        logger.error("No user messages provided for schema generation", agent_id=agent_id)
        return None

    _safe_heartbeat("Generating response schema via Rose")
    logger.info(f"[TIMING] Starting response schema generation for agent {agent_id}")

    # Fast Mode: the schema is deterministic given the goal + schema prompt/settings,
    # so cache it and skip the (≈2s) generation LLM call on replay. We still persist
    # it to the agent row.
    _fc_key = None
    _fc_cached: Optional[Dict[str, Any]] = None
    write_through_enabled = False
    if compute_auth:
        write_through_enabled = write_through_enabled_for_user(
            compute_auth.get("user_id") or compute_auth.get("userId")
        )
    if not write_through_enabled and agent_id:
        from providers.fast_cache import client as _fc_client

        _, _, write_through_enabled, _ = await _fc_client.resolve_agent_fast_mode(agent_id)
    if goal and (fast_mode_cache_enabled or write_through_enabled):
        from providers.fast_cache import client as _fc_client
        from providers.fast_cache import normalize as _fc_norm

        _fc_key = _fc_norm.content_key(
            goal,
            "response_schema",
            {
                "pool": "rose-1-lite",
                "system": _RESPONSE_SCHEMA_SYSTEM_PROMPT,
                "user": f"Goal: {goal}",
                "response_model": "_GeneratedResponseSchema",
                "temperature": 0.3,
                "max_tokens": [2000, 4000],
            },
        )
        if fast_mode_cache_enabled:
            _fc_cached = await _fc_client.cache_get(_fc_key)

    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            # 1. Generate schema in-process (or replay from the Fast Mode cache) so the
            # stable agents-side Rose routing owns claudeAuth/gptAuth selection,
            # waterfall, and token rotation.
            generate_start = time.perf_counter()
            if _fc_cached is not None:
                schema = _fc_cached.get("schema", {})
                usage = _fc_cached.get("usage", {})
            else:
                schema, usage = await _generate_response_schema_with_rose(
                    goal,
                    agent_id=agent_id,
                    compute_auth=compute_auth,
                )
                if _fc_key is not None:
                    from providers.fast_cache import client as _fc_client
                    from providers.fast_cache import normalize as _fc_norm

                    await _fc_client.cache_set(
                        _fc_key, "llm", _fc_norm.goal_hash(goal), {"schema": schema, "usage": usage}
                    )
            generate_elapsed = time.perf_counter() - generate_start
            logger.info(
                f"[TIMING] Schema generation Rose call: {generate_elapsed * 1000:.1f}ms ({generate_elapsed:.2f}s)"
            )

            tokens_in = usage.get("prompt_tokens", 0)
            tokens_out = usage.get("completion_tokens", 0)

            logger.info(
                "Generated response schema",
                agent_id=agent_id,
                field_count=len(schema.get("fields", [])),
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            )

            # 2. Save schema to agent record
            save_start = time.perf_counter()
            try:
                save_response = await client.patch(
                    f"{backend_url}/api/agents/{agent_id}",
                    headers={
                        **backend_api_headers(api_key),
                        **workflow_generation_headers(),
                    },
                    json={"response_schema": schema},
                )
            except httpx.HTTPError as e:
                raise ResponseSchemaPersistenceError(
                    f"Failed to save response schema for agent {agent_id}: {extract_error_message(e)}"
                ) from e
            save_elapsed = time.perf_counter() - save_start
            logger.info(f"[TIMING] Schema save API call: {save_elapsed * 1000:.1f}ms")

            if not save_response.is_success:
                logger.warning(
                    "Failed to save response schema", agent_id=agent_id, status_code=save_response.status_code
                )
                raise ResponseSchemaPersistenceError(
                    f"Failed to save response schema for agent {agent_id}: HTTP {save_response.status_code}"
                )

            logger.info("Saved response schema to agent", agent_id=agent_id)

            activity_elapsed = time.perf_counter() - activity_start
            logger.info(
                f"[TIMING] Total response schema activity: {activity_elapsed * 1000:.1f}ms ({activity_elapsed:.2f}s)"
            )
            return {
                "schema": schema,
                "usage": {
                    "prompt_tokens": tokens_in,
                    "completion_tokens": tokens_out,
                    "total_tokens": usage.get("total_tokens", tokens_in + tokens_out),
                },
            }

    except httpx.HTTPStatusError as e:
        logger.error(
            "Backend API error saving response schema",
            agent_id=agent_id,
            status_code=e.response.status_code,
            response_text=e.response.text[:500],
        )
        return None
    except ResponseSchemaPersistenceError:
        raise
    except Exception as e:
        logger.error("Failed to generate response schema", agent_id=agent_id, error=extract_error_message(e))
        return None


async def fetch_claude_max_token(user_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetch Claude Max OAuth token for a user from the backend.

    Returns dict with {accessToken, source, poolTokenId} on success, None otherwise.
    - source: 'user' (personal token) or 'pool' (shared pool token)
    - poolTokenId: integration ID for pool tokens (used to mark rate-limited on failure)
    """
    config = load_config()

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{config.backend.api_url}/api/integrations/claude-code/credentials/token",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                },
                timeout=15.0,
            )
            if response.status_code == 200:
                data = response.json()
                token = data.get("accessToken")
                if token:
                    source = data.get("source", "user")
                    pool_token_id = data.get("poolTokenId")
                    logger.info(f"✅ Claude Max token fetched for user {user_id} (source={source})")
                    return {
                        "accessToken": token,
                        "source": source,
                        "poolTokenId": pool_token_id,
                    }
            elif response.status_code == 404:
                logger.info(f"Claude Max credentials not found for user {user_id}")
            else:
                logger.warning(f"Claude Max token fetch failed: {response.status_code}")
    except Exception as e:
        logger.warning(f"Failed to fetch Claude Max token: {e}")

    return None


@activity.defn
async def fetch_claude_max_token_activity(user_id: str) -> Optional[Dict[str, Any]]:
    """Temporal wrapper for fetching Claude Max OAuth credentials."""
    _safe_heartbeat("Fetching Claude Max token")
    return await fetch_claude_max_token(user_id)


@activity.defn
async def fetch_gpt_code_token_activity(user_id: str) -> Optional[Dict[str, Any]]:
    """Fetch a GPT/Codex OAuth token for a user from the backend."""
    config = load_config()
    _safe_heartbeat("Fetching GPT token")

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{config.backend.api_url}/api/integrations/gpt-code/credentials/token",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                },
                timeout=15.0,
            )
            if response.status_code == 200:
                data = response.json()
                token = data.get("accessToken")
                if token:
                    source = data.get("source", "user")
                    logger.info(f"✅ GPT token fetched for user {user_id} (source={source})")
                    return {
                        "accessToken": token,
                        "accountId": data.get("accountId"),
                        "source": source,
                        "poolTokenId": data.get("poolTokenId"),
                    }
            elif response.status_code == 404:
                logger.info(f"GPT credentials not found for user {user_id}")
            else:
                logger.warning(f"GPT token fetch failed: {response.status_code}")
    except Exception as e:
        logger.warning(f"Failed to fetch GPT token: {e}")

    return None


@activity.defn
async def fetch_compute_token_activity(
    user_id: str,
    lineage_key: Optional[str] = None,
    agent_id: Optional[str] = None,
    root_agent_id: Optional[str] = None,
    fast_cache_affinity_key: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Fetch one provider-typed compute token across Claude/GPT from the backend."""
    config = load_config()
    pinned_benchmark_type = benchmark_compute_token_type()
    _safe_heartbeat("Fetching compute token")

    try:
        async with httpx.AsyncClient() as client:
            params: Dict[str, str] = {}
            if lineage_key:
                params["lineageKey"] = lineage_key
            if agent_id:
                params["agentId"] = agent_id
            if root_agent_id:
                params["rootAgentId"] = root_agent_id
            if fast_cache_affinity_key:
                params["fastCacheAffinityKey"] = fast_cache_affinity_key
            if anthropic_family_excluded():
                params["tokenType"] = "gpt"
            elif pinned_benchmark_type:
                params["tokenType"] = pinned_benchmark_type
            response = await client.get(
                f"{config.backend.api_url}/api/integrations/compute-code/credentials/token",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                },
                params=params,
                timeout=15.0,
            )
            if response.status_code == 200:
                data = response.json()
                token = data.get("accessToken")
                provider_type = data.get("type")
                if token and provider_type in ("claude", "gpt"):
                    logger.info(
                        "✅ Compute token fetched",
                        user_id=user_id,
                        type=provider_type,
                        source=data.get("source", "user"),
                    )
                    return {
                        "type": provider_type,
                        "accessToken": token,
                        "accountId": data.get("accountId"),
                        "source": data.get("source", "user"),
                        "poolTokenId": data.get("poolTokenId"),
                        "lineageKey": data.get("lineageKey"),
                        "fastCacheAffinityKey": data.get("fastCacheAffinityKey") or fast_cache_affinity_key,
                    }
            elif response.status_code == 404:
                logger.info(f"Compute credentials not found for user {user_id}")
            else:
                logger.warning(f"Compute token fetch failed: {response.status_code}")
    except Exception as e:
        logger.warning(f"Failed to fetch compute token: {e}")

    return None


@activity.defn
async def heartbeat_compute_token_lineage_activity(lineage_key: str) -> bool:
    """Refresh a compute-token lineage lease. Best-effort; callers should not block on it."""
    if not lineage_key:
        return False
    config = load_config()
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/integrations/compute-code/token/lineage-heartbeat",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "Content-Type": "application/json",
                },
                json={"lineageKey": lineage_key},
                timeout=5.0,
            )
            return response.status_code == 200
    except Exception as e:
        logger.warning(f"Compute token lineage heartbeat failed: {e}")
        return False


@activity.defn
async def mark_claude_token_rate_limited_activity(
    source: str,
    user_id: str,
    pool_token_id: Optional[str] = None,
    cooldown_seconds: int = 5 * 60,
    rate_limited_until: Optional[str] = None,
    failure_reason: Optional[str] = None,
) -> bool:
    """
    Mark the current Claude token as rate-limited in the backend for a cooldown period.

    This is the CRITICAL step that makes token rotation work. Without it, the next
    fetch returns the same rate-limited token and we loop forever. After this call:
      - If source='user': next getClaudeCodeToken falls back to the shared pool.
      - If source='pool': fetchPoolToken excludes this token (LRU rotates to next).

    The cooldown is time-windowed (default 5 min); the token auto-heals once
    rateLimitedUntil passes. This is NOT a permanent disable.
    """
    config = load_config()
    effective_rate_limited_until = rate_limited_until or (
        datetime.now(timezone.utc) + timedelta(seconds=cooldown_seconds)
    ).isoformat().replace("+00:00", "Z")

    body: Dict[str, Any] = {
        "source": source,
        "rateLimitedUntil": effective_rate_limited_until,
    }
    if failure_reason:
        body["failureReason"] = failure_reason
    if source == "pool" and pool_token_id:
        body["poolTokenId"] = pool_token_id
    if source == "user":
        body["userId"] = user_id

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/integrations/claude-code/token/rate-limited",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=10.0,
            )
            if response.status_code == 200:
                logger.info(f"✅ Marked {source} Claude token rate-limited until {effective_rate_limited_until}")
                return True
            logger.warning(f"Failed to mark token rate-limited: {response.status_code} {response.text[:200]}")
    except Exception as e:
        logger.warning(f"Error marking token rate-limited: {e}")

    return False


@activity.defn
async def mark_compute_token_rate_limited_activity(
    token_type: str,
    source: str,
    user_id: str,
    pool_token_id: Optional[str] = None,
    cooldown_seconds: int = 5 * 60,
    rate_limited_until: Optional[str] = None,
    failure_reason: Optional[str] = None,
) -> bool:
    """Mark the selected provider-typed compute token rate-limited in backend."""
    config = load_config()
    effective_rate_limited_until = rate_limited_until or (
        datetime.now(timezone.utc) + timedelta(seconds=cooldown_seconds)
    ).isoformat().replace("+00:00", "Z")

    body: Dict[str, Any] = {
        "type": token_type,
        "source": source,
        "rateLimitedUntil": effective_rate_limited_until,
    }
    if failure_reason:
        body["failureReason"] = failure_reason
    if source == "pool" and pool_token_id:
        body["poolTokenId"] = pool_token_id
    if source == "user":
        body["userId"] = user_id

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/integrations/compute-code/token/rate-limited",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=10.0,
            )
            if response.status_code == 200:
                logger.info(
                    "✅ Marked compute token rate-limited",
                    type=token_type,
                    source=source,
                    rate_limited_until=effective_rate_limited_until,
                    failure_reason=failure_reason,
                )
                return True
            logger.warning(f"Failed to mark compute token rate-limited: {response.status_code} {response.text[:200]}")
    except Exception as e:
        logger.warning(f"Error marking compute token rate-limited: {e}")

    return False


@activity.defn
async def mark_gpt_token_rate_limited_activity(
    source: str,
    user_id: str,
    pool_token_id: Optional[str] = None,
    cooldown_seconds: int = 5 * 60,
    rate_limited_until: Optional[str] = None,
    failure_reason: Optional[str] = None,
) -> bool:
    """Mark the current GPT token as rate-limited in the backend."""
    config = load_config()
    effective_rate_limited_until = rate_limited_until or (
        datetime.now(timezone.utc) + timedelta(seconds=cooldown_seconds)
    ).isoformat().replace("+00:00", "Z")

    body: Dict[str, Any] = {
        "source": source,
        "rateLimitedUntil": effective_rate_limited_until,
    }
    if failure_reason:
        body["failureReason"] = failure_reason
    if source == "pool" and pool_token_id:
        body["poolTokenId"] = pool_token_id
    if source == "user":
        body["userId"] = user_id

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{config.backend.api_url}/api/integrations/gpt-code/token/rate-limited",
                headers={
                    "X-API-Key": config.backend.api_key or "",
                    "X-User-Id": user_id,
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=10.0,
            )
            if response.status_code == 200:
                logger.info(f"✅ Marked {source} GPT token rate-limited until {effective_rate_limited_until}")
                return True
            logger.warning(f"Failed to mark GPT token rate-limited: {response.status_code} {response.text[:200]}")
    except Exception as e:
        logger.warning(f"Error marking GPT token rate-limited: {e}")

    return False


@activity.defn
@traced("call_planner_llm_activity")
async def call_planner_llm_activity(
    messages: List[Dict[str, Any]],
    model: str,
    tools_description: str,
    user_context: str,
    response_schema: Optional[Dict[str, Any]] = None,
    claude_max_token: Optional[str] = None,
    agent_id: Optional[str] = None,
    tool_call_id: Optional[str] = None,
    claude_token_source: Optional[str] = None,
    claude_token_pool_id: Optional[str] = None,
    claude_token_user_id: Optional[str] = None,
    gpt_token: Optional[str] = None,
    gpt_account_id: Optional[str] = None,
    gpt_token_source: Optional[str] = None,
    gpt_token_pool_id: Optional[str] = None,
    gpt_token_user_id: Optional[str] = None,
    compute_token_lineage_key: Optional[str] = None,
    compute_token_fast_cache_affinity_key: Optional[str] = None,
    fast_mode_cache_enabled: bool = False,
    fast_mode_goal: Optional[str] = None,
    fast_mode_step: int = 0,
) -> Dict[str, Any]:
    """
    Temporal activity for calling the dedicated planner LLM.

    The planner receives conversation context and generates an execution plan
    with tasks and dependencies. Streams char count to frontend via PLAN_STREAM.

    When claude_max_token is provided, it's passed to the Rose completions endpoint
    which calls Anthropic directly ($0 cost via user's Claude subscription).
    If that fails, the endpoint falls through to the waterfall automatically.

    Args:
        messages: Conversation history (user/assistant messages)
        model: LLM model to use
        tools_description: Description of tools available in execute phase
        user_context: User context for personalization
        response_schema: Optional structured output schema the agent should return
        claude_max_token: Optional Claude OAuth token for direct Anthropic calls via Rose endpoint
        agent_id: Agent ID for streaming plan progress to frontend
        tool_call_id: Tool call ID for linking streaming to final plan

    Returns:
        Dict from PlannerResponse.model_dump() with title, tasks, and join
    """
    import time

    from utils.prompts import build_planner_system_prompt
    from utils.tool_schemas import PlannerResponse

    activity_start = time.perf_counter()
    _safe_heartbeat("Calling planner LLM")

    # Fast Mode: set the cache context so the planner's Rose call (via
    # call_llm_structured_streaming → cached_complete) records/replays by canonical
    # request fingerprint. call_site "planner" keeps it distinct.
    write_through_enabled = write_through_enabled_for_user(claude_token_user_id or gpt_token_user_id)
    if fast_mode_goal and (fast_mode_cache_enabled or write_through_enabled):
        set_fast_cache_context(
            FastCacheContext(
                enabled=fast_mode_cache_enabled,
                goal=fast_mode_goal,
                base_step=fast_mode_step,
                write_enabled=fast_mode_cache_enabled or write_through_enabled,
            )
        )

    # Build system prompt for planner
    prompt_start = time.perf_counter()
    system_prompt = build_planner_system_prompt(tools_description, user_context, response_schema=response_schema)
    prompt_elapsed = time.perf_counter() - prompt_start
    logger.info(f"[TIMING] Planner system prompt build: {prompt_elapsed * 1000:.1f}ms")

    # Prepend system message
    full_messages = [{"role": "system", "content": system_prompt}] + messages
    # Resolve context pointers
    full_messages = await resolve_pointers_in_messages(
        full_messages,
        user_id=claude_token_user_id or gpt_token_user_id,
    )

    total_chars = sum(len(m.get("content", "")) for m in full_messages)
    logger.info(f"[TIMING] Planner input: {len(full_messages)} messages, {total_chars} chars total")

    # Stream plan char count to frontend via PLAN_STREAM events
    # Use tool_call_id as stream_id so Temporal retries update the same chip (not create duplicates)
    plan_stream_id = tool_call_id or str(uuid.uuid4())
    last_broadcast_len = [0]

    async def on_plan_heartbeat(text: str, count: int):
        _safe_heartbeat(f"Planner thinking... {len(text)} chars")

    llm_started_at_ms = [None]

    async def on_plan_progress(total_bytes: int):
        """Called every 5 chunks with total accumulated bytes (reasoning + json)."""
        # Only broadcast when 50+ new bytes since last broadcast
        if agent_id and tool_call_id and total_bytes - last_broadcast_len[0] >= 50:
            last_broadcast_len[0] = total_bytes
            await stream_plan_event(
                agent_id=agent_id,
                stream_id=plan_stream_id,
                tool_call_id=tool_call_id,
                title="Generating Plan",
                char_count=total_bytes,
                llm_started_at_ms=llm_started_at_ms[0],
            )

    try:
        llm_start = time.perf_counter()
        llm_started_at_ms[0] = int(time.time() * 1000)
        if agent_id and tool_call_id:
            await stream_plan_event(
                agent_id=agent_id,
                stream_id=plan_stream_id,
                tool_call_id=tool_call_id,
                title="Generating Plan",
                char_count=0,
                llm_started_at_ms=llm_started_at_ms[0],
            )
        result, usage, _ = await call_llm_structured_streaming(
            messages=full_messages,
            model=model,
            temperature=0.2,
            max_tokens=16384,
            response_model=PlannerResponse,
            on_chunk=on_plan_heartbeat,
            on_raw_progress=on_plan_progress,
            agent_id=agent_id,
            claude_token=claude_max_token,
            claude_token_source=claude_token_source,
            claude_token_pool_id=claude_token_pool_id,
            claude_token_user_id=claude_token_user_id,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            gpt_token_user_id=gpt_token_user_id,
            compute_token_lineage_key=compute_token_lineage_key,
            compute_token_fast_cache_affinity_key=compute_token_fast_cache_affinity_key,
            skip_cache_write=False,
            call_site="planner",
            effort="max",
            deadline_s=220.0,
            ttft_timeout_s=120.0,
        )
        llm_elapsed = time.perf_counter() - llm_start
        activity_elapsed = time.perf_counter() - activity_start

        tokens_in = usage.get("prompt_tokens", 0)
        tokens_out = usage.get("completion_tokens", 0)
        logger.info(
            "Planner LLM completed",
            title=result.title,
            task_count=len(result.tasks),
            join=result.join,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )
        logger.info(
            f"[TIMING] Planner LLM API call: {llm_elapsed * 1000:.1f}ms ({llm_elapsed:.2f}s), total activity: {activity_elapsed * 1000:.1f}ms"
        )

        # Return plan with usage for cost tracking
        # Use actual_model from Rose response (may be "claude-opus-4-7-claude" for $0 pricing)
        actual_model = usage.get("actual_model", model)
        return {
            "result": result.model_dump(),
            "usage": {
                "llm": [
                    {
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "model": actual_model,
                        "provider": "Rose Planner",
                        # Propagate fast-cache replay + cache-token fields so the
                        # workflow cost aggregator zeroes a replayed planner call
                        # instead of billing the replayed output tokens.
                        "from_fast_cache": usage.get("from_fast_cache", False),
                        "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
                        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
                    }
                ],
                "service": [],
            },
        }

    except Exception as e:
        logger.error("Planner LLM failed", error=extract_error_message(e))
        raise
