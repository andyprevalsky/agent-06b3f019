"""Tool schemas and dynamic models used by the LLM orchestration layer."""

from enum import Enum
from typing import Any, Dict, List, Optional, Type, Union, Literal, TYPE_CHECKING

import structlog
from pydantic import BaseModel, Field, create_model


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
    "spawn_agent",  # Unified: type=browser|code|sub_agent|explore
    "wait_for",
    "send_message_to_user_execute_phase",
    "call_phone_number",
    "message_person",
    "attempt_completion",
]

# Tools the planner can assign to tasks (what shows up in task.tool_name)
# These use separate names so the planner doesn't need to understand spawn_agent params.
# The DAG executor converts these to spawn_agent via TOOL_ALIASES.
PLANNER_ASSIGNABLE_TOOLS = [
    "spawn_explore_agent",
    "spawn_browser_agent",
    "spawn_code_agent",
    "spawn_sub_agent",
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
    spawn_sub_agent = "spawn_sub_agent"
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
    goal: str = Field(description="Brief description of task objective")
    tool_name: PlanToolName
    depends_on: List[int] = Field(default_factory=list, description="Indices of tasks this depends on (empty = no deps)")


class DependencyEntry(BaseModel):
    """A single entry in the dependencies graph."""
    task_idx: str = Field(description="The task index (0-based, as string)")
    depends_on: List[str] = Field(default_factory=list, description="List of task indices this task depends on")


class PlannerResponse(BaseModel):
    """Structured output from the planner LLM."""
    title: str = Field(description="Short plan title")
    content: str = Field(description="Markdown explanation of the plan")
    tasks: List[PlannerTask] = Field(description="List of tasks with dependencies")
    dependencies_graph: List[DependencyEntry] = Field(description="Explicit dependency DAG as list of entries")
    join: Literal["all", "any"] = Field(description="How to combine results: 'all' (AND) or 'any' (OR)")


# ============================================================================
# Individual Tool Pydantic Models
# ============================================================================


class VerifierConfig(BaseModel):
    """Verifier configuration for evaluating agent success. Requires type='FLOAT_LLM_JUDGE' and an llm_judge_prompt."""

    type: Literal["FLOAT_LLM_JUDGE"] = Field(description="Must be 'FLOAT_LLM_JUDGE'")
    llm_judge_prompt: str = Field(description="Prompt for the LLM judge to evaluate the agent's performance")


class ResponseSchemaFieldConfig(BaseModel):
    """Configuration for a single field in the output schema."""

    name: str = Field(description="Field name in snake_case")
    type: Literal["str", "int", "float", "bool", "list[str]", "list[int]", "file_pointer", "list[file_pointer]"] = Field(
        description="Field type: str, int, float, bool, list[str], list[int], file_pointer, or list[file_pointer]. "
        "IMPORTANT: If the output is a FILE (image, document, generated artifact, etc.), you MUST use 'file_pointer' or 'list[file_pointer]'. "
        "Using 'str' for file paths will NOT work - files will not be downloaded or transferred. "
        "The file_pointer type enables automatic file transfer from remote environments to persistent storage."
    )
    required: bool = Field(description="Whether this field is required in the output")
    description: str = Field(description="Brief description of what this field contains")


class ResponseSchemaConfig(BaseModel):
    """Structured output schema defining what data the agent must return when complete.

    IMPORTANT: If the agent needs to return any FILES (images, documents, screenshots,
    downloads, generated artifacts, etc.), you MUST use 'file_pointer' or 'list[file_pointer]'
    as the field type. Using 'str' for file paths will NOT work - files will not be
    transferred from remote environments."""

    fields: List[ResponseSchemaFieldConfig] = Field(
        description="List of output fields that the agent must return when complete"
    )


class SubAgentConfig(BaseModel):
    """Configuration for a single sub-agent."""

    goal: str = Field(description="Goal/task for this sub-agent")
    # model removed - always inherits from parent agent
    read_only: bool = Field(
        default=False,
        description="True if this sub-agent must stay read-only (plan-phase spawn), False for normal execution.",
    )
    verifier: VerifierConfig
    output_schema: ResponseSchemaConfig
    attachments: Optional[List[str]] = Field(
        default=None,
        description="List of filenames to pass to this sub-agent. Use the exact `original_filename` value from file_pointer objects in your context (e.g., 'rs.jpeg'). Do NOT use the file's `id` field or any other format."
    )


class WaitForTool(BaseModel):
    """Tool call for waiting until a timestamp or condition is met."""

    tool: Literal["wait_for"]
    until_timestamp: Optional[str] = Field(
        default=None,
        description="ISO 8601 timestamp to wait until (e.g., '2026-03-12T09:00:00Z'). Mutually exclusive with condition."
    )
    condition: Optional[str] = Field(
        default=None,
        description="Natural language condition to poll for (e.g., 'Bitcoin price drops below $50,000'). An explore agent will periodically check if this condition is satisfied."
    )
    check_interval_seconds: Optional[int] = Field(
        default=900,
        ge=60, le=86400,
        description="Seconds between condition checks (60-86400, default 900). Only used with condition."
    )
    max_checks: Optional[int] = Field(
        default=20,
        ge=1, le=100,
        description="Maximum number of condition checks before giving up (1-100, default 20). Only used with condition."
    )


class WebSearchTool(BaseModel):
    """Tool call for searching the web with real-time information."""

    tool: Literal["web_search"]
    query: str = Field(description="Search query or question about current/recent information")


class WebFetchTool(BaseModel):
    """Tool call for fetching and extracting content from a URL with JavaScript rendering support."""

    tool: Literal["web_fetch"]
    url: str = Field(description="URL to fetch and extract content from")
    objective: str = Field(description="What content to focus on extracting from the page")
    excerpts: bool = Field(default=True, description="Return focused excerpts aligned to objective")
    full_content: bool = Field(default=False, description="Return complete page content instead of excerpts")
    download_files: Optional[List[str]] = Field(
        default=None,
        description="File extensions to auto-download from the page (e.g. ['pdf', 'csv', 'xlsx']). Discovered URLs matching these extensions are downloaded and returned as file pointers."
    )


class GrepTool(BaseModel):
    """Search user's local data (message threads) by keyword.

    Searches iMessage and email conversation threads for matching messages.
    Returns matching messages with surrounding context (like grep -C).
    Pattern is plain text (not regex). Use empty string '' to return all messages (no filter).
    """

    tool: Literal["grep"]
    pattern: str = Field(description="Text to search for in messages (plain text, not regex). Use '' to return all messages. E.g. 'dinner', 'project update'")
    source: str = Field(default="messages", description="Data source to search. Currently only 'messages' is available.")
    person_id: Optional[str] = Field(default=None, description="Optional person identifier to scope search to one thread. Can be an email address, phone number, or full name.")
    since: Optional[str] = Field(default=None, description="ISO 8601 timestamp cutoff — only return messages after this time. E.g. '2025-06-01T00:00:00Z'. Defaults to 365 days ago.")


class PeopleSearchTool(BaseModel):
    """Tool call for searching for people using Exa's people index."""

    tool: Literal["people_search"]
    query: str = Field(description="Natural language query describing the person to find (name, role, company, skills)")
    max_results: Optional[int] = Field(default=10, ge=1, le=100, description="Maximum number of results to return")


class DeepResearchTool(BaseModel):
    """Tool call for comprehensive multi-step research on complex topics."""

    tool: Literal["deep_research"]
    query: str = Field(description="Complex research topic or question requiring in-depth analysis")
    max_tokens: Optional[int] = Field(default=4000, description="Maximum tokens for response")


class SendMessageToUserTool(BaseModel):
    """Tool for messaging the user during PLAN phase. Use is_question=true to block for clarifications, or false to broadcast plan/intention while continuing to work."""

    tool: Literal["send_message_to_user"]
    message: str = Field(description="User-visible markdown text explaining the question, blocker, or FYI.")
    is_question: bool = Field(
        default=True,
        description="True to block workflow until the user responds (clarification/approval). False to send a non-blocking FYI (e.g., sharing the plan).",
    )


class SendMessageToUserExecutePhaseTool(BaseModel):
    """Send an informational message to the user during execution (non-blocking). Use this to provide status updates or share findings."""

    tool: Literal["send_message_to_user_execute_phase"]
    message: str = Field(description="User-visible markdown text explaining what you want them to know.")


class EnableWritePermissionsTool(BaseModel):
    """Request write permissions before performing a hard write to an internet database.
    
    You MUST call this tool before:
    1. Transferring value (e.g., clicking a pay button, confirming a purchase)
    2. Publishing content (e.g., submitting a social media post, creating a listing)
    3. Transmitting messages (e.g., sending an email, SMS, or chat message)
    
    ⚠️ WARNING: If you perform any of these actions WITHOUT first calling this tool,
    you will be terminated. We don't want to terminate you!
    
    Permission is SINGLE-USE: only the immediate next action is authorized.
    Before calling this tool, ensure the state is fully prepared (all fields filled,
    page ready) so no other action is needed between permission and execution.
    
    This tool is resource-intensive - use it only when truly needed.
    """

    tool: Literal["enable_write_permissions"]
    reason: str = Field(
        description="Why write permission is needed. Be specific about what will be written/sent/paid."
    )
    action_description: str = Field(
        description="Exact description of the action that will be performed immediately after permission is granted. "
        "E.g., 'Click the Pay Now button to complete $42.99 purchase on Amazon', "
        "'Submit tweet: Hello world!', 'Send email to john@example.com with subject: Meeting tomorrow'"
    )


class SendSmsTool(BaseModel):
    """Tool call for sending SMS to a person."""

    tool: Literal["send_sms"]
    phone_number: str = Field(
        description="The phone number to send the SMS to (E.164 format, e.g., +19729777432). Use the user's phone number if sending to them."
    )
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


class MessagePersonTool(BaseModel):
    """Send a message to a person via iMessage or email. This is the ONLY tool for sending messages
    to people. It automatically reads message history, researches the person, generates an appropriate
    message based on your intent, and requests user approval before sending.

    Provide a person identifier (full name, phone, or email) and describe the intent of the message.
    Do NOT write the message yourself - the tool generates it based on context and intent."""

    tool: Literal["message_person"]
    person_id: str = Field(
        description="Identifier for the person: full name (e.g., 'John Smith'), "
        "phone number (E.164 format, e.g., '+19729777432'), or email address. "
        "Full name must resolve unambiguously to one person."
    )
    channel: Literal["imessage", "email"] = Field(
        description="Communication channel: 'imessage' for iMessage/SMS via user's Mac, 'email' for email via user's Gmail"
    )
    from_email: Optional[str] = Field(
        default=None,
        description="The email address to send from (required when channel is 'email'). "
        "Must match one of the user's connected email accounts."
    )
    intent: str = Field(
        description="Detailed description of the intent/purpose of the message. "
        "Be as descriptive as possible about what the message should accomplish. "
        "Examples: 'Get them interested in angel investing in Rose Labs - mention our "
        "recent traction and ask if they would be open to a call', "
        "'Check in and make sure they feel supported after their recent job change', "
        "'Notify them about the new API features we launched this week'"
    )


class SpawnAgentTool(BaseModel):
    """Spawn an autonomous agent. Type determines capabilities and required config:

    type="explore": Research agent for ALL information gathering.
      Required: goal (str). Do NOT pass output_schema or verifier — explore agents return free-form summaries.
      Example: spawn_agent(type="explore", goal="Find pricing for Acme Corp products")

    type="browser": Web automation (purchases, forms, JS-heavy sites).
      Required: goal (str), start_url (str), output_schema (ResponseSchemaConfig).
      Optional: attachments (list of URLs/file paths).
      25-step limit. Login state persists. Do NOT use for info gathering - use explore.

    type="code": Coding tasks in ephemeral E2B sandbox.
      Required: goal (str), output_schema (ResponseSchemaConfig).
      Optional: github_repo_link (str), attachments (list of URLs/file paths).
      Each agent = ONE focused task. Keep under 10 minutes.

    type="sub_agent": Delegate complex task with own planning cycle.
      Required: goal (str), output_schema (ResponseSchemaConfig).
      Optional: read_only (bool), verifier (VerifierConfig), attachments.
    """

    tool: Literal["spawn_agent"]
    type: Literal["browser", "code", "sub_agent", "explore"]
    goal: str = Field(description="Task/objective for the agent")

    output_schema: Optional[ResponseSchemaConfig] = Field(
        default=None,
        description=(
            "REQUIRED for type=browser, type=code, type=sub_agent. "
            "MUST NOT be provided for type=explore. "
            "Defines the structured data the agent returns. "
            "Example: {\"summary\": \"str\", \"items\": \"list[str]\", \"file\": \"file_pointer\"}"
        )
    )
    attachments: Optional[List[str]] = Field(
        default=None,
        description="List of filenames to pass to this agent. Use the exact `original_filename` value from file_pointer objects in your context."
    )

    start_url: Optional[str] = Field(
        default=None,
        description=(
            "REQUIRED for type=browser. Not used by other types. "
            "The URL to navigate to first. Must be a user-facing URL, not a deep-link."
        )
    )
    # code only - GitHub repo to clone into sandbox
    github_repo_link: Optional[str] = Field(
        default=None,
        description="(code only) GitHub repository URL to clone. Format: 'https://github.com/{owner}/{repo}'"
    )
    # sub_agent only
    read_only: Optional[bool] = Field(
        default=None,
        description="(sub_agent only) True if sub-agent must stay read-only (plan-phase spawn)."
    )
    verifier: Optional[VerifierConfig] = Field(
        default=None,
        description="(sub_agent only) Verification config for evaluating agent success."
    )


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
    BASE = "base"  # $0.25 fixed, $0.03 per match. Broad, common queries expecting many matches
    CORE = "core"  # $2.00 fixed, $0.15 per match. Specific queries with moderate expected matches
    PRO = "pro"  # $10.00 fixed, $1.00 per match. Highly specific queries with rare/hard-to-find matches


class ProcessorEnum(str, Enum):
    """Processor types for Enrich operations with pricing."""

    LITE = "lite"  # $0.005 per match. Simple data extraction
    BASE = "base"  # $0.01 per match. Reliable for standard enrichments
    CORE = "core"  # $0.025 per match. Cross-referenced data
    PRO = "pro"  # $0.10 per match. Exploratory research
    ULTRA = "ultra"  # $0.30 per match. Deep research


class CadenceEnum(str, Enum):
    """Frequency of monitoring runs.

    - 'hourly': Check every hour. Best for fast-moving topics requiring immediate updates.
    - 'daily' [DEFAULT]: Check once per day. Best for most news, announcements, and regular updates.
    - 'weekly': Check once per week. Best for slower changes, long-term trends, or when cost optimization matters.

    Higher frequency = more runs = higher cost. Choose based on how quickly information changes."""

    HOURLY = "hourly"
    DAILY = "daily"
    WEEKLY = "weekly"


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
        ),
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
        ),
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
        ),
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
        ),
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
        ),
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
        ),
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
        ),
    )
    cadence: CadenceEnum = CadenceEnum.DAILY
    webhook_url: Optional[str] = Field(
        default=None,
        description=(
            "Optional URL to receive HTTP POST notifications when events are detected or monitors finish scheduled runs. "
            "Format: 'https://your-domain.com/webhook'. "
            "If not provided, use check_monitor_events tool to poll for updates. "
            "Webhooks require backend infrastructure to receive and process notifications."
        ),
    )
    metadata: Optional[Dict[str, str]] = Field(
        default=None,
        description=(
            "Optional metadata to store with the monitor. Keys and values must be strings. "
            "Maximum 16 characters per key, 512 characters per value. "
            "Useful for tracking monitor purpose, category, or related information. "
            "Example: {'category': 'regulations', 'priority': 'high'}"
        ),
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
        ),
    )
    limit: Optional[int] = Field(
        default=10,
        ge=1,
        le=100,
        description=(
            "Maximum number of events to return. Range: 1-100. Default: 10. "
            "Returns most recent events first."
        ),
    )


# ============================================================================
# Plan Phase Tools
# ============================================================================


class SetPlanTool(BaseModel):
    """
    Signal readiness for plan generation. A dedicated planner LLM will analyze
    the conversation history and available tools to generate an optimal execution plan.

    Call this when you have gathered enough context and are ready to proceed.
    The planner will structure your research into tasks with proper dependencies.
    """

    tool: Literal["set_plan"]
    # No parameters - planner LLM generates the plan internally


class ProgressToAutonomousExecutionPhaseTool(BaseModel):
    """Request to transition from planning to autonomous execution. The user will be prompted to approve the plan."""

    tool: Literal["progress_to_autonomous_execution_phase"]


# ============================================================================
# Universal Completion Tool (replaces mark_execution_complete and progress_to_autonomous_execution_phase)
# ============================================================================


class AttemptCompletionTool(BaseModel):
    """
    Signal that you believe your current phase/task is complete.

    In PLAN phase: Call when plan is ready and you no longer need clarifications.
    In EXECUTE phase: Call when you believe the goal has been fully accomplished.

    When you call this, a separate verifier LLM will evaluate whether you actually
    completed the task. The verifier strictly looks at the tools you called and their
    results — NOT the result field below. Make sure your work is reflected in your
    tool calls, not just described in the result.

    If verification passes, the loop exits. If not, you'll receive feedback and can
    continue working.

    Still populate the result field with your final answer/findings — it is used for
    logging and display purposes.
    """

    tool: Literal["attempt_completion"]
    result: str = Field(
        default="",
        description="Summary of your final result for logging and display. The verifier does not see this — it evaluates your tool calls directly."
    )


# SpawnSubAgentTool removed - unified into SpawnAgentTool above


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
        ),
    )
    keyword: Optional[str] = Field(
        default=None,
        description=(
            "Optional keyword to filter services by description or resource URL. "
            "Examples: 'weather', 'price', 'news', 'data'"
        ),
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
    method: Literal["GET", "POST"] = Field(default="GET", description="HTTP method for the request (shown in search results). Default: GET")
    params: Dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "REQUIRED: Request parameters from the service's input_schema. "
            "Look at the 'Params:' line in search results for required fields. "
            "For GET requests: these become query parameters. "
            "For POST requests: this becomes the JSON body. "
            'Example: {"url": "https://example.com", "includeResponseBody": true}'
        ),
    )
    max_amount_cents: int = Field(
        description=(
            "Maximum amount in cents willing to pay for this call (safety limit). "
            "The call will fail if the service requires more than this amount. "
            "Set this to at least the price shown in search results. "
            "Example: 100 = $1.00, 10 = $0.10, 1 = $0.01"
        )
    )


class CallPhoneNumberTool(BaseModel):
    """
    Make an outbound phone call to extract structured data via voice AI.

    This tool initiates a phone call using a voice AI agent that will have a conversation
    with the person who answers. The agent follows the system_prompt instructions and
    extracts structured data according to the output_schema.

    The call is monitored until completion and returns the extracted data.

    IMPORTANT: Only call this tool ONCE per phone number. Do NOT make parallel calls to the
    same number - this will result in multiple simultaneous calls to the same person. If you
    need to call multiple different numbers, you may call them in parallel.
    """

    tool: Literal["call_phone_number"]
    to: str = Field(
        description="Phone number to call in E.164 format (e.g., +19729777432)"
    )
    system_prompt: str = Field(
        description=(
            "Instructions for how the voice agent should behave, who they are, and what they're calling about. "
            "Be specific about the agent's identity, tone, and conversation goals. "
            "Example: 'You are a friendly assistant from Acme Corp calling to confirm an appointment. "
            "Introduce yourself, verify you're speaking with the right person, and confirm the appointment details.'"
        )
    )
    output_schema: Dict[str, str] = Field(
        description=(
            "Simple key-value mapping of field names to their descriptions. "
            "Each key is the field name (snake_case), each value is a description of what to extract. "
            "Example: {'full_name': 'The person\\'s full name', 'arrival_time': 'When they will arrive'}"
        )
    )


# Map tool names to their Pydantic models
TOOL_MODELS = {
    "wait_for": WaitForTool,
    "web_search": WebSearchTool,
    "web_fetch": WebFetchTool,
    "people_search": PeopleSearchTool,
    "deep_research": DeepResearchTool,
    "send_message_to_user": SendMessageToUserTool,
    "send_message_to_user_execute_phase": SendMessageToUserExecutePhaseTool,
    "enable_write_permissions": EnableWritePermissionsTool,
    "spawn_agent": SpawnAgentTool,
    "search_user_network_for_people": SearchUserNetworkTool,
    "find_all": FindAllTool,
    "enrich": EnrichTool,
    "monitor": MonitorTool,
    "check_monitor_events": CheckMonitorEventsTool,
    "message_person": MessagePersonTool,
    # Plan phase tools
    "set_plan": SetPlanTool,
    # Universal completion tool (available in both phases)
    "attempt_completion": AttemptCompletionTool,
    # x402 Bazaar tools
    "search_x402_bazaar": SearchX402BazaarTool,
    "pay_for_x402_bazaar_service": PayForX402BazaarServiceTool,
    # Phone calling tool
    "call_phone_number": CallPhoneNumberTool,
    # Local data search
    "grep": GrepTool,
}

# Tools available inside the explore agent (subset of read-only tools)
EXPLORE_AGENT_TOOLS = ["web_search", "web_fetch", "grep", "attempt_completion"]

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
    # NOTE: reasoning is handled externally via OpenRouter reasoning_details
    AgentAction = create_model(
        "AgentAction",
        response=(
            str,
            Field(
                description="Thinking/reasoning about what to do next. Explain your observations "
                           "and strategy. This is shown to the user as 'Thinking...' text. "
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
    "VerifierConfig",
    "SubAgentConfig",
    "WaitForTool",
    "WebSearchTool",
    "DeepResearchTool",
    "SendMessageToUserTool",
    "SendMessageToUserExecutePhaseTool",
    "EnableWritePermissionsTool",
    "SendSmsTool",
    "SendSmsAsUserTool",
    "SendEmailTool",
    "MessagePersonTool",
    "SpawnAgentTool",
    "SearchUserNetworkTool",
    "FindAllTool",
    "EnrichTool",
    "MonitorTool",
    "CheckMonitorEventsTool",
    "SetPlanTool",
    "AttemptCompletionTool",
    # Legacy (kept for backward compatibility, but deprecated)
    "ProgressToAutonomousExecutionPhaseTool",
    "SearchX402BazaarTool",
    "PayForX402BazaarServiceTool",
    "CallPhoneNumberTool",
    "GrepTool",
    "TOOL_MODELS",
    "create_agent_action_model",
    "ProgressScore",
]

