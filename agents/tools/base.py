"""
Base classes and data structures for standardized tool implementation.

All tools should inherit from ToolManager and emit ToolEvent objects.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, asdict
from typing import Literal, Optional, Dict, Any, List, AsyncGenerator
from enum import Enum


__all__ = [
    "EventType",
    "MessageStatus",
    "UsageType",
    "UsageItem",
    "ToolEvent",
    "ToolManager",
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

class ToolManager(ABC):
    """
    Base class for all tool managers.
    
    All tools must:
    1. Inherit from this class
    2. Define tool_name property
    3. Implement execute_tool() as an async generator that yields ToolEvent objects
    
    Tools should NOT return values - all communication happens via events.
    """
    
    @property
    @abstractmethod
    def tool_name(self) -> str:
        """
        Unique tool name.
        Must match the tool name used in the LLM tool definitions.
        """
        pass
    
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

