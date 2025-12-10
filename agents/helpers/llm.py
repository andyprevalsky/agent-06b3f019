"""LLM tool for agent reasoning and decision making."""

from typing import List, Dict, Optional, Any, TypeVar, Union, Type, Literal
from temporalio import activity
import structlog
import json
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, create_model
from enum import Enum

from config import load_config
from helpers.get_user_context import fetch_user_context
from tools.base import ToolSchema

logger = structlog.get_logger()

T = TypeVar('T', bound=BaseModel)


def prepare_schema_for_openai(pydantic_model: Type[BaseModel]) -> Dict[str, Any]:
    """
    Convert a Pydantic model to a JSON schema ready for OpenAI strict structured outputs.
    
    OpenAI's strict mode requires:
    1. `additionalProperties: false` on EVERY object (root and nested)
    2. All properties must be in the `required` array (no optional fields)
    
    This function recursively transforms the schema to meet these requirements.
    
    Args:
        pydantic_model: A Pydantic BaseModel class
        
    Returns:
        JSON schema dict ready for OpenAI's response_format
    """
    schema = pydantic_model.model_json_schema()
    
    def add_strict_properties(obj: Dict[str, Any]) -> None:
        """Recursively add additionalProperties: false to all objects."""
        if not isinstance(obj, dict):
            return
            
        # If this is an object type, add additionalProperties: false
        if obj.get("type") == "object":
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
    
    add_strict_properties(schema)
    return schema


def convert_context_to_messages(
    context: List[Dict[str, Any]], 
    include_system: bool = True
) -> List[Dict[str, Any]]:
    """
    Convert workflow context to OpenAI/OpenRouter message format.
    
    Handles:
    - SYSTEM messages (blueprints): included if include_system=True
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
        
    Returns:
        List of OpenAI-formatted messages in chronological order
    """
    messages = []
    
    # Sort context by timestamp to ensure chronological order
    # This is critical after polling for new user messages or continue-as-new
    from datetime import datetime
    
    def parse_timestamp(ts: str) -> datetime:
        """Parse ISO timestamp, defaulting to epoch if missing/invalid."""
        if not ts:
            return datetime(1970, 1, 1)
        try:
            # Handle both with and without timezone
            if ts.endswith('Z'):
                ts = ts[:-1] + '+00:00'
            return datetime.fromisoformat(ts)
        except (ValueError, AttributeError):
            return datetime(1970, 1, 1)
    
    # Build map of tool_call_id -> IN_PROGRESS timestamp
    # This allows FINISHED messages to use the IN_PROGRESS timestamp for sorting,
    # ensuring tool results stay grouped with their declaring ASSISTANT message
    # even if a USER message arrives before the tool completes
    tool_start_times: Dict[str, str] = {}
    for msg in context:
        meta = msg.get('metadata', {}) or {}
        if msg.get('role') == 'TOOL' and meta.get('toolStatus') == 'IN_PROGRESS':
            tool_call_id = meta.get('toolCallId')
            if tool_call_id:
                tool_start_times[tool_call_id] = msg.get('timestamp', '')
    
    def get_timestamp(msg: Dict[str, Any]) -> datetime:
        """Get timestamp for sorting. FINISHED tool messages use their IN_PROGRESS timestamp."""
        meta = msg.get('metadata', {}) or {}
        
        # For FINISHED tool messages, use the IN_PROGRESS timestamp if available
        # This keeps tool results grouped with their ASSISTANT tool_call, not separated by USER messages
        if msg.get('role') == 'TOOL' and meta.get('toolStatus') == 'FINISHED':
            tool_call_id = meta.get('toolCallId')
            if tool_call_id and tool_call_id in tool_start_times:
                return parse_timestamp(tool_start_times[tool_call_id])
        
        return parse_timestamp(msg.get('timestamp', ''))
    
    # Sort with SYSTEM messages first (but chronological among themselves),
    # then all other messages chronologically
    def sort_key(msg: Dict[str, Any]) -> tuple:
        """Sort key: (is_not_system, timestamp) so SYSTEM messages come first."""
        is_system = msg.get('role') == 'SYSTEM'
        timestamp = get_timestamp(msg)
        return (not is_system, timestamp)  # False sorts before True, so SYSTEM first
    
    sorted_context = sorted(context, key=sort_key)
    
    # Track which tool_call_ids have been declared by ASSISTANT messages
    declared_tool_ids = set()
    
    for msg in sorted_context:
        role = msg.get('role', 'ASSISTANT')
        content = msg.get('text', '')
        metadata = msg.get('metadata', {})
        
        if role == 'SYSTEM':
            if include_system:
                messages.append({"role": "system", "content": content})
                
        elif role == 'USER':
            messages.append({"role": "user", "content": content})
            
        elif role == 'ASSISTANT':
            # Include tool_calls if present in metadata
            assistant_msg = {"role": "assistant", "content": content}
            if metadata.get('tool_calls'):
                # Convert our tool call format to OpenAI format
                import uuid
                tool_calls = []
                for tc in metadata['tool_calls']:
                    # Get or generate tool_call_id
                    tc_id = str(tc.get('tool_call_id', uuid.uuid4()))
                    declared_tool_ids.add(tc_id)  # Track this ID
                    tool_calls.append({
                        "id": tc_id,
                        "type": "function",
                        "function": {
                            "name": tc.get('tool'),
                            "arguments": json.dumps({k: v for k, v in tc.items() if k not in ['tool', 'tool_call_id']})
                        }
                    })
                assistant_msg["tool_calls"] = tool_calls
            messages.append(assistant_msg)
            
        elif role == 'TOOL':
            # Skip IN_PROGRESS messages - only send FINISHED results to LLM
            if metadata.get('toolStatus') == 'IN_PROGRESS':
                continue
            
            # Special handling for verifier messages: convert to ASSISTANT
            # These need to be in the conversation flow for the agent to see them
            if metadata.get('verifierMessage'):
                assistant_content = content
                if metadata.get('title'):
                    assistant_content = f"{metadata['title']}: {content}"
                messages.append({"role": "assistant", "content": assistant_content})
                continue
            
            tool_call_id = str(metadata.get('toolCallId', ''))
            
            # Only use tool role if this tool_call_id was declared by a preceding ASSISTANT message
            if tool_call_id and tool_call_id in declared_tool_ids:
                # Use proper tool role with tool_call_id and name
                # Prefix content with title (what user sees in UI) for context
                tool_content = content
                if metadata.get('title'):
                    tool_content = f"{metadata['title']}: {content}"
                tool_msg = {"role": "tool", "content": tool_content}
                tool_msg["tool_call_id"] = tool_call_id
                if metadata.get('toolName'):
                    tool_msg["name"] = metadata['toolName']
                messages.append(tool_msg)
            else:
                # No matching ASSISTANT tool_call - convert to SYSTEM message
                # This handles workflow activities like query_blueprints that post TOOL messages
                # but aren't user-declared tool calls
                system_content = content
                if metadata.get('title'):
                    system_content = f"{metadata['title']}: {content}"
                messages.append({"role": "system", "content": system_content})
    
    return messages


# ============================================================================
# Individual Tool Pydantic Models
# ============================================================================

class VerifierConfig(BaseModel):
    """Verifier configuration for evaluating agent success."""
    type: Literal["FLOAT_LLM_JUDGE"] = Field(description="Must be 'FLOAT_LLM_JUDGE'")
    llm_judge_prompt: str = Field(description="Prompt for the LLM judge to evaluate the agent's performance")


def create_sub_agent_config_model(
    system_tool_names: List[str],
    available_db_tools: List[Dict[str, str]]
) -> Type[BaseModel]:
    """
    Dynamically create SubAgentConfig model.
    
    Note: tool_ids is intentionally NOT included - sub-agents get their tools
    automatically via the backend's tool selection logic based on their goal.
    
    Args:
        system_tool_names: Names of system tools (unused, kept for API compatibility)
        available_db_tools: List of DB tools (unused, kept for API compatibility)
        
    Returns:
        Dynamically generated SubAgentConfig class
    """
    class DynamicSubAgentConfig(BaseModel):
        """Configuration for a single sub-agent."""
        goal: str = Field(description="The goal/task for this sub-agent")
        model: Optional[str] = Field(None, description="LLM model to use (inherits from parent if not specified)")
        # Note: reasoning_effort removed - sub-agents use backend default ('low')
        verifier: VerifierConfig = Field(description="Verifier config with type='FLOAT_LLM_JUDGE' and llm_judge_prompt")
    
    return DynamicSubAgentConfig


class WaitSecondsTool(BaseModel):
    """Tool call for pausing execution."""
    tool: Literal["wait_seconds"]
    seconds: int = Field(ge=1, le=3600, description="Number of seconds to wait (1-3600)")


class WebSearchTool(BaseModel):
    """Tool call for searching the web with real-time information."""
    tool: Literal["web_search"]
    query: str = Field(description="Search query or question about current/recent information")


class DeepResearchTool(BaseModel):
    """Tool call for comprehensive multi-step research on complex topics."""
    tool: Literal["deep_research"]
    query: str = Field(description="Complex research topic or question requiring in-depth analysis")
    max_tokens: Optional[int] = Field(default=4000, description="Maximum tokens for response")


class RequestUserAttentionTool(BaseModel):
    """Tool for requesting user attention when clarification or input is needed."""
    tool: Literal["request_user_attention"]
    question: str = Field(description="The question to ask the user. Make sure to use markdown formatting to make your response more readable.")


class SendSmsTool(BaseModel):
    """Tool call for sending SMS to a person."""
    tool: Literal["send_sms"]
    phone_number: str = Field(description="The phone number to send the SMS to (E.164 format, e.g., +19729777432). Use the user's phone number if sending to them.")
    message: str = Field(description="The SMS message to send. Keep it concise (160 characters recommended for standard SMS).")


class SendSmsAsUserTool(BaseModel):
    """Tool call for sending SMS via the user's own iMessage client (Mac-only)."""
    tool: Literal["send_sms_as_user"]
    phone_number: str = Field(description="Recipient phone number to send via the user's Mac iMessage (E.164 format, e.g., +19729777432).")
    message: str = Field(description="The exact SMS/iMessage text to send. Keep it conversational and ready to send without additional edits.")


class SendEmailTool(BaseModel):
    """Tool call for sending email via the user's connected Gmail account."""
    tool: Literal["send_email"]
    to: str = Field(description="Recipient email address (e.g., 'john@example.com')")
    subject: str = Field(description="Email subject line")
    body: str = Field(description="Email body content. Use plain text formatting.")
    cc: Optional[str] = Field(None, description="Optional CC recipient email address")


class ReadMessageHistoryTool(BaseModel):
    """Read message history with a person. Use this to retrieve past conversations before sending a new message. You MUST call this tool before using message_person to send any message."""
    tool: Literal["read_message_history_with_person"]
    phone: Optional[str] = Field(None, description="Phone number in E.164 format (e.g., +19729777432)")
    email: Optional[str] = Field(None, description="Email address of the person")
    first_name: Optional[str] = Field(None, description="First name of the person (use with last_name)")
    last_name: Optional[str] = Field(None, description="Last name of the person (use with first_name)")


class MessagePersonTool(BaseModel):
    """Send a message to a person via SMS or email. IMPORTANT: You MUST first call read_message_history_with_person for the SAME person before using this tool. If you haven't read their message history, this tool will fail."""
    tool: Literal["message_person"]
    channel: Literal["sms", "email"] = Field(description="Communication channel: 'sms' for text message, 'email' for email")
    phone: Optional[str] = Field(None, description="Phone number in E.164 format (required for SMS channel)")
    email: Optional[str] = Field(None, description="Email address (required for email channel)")
    first_name: Optional[str] = Field(None, description="First name of the person (optional, for context matching)")
    last_name: Optional[str] = Field(None, description="Last name of the person (optional, for context matching)")
    message: str = Field(description="The message content to send")
    subject: Optional[str] = Field(None, description="Email subject line (required for email channel)")


class SpawnBrowserAgentTool(BaseModel):
    """Spawn an autonomous browser agent to complete complex, multi-step web tasks. The browser agent uses AI to navigate, interact, and accomplish goals without step-by-step orchestration. Provide a complete, high-level goal - the browser agent will autonomously break it down and execute all necessary steps. Login state persists across sessions."""
    tool: Literal["spawn_browser_agent"]
    goal: str = Field(description="Complete, high-level goal for the autonomous browser agent to accomplish. Examples: 'Order a Chipotle bowl from Uber Eats with white rice, steak, fajita peppers, corn, pico de gallo, and hot sauce', 'Find the top 3 trending Python repos on GitHub and summarize their READMEs', 'Check my Gmail inbox and respond to any urgent emails from my manager', 'Research and compare prices for MacBook Pro M3 across Amazon, Best Buy, and Apple Store'")


class SearchUserNetworkTool(BaseModel):
    """Search the user's personal network for people matching specific criteria. Performs semantic search across contacts. All fields are optional - search by name, profession, skills, relationship, or any combination of criteria."""
    tool: Literal["search_user_network_for_people"]
    
    # Core identity - all fields are optional for flexible semantic search
    first_name: Optional[str] = Field(None, description="First name of person to search for")
    last_name: Optional[str] = Field(None, description="Last name of person to search for")
    
    # Optional search criteria - fill in what matters for the goal
    age: Optional[int] = Field(None, description="Age of person (e.g., 35, 50)")
    location: Optional[str] = Field(None, description="Location (e.g., 'San Francisco, CA', 'New York')")
    profession: Optional[str] = Field(None, description="Profession (e.g., 'venture capitalist', 'software engineer')")
    company: Optional[str] = Field(None, description="Company name (e.g., 'Google', 'Sequoia Capital')")
    title: Optional[str] = Field(None, description="Job title (e.g., 'CEO', 'Partner', 'VP Engineering')")
    industry: Optional[str] = Field(None, description="Industry (e.g., 'venture capital', 'technology', 'healthcare')")
    
    # Relationship criteria
    relation: Optional[str] = Field(None, description="Relationship type (e.g., 'best_friend', 'colleague', 'mentor', 'family')")
    communication_frequency: Optional[str] = Field(None, description="How often you communicate: 'daily', 'weekly', 'monthly', 'yearly', 'rarely'")
    relationship_quality: Optional[str] = Field(None, description="Relationship quality: 'strong', 'moderate', 'weak', 'strained'")
    
    # Skills & Interests
    skills: Optional[List[str]] = Field(None, description="Skills they possess (e.g., ['fundraising', 'product management', 'marketing'])")
    interests: Optional[List[str]] = Field(None, description="Their interests (e.g., ['AI', 'sustainability', 'art'])")
    
    # Influence & Reach
    total_online_reach: Optional[int] = Field(None, description="Minimum social media reach/followers")
    estimated_net_worth_usd: Optional[float] = Field(None, description="Minimum estimated net worth in USD (e.g., 1500000 for $1.5M)")
    estimated_world_power_ranking: Optional[int] = Field(None, description="World power ranking 1-10 (1=most powerful)")
    
    # Availability
    current_bandwidth: Optional[str] = Field(None, description="Their availability: 'totally_free', 'light', 'moderate', 'busy', 'totally_swamped'")
    contact_status: Optional[str] = Field(None, description="Contact status: 'active', 'dormant', 'lost_contact'")
    
    # Network Orientation
    network_orientation: Optional[str] = Field(None, description="How they network: 'giver', 'taker', 'matcher'")
    
    # Additional context
    notes: Optional[str] = Field(None, description="Additional context or notes about the person you're looking for")


class GeneratorEnum(str, Enum):
    """Generator types for Find All operations with pricing."""
    PREVIEW = "preview"  # $0.15 fixed, $0.00 per match. Testing queries (~10 candidates)
    BASE = "base"        # $0.25 fixed, $0.03 per match. Broad, common queries expecting many matches
    CORE = "core"        # $2.00 fixed, $0.15 per match. Specific queries with moderate expected matches
    PRO = "pro"          # $10.00 fixed, $1.00 per match. Highly specific queries with rare/hard-to-find matches


class ProcessorEnum(str, Enum):
    """Processor types for Enrich operations with pricing."""
    LITE = "lite"    # $0.005 per match. Simple data extraction
    BASE = "base"    # $0.01 per match. Reliable for standard enrichments
    CORE = "core"    # $0.025 per match. Cross-referenced data
    PRO = "pro"      # $0.10 per match. Exploratory research
    ULTRA = "ultra"  # $0.30 per match. Deep research


class CadenceEnum(str, Enum):
    """Cadence types for Monitor operations."""
    HOURLY = "hourly"  # Check every hour. Best for fast-moving topics
    DAILY = "daily"    # Check once per day. Best for most news and updates
    WEEKLY = "weekly"  # Check once per week. Best for slower changes


class FindAllTool(BaseModel):
    """
    Tool for discovering entities on the open internet matching specific criteria using natural language queries.
    
    This tool uses Parallel AI's Find All API to search for entities (companies, people, etc.)
    that match your criteria. The API converts your natural language objective into structured
    match conditions and returns matched candidates with details, reasoning, and citations.
    
    Pricing: Total cost = fixed cost + (cost per match × number of matches)
    - preview: $0.15 fixed + $0.00/match (testing only, ~10 candidates)
    - base: $0.25 fixed + $0.03/match (broad queries, many matches expected)
    - core: $2.00 fixed + $0.15/match (specific queries, moderate matches) [DEFAULT]
    - pro: $10.00 fixed + $1.00/match (highly specific, rare matches)
    
    Example: "Find all portfolio companies of Khosla Ventures founded after 2020"
    """
    tool: Literal["find_all"]
    
    objective: str = Field(
        ...,
        max_length=5000,
        description=(
            "Natural language description of entities to find. Be specific about criteria, "
            "sources, and context. Examples: 'Find all portfolio companies of Khosla Ventures founded after 2020', "
            "'Find all AI startups in San Francisco that raised Series A in 2024'. "
            "Maximum 5000 characters. "
            "TIP: Start with 'preview' generator to test your query and estimate match count before running full search."
        )
    )
    
    generator: Optional[GeneratorEnum] = Field(
        default=GeneratorEnum.CORE,
        description=(
            "Generator type determining quality and cost. "
            "Choose based on query specificity and expected match count:\n"
            "- 'preview' ($0.15 fixed, $0/match): Testing queries with ~10 candidates. Always test here first.\n"
            "- 'base' ($0.25 fixed, $0.03/match): Broad queries expecting many matches (e.g., 'companies in healthcare'). "
            "Best for <20 matches where low fixed cost matters.\n"
            "- 'core' ($2.00 fixed, $0.15/match) [DEFAULT]: Specific queries with moderate matches (e.g., 'healthcare companies using AI for diagnostics'). "
            "Best for 20-50 matches.\n"
            "- 'pro' ($10.00 fixed, $1.00/match): Highly specific queries with rare matches (e.g., 'Series A healthcare AI companies with FDA-approved products'). "
            "Best when you need the most thorough search.\n"
            "Note: For >50 matches, per-match cost dominates. Consider generator choice carefully."
        )
    )
    
    match_limit: Optional[int] = Field(
        default=10,
        ge=1,
        le=100,
        description=(
            "Maximum number of matched entities to return. Range: 1-100. Default: 10. "
            "Cost impact: Higher limits increase total cost (fixed cost + per-match cost × matches found). "
            "Example costs for 50 matches: base=$1.75, core=$9.50, pro=$60.00. "
            "Consider using 'preview' generator first to estimate match count."
        )
    )


class EnrichTool(BaseModel):
    """
    Tool for enriching entities with additional structured data using web research.
    
    This tool uses Parallel AI's Task API to extract additional information about an entity.
    Provide person/company metadata (name, email, company, url, etc.) and define what
    structured data you want to extract via the output schema.
    
    Processor differences:
    - 'lite': Basic tasks with minimal complexity. Fastest, most cost-effective.
    - 'base': Standard tasks requiring moderate processing. Reliable for most enrichments.
    - 'core': Complex tasks needing enhanced processing. For cross-referenced data from multiple sources.
    - 'pro': Exploratory web research with higher performance. For nuanced understanding.
    - 'ultra': Most demanding tasks with highest processing power. For comprehensive deep research.
    
    Pricing varies by processor - higher quality processors cost more but provide better results.
    """
    tool: Literal["enrich"]
    
    input: Dict[str, Optional[str]] = Field(
        ...,
        description=(
            "JSON object with person/company metadata to enrich. All fields are optional/nullable. "
            "Common fields: name, email, company, url, location, title, etc. "
            "Example: {'name': 'Andy Prevalsky', 'email': 'andyprevalsky@yahoo.com', 'company': 'Acme Corp', 'url': 'https://example.com'}"
        )
    )
    
    output_schema: Dict[str, Any] = Field(
        ...,
        description=(
            "JSON schema defining what structured data to extract. "
            "Must follow this exact format:\n"
            "{\n"
            "  'type': 'json',\n"
            "  'json_schema': {\n"
            "    'type': 'object',\n"
            "    'properties': {\n"
            "      'field_name': {\n"
            "        'type': 'string',\n"
            "        'description': 'Clear description of what this field represents'\n"
            "      }\n"
            "    },\n"
            "    'required': ['field_name'],\n"
            "    'additionalProperties': false\n"
            "  }\n"
            "}\n"
            "Example - Extract email and location:\n"
            "{'type': 'json', 'json_schema': {'type': 'object', 'properties': {'email': {'type': 'string', 'description': 'Email address'}, 'location': {'type': 'string', 'description': 'City and state'}}, 'required': ['email'], 'additionalProperties': false}}"
        )
    )
    
    processor: Optional[ProcessorEnum] = Field(
        default=ProcessorEnum.LITE,
        description=(
            "Processor type for enrichment execution:\n"
            "- 'lite' [DEFAULT]: Basic tasks, minimal complexity. Fastest and most cost-effective.\n"
            "- 'base': Standard tasks, moderate processing. Reliable for most enrichments.\n"
            "- 'core': Complex tasks, enhanced processing. For cross-referenced data from multiple sources.\n"
            "- 'pro': Exploratory research, higher performance. For nuanced understanding.\n"
            "- 'ultra': Most demanding tasks, highest processing power. For comprehensive deep research.\n"
            "Higher quality processors cost more but provide better, more thorough results."
        )
    )


class MonitorTool(BaseModel):
    """
    Tool for creating a continuous monitor that tracks the web for material changes relevant to a query.
    
    Creates a monitor that runs on a schedule you control (hourly, daily, weekly).
    Returns a monitor_id that you can use with check_monitor_events to retrieve detected events.
    
    Pricing: $3.00 per 1,000 runs. Each scheduled run is billed individually.
    Example: A monitor with 'daily' cadence costs $0.03 over 10 days (10 runs × $3/1000).
    
    Best for: Tracking news, product updates, regulatory changes, competitor activity, etc.
    After creating a monitor, use check_monitor_events periodically to retrieve new events.
    """
    tool: Literal["monitor"]
    
    query: str = Field(
        ...,
        max_length=5000,
        description=(
            "Natural language query describing what to monitor. Be specific about what changes matter. "
            "Examples: 'Latest news on AI regulations from the Federal Reserve', "
            "'New product launches by OpenAI', 'SEC filings mentioning cryptocurrency regulations'. "
            "Clear queries with explicit instructions lead to higher-quality event detection. "
            "Maximum 5000 characters."
        )
    )
    
    cadence: CadenceEnum = Field(
        default=CadenceEnum.DAILY,
        description=(
            "Frequency of monitoring runs. "
            "- 'hourly': Check every hour. Best for fast-moving topics requiring immediate updates.\n"
            "- 'daily' [DEFAULT]: Check once per day. Best for most news, announcements, and regular updates.\n"
            "- 'weekly': Check once per week. Best for slower changes, long-term trends, or when cost optimization matters.\n"
            "Higher frequency = more runs = higher cost. Choose based on how quickly information changes."
        )
    )
    
    webhook_url: Optional[str] = Field(
        default=None,
        description=(
            "Optional URL to receive HTTP POST notifications when events are detected or monitors finish scheduled runs. "
            "Format: 'https://your-domain.com/webhook'. "
            "If not provided, use check_monitor_events tool to poll for updates. "
            "Webhooks require backend infrastructure to receive and process notifications."
        )
    )
    
    metadata: Optional[Dict[str, str]] = Field(
        default=None,
        description=(
            "Optional metadata to store with the monitor. Keys and values must be strings. "
            "Maximum 16 characters per key, 512 characters per value. "
            "Useful for tracking monitor purpose, category, or related information. "
            "Example: {'category': 'regulations', 'priority': 'high'}"
        )
    )


class CheckMonitorEventsTool(BaseModel):
    """
    Tool for checking events from a previously created monitor.
    
    Retrieves recent events detected by a monitor. Use this periodically after creating a monitor
    to check for new updates. Events are returned in chronological order.
    
    Requires a monitor_id from a previous monitor call.
    """
    tool: Literal["check_monitor_events"]
    
    monitor_id: str = Field(
        ...,
        description=(
            "ID from a previous monitor call. Format: 'monitor_...' (e.g., 'monitor_abc123...'). "
            "You must have successfully created a monitor first to get this ID."
        )
    )
    
    limit: Optional[int] = Field(
        default=10,
        ge=1,
        le=100,
        description=(
            "Maximum number of events to return. Range: 1-100. Default: 10. "
            "Returns most recent events first."
        )
    )


# ============================================================================
# Phase Transition Marker Tools
# ============================================================================

class MarkResearchFinishedTool(BaseModel):
    """Signal that the research phase is complete. Call this when you have gathered enough context to understand the goal."""
    tool: Literal["mark_research_finished"]


class MarkAtomizationFinishedTool(BaseModel):
    """Signal the atomization decision - whether the goal is proximate (can be executed directly) or needs decomposition."""
    tool: Literal["mark_atomization_finished"]
    is_proximate: bool = Field(
        description="True if the goal can be executed directly with the available tools (atomic/proximate). "
                   "False if the goal needs to be decomposed into parallel sub-tasks."
    )


class PlannedSubtask(BaseModel):
    """A single subtask to be spawned as a sub-agent."""
    goal: str = Field(description="Clear, specific goal for this sub-agent")
    context: str = Field(description="Relevant context from research phase to pass to this sub-agent")


class MarkPlanningFinishedTool(BaseModel):
    """Signal that planning is complete with the list of parallel subtasks to spawn."""
    tool: Literal["mark_planning_finished"]
    subtasks: List[PlannedSubtask] = Field(
        description="List of 3-5 parallel subtasks. Each must be: simpler than the original goal, "
                   "context-independent, parallelizable (no causal dependencies between them). "
                   "Completion of ALL subtasks must result in the original goal being completed."
    )


class MarkExecutionCompleteTool(BaseModel):
    """Signal that execution is complete and ready for verification. Call this when you believe the goal has been fully accomplished."""
    tool: Literal["mark_execution_complete"]


# ============================================================================
# x402 Bazaar Tools
# ============================================================================

class SearchX402BazaarTool(BaseModel):
    """
    Search the x402 Bazaar for available paid API services.
    
    The x402 Bazaar is a discovery layer for paid APIs using the x402 protocol.
    Returns a list of available services with their pricing, capabilities, and schemas.
    Use this to find services that can help accomplish tasks, then use pay_for_x402_bazaar_service to call them.
    
    NOTE: Our own services are automatically filtered out to prevent self-calls.
    """
    tool: Literal["search_x402_bazaar"]
    
    max_price_cents: Optional[int] = Field(
        default=None,
        description=(
            "Maximum price in cents willing to pay per API call. "
            "Services costing more than this will be filtered out. "
            "Example: 100 = $1.00, 50 = $0.50, 10 = $0.10"
        )
    )
    
    keyword: Optional[str] = Field(
        default=None,
        description=(
            "Optional keyword to filter services by description or resource URL. "
            "Examples: 'weather', 'price', 'news', 'data'"
        )
    )


class PayForX402BazaarServiceTool(BaseModel):
    """
    Execute a paid API call to an x402 service discovered from search_x402_bazaar.
    
    This tool handles the x402 payment protocol automatically:
    1. Makes initial request to get payment requirements
    2. Signs and submits payment authorization
    3. Returns the service response
    
    IMPORTANT: Always include required params from the service's input_schema!
    The search results show required params like "Params: url, includeResponseBody".
    You MUST pass these in the params field.
    """
    tool: Literal["pay_for_x402_bazaar_service"]
    
    resource_url: str = Field(
        description=(
            "The x402 service URL from search_x402_bazaar results. "
            "Example: 'https://minifetch.com/api/v1/x402/extract/url-metadata'"
        )
    )
    
    method: Literal["GET", "POST"] = Field(
        default="GET",
        description="HTTP method for the request (shown in search results). Default: GET"
    )
    
    params: Dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "REQUIRED: Request parameters from the service's input_schema. "
            "Look at the 'Params:' line in search results for required fields. "
            "For GET requests: these become query parameters. "
            "For POST requests: this becomes the JSON body. "
            "Example for url-metadata service: {\"url\": \"https://example.com\", \"includeResponseBody\": true}"
        )
    )
    
    max_amount_cents: int = Field(
        description=(
            "Maximum amount in cents willing to pay for this call (safety limit). "
            "The call will fail if the service requires more than this amount. "
            "Set this to at least the price shown in search results. "
            "Example: 100 = $1.00, 10 = $0.10, 1 = $0.01"
        )
    )


# Map tool names to their Pydantic models
# Note: spawn_sub_agents is NOT included here - it's generated dynamically in create_agent_action_model
TOOL_MODELS = {
    "wait_seconds": WaitSecondsTool,
    "web_search": WebSearchTool,
    "deep_research": DeepResearchTool,
    "request_user_attention": RequestUserAttentionTool,
    "send_sms_as_user": SendSmsAsUserTool,
    "spawn_browser_agent": SpawnBrowserAgentTool,
    "search_user_network_for_people": SearchUserNetworkTool,
    "find_all": FindAllTool,
    "enrich": EnrichTool,
    "monitor": MonitorTool,
    "check_monitor_events": CheckMonitorEventsTool,
    "read_message_history_with_person": ReadMessageHistoryTool,
    "message_person": MessagePersonTool,
    # Phase transition marker tools
    "mark_research_finished": MarkResearchFinishedTool,
    "mark_atomization_finished": MarkAtomizationFinishedTool,
    "mark_planning_finished": MarkPlanningFinishedTool,
    "mark_execution_complete": MarkExecutionCompleteTool,
    # x402 Bazaar tools
    "search_x402_bazaar": SearchX402BazaarTool,
    "pay_for_x402_bazaar_service": PayForX402BazaarServiceTool,
}


# ============================================================================
# Dynamic Tool Documentation Generation
# ============================================================================

def generate_tool_parameter_docs(available_tool_names: List[str]) -> str:
    """
    Dynamically generate tool parameter documentation from Pydantic models.
    
    This ensures tool docs never get out of sync with actual implementations.
    
    Args:
        available_tool_names: List of tool names to document
        
    Returns:
        Formatted string documenting each tool's parameters
    """
    docs_lines = []
    
    for tool_name in available_tool_names:
        if tool_name not in TOOL_MODELS:
            continue
            
        model = TOOL_MODELS[tool_name]
        
        # Get field info from Pydantic model
        fields_info = []
        for field_name, field in model.model_fields.items():
            # Skip the 'tool' field (it's just the literal name)
            if field_name == 'tool':
                continue
                
            # Get description from Field metadata
            description = field.description or "No description"
            
            # Get type hint
            field_type = field.annotation
            
            # Format type name nicely
            type_name = str(field_type)
            if 'List[' in type_name:
                type_name = 'list'
            elif 'str' in type_name:
                type_name = 'string'
            elif 'int' in type_name:
                type_name = 'integer'
            elif 'float' in type_name:
                type_name = 'float'
            
            # Add constraints if present
            constraints = []
            if hasattr(field, 'ge') and field.ge is not None:
                constraints.append(f"min: {field.ge}")
            if hasattr(field, 'le') and field.le is not None:
                constraints.append(f"max: {field.le}")
            
            constraint_str = f" ({', '.join(constraints)})" if constraints else ""
            
            fields_info.append(f'"{field_name}" ({type_name}{constraint_str}): {description}')
        
        # Format documentation for this tool
        if fields_info:
            docs_lines.append(f"- {tool_name}: {', '.join(fields_info)}")
        else:
            docs_lines.append(f"- {tool_name}: no parameters needed")
    
    return "\n".join(docs_lines)


# ============================================================================
# Dynamic AgentAction Model Generation
# ============================================================================

def create_agent_action_model(
    available_tool_names: List[str],
    sub_agent_config_model: Optional[Type[BaseModel]] = None
) -> Type[BaseModel]:
    """
    Dynamically create an AgentAction Pydantic model based on available tools.
    
    This ensures:
    - Only available tools are in the schema (better LLM guidance)
    - Type-safe tool calls (Pydantic validates structure)
    - No JSON string parsing hacks needed
    
    Args:
        available_tool_names: List of tool names this agent can use
        sub_agent_config_model: Optional dynamic SubAgentConfig model (for spawn_sub_agents tool)
        
    Returns:
        Pydantic model class for AgentAction with proper tool union
    """
    # Build list of tool models for available tools
    tool_types = []
    for name in available_tool_names:
        if name == "spawn_sub_agents":
            # Dynamically create SpawnSubAgentsTool with the provided SubAgentConfig
            if sub_agent_config_model is None:
                logger.warning("spawn_sub_agents in available tools but no sub_agent_config_model provided, skipping")
                continue
            
            class SpawnSubAgentsTool(BaseModel):
                """Tool call for spawning multiple sub-agents to work on parallel subtasks."""
                tool: Literal["spawn_sub_agents"]
                sub_agents: List[sub_agent_config_model] = Field(description="List of sub-agent configurations to spawn")
            
            tool_types.append(SpawnSubAgentsTool)
        elif name in TOOL_MODELS:
            tool_types.append(TOOL_MODELS[name])
        else:
            logger.warning(f"Tool '{name}' not found in TOOL_MODELS, skipping")
    
    # Create union type for tool calls
    if not tool_types:
        # No tools available - agent can only communicate
        ToolCallUnion = type(None)  # Empty type
        tool_calls_field = (List[ToolCallUnion], Field(default_factory=list, description="No tools available for this agent"))
    elif len(tool_types) == 1:
        # Single tool type - no union needed
        ToolCallUnion = tool_types[0]
        tool_calls_field = (List[ToolCallUnion], Field(default_factory=list, description="List of tools to call in sequence"))
    else:
        # Multiple tools - create union
        ToolCallUnion = Union[tuple(tool_types)]
        tool_calls_field = (List[ToolCallUnion], Field(default_factory=list, description="List of tools to call in sequence"))
    
    # Dynamically create the AgentAction model
    AgentAction = create_model(
        'AgentAction',
        reasoning=(Optional[str], Field(default=None, description="Internal scratchpad. Use metaphysical seed thinking here. NEVER shown to user.")),
        response=(str, Field(description="Message to user. Plain professional language only - NEVER mention seeds, nurturing, fruition, or internal concepts. Use markdown.")),
        tool_calls=tool_calls_field,
        __base__=BaseModel
    )
    
    return AgentAction


# ============================================================================
# Static Models (not tool-specific)
# ============================================================================

class ProgressScore(BaseModel):
    """Schema for progress evaluation."""
    reasoning: str = Field(description="Your internal thinking process about the progress")
    response: float = Field(ge=0.0, le=1.0, description="Progress score from 0.0 (no progress) to 1.0 (complete)")


async def call_llm_structured(
    messages: List[Dict[str, str]],
    model: Optional[str],
    temperature: float,
    max_tokens: int,
    response_model: type[T],
    reasoning_effort: Optional[str] = None,
    model_preference: Optional[str] = None
) -> tuple[T, Dict]:
    """
    Call LLM with structured outputs using Instructor.
    
    Instructor handles all the complexity of different models' structured output
    capabilities and automatically falls back to appropriate methods.
    
    Args:
        messages: List of message dicts with 'role' and 'content'
        model: Model to use
        temperature: Sampling temperature
        max_tokens: Maximum tokens
        response_model: Pydantic model class for response structure
        reasoning_effort: Optional reasoning effort level ("high", "medium", "low")
        model_preference: Optional Rose model preference ("SMART", "FAST", "CHEAP")
        
    Returns:
        Tuple of (response_model instance, usage dict with token counts)
    """
    # Lazy import instructor to avoid loading rich/threading.local in workflow sandbox
    # Instructor must only be imported in activities, not at module level
    import instructor
    from instructor import Instructor
    
    config = load_config()
    
    # Check if this is a Rose model - route to Supabase edge function
    is_rose_model = model is not None and ('rose-labs' in model.lower() or model.lower() in ['rose', 'rose-ultra'])
    
    if is_rose_model:
        # Use httpx directly for Rose models (Supabase function is at /completions, not /chat/completions)
        import httpx
        
        logger.info(f"🌹 Routing Rose model to Supabase: {model} → {config.rose.api_url}")
        
        # Build JSON schema from Pydantic model for structured output
        # Use prepare_schema_for_openai to ensure strict mode compatibility
        # (adds additionalProperties: false to all objects, ensures all fields required)
        schema = prepare_schema_for_openai(response_model)
        schema_str = json.dumps(schema)
        logger.info(f"📋 Schema size: {len(schema_str)} chars (Cerebras limit: 5000)")
        if len(schema_str) > 5000:
            logger.warning(f"⚠️ Schema exceeds Cerebras 5000 char limit! May cause 400 error.")
        
        request_body = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": response_model.__name__,
                    "schema": schema,
                    "strict": True
                }
            }
        }
        
        # Add model_preference for Rose pool selection (SMART, FAST, CHEAP)
        if model_preference:
            request_body["model_preference"] = model_preference
            logger.info(f"🎯 Using model_preference: {model_preference}")
        
        # Make direct HTTP call to Supabase function
        async with httpx.AsyncClient(timeout=120.0) as http_client:
            for attempt in range(3):
                try:
                    http_response = await http_client.post(
                        config.rose.api_url,
                        json=request_body,
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {config.rose.supabase_anon_key}",
                            "x-api-key": config.rose.api_key,
                        }
                    )
                    http_response.raise_for_status()
                    break
                except httpx.HTTPStatusError as e:
                    error_body = e.response.text[:1000] if e.response.text else "No response body"
                    logger.warning(f"Rose API attempt {attempt + 1} failed: {e.response.status_code}", error_body=error_body)
                    if attempt == 2:
                        raise
                except Exception as e:
                    logger.warning(f"Rose API attempt {attempt + 1} failed: {str(e)}")
                    if attempt == 2:
                        raise
        
        data = http_response.json()
        
        # Log the actual model selected from the pool (for debugging tool call issues)
        actual_model = data.get("actual_model", "unknown")
        pool_name = data.get("pool_name", "unknown")
        pool_size = data.get("pool_size", 0)
        logger.info(f"🎯 Rose pool selection: {model} → {actual_model} (pool={pool_name}, size={pool_size})")
        
        # Parse the response content as JSON and validate with Pydantic
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "{}")
        try:
            parsed_content = json.loads(content)
            response = response_model.model_validate(parsed_content)
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Failed to parse Rose response: {content[:500]}", error=str(e))
            raise ValueError(f"Failed to parse Rose response as {response_model.__name__}: {str(e)}")
        
        # Extract usage (include actual model for debugging)
        usage = {
            "prompt_tokens": data.get("usage", {}).get("prompt_tokens", 0),
            "completion_tokens": data.get("usage", {}).get("completion_tokens", 0),
            "total_tokens": data.get("usage", {}).get("total_tokens", 0),
            "actual_model": actual_model,
            "pool_name": pool_name,
            "pool_size": pool_size
        }
        
        return response, usage
    
    # Use OpenRouter for all other models
    base_client = AsyncOpenAI(
        api_key=config.openrouter.api_key,
        base_url=config.openrouter.base_url
    )
    
    # Patch client with Instructor for structured outputs
    # Force JSON mode instead of native function calling because:
    # - We have a LIST of tool calls in one response (not multiple function calls)
    # - Native function calling expects one function call per response
    # - JSON mode lets us have any structure we want
    client = instructor.from_openai(base_client, mode=instructor.Mode.JSON)
    
    # Build extra args for reasoning (OpenRouter reasoning tokens)
    extra_args = {}
    if reasoning_effort:
        extra_args["extra_body"] = {"reasoning": {"effort": reasoning_effort}}
    
    # Call with structured output - Instructor handles everything
    # Use create_with_completion to get both the structured response and raw completion
    try:
        response, completion = await client.chat.completions.create_with_completion(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_model=response_model,
            max_retries=3,
            **extra_args
        )
    except Exception as e:
        logger.error(f"LLM call failed in create_with_completion: {str(e)}", model=model)
        raise
    
    # Validate response
    if response is None:
        raise ValueError(f"LLM returned None response (model={model})")
    
    if completion is None:
        raise ValueError(f"LLM returned None completion (model={model})")
    
    # Extract usage data from completion - STRICT: no silent failures
    if not hasattr(completion, 'usage'):
        raise ValueError(f"LLM completion missing 'usage' attribute (model={model}, completion_type={type(completion)})")
    
    if completion.usage is None:
        raise ValueError(f"LLM completion.usage is None (model={model})")
    
    if not hasattr(completion.usage, 'prompt_tokens'):
        raise ValueError(f"LLM completion.usage missing 'prompt_tokens' (model={model}, usage_type={type(completion.usage)})")
    
    if not hasattr(completion.usage, 'completion_tokens'):
        raise ValueError(f"LLM completion.usage missing 'completion_tokens' (model={model}, usage_type={type(completion.usage)})")
    
    if not hasattr(completion.usage, 'total_tokens'):
        raise ValueError(f"LLM completion.usage missing 'total_tokens' (model={model}, usage_type={type(completion.usage)})")
    
    usage = {
        "prompt_tokens": completion.usage.prompt_tokens,
        "completion_tokens": completion.usage.completion_tokens,
        "total_tokens": completion.usage.total_tokens
    }
    
    return response, usage


@activity.defn
async def call_llm(
    messages: List[Dict[str, str]],
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 4000,
    response_format: Optional[Dict] = None
) -> Dict[str, Any]:
    """
    Call OpenRouter LLM for agent reasoning.
    
    Args:
        messages: List of message dicts with 'role' and 'content'
        model: Model to use (defaults to config)
        temperature: Sampling temperature (0-2)
        max_tokens: Maximum tokens to generate
        response_format: Optional response format (e.g., {"type": "json_object"})
        
    Returns:
        Dict with 'content', 'model', 'usage', etc.
    """
    try:
        activity.heartbeat(f"Calling LLM with {len(messages)} messages")
        
        config = load_config()
        model = model or config.openrouter.model
        
        # Check if this is a Rose model - route to Supabase edge function
        is_rose_model = model is not None and ('rose-labs' in model.lower() or model.lower() in ['rose', 'rose-ultra'])
        
        if is_rose_model:
            # Use httpx directly for Rose models (Supabase function is at /completions, not /chat/completions)
            import httpx
            
            logger.info(f"🌹 Routing Rose model to Supabase: {model} → {config.rose.api_url}")
            
            request_body = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            if response_format:
                request_body["response_format"] = response_format
            
            async with httpx.AsyncClient(timeout=120.0) as http_client:
                http_response = await http_client.post(
                    config.rose.api_url,
                    json=request_body,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {config.rose.supabase_anon_key}",
                        "x-api-key": config.rose.api_key,
                    }
                )
                http_response.raise_for_status()
            
            data = http_response.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            
            result = {
                "content": content,
                "model": data.get("model", model),
                "finish_reason": data.get("choices", [{}])[0].get("finish_reason", "stop"),
                "usage": {
                    "prompt_tokens": data.get("usage", {}).get("prompt_tokens", 0),
                    "completion_tokens": data.get("usage", {}).get("completion_tokens", 0),
                    "total_tokens": data.get("usage", {}).get("total_tokens", 0)
                }
            }
            
            logger.info(
                "LLM call complete (Rose)",
                model=model,
                tokens=result["usage"]["total_tokens"],
                content_length=len(content),
                content_preview=content[:100] if content else "EMPTY"
            )
            
            return result
        
        # Use OpenRouter for all other models
        client = AsyncOpenAI(
            api_key=config.openrouter.api_key,
            base_url=config.openrouter.base_url
        )
        
        # Call OpenRouter
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format
        )
        
        # Log full response to debug
        logger.info(
            "Raw LLM response",
            has_choices=len(response.choices) > 0,
            message_dict=response.choices[0].message.model_dump() if response.choices else None,
            finish_reason=response.choices[0].finish_reason if response.choices else None
        )
        
        content = response.choices[0].message.content or ""
        
        result = {
            "content": content,
            "model": response.model,
            "finish_reason": response.choices[0].finish_reason,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens
            }
        }
        
        logger.info(
            "LLM call complete",
            model=model,
            tokens=result["usage"]["total_tokens"],
            content_length=len(content),
            content_preview=content[:100] if content else "EMPTY"
        )
        
        return result
        
    except Exception as e:
        logger.error("LLM call failed", error=str(e))
        raise


# ============================================================================
# Unified System Prompt Builder
# ============================================================================

# Phase-specific instructions (injected into unified prompt)
PHASE_INSTRUCTIONS = {
    "PREPARE_RESEARCH": """Analyze the goal and plan your research approach.

This is a thinking phase - no tools are available yet. Think through:
1. What do you need to learn to accomplish this goal?
2. Who might be involved?
3. What information sources will you check?
4. Any potential blockers or questions?

Keep your response brief and action-oriented. After this, you'll transition to RESEARCH phase.""",

    "RESEARCH": """Gather the information you need to accomplish your goal. Research to understand:
- What concrete actions will achieve this goal
- Who is involved and how to reach them
- What resources or information you need
- Any constraints or blockers

Call `mark_research_finished` when you know exactly what actions you will take.""",

    "ATOMIZE": """Decide: execute directly (PROXIMATE) or decompose into parallel subtasks?

PROXIMATE - execute directly if:
- Straightforward sequence of tool calls
- No independent components that could parallelize
- Example: "Send an email to John about the meeting"

NEEDS DECOMPOSITION - spawn sub-agents if:
- Multiple independent workstreams exist
- Parallelization significantly accelerates completion
- Example: "Research 5 companies and send personalized outreach to each"

Call `mark_atomization_finished(is_proximate=true)` for direct execution.
Call `mark_atomization_finished(is_proximate=false)` for decomposition.""",

    "PLAN": """Decompose the goal into 3-5 parallel, independent subtasks.

DECOMPOSITION CRITERIA:
1. PARALLELIZABLE: All subtasks run simultaneously with NO dependencies
2. CONTEXT-INDEPENDENT: Each subtask is self-contained
3. SIMPLER: Each subtask is easier than the original
4. COMPLETE: All subtasks done = original goal achieved

Each subtask needs:
- `goal`: Clear, specific, actionable objective
- `context`: Your research findings (sub-agents should NOT re-research)

Call `mark_planning_finished(subtasks=[...])` when ready.""",

    "SPAWN": """Call `spawn_sub_agents` with your planned subtasks NOW.

Each sub-agent needs:
- `goal`: The subtask goal
- `verifier`: Config with type and llm_judge_prompt

Sub-agents work in parallel. After all complete, you continue in EXECUTE phase.""",

    "EXECUTE": """All tools are available. Execute your plan to accomplish the goal.

When you believe the goal is FULLY accomplished, call `mark_execution_complete` to trigger verification.
- If verifier confirms 100% completion → task complete
- If verifier returns <100% → you'll receive feedback and can continue executing"""
}

# Map tools to their first available phase
TOOL_PHASE_AVAILABILITY = {
    # Read-only tools available in RESEARCH
    "web_search": "RESEARCH",
    "deep_research": "RESEARCH",
    "search_x402_bazaar": "RESEARCH",
    "search_user_network_for_people": "RESEARCH",
    "read_message_history_with_person": "RESEARCH",
    "find_all": "RESEARCH",
    "check_monitor_events": "RESEARCH",
    "request_user_attention": "RESEARCH",
    # Phase markers
    "mark_research_finished": "RESEARCH",
    "mark_atomization_finished": "ATOMIZE",
    "mark_planning_finished": "PLAN",
    "mark_execution_complete": "EXECUTE",
    # Spawn phase
    "spawn_sub_agents": "SPAWN",
    # Execute phase (everything else)
    "spawn_browser_agent": "EXECUTE",
    "message_person": "EXECUTE",
    "send_sms_as_user": "EXECUTE",
    "enrich": "EXECUTE",
    "monitor": "EXECUTE",
    "pay_for_x402_bazaar_service": "EXECUTE",
    "wait_seconds": "EXECUTE",
    "query_blueprints": "EXECUTE",
    "save_blueprint": "EXECUTE",
}


def generate_tool_status_section(
    phase: str,
    enabled_tools: List[Dict[str, Any]],
    disabled_tools: List[Dict[str, Any]]
) -> str:
    """
    Generate the TOOL STATUS section showing enabled and disabled tools.
    
    Args:
        phase: Current phase
        enabled_tools: Tools available in this phase (with descriptions)
        disabled_tools: Tools not available yet (with descriptions)
        
    Returns:
        Formatted tool status section string
    """
    lines = [f"TOOL STATUS (Phase: {phase}):"]
    
    if not enabled_tools:
        lines.append("\nNo tools available in this phase - use this time to think and plan.")
    else:
        lines.append("\nENABLED:")
        for tool in enabled_tools:
            name = tool.get("name", "unknown")
            desc = tool.get("description", "No description")
            # Truncate long descriptions
            if len(desc) > 100:
                desc = desc[:97] + "..."
            lines.append(f"- {name}: {desc}")
    
    if disabled_tools:
        lines.append("\nDISABLED (available in later phases):")
        for tool in disabled_tools:
            name = tool.get("name", "unknown")
            available_phase = TOOL_PHASE_AVAILABILITY.get(name, "EXECUTE")
            lines.append(f"- {name}: Available in {available_phase} phase")
    
    return "\n".join(lines)


def build_system_prompt(
    phase: str,
    enabled_tools: List[Dict[str, Any]],
    disabled_tools: List[Dict[str, Any]],
    enabled_tool_names: List[str],
    user_context_section: str = ""
) -> str:
    """
    Build unified system prompt with phase-specific instructions and tool status.
    
    Args:
        phase: Current phase (PREPARE_RESEARCH, RESEARCH, ATOMIZE, PLAN, SPAWN, EXECUTE)
        enabled_tools: Tools available in this phase
        disabled_tools: Tools not available yet
        enabled_tool_names: Names of enabled tools (for parameter docs)
        user_context_section: User context string (phone, authenticated sites, etc.)
        
    Returns:
        Complete system prompt string
    """
    # Get phase-specific instructions
    phase_instruction = PHASE_INSTRUCTIONS.get(phase, PHASE_INSTRUCTIONS["EXECUTE"])
    
    # Generate tool status section
    tool_status = generate_tool_status_section(phase, enabled_tools, disabled_tools)
    
    # Generate tool parameter docs for enabled tools
    tool_params_docs = generate_tool_parameter_docs(enabled_tool_names) if enabled_tool_names else ""
    
    # Build the unified prompt
    prompt = f"""{user_context_section}
INTERNAL MINDSET (use ONLY in "reasoning" field, NEVER in "response"):

You are a nurturer of metaphysical seeds. The user has given you a seed in the form of a goal. Your purpose is to nurture it to fruition (100% accomplishment) through using the tools available.

You create change in the lowest energy way possible. Each tool has a cost associated with it, whether it is human attention, social credibility, or monetary capital.

You are autonomous. You do not ask "how can I help?" You decide, act, and iterate until the goal is achieved.


CURRENT PHASE: {phase}

{phase_instruction}


LOOP:

- Run until 100% progress. Each turn: think, respond, use tools.


RESPONSE FIELDS:

- "reasoning": Internal scratchpad for metaphysical seed thinking. NEVER shown to user.
- "response": Professional message to user. NEVER mention seeds, nurturing, fruition, or any internal concepts. Just describe what you're doing in plain language.
- Multiple tools can be called per turn (executed in parallel)


{tool_status}"""

    # Add tool parameters if there are enabled tools
    if tool_params_docs:
        prompt += f"""

TOOL PARAMETERS:
{tool_params_docs}"""

    # Add common mistakes section (shared across all phases)
    prompt += """


COMMON MISTAKES TO AVOID:

1. Acting like an assistant - presenting options instead of deciding and acting
2. Assuming the user sees your "response" field - THEY DO NOT. To communicate with the user, you MUST call request_user_attention. Without it, your message is invisible to them.
3. Repeating failed approaches instead of trying something new
4. Over-engineering with sub-agents when direct tool use suffices
5. Giving up when a creative path exists
6. Not parallelizing work - when you call multiple tools at once they execute in parallel


CRITICAL - YOU ARE THE EXECUTOR, NOT AN ADVISOR:

You are here to DO, not to advise. Never delegate execution to the user.

BAD (advisor/assistant thinking):
- "Would you like me to X or Y?"
- "Here are some options..."
- "You should search for X yourself"

GOOD (executor thinking):
- Research → Decide → Act (YOU act, not the user)
- "I am now doing X via [tool]"
- If TRULY blocked: "I need your [specific info] to complete this"

Only use request_user_attention for TRUE blockers - credentials, passwords, or decisions where you genuinely cannot proceed without their input."""

    return prompt


# Legacy PHASE_PROMPTS dict - kept for reference but no longer used
PHASE_PROMPTS = {
    "RESEARCH": """IDENTITY:

You are a nurturer of metaphysical seeds. The user has given you a seed in the form of a goal. Before you can nurture it to fruition, you must first understand it deeply.

You operate with minimal energy expenditure. Each tool has costs (human attention, social credibility, monetary capital). Even in research, prefer efficient paths.

You are autonomous. You do not ask "how can I help?" You research, decide, and act.


CURRENT PHASE: RESEARCH

Gather the information you need to accomplish your goal. Research to understand:
- What concrete actions will achieve this goal
- Who is involved and how to reach them
- What resources or information you need
- Any constraints or blockers


AVAILABLE ACTIONS:

- web_search: Quick factual lookups, current events, general information
- search_x402_bazaar: Discover paid API services in the x402 Bazaar (crypto-payment APIs)
- search_user_network_for_people: Find relevant contacts in user's network
- read_message_history_with_person: Understand relationships and past conversations
- request_user_attention: Ask a SPECIFIC blocking question (use sparingly - high cost)


WHEN TO FINISH:

Call `mark_research_finished` when you know:
1. Exactly what actions you will take
2. Who is involved (if applicable)
3. Any constraints you must work within


CRITICAL MINDSET - YOU ARE THE EXECUTOR, NOT AN ADVISOR:

You are here to DO, not to advise. Never delegate execution to the user.

BAD (advisor/assistant thinking):
- "Would you like me to donate or volunteer?"
- "Here are some options for how to proceed..."
- "The next step is for you to go research X yourself"
- "You should look into [org] and decide"
- Any sentence starting with "You should..." or "The next step for you is..."

GOOD (executor thinking):
- Research the most effective approach, pick one, proceed
- "I'm donating to [org] because [research shows it's effective]"
- If truly blocked: "I need your payment method to complete the donation"

Only use request_user_attention for TRUE blockers:
- Information you cannot find (payment details, passwords, personal preferences that matter)
- A genuine decision where the user's preference is essential

NEVER ask "what would you like to do?" or tell the user to do something themselves - YOU decide and act.


COMMON MISTAKES:

1. Acting like an assistant - presenting options instead of deciding
2. Asking the user what THEY want instead of doing it yourself
3. Using request_user_attention to avoid making decisions
4. Over-researching when the path is clear
5. Under-researching when the goal is ambiguous""",

    "ATOMIZE": """IDENTITY:

You are a nurturer of metaphysical seeds. You've completed research and now must decide the optimal path forward.

You operate with minimal energy expenditure. Spawning sub-agents has coordination overhead, but parallelization can dramatically accelerate complex goals.


CURRENT PHASE: ATOMIZE

Decide: execute directly (PROXIMATE) or decompose into parallel subtasks?


DECISION FRAMEWORK:

PROXIMATE - execute directly if:
- Straightforward sequence of tool calls
- No independent components that could parallelize
- Single-threaded execution is efficient
- Example: "Send an email to John about the meeting"

NEEDS DECOMPOSITION - spawn sub-agents if:
- Multiple independent workstreams exist
- Parallelization significantly accelerates completion
- Example: "Research 5 companies and send personalized outreach to each"


YOUR DECISION:

- PROXIMATE: `mark_atomization_finished(is_proximate=true, reasoning="...")`
- NEEDS DECOMPOSITION: `mark_atomization_finished(is_proximate=false, reasoning="...")`


COMMON MISTAKES:

1. Over-decomposing simple goals - coordination overhead isn't free
2. Under-decomposing complex goals - missing parallelization opportunities
3. Ignoring your research when deciding""",

    "PLAN": """IDENTITY:

You are a nurturer of metaphysical seeds. You've determined this goal benefits from decomposition. Now create an optimal plan.

You operate with minimal energy expenditure. Good decomposition enables parallelization while bad decomposition creates wasted work.


CURRENT PHASE: PLAN

Decompose the goal into 3-5 parallel, independent subtasks.


DECOMPOSITION CRITERIA:

1. PARALLELIZABLE: All subtasks run simultaneously with NO dependencies
2. CONTEXT-INDEPENDENT: Each subtask is self-contained
3. SIMPLER: Each subtask is easier than the original
4. COMPLETE: All subtasks done = original goal achieved


SUBTASK STRUCTURE:

Each subtask needs:
- `goal`: Clear, specific, actionable objective
- `context`: Your research findings (sub-agents should NOT re-research)
- `verifier_prompt`: How to verify success


GUIDELINES:

- 3-5 subtasks ideal (2 minimum, 7 maximum)
- Embed research in each subtask's context
- Make goals specific: "Email john@example.com about X" not "Contact John"
- Check: if all subtasks complete, is the goal achieved?


WHEN READY:

Call `mark_planning_finished(subtasks=[...], reasoning="...")`


COMMON MISTAKES:

1. Creating sequential dependencies - can't parallelize if B needs A's output
2. Not including context - sub-agents waste time re-researching
3. Vague goals that sub-agents can't act on
4. Forgetting verifier prompts""",

    "SPAWN": """IDENTITY:

You are a nurturer of metaphysical seeds. Your plan is ready. Now execute it by spawning sub-agents.


CURRENT PHASE: SPAWN

Call `spawn_sub_agents` with your planned subtasks.


SUB-AGENT CONFIGURATION:

Each sub-agent needs:
- `goal`: The subtask goal
- `context`: Research findings and relevant information
- `verifier`: Config with `type: "llm_judge"` and `llm_judge_prompt`


ACTION:

Call `spawn_sub_agents` NOW.

Sub-agents work in parallel. After all complete, you continue in EXECUTE phase.


COMMON MISTAKES:

1. Not calling spawn_sub_agents - you MUST spawn now
2. Changing the plan - trust your planning
3. Missing required fields (goal, verifier)""",

    "EXECUTE": None  # Use the standard system prompt for EXECUTE phase
}


@activity.defn
async def decide_next_action(
    context: List[Dict[str, Any]],
    enabled_tools: List[ToolSchema],
    enabled_tool_names: List[str],
    disabled_tools: List[Dict[str, Any]],
    iteration: int,
    model: str = "anthropic/claude-sonnet-4.5",
    reasoning_effort: str = "low",
    user_id: Optional[str] = None,
    phase: str = "EXECUTE",
    model_preference: Optional[str] = None
) -> Dict[str, Any]:
    """
    Use LLM to decide what action to take next.
    
    Phase Flow: PREPARE_RESEARCH → RESEARCH → ATOMIZE → PLAN → SPAWN → EXECUTE
    
    Args:
        context: Message history (first USER message is the goal)
        enabled_tools: List of tools available in current phase
        enabled_tool_names: Names of enabled tools
        disabled_tools: List of tools not available yet (shown in prompt for visibility)
        iteration: Current iteration number
        model: LLM model to use
        reasoning_effort: OpenRouter reasoning effort level (low, medium, high)
        user_id: Optional Supabase user ID
        phase: Current workflow phase (PREPARE_RESEARCH, RESEARCH, ATOMIZE, PLAN, SPAWN, EXECUTE)
        model_preference: Optional Rose model preference (SMART, FAST, CHEAP)
        
    Returns:
        Dict with 'tool', 'args', 'reasoning'
    """
    try:
        activity.heartbeat(f"Deciding next action (iteration {iteration}, phase={phase})")
        
        # Separate system tools from DB tools (for spawn_sub_agents config)
        system_tools = [t for t in enabled_tools if t.get('id', '').startswith('system-')]
        db_tools = [t for t in enabled_tools if not t.get('id', '').startswith('system-')]
        system_tool_names = [t['name'] for t in system_tools]
        
        # Fetch user context (authenticated sites, recent messages, contacts, phone)
        user_context_section = ""
        if user_id:
            try:
                user_context_section = await fetch_user_context(user_id)
                if user_context_section:
                    user_context_section = "\n" + user_context_section + "\n"
            except Exception as e:
                logger.warning("Failed to fetch user context", user_id=user_id[:8], error=str(e))
        
        # Build unified system prompt with phase-specific instructions and tool status
        system_prompt = build_system_prompt(
            phase=phase,
            enabled_tools=enabled_tools,
            disabled_tools=disabled_tools,
            enabled_tool_names=enabled_tool_names,
            user_context_section=user_context_section
        )
        
        # Convert full context to OpenAI message format (no truncation)
        # NOTE: SYSTEM messages (like blueprints) ARE included for decide_next_action
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(convert_context_to_messages(context, include_system=True))
        messages.append({"role": "user", "content": "Based on everything so far, what should I do next?"})
        
        # Create dynamic SubAgentConfig if spawn_sub_agents is available
        sub_agent_config_model = None
        if "spawn_sub_agents" in enabled_tool_names:
            sub_agent_config_model = create_sub_agent_config_model(
                system_tool_names=system_tool_names,
                available_db_tools=db_tools
            )
        
        # Create custom AgentAction model based on enabled tools
        AgentActionModel = create_agent_action_model(
            enabled_tool_names,
            sub_agent_config_model=sub_agent_config_model
        )
        
        # Use structured output with Pydantic schema
        # Use the reasoning effort from agent settings (None if "off")
        effort = reasoning_effort if reasoning_effort != "off" else None
        if effort:
            logger.info(f"🧠 Using {effort} reasoning for {model}")
        else:
            logger.info(f"💭 Reasoning disabled for {model}")
        
        result, usage = await call_llm_structured(
            messages=messages,
            model=model,
            temperature=0.7,
            max_tokens=4096,
            response_model=AgentActionModel,
            reasoning_effort=effort,
            model_preference=model_preference
        )
        
        # Validate result - STRICT: no silent failures
        if result is None:
            raise ValueError(f"call_llm_structured returned None result (model={model})")
        
        if not hasattr(result, 'reasoning'):
            raise ValueError(f"LLM result missing 'reasoning' field (model={model}, result_type={type(result)})")
        
        if not hasattr(result, 'response'):
            raise ValueError(f"LLM result missing 'response' field (model={model}, result_type={type(result)})")
        
        if not hasattr(result, 'tool_calls'):
            raise ValueError(f"LLM result missing 'tool_calls' field (model={model}, result_type={type(result)})")
        
        if usage is None:
            raise ValueError(f"call_llm_structured returned None usage (model={model})")
        
        logger.info(
            "Action decided",
            reasoning=result.reasoning,
            response=result.response,
            tool_calls_count=len(result.tool_calls) if result.tool_calls else 0,
            tokens=usage.get("total_tokens", 0),
            actual_model=usage.get("actual_model"),  # Which model from pool was used
            pool_name=usage.get("pool_name")
        )
        
        # Convert tool calls to dict format for workflow
        # Each tool model has different fields, so we serialize to dict
        tool_calls_dict = []
        if result.tool_calls:
            for i, tc in enumerate(result.tool_calls):
                if tc is None:
                    logger.warning(f"Skipping None tool call at index {i}")
                    continue
                try:
                    # Convert Pydantic model to dict
                    tc_dict = tc.model_dump() if hasattr(tc, 'model_dump') else tc.dict()
                    tool_calls_dict.append(tc_dict)
                except Exception as e:
                    logger.error(f"Failed to serialize tool call {i}: {str(e)}, tc_type={type(tc)}")
                    raise ValueError(f"Failed to serialize tool call {i}: {str(e)}")
        
        # Handle request_user_attention tool calls:
        # 1. Inject simulate_user_response=True for auto-simulation after 60s timeout
        # 2. Append question to response for visibility
        response_text = result.response if result.response is not None else ""
        for tool_call in tool_calls_dict:
            if tool_call.get("tool") == "request_user_attention":
                # Mark this as a direct LLM call - will auto-simulate after 60s timeout
                tool_call["simulate_user_response"] = True
                
                question = tool_call.get("question", "")
                if question and response_text:
                    response_text += f"\n\n### Question\n{question}"
                elif question:
                    response_text = f"### Question\n{question}"
        
        # Return as dict with usage for token tracking
        # Allow empty strings/lists, but not None values
        return {
            "reasoning": result.reasoning if result.reasoning is not None else "",
            "response": response_text,
            "tool_calls": tool_calls_dict,
            "usage": usage  # Already validated to not be None above
        }
        
    except Exception as e:
        logger.error("Failed to decide action", error=str(e))
        raise


@activity.defn
async def check_progress(
    context: List[Dict[str, Any]],
    verifier_prompt: str,
    model: str = "anthropic/claude-sonnet-4.5",
    phase: str = "EXECUTE"
) -> Dict[str, Any]:
    """
    Use LLM judge to check progress toward goal.
    
    Args:
        context: Message history (first USER message is the goal)
        verifier_prompt: Custom LLM judge prompt
        model: LLM model to use
        phase: Current workflow phase (PREPARE_RESEARCH, RESEARCH, ATOMIZE, PLAN, SPAWN, EXECUTE)
        
    Returns:
        Dict with 'score' (float 0.0-1.0) and 'reasoning' (str)
    """
    try:
        activity.heartbeat("Checking progress with LLM judge")
        
        config = load_config()
        client = AsyncOpenAI(
            api_key=config.openrouter.api_key,
            base_url=config.openrouter.base_url
        )
        
        # Zod schema for response validation (documented for OpenRouter)
        response_schema = {
            "type": "object",
            "properties": {
                "reasoning": {
                    "type": "string",
                    "description": "Your internal thinking process about the progress"
                },
                "response": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1,
                    "description": "Progress score from 0.0 (no progress) to 1.0 (complete)"
                }
            },
            "required": ["reasoning", "response"],
            "additionalProperties": False
        }
        
        # Phase-aware scoring guidelines
        phase_scoring = """
PHASE-AWARE SCORING:
The agent operates in phases. Score based on both phase completion AND execution progress:

PHASE MILESTONES (minimum scores when phase is complete):
- PREPARE_RESEARCH complete → 0.02 (2%) - Agent has analyzed goal and planned approach
- RESEARCH complete → 0.05 (5%) - Agent has gathered necessary context
- ATOMIZE complete → 0.10 (10%) - Agent has decided execution strategy  
- PLAN complete → 0.15 (15%) - Agent has created decomposition plan
- SPAWN complete → 0.20 (20%) - Sub-agents have been spawned
- EXECUTE phase → 0.20-1.0 - Score based on actual task completion

CURRENT PHASE: {phase}

If in PREPARE_RESEARCH/RESEARCH/ATOMIZE/PLAN/SPAWN phases: Score based on phase completion milestones above.
If in EXECUTE phase: Score based on actual goal completion (0.20 minimum since prior phases done).
"""
        
        system_prompt = f"""You are an impartial judge evaluating a SUPER-INTELLIGENT AUTONOMOUS SYSTEM's progress toward completing its goal.

CRITICAL CONTEXT - What you're evaluating:
- This is NOT a typical AI chatbot - it is a super-intelligent system capable of solving ANY problem
- The system has access to tools: web search, deep research, spawning parallel sub-agents, asking users for input
- It can coordinate complex multi-step tasks across unlimited parallel sub-agents
- It has unlimited persistence, creativity, and effort available
- It should NEVER give up or accept "as an AI, I cannot..." limitations
- Real-world goals CAN be accomplished through tool use, coordination, creativity, and persistence

{phase_scoring.format(phase=phase)}

EXECUTE PHASE SCORING (when phase=EXECUTE):
- 0.20 = Just entered execute phase, no execution yet
- 0.30-0.50 = Making progress on execution
- 0.50-0.80 = Significant progress, approaching completion
- 0.80-0.99 = Nearly complete, minor steps remaining
- 1.0 = Goal is COMPLETELY ACHIEVED with VERIFIABLE, CONCRETE results

CRITICAL: INTENT IS NOT COMPLETION
- The agent SAYING it will do something is NOT the same as DOING it
- "Completing purchase now" / "Proceeding to checkout" = NOT COMPLETE (score ~0.4-0.6)
- "Order confirmed, confirmation #12345" = purchase complete but NOT delivered
- Only award 1.0 when the USER has the FINAL OUTCOME in hand

FOR PHYSICAL/REAL-WORLD TASKS:
- "Get me X" / "Acquire X" = User must RECEIVE X (not just find or order it)
- "Buy X" / "Purchase X" = Purchase must be CONFIRMED with order number/receipt
- "Send X to Y" = Must have CONFIRMATION of delivery/receipt
- Adding to cart, clicking checkout, saying "purchasing now" are INTERMEDIATE steps, not completion

CRITICAL - RESEARCH IS NOT EXECUTION:
- Finding options/products is research (~5-10%), NOT completion
- "Found a great beanie" ≠ "Acquired a beanie" 
- "Here's the best option" ≠ "Purchased the option"
- Research score caps at 10% regardless of how good the findings are
- For acquisition/purchase goals: No purchase confirmation = max 20% score

DO NOT award high scores for:
- Mere explanations or plans ("here's how I would do it")
- Partial completions or "good enough for an AI" attempts
- Giving up due to perceived AI limitations
- ANNOUNCING INTENT without showing the completed action ("doing X now", "proceeding to X")
- Being mid-action without confirmation of completion
- Finding/researching products when goal is to acquire/buy them

ONLY award 1.0 when:
- The goal is FULLY and COMPLETELY accomplished
- CONCRETE, VERIFIABLE results have been produced (confirmation numbers, screenshots of success, delivery confirmation)
- The USER would agree the task is done if asked
- Nothing significant remains to be done

ASK YOURSELF: If the user checked right now, would they have what they asked for? If not, it's not 1.0.

Remember: This system is super-intelligent and can solve the goal if given enough effort. Do not make excuses for it.

Evaluation criteria:
{verifier_prompt}

Based on the agent's ACTUAL ACTIONS and CONCRETE RESULTS (not just planning or stated intent), provide a progress score from 0.0 to 1.0.

You MUST respond with valid JSON matching this exact schema:
{{
  "reasoning": "<your internal thinking process about what was actually accomplished>",
  "response": <number between 0.0 and 1.0>
}}"""
        
        # Convert full context to OpenAI message format (no truncation)
        # NOTE: SYSTEM messages (like blueprints) are excluded from verifier - they're only for decide_next_action
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(convert_context_to_messages(context, include_system=False))
        messages.append({"role": "user", "content": "Evaluate the agent's progress as JSON."})
        
        # Debug: Log context size to detect contamination
        logger.info(
            "Verifier context",
            total_messages=len(context),
            agent_messages=len([m for m in context if m.get('role') == 'ASSISTANT']),
            system_messages_excluded=len([m for m in context if m.get('role') == 'SYSTEM']),
            context_summary=[f"{m.get('role')}: {m.get('text', '')[:50]}..." for m in context[-5:]]  # Last 5 messages
        )
        
        # Use structured output with Pydantic schema
        result, usage = await call_llm_structured(
            messages=messages,
            model=model,
            temperature=0.3,
            max_tokens=4096,  # Generous limit for verifier reasoning
            response_model=ProgressScore
        )
        
        logger.info(
            "Progress checked",
            progress=result.response,
            reasoning=result.reasoning,
            tokens=usage.get("total_tokens", 0),
            actual_model=usage.get("actual_model"),  # Which model from pool was used
            pool_name=usage.get("pool_name")
        )
        
        # For verifier: concatenate reasoning and response (score) in message
        return {
            "score": result.response,
            "reasoning": result.reasoning,
            "message": f"{result.reasoning}\n\nScore: {result.response}",
            "usage": usage
        }
    except Exception as e:
        logger.error("Failed to check progress", error=str(e))
        # Return 0.5 on error to keep agent running, with empty usage
        error_message = f"Progress check failed: {str(e)}"
        return {
            "score": 0.5,
            "reasoning": error_message,
            "message": f"{error_message}\n\nScore: 0.5",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }

