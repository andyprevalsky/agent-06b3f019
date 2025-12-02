"""LLM tool for agent reasoning and decision making."""

from typing import List, Dict, Optional, Any, TypeVar, Union, Type, Literal
from temporalio import activity
import structlog
import json
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, create_model
from enum import Enum

from config import load_config

logger = structlog.get_logger()

T = TypeVar('T', bound=BaseModel)


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
    Dynamically create SubAgentConfig with description based on available tools.
    
    This ensures the tool_ids description is always up-to-date with:
    - System tools that sub-agents have by default
    - DB tools that the parent agent can pass to sub-agents
    
    Args:
        system_tool_names: Names of system tools available to sub-agents (e.g., ['wait_seconds', 'request_user_attention'])
        available_db_tools: List of DB tools parent has access to (with id, name, description)
        
    Returns:
        Dynamically generated SubAgentConfig class
    """
    # Format system tools list
    system_tools_str = ", ".join(system_tool_names) if system_tool_names else "none"
    
    # Build description of DB tools available to pass
    if available_db_tools:
        db_tools_list = "\n".join([
            f'{{\n'
            f'  "tool_name": "{tool["name"]}",\n'
            f'  "tool_id": "{tool["id"]}",\n'
            f'  "tool_description": "{tool["description"]}"\n'
            f'}}'
            for tool in available_db_tools
        ])
        tool_ids_desc = (
            f"Optional list of tool IDs to give this sub-agent additional capabilities. "
            f"By default, sub-agents ONLY have these base system tools: {system_tools_str}. "
            f"To enable advanced capabilities, you MUST pass the relevant tool IDs from your available tools:\n{db_tools_list}"
        )
    else:
        tool_ids_desc = (
            f"Optional list of tool IDs. Note: You only have system tools ({system_tools_str}), so sub-agents will be limited to those base capabilities unless you pass additional tool IDs."
        )
    
    class DynamicSubAgentConfig(BaseModel):
        """Configuration for a single sub-agent."""
        goal: str = Field(description="The goal/task for this sub-agent")
        model: Optional[str] = Field(None, description="LLM model to use (inherits from parent if not specified)")
        reasoning_effort: Optional[str] = Field(None, description="Reasoning effort: 'off', 'low', 'medium', 'high'")
        tool_ids: Optional[List[str]] = Field(default_factory=list, description=tool_ids_desc)
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


class BuyItemFromAmazonTool(BaseModel):
    """Tool for searching and buying items from Amazon."""
    tool: Literal["buy_item_from_amazon"]
    item_search_query: str = Field(description="What to search for on Amazon (e.g., 'wooden shower bench', 'wireless headphones')")
    item_qualifications: Optional[str] = Field(default=None, description="Natural language description of qualities that matter (e.g., 'under $100, highly rated, many reviews', 'best value, waterproof, has storage', 'premium quality, fast shipping'). If not provided, selects best overall product.")


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
    estimated_world_power_ranking: Optional[int] = Field(None, ge=1, le=10, description="World power ranking 1-10 (1=most powerful)")
    
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


# Map tool names to their Pydantic models
# Note: spawn_sub_agents is NOT included here - it's generated dynamically in create_agent_action_model
TOOL_MODELS = {
    "wait_seconds": WaitSecondsTool,
    "web_search": WebSearchTool,
    "deep_research": DeepResearchTool,
    "buy_item_from_amazon": BuyItemFromAmazonTool,
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
        reasoning=(Optional[str], Field(default=None, description="Your internal thinking process. Do not use this field to communicate with the user or the verifier, or your future self, they will NOT see it: They will not see it! This field is only here to be used a throwaway scratchpad for your reasoning.")),
        response=(str, Field(description="Message to communicate to the user & verifier (REQUIRED - always explain what you're doing). Make sure to use markdown formatting to make your response more readable.")),
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
    reasoning_effort: Optional[str] = None
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
        schema = response_model.model_json_schema()
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


@activity.defn
async def decide_next_action(
    context: List[Dict[str, Any]],
    available_tools: List[Dict[str, str]],
    available_tool_names: List[str],
    iteration: int,
    model: str = "anthropic/claude-sonnet-4.5",
    reasoning_effort: str = "low",
    user_id: Optional[str] = None,
    user_phone: Optional[str] = None
) -> Dict[str, Any]:
    """
    Use LLM to decide what action to take next.
    
    Args:
        context: Message history (first USER message is the goal)
        available_tools: List of dicts with 'name' and 'description' for each tool
        iteration: Current iteration number
        model: LLM model to use
        reasoning_effort: OpenRouter reasoning effort level (low, medium, high)
        user_id: Optional Supabase user ID
        user_phone: Optional user's phone number (E.164 format)
        
    Returns:
        Dict with 'tool', 'args', 'reasoning'
    """
    try:
        activity.heartbeat(f"Deciding next action (iteration {iteration})")
        
        # Separate system tools from DB tools
        system_tools = [t for t in available_tools if t['id'].startswith('system-')]
        db_tools = [t for t in available_tools if not t['id'].startswith('system-')]
        
        system_tool_names = [t['name'] for t in system_tools]
        
        # Build tool list from DB descriptions (including IDs for spawn_sub_agents)
        tools_list = "\n".join([
            f"- {tool['name']} (id: {tool['id']}): {tool['description']}"
            for tool in available_tools
        ])
        
        # Generate parameter documentation dynamically from Pydantic models
        tool_params_docs = generate_tool_parameter_docs(available_tool_names)
        
        # Build user contact info section if available
        user_info_section = ""
        if user_id and user_phone:
            user_info_section = f"""
USER CONTACT INFORMATION:
- User ID: {user_id}
- Phone Number: {user_phone}

When sending SMS messages to the user, use their phone number: {user_phone}
"""
        
        system_prompt = f"""{user_info_section}
IDENTITY:

- You are a nurturer of metaphysical seeds. The user will give you a seed in the form of a goal. Your purpose is to nurture them to fruition (100% accomplishment) through using the tools available.

- You create change in the lowest energy way possible. Each tool has a cost associated with it, whether it is human attention, social credibility, or monetary capital. You are looking for the simple solution that ensures the seed flowers with 100% probabilistic certainty, while minimizing the total cost.

- Never give up. Stuck? Try a NEW approach, don't repeat yourself.


LOOP:

- Run until 100% progress. Each turn: think, respond, use tools.
- A verifier scores (0-100%) and gives feedback after each response. Use it to course-correct.

A common pattern to solving most problems effectively is going through 3 phases:

Phase 1 - Research:
Use the tools available to you to understand the nature of the goal, whether that is research tools, asking the user a question via request_user_attention, searching through the user's provided information, etc. This is where you can explicitly request_user_attention.

Phase 2 - Planning:
Given your newfound understanding of the exact thing to be accomplished, create a plan that minimizes tool costs while maximizing probability of success. For complex plans you can offload complexity to sub-agents by decomposing the goal into context-independent, parallelizable, and more proximate subgoals. Because each sub-agent has access to all the same tools you do, they can recursively break down problems as long as your decomposition is good. This is where you can explicitly request_user_attention.

Phase 3 - Implementation:
Execute your plan by using the tools available to you. As you execute your plan you will likely encounter new information that requires you to update your plan. Never change the goal that is being accomplished but do consider updating the plan if you can make a plan that is better at minimizing energy and increasing probability of success. Try to refrain from using request_user_attention here - consider the cost of using this tool to be much higher during implementation phases.


RESPONSE FIELDS:

- "reasoning": internal scratchpad (logged, not shown to user or verifier)
- "response": progress log for verifier and your future self. THE USER CANNOT SEE THIS.
- Multiple tools can be called per turn (executed sequentially)


BLUEPRINTS:

- Reference examples show how other agents solved SIMILAR tasks - use as inspiration only, not your history


COMMON MISTAKES TO AVOID:

1. Assuming the user sees your "response" field - THEY DO NOT. To communicate with the user, you MUST call request_user_attention. Without it, your message is invisible to them.
2. Repeating failed approaches instead of trying something new
3. Over-engineering with sub-agents when direct tool use suffices
4. Giving up when a creative path exists
5. Not parrallelizing work. To ensure a goal is accomplished with 100% probability, you often need to execute multiple strategies in parallel. When you call multiple tool at once they are executed in parallel, (spawning sub-agents is a form of parrallelization, for each sub-agent you create, you are executing a new thread of execution)


TOOLS:
{tools_list}

TOOL PARAMETERS:
{tool_params_docs}"""
        
        # Convert full context to OpenAI message format (no truncation)
        # NOTE: SYSTEM messages (like blueprints) ARE included for decide_next_action
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(convert_context_to_messages(context, include_system=True))
        messages.append({"role": "user", "content": "Based on everything so far, what should I do next?"})
        
        # Create dynamic SubAgentConfig if spawn_sub_agents is available
        sub_agent_config_model = None
        if "spawn_sub_agents" in available_tool_names:
            sub_agent_config_model = create_sub_agent_config_model(
                system_tool_names=system_tool_names,
                available_db_tools=db_tools
            )
        
        # Create custom AgentAction model based on available tools
        AgentActionModel = create_agent_action_model(
            available_tool_names,
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
            reasoning_effort=effort
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
        
        # Append question to response if using request_user_attention tool
        response_text = result.response if result.response is not None else ""
        for tool_call in tool_calls_dict:
            if tool_call.get("tool") == "request_user_attention":
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
    model: str = "anthropic/claude-sonnet-4.5"
) -> Dict[str, Any]:
    """
    Use LLM judge to check progress toward goal.
    
    Args:
        context: Message history (first USER message is the goal)
        verifier_prompt: Custom LLM judge prompt
        model: LLM model to use
        
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
        
        system_prompt = f"""You are an impartial judge evaluating a SUPER-INTELLIGENT AUTONOMOUS SYSTEM's progress toward completing its goal.

CRITICAL CONTEXT - What you're evaluating:
- This is NOT a typical AI chatbot - it is a super-intelligent system capable of solving ANY problem
- The system has access to tools: web search, deep research, spawning parallel sub-agents, asking users for input
- It can coordinate complex multi-step tasks across unlimited parallel sub-agents
- It has unlimited persistence, creativity, and effort available
- It should NEVER give up or accept "as an AI, I cannot..." limitations
- Real-world goals CAN be accomplished through tool use, coordination, creativity, and persistence

BE EXTREMELY STRICT in your evaluation:
- 0.0 = No progress or just starting
- 0.5 = Meaningful progress but far from complete
- 1.0 = Goal is COMPLETELY ACHIEVED with VERIFIABLE, CONCRETE results

DO NOT award high scores for:
- Mere explanations or plans ("here's how I would do it")
- Partial completions or "good enough for an AI" attempts
- Giving up due to perceived AI limitations
- Research without action, or planning without execution

ONLY award 1.0 when:
- The goal is FULLY and COMPLETELY accomplished
- CONCRETE, VERIFIABLE results have been produced
- Nothing significant remains to be done

Remember: This system is super-intelligent and can solve the goal if given enough effort. Do not make excuses for it.

Evaluation criteria:
{verifier_prompt}

Based on the agent's ACTUAL ACTIONS and CONCRETE RESULTS (not just planning), provide a progress score from 0.0 to 1.0.

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

