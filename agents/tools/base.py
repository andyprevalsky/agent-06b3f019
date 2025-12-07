"""
Base classes and data structures for standardized tool implementation.

All tools should inherit from ToolManager and emit ToolEvent objects.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, asdict
from typing import Literal, Optional, Dict, Any, List, AsyncGenerator
from enum import Enum
import json
from temporalio.exceptions import ActivityError, ApplicationError


__all__ = [
    "EventType",
    "MessageStatus",
    "UsageType",
    "UsageItem",
    "ToolEvent",
    "ToolManager",
    "format_tool_message",
    "format_error_message",
    "format_time_elapsed",
    "extract_root_error",
]


# ========================================
# ENUMS
# ========================================

class EventType(str, Enum):
    """Types of events that tools can emit."""
    POST_MESSAGE = "post_message"          # Post a message to UI and DB
    USAGE = "usage"                        # Track tool usage/cost
    ADD_TO_CONTEXT = "add_to_context"      # Add message to workflow context (no UI)
    WAIT_FOR_SIGNAL = "wait_for_signal"    # Wait for a workflow signal


class MessageStatus(str, Enum):
    """Status of a POST_MESSAGE event."""
    IN_PROGRESS = "IN_PROGRESS"  # Tool is currently executing
    FINISHED = "FINISHED"        # Tool completed successfully
    ERROR = "ERROR"              # Tool failed with an error


class UsageType(str, Enum):
    """Type of usage being tracked."""
    LLM = "llm"           # Token-based LLM usage (input/output tokens)
    SERVICE = "service"   # Non-token service usage (searches, API calls, etc.)


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
    provider: str    # Human-readable: "Perplexity Input Tokens", "OpenAI Search Queries"
    
    # Token-based fields (only for type='llm')
    number_of_tokens: Optional[int] = None
    token_price_per_million_cents: Optional[int] = None  # Price in cents per million tokens
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for serialization."""
        return {
            "type": self.type.value,
            "cost_cents": self.cost_cents,
            "provider": self.provider,
            "number_of_tokens": self.number_of_tokens,
            "token_price_per_million_cents": self.token_price_per_million_cents,
        }


@dataclass
class ToolEvent:
    """
    Event emitted by tool during execution.
    
    Tools are async generators that yield events to communicate with the workflow.
    The workflow handles these events (post messages, track usage, etc.).
    """
    
    type: EventType
    
    # For POST_MESSAGE events
    title: Optional[str] = None
    message: Optional[str] = None
    status: Optional[MessageStatus] = None  # Status for POST_MESSAGE events
    
    # For USAGE events - list of usage items
    tool_name: Optional[str] = None
    usage_items: Optional[List[UsageItem]] = None
    
    # For ADD_TO_CONTEXT events
    role: Optional[str] = None  # "SYSTEM", "USER", "ASSISTANT", "TOOL"
    text: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    
    # For WAIT_FOR_SIGNAL events
    signal_key: Optional[str] = None
    
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
        }
        
        # Convert usage_items to dicts
        if self.usage_items:
            result["usage_items"] = [item.to_dict() for item in self.usage_items]
        else:
            result["usage_items"] = None
        
        return result


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
    """Format tool parameters for display in markdown."""
    if not params:
        return "None"
    
    lines = []
    for key, value in params.items():
        # Skip internal fields
        if key in ['tool', 'tool_call_id']:
            continue
        
        # Format value nicely
        if isinstance(value, dict):
            value_str = json.dumps(value, indent=2)
        elif isinstance(value, (list, tuple)):
            if len(value) > 3:
                value_str = f"[{', '.join(str(v) for v in value[:3])}, ... ({len(value)} total)]"
            else:
                value_str = str(value)
        elif isinstance(value, str) and len(value) > 100:
            value_str = value[:97] + "..."
        else:
            value_str = str(value)
        
        lines.append(f"- **{key}**: {value_str}")
    
    return "\n".join(lines) if lines else "None"


def format_result(result: Dict[str, Any]) -> str:
    """Format tool result for display in markdown."""
    if not result:
        return "No result data"
    
    # Extract key fields
    lines = []
    
    # Common result fields
    if "answer" in result:
        answer = result["answer"]
        if isinstance(answer, str) and len(answer) > 500:
            answer = answer[:497] + "..."
        lines.append(f"{answer}")
    
    if "candidates" in result:
        candidates = result["candidates"]
        if isinstance(candidates, list):
            lines.append(f"\n**Found {len(candidates)} candidates**")
            for i, candidate in enumerate(candidates[:5], 1):
                name = candidate.get("name", "Unknown")
                lines.append(f"{i}. {name}")
            if len(candidates) > 5:
                lines.append(f"...and {len(candidates) - 5} more")
    
    if "sources" in result:
        sources = result.get("sources", [])
        if sources:
            lines.append(f"\n**Sources:**")
            for src in sources[:5]:
                lines.append(f"- {src}")
            if len(sources) > 5:
                lines.append(f"- ...and {len(sources) - 5} more")
    
    if "findall_id" in result:
        lines.append(f"\nFind All ID: {result['findall_id']}")
    
    if "monitor_id" in result:
        lines.append(f"\nMonitor ID: {result['monitor_id']}")
    
    if "output" in result:
        output = result["output"]
        if isinstance(output, dict) and "content" in output:
            content = output["content"]
            if isinstance(content, dict):
                lines.append(f"\n**Extracted Data:**")
                for key, value in list(content.items())[:5]:
                    if isinstance(value, str) and len(value) > 100:
                        value = value[:97] + "..."
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
        
        # Include full message text - this is already formatted nicely
        messages_text = result["messages"]
        if messages_text:
            lines.append(f"\n**Messages:**\n\n{messages_text}")
    
    # If no specific formatting, show summary
    if not lines:
        result_str = json.dumps(result, indent=2)
        if len(result_str) > 500:
            result_str = result_str[:497] + "..."
        lines.append(result_str)
    
    return "\n".join(lines)


def format_tool_message(
    params: Dict[str, Any],
    result: Dict[str, Any],
    time_elapsed: float,
    cost_cents: int
) -> str:
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

**Cost:** ${cost_cents/100:.4f}"""


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
    if isinstance(error, ActivityError):
        if hasattr(error, 'cause') and error.cause:
            return extract_root_error(error.cause)
    
    # If it's a Temporal ApplicationError, get the original message
    if isinstance(error, ApplicationError):
        if hasattr(error, 'message') and error.message:
            return error.message
    
    # For other exceptions, use string representation
    return str(error)


def format_error_message(
    params: Dict[str, Any],
    error: Exception,
    time_elapsed: float,
    cost_cents: int = 0
) -> str:
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
        except:
            pass  # Keep original error string if parsing fails
    
    return f"""**Params Passed:**

{format_params(params)}

**Error:**

{error_str}

**Time Elapsed:** {format_time_elapsed(time_elapsed)}

**Cost:** ${cost_cents/100:.4f}"""


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
    
    @abstractmethod
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
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

