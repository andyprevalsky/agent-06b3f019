"""
Base classes and data structures for standardized tool implementation.

All tools should inherit from ToolManager and emit ToolEvent objects.
"""

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Any, AsyncGenerator, Dict, List, Optional, TypedDict

from temporalio.exceptions import ActivityError, ApplicationError

__all__ = [
    "EventType",
    "MessageStatus",
    "UsageType",
    "UsageItem",
    "ToolEvent",
    "AssistantEvent",
    "ToolManager",
    "ToolSchema",
    "format_tool_message",
    "format_error_message",
    "format_time_elapsed",
    "extract_root_error",
]


# ========================================
# TYPED DICT FOR TOOL SCHEMA
# ========================================


class ToolSchema(TypedDict, total=False):
    """
    Schema for tool definitions passed to the LLM.

    Required fields:
        id: Unique tool identifier
        name: Tool name (matches ToolManager.tool_name)
        description: Description for LLM to understand when to use tool

    Optional fields:
        read_only: True if tool only reads data (no side effects)
    """

    id: str
    name: str
    description: str
    read_only: bool  # Optional - defaults to False


# ========================================
# ENUMS
# ========================================


class EventType(str, Enum):
    """Types of events that tools can emit."""

    POST_MESSAGE = "post_message"  # Post a message to UI and DB
    STREAM_MESSAGE = "stream_message"  # Stream chunks to Realtime (no DB write)
    USAGE = "usage"  # Track tool usage/cost
    # Deprecated - not used by any tools:
    ADD_TO_CONTEXT = "add_to_context"  # Add message to workflow context (no UI)
    WAIT_FOR_SIGNAL = "wait_for_signal"  # Wait for a workflow signal


class MessageStatus(str, Enum):
    """Status of a POST_MESSAGE event."""

    IN_PROGRESS = "IN_PROGRESS"  # Tool is currently executing
    FINISHED = "FINISHED"  # Tool completed successfully
    ERROR = "ERROR"  # Tool failed with an error


class UsageType(str, Enum):
    """Type of usage being tracked."""

    LLM = "llm"  # Token-based LLM usage (input/output tokens)
    SERVICE = "service"  # Non-token service usage (searches, API calls, etc.)


# ========================================
# DATA CLASSES
# ========================================


@dataclass
class UsageItem:
    """
    Standardized usage item for cost tracking.

    All costs are pre-calculated and stored in cents.
    Token counts are tracked separately for agent-level aggregation.

    Examples:
        - LLM usage: Perplexity input tokens at $2/million
        - Service usage: Perplexity searches at $5/1000
    """

    type: UsageType
    cost_cents: int  # Pre-calculated cost in cents (1 cent = $0.01)
    provider: str  # Human-readable: "Perplexity Input Tokens", "OpenAI Search Queries"

    # Token-based fields (only for type='llm')
    number_of_tokens: Optional[int] = None
    token_price_per_million_cents: Optional[int] = None  # Price in cents per million tokens
    tokens_in: Optional[int] = None  # Input/prompt tokens (for split tracking)
    tokens_out: Optional[int] = None  # Output/completion tokens (for split tracking)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for serialization."""
        return {
            "type": self.type.value,
            "cost_cents": self.cost_cents,
            "provider": self.provider,
            "number_of_tokens": self.number_of_tokens,
            "token_price_per_million_cents": self.token_price_per_million_cents,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
        }


@dataclass
class ToolEvent:
    """
    Event emitted by tool during execution.

    Tools are async generators that yield events to communicate with the workflow.
    All FE state changes flow through ToolEvents → handle_tool_event().
    """

    type: EventType

    # For POST_MESSAGE events
    title: Optional[str] = None
    message: Optional[str] = None
    status: Optional[MessageStatus] = None  # Status for POST_MESSAGE events

    # For STREAM_MESSAGE events (LLM streaming chunks)
    stream_id: Optional[str] = None
    delta: Optional[str] = None  # Incremental text chunk
    sequence: Optional[int] = None  # Ordering for chunks
    done: Optional[bool] = None  # True if final chunk
    sub_agent_id: Optional[str] = None  # For routing (browser agent)
    llm_started_at_ms: Optional[int] = None  # LLM request start epoch ms, before first token

    # For USAGE events - list of usage items
    tool_name: Optional[str] = None
    usage_items: Optional[List[UsageItem]] = None

    # For ADD_TO_CONTEXT events (deprecated - not used)
    role: Optional[str] = None  # "SYSTEM", "USER", "ASSISTANT", "TOOL"
    text: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

    # For WAIT_FOR_SIGNAL events (deprecated - not used)
    signal_key: Optional[str] = None

    # For structured data (e.g., plan artifacts)
    data: Optional[Dict[str, Any]] = None

    # For POST_MESSAGE events with file attachments (OAI-style)
    file_pointer: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for serialization."""
        result = {
            "type": self.type.value,
            "title": self.title,
            "message": self.message,
            "status": self.status.value if self.status else None,
            "tool_name": self.tool_name,
            "role": self.role,
            "text": self.text,
            "metadata": self.metadata,
            "signal_key": self.signal_key,
            "data": self.data,
            "file_pointer": self.file_pointer,
        }

        # Convert usage_items to dicts
        if self.usage_items:
            result["usage_items"] = [item.to_dict() for item in self.usage_items]
        else:
            result["usage_items"] = None

        return result


@dataclass
class AssistantEvent:
    """
    Event for posting ASSISTANT role messages (output files, responses).

    Separate from ToolEvent to maintain clean separation:
    - ToolEvent → TOOL messages (progress, status)
    - AssistantEvent → ASSISTANT messages (output files, agent responses)
    """

    message: str = ""
    file_pointer: Optional[Dict[str, Any]] = None


# ========================================
# BASE MANAGER CLASS
# ========================================

# ========================================
# HELPER FUNCTIONS
# ========================================


def format_time_elapsed(seconds: float) -> str:
    """Format seconds into human-readable duration (e.g., '29s', '3m 26s', '1hr 3m 28s')."""
    total_seconds = int(seconds)

    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60

    if hours > 0:
        return f"{hours}hr {minutes}m {secs}s"
    elif minutes > 0:
        return f"{minutes}m {secs}s"
    else:
        return f"{secs}s"


def format_params(params: Dict[str, Any]) -> str:
    """Format tool parameters for display in markdown. NO TRUNCATION."""
    if not params:
        return "None"

    lines = []
    for key, value in params.items():
        # Skip internal fields
        if key in ["tool", "tool_call_id"]:
            continue

        # Format value nicely - NO TRUNCATION
        if isinstance(value, dict):
            value_str = json.dumps(value, indent=2)
        elif isinstance(value, (list, tuple)):
            value_str = json.dumps(value, indent=2, default=str)
        else:
            value_str = str(value)

        lines.append(f"- **{key}**: {value_str}")

    return "\n".join(lines) if lines else "None"


def format_result(result: Dict[str, Any]) -> str:  # noqa: C901
    """Format tool result for display in markdown. NO TRUNCATION - show full results."""
    if not result:
        return "No result data"

    # Extract key fields
    lines = []

    # Common result fields - NO TRUNCATION
    if "answer" in result:
        lines.append(f"{result['answer']}")

    # web_fetch uses "content" instead of "answer"
    if "content" in result and "answer" not in result:
        lines.append(f"{result['content']}")

    # Handle Grep results. Keep match content visible so local-data searches are
    # auditable in transcripts and benchmark validators can inspect evidence.
    if "matches" in result and "total_matches" in result:
        matches = result.get("matches", [])
        lines.append(
            f"**Grep Matches:** {len(matches)} shown / {result.get('total_matches', 0)} total"
        )
        for i, match in enumerate(matches, 1):
            source = match.get("source", "unknown")
            path = match.get("path", "")
            role = match.get("role")
            location = match.get("location", {})
            lines.append(f"\n**{i}. source: {source} path: {path}**")
            if role:
                lines.append(f"role: {role}")
            if location:
                lines.append(f"location: {json.dumps(location, default=str)}")
            ownership = match.get("ownership")
            if isinstance(ownership, dict):
                safe_ownership = {key: ownership[key] for key in
                    ("owner_user_id", "owner_name", "provider", "account_id", "shared", "team_ids")
                    if key in ownership}
                lines.append(f"ownership: {json.dumps(safe_ownership, default=str)}")
            record_owners = [
                {key: record[key] for key in ("message_id", "owner_user_id", "account_id") if key in record}
                for record in match.get("records", []) if isinstance(record, dict)
            ]
            if record_owners:
                lines.append(f"record_ownership: {json.dumps(record_owners, default=str)}")
            content = match.get("content")
            if content:
                lines.append(str(content))

    if "candidates" in result:
        candidates = result["candidates"]
        if isinstance(candidates, list):
            lines.append(f"\n**Found {len(candidates)} candidates**")
            for i, candidate in enumerate(candidates, 1):
                name = candidate.get("name", "Unknown")
                lines.append(f"{i}. {name}")

    if "sources" in result:
        sources = result.get("sources", [])
        if sources:
            lines.append("\n**Sources:**")
            for src in sources:
                lines.append(f"- {src}")

    if "images" in result:
        images = result.get("images", [])
        if images:
            lines.append(f"\n**Images ({len(images)}):**")
            for img in images:
                lines.append(f"- {img}")

    if "links" in result:
        links = result.get("links", [])
        if links:
            lines.append(f"\n**Links ({len(links)}):**")
            for link in links:
                lines.append(f"- {link}")

    if "output" in result:
        output = result["output"]
        if isinstance(output, dict) and "content" in output:
            content = output["content"]
            if isinstance(content, dict):
                lines.append("\n**Extracted Data:**")
                for key, value in content.items():
                    lines.append(f"- {key}: {value}")

    # Handle message history results (read_message_history_with_person)
    if "messages" in result and "message_count" in result:
        person = result.get("person", {})
        if person:
            person_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
            person_email = person.get("email", "")
            person_phone = person.get("phoneNumber", "")
            person_info = [person_name]
            if person_email:
                person_info.append(person_email)
            if person_phone:
                person_info.append(person_phone)
            lines.append(f"**Person:** {' | '.join(person_info)}")

        lines.append(f"**Message Count:** {result['message_count']}")

        # Include full message text
        messages_text = result["messages"]
        if messages_text:
            lines.append(f"\n**Messages:**\n\n{messages_text}")

    # Handle x402 bazaar search results - NO TRUNCATION
    if "services" in result and "service_count" in result:
        services = result.get("services", [])
        if services:
            for i, svc in enumerate(services, 1):
                resource = svc.get("resource", "Unknown URL")
                price_display = svc.get("price_display", f"${svc.get('price_cents', 0) / 100:.4f}")
                method = svc.get("method", "GET")
                network = svc.get("network", "base")

                lines.append(f"\n**{i}. {resource}**")
                lines.append(f"   - Price: {price_display} | Method: {method} | Network: {network}")

                # Show input schema params if available
                input_schema = svc.get("input_schema")
                if input_schema and isinstance(input_schema, dict):
                    query_params = input_schema.get("queryParams")
                    if query_params and isinstance(query_params, dict):
                        param_details = []
                        for name, info in query_params.items():
                            if isinstance(info, dict):
                                required = info.get("required", False)
                                if required:
                                    param_details.append(f"{name} (required)")
                                else:
                                    param_details.append(name)
                            else:
                                param_details.append(name)
                        if param_details:
                            lines.append(f"   - Params: {', '.join(param_details)}")

                # Show metadata description if available
                metadata = svc.get("metadata")
                if metadata and isinstance(metadata, dict) and metadata.get("description"):
                    lines.append(f"   - Description: {metadata['description']}")
        else:
            lines.append("No services found matching your criteria.")

    # If no specific formatting, show full JSON - NO TRUNCATION
    if not lines:
        result_str = json.dumps(result, indent=2, default=str)
        lines.append(result_str)

    return "\n".join(lines)


def format_tool_message(params: Dict[str, Any], result: Dict[str, Any], time_elapsed: float, cost_cents: float) -> str:
    """
    Format a standardized tool message with Params, Result, Time Elapsed, and Cost.

    Args:
        params: Tool call parameters
        result: Tool execution result
        time_elapsed: Time elapsed in seconds
        cost_cents: Cost in cents

    Returns:
        Formatted markdown string
    """
    return f"""**Params Passed:**

{format_params(params)}

**Result:**

{format_result(result)}

**Time Elapsed:** {format_time_elapsed(time_elapsed)}

**Cost:** ${cost_cents / 100:.4f}"""


def extract_root_error(error: Exception) -> str:
    """
    Extract the most meaningful error message from a chain of Temporal exceptions.

    Temporal wraps errors in ActivityError -> ApplicationError chains.
    This function unwraps them to get the original, readable error message.

    Args:
        error: Exception to extract from

    Returns:
        Clean error message string
    """
    # If it's a Temporal ActivityError, unwrap to get the original cause
    if isinstance(error, ActivityError) and hasattr(error, "cause") and error.cause:
        return extract_root_error(error.cause)

    # If it's a Temporal ApplicationError, get the original message
    if isinstance(error, ApplicationError) and hasattr(error, "message") and error.message:
        return error.message

    # For other exceptions, use string representation
    return str(error)


def format_error_message(params: Dict[str, Any], error: Exception, time_elapsed: float, cost_cents: int = 0) -> str:
    """
    Format a standardized error message with Params, Error, Time Elapsed, and Cost.

    Args:
        params: Tool call parameters
        error: The exception that occurred
        time_elapsed: Time elapsed in seconds
        cost_cents: Cost in cents (usually 0 for failures)

    Returns:
        Formatted markdown string
    """
    # Extract the meaningful error message (unwraps Temporal exception chains)
    error_str = extract_root_error(error)

    # Try to extract API error message from HTTP errors
    if "HTTP error" in error_str and '{"type":"error"' in error_str:
        # Extract JSON error message from Parallel API errors
        import json

        try:
            # Find the JSON part
            start = error_str.find('{"type":"error"')
            if start != -1:
                json_str = error_str[start:]
                error_data = json.loads(json_str)
                if "error" in error_data and "message" in error_data["error"]:
                    error_str = error_data["error"]["message"]
        except Exception:
            pass  # Keep original error string if parsing fails

    return f"""**Params Passed:**

{format_params(params)}

**Error:**

{error_str}

**Time Elapsed:** {format_time_elapsed(time_elapsed)}

**Cost:** ${cost_cents / 100:.4f}"""


# ========================================
# BASE MANAGER CLASS
# ========================================


class ToolManager(ABC):
    """
    Base class for all tool managers.

    All tools must:
    1. Inherit from this class
    2. Define tool_name property
    3. Implement execute_tool() as an async generator that yields ToolEvent objects

    Tools should NOT return values - all communication happens via events.

    For tools that require user approval before execution:
    1. Set requires_approval = True
    2. Override get_approval_question() to return a human-readable approval prompt
    """

    # Set to True in subclass if tool requires user approval before execution
    requires_approval: bool = False

    # Set to True in subclass for read-only tools (used in PLAN phase)
    read_only: bool = False

    @property
    @abstractmethod
    def tool_name(self) -> str:
        """
        Unique tool name.
        Must match the tool name used in the LLM tool definitions.
        """
        pass

    def get_approval_question(self, tool_call: Dict[str, Any]) -> str:
        """
        Return the approval question to show the user before executing this tool.

        Override this method in subclasses where requires_approval = True.
        The question should clearly describe what action the tool will take.

        Args:
            tool_call: Dict with tool parameters (from LLM)

        Returns:
            Human-readable question string for the approval prompt
        """
        raise NotImplementedError(
            f"Tool '{self.tool_name}' has requires_approval=True but does not implement get_approval_question()"
        )

    def yield_in_progress(self, title: Optional[str] = None, message: Optional[str] = None) -> ToolEvent:
        """
        Helper method to create an IN_PROGRESS event.

        Tools can call this early in execute_tool (e.g., before params validation)
        to show immediate feedback. If early tool detection is enabled, this will
        use the same tool_call_id that was broadcast during streaming, so the
        second IN_PROGRESS call with full params will overwrite the initial one.

        Args:
            title: Optional title (defaults to "Starting {tool_name}...")
            message: Optional message

        Returns:
            ToolEvent with IN_PROGRESS status
        """
        if title is None:
            title = f"Starting {self.tool_name}..."

        return ToolEvent(
            type=EventType.POST_MESSAGE, title=title, message=message or "", status=MessageStatus.IN_PROGRESS
        )

    @abstractmethod
    async def execute_tool(
        self, workflow_instance, tool_call: Dict[str, Any], tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Execute the tool and yield events.

        This is the main entry point called by the workflow.
        Should yield events for:
        - Pre-execution message
        - Activity execution
        - Usage tracking
        - Post-execution message

        Args:
            workflow_instance: The workflow instance (self) for calling activities
            tool_call: Dict with tool parameters (from LLM)
            tool_call_id: Unique ID for this tool execution

        Yields:
            ToolEvent objects

        Example:
            # Pre-execution status
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Starting...",
                message="...",
                status=MessageStatus.IN_PROGRESS
            )

            # Execute activity
            result = await workflow.execute_activity(...)

            # Report usage
            yield ToolEvent(
                type=EventType.USAGE,
                tool_name="my_tool",
                usage_items=[...]
            )

            # Post-execution status
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Complete",
                message="...",
                status=MessageStatus.FINISHED
            )
        """
        pass
