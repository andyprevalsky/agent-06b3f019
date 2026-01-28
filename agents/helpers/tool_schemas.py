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
    "web_search",
    "web_fetch",
    "send_message_to_user",
    "set_plan",
    "attempt_completion",
]

# Tools available during EXECUTE phase (run the plan)
EXECUTE_PHASE_TOOLS = [
    "spawn_browser_agent",
    "spawn_claude_code_agent",
    "spawn_sub_agent",
    "wait_seconds",
    "web_search",
    "people_search",
    "send_message_to_user_execute_phase",
    "attempt_completion",
]

# Tools the planner can assign to tasks (what shows up in task.tool_name)
PLANNER_ASSIGNABLE_TOOLS = [
    "spawn_browser_agent",
    "spawn_claude_code_agent",
    "spawn_sub_agent",
    "wait_seconds",
    "web_search",
    "people_search",
    "send_message_to_user_execute_phase",
    "reasoning",  # Pure thinking/analysis step (no tool call)
]

class PlanToolName(str, Enum):
    """The tool to execute for this task, or 'reasoning' for thinking/analysis."""
    spawn_browser_agent = "spawn_browser_agent"
    spawn_claude_code_agent = "spawn_claude_code_agent"
    spawn_sub_agent = "spawn_sub_agent"
    wait_seconds = "wait_seconds"
    web_search = "web_search"
    people_search = "people_search"
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


class WaitSecondsTool(BaseModel):
    """Tool call for pausing execution."""

    tool: Literal["wait_seconds"]
    seconds: int = Field(ge=1, le=3600, description="Number of seconds to wait (1-3600)")


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
    """Spawn an autonomous browser agent to complete short, simple web tasks. Best for: purchases, checkouts, form submissions, downloading files, and reading content from JS-heavy sites. The browser agent should be used for short simple trajectories, not complex reasoning loops—it has a 25-step limit. Provide a complete, high-level goal - the browser agent will autonomously execute all necessary steps. Login state and saved payment methods persist across sessions. Minimize the work done by this tool and keep the trajectory as short as possible. Do not call this tool multiple times in parallel."""

    tool: Literal["spawn_browser_agent"]
    start_url: str = Field(
        description="The URL to navigate to first. The browser will automatically navigate here before starting. Examples: 'https://amazon.com/dp/B09V3KXJPB', 'https://x.com/compose/post', 'https://uber.com/orders'"
    )
    goal: str = Field(
        description="Complete, high-level goal for the autonomous browser agent to accomplish. Examples: 'Buy this item', 'Post a tweet saying Hello World', 'Reorder my last Uber Eats order'"
    )
    output_schema: ResponseSchemaConfig
    attachments: Optional[List[str]] = Field(
        default=None,
        description="List of filenames to pass to this agent. Use the exact `original_filename` value from file_pointer objects in your context (e.g., 'photo.jpg'). Do NOT use the file's `id` field or any other format."
    )


class SpawnClaudeCodeAgentTool(BaseModel):
    """Spawn an autonomous Claude Code agent to complete coding tasks in an ephemeral E2B sandbox.

    The Claude Code agent has access to a full Linux environment with:
    - File system (read, write, edit files)
    - Terminal (run any bash commands)
    - Git (clone repos, create branches, commit)
    - Package managers (npm, pip, etc.)

    TASK SCOPING: If a task can be broken into 2+ subtasks with no context dependency between them,
    you MUST split them into separate Claude Code agents. Tasks timeout after 10 minutes, so anything
    too complex that isn't broken down will fail. Each agent should have ONE focused deliverable.

    Provide a complete, high-level coding goal. Note: Sandboxes are ephemeral -
    files don't persist after the session ends. Use git to push changes to preserve work,
    or use file_pointer in output_schema to return generated files.
    """

    tool: Literal["spawn_claude_code_agent"]
    goal: str = Field(
        description="Complete coding goal for Claude Code to accomplish. Examples: 'Clone the repo at https://github.com/user/project, add TypeScript support, and push changes to a new branch', 'Create a Python script that analyzes CSV data and generates a report', 'Set up a new React project with Tailwind CSS and create a landing page component'"
    )
    output_schema: ResponseSchemaConfig
    attachments: Optional[List[str]] = Field(
        default=None,
        description="List of filenames to pass to this agent. Use the exact `original_filename` value from file_pointer objects in your context (e.g., 'data.csv'). Do NOT use the file's `id` field or any other format."
    )
    github_repo_link: Optional[str] = Field(
        default=None,
        description="GitHub repository URL to clone into the sandbox before starting. The agent will work inside the cloned repo directory and automatically push changes to main. Format: 'https://github.com/{owner}/{repo}' (e.g., 'https://github.com/acme-corp/my-project'). Only repos you have been granted access to can be cloned."
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

    A verifier will run to confirm completion. If verification passes, the loop exits.
    If not, you'll receive feedback and can continue working.
    """

    tool: Literal["attempt_completion"]


class SpawnSubAgentTool(BaseModel):
    """Tool call for spawning a sub-agent to work on a subtask.

    IMPORTANT: When defining the output_schema, if the sub-agent needs to return any FILES
    (images, documents, generated artifacts, etc.), you MUST use 'file_pointer' or 'list[file_pointer]'
    as the field type. Using 'str' for file paths will NOT work - files will not be transferred."""

    tool: Literal["spawn_sub_agent"]
    sub_agent: SubAgentConfig


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


# Map tool names to their Pydantic models
TOOL_MODELS = {
    "wait_seconds": WaitSecondsTool,
    "web_search": WebSearchTool,
    "web_fetch": WebFetchTool,
    "people_search": PeopleSearchTool,
    "deep_research": DeepResearchTool,
    "send_message_to_user": SendMessageToUserTool,
    "send_message_to_user_execute_phase": SendMessageToUserExecutePhaseTool,
    "enable_write_permissions": EnableWritePermissionsTool,
    "send_sms_as_user": SendSmsAsUserTool,
    "spawn_browser_agent": SpawnBrowserAgentTool,
    "spawn_claude_code_agent": SpawnClaudeCodeAgentTool,
    "spawn_sub_agent": SpawnSubAgentTool,
    "search_user_network_for_people": SearchUserNetworkTool,
    "find_all": FindAllTool,
    "enrich": EnrichTool,
    "monitor": MonitorTool,
    "check_monitor_events": CheckMonitorEventsTool,
    "read_message_history_with_person": ReadMessageHistoryTool,
    "message_person": MessagePersonTool,
    # Plan phase tools
    "set_plan": SetPlanTool,
    # Universal completion tool (available in both phases)
    "attempt_completion": AttemptCompletionTool,
    # x402 Bazaar tools
    "search_x402_bazaar": SearchX402BazaarTool,
    "pay_for_x402_bazaar_service": PayForX402BazaarServiceTool,
}

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
    "WaitSecondsTool",
    "WebSearchTool",
    "DeepResearchTool",
    "SendMessageToUserTool",
    "SendMessageToUserExecutePhaseTool",
    "EnableWritePermissionsTool",
    "SendSmsTool",
    "SendSmsAsUserTool",
    "SendEmailTool",
    "ReadMessageHistoryTool",
    "MessagePersonTool",
    "SpawnBrowserAgentTool",
    "SpawnClaudeCodeAgentTool",
    "SpawnSubAgentTool",
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
    "TOOL_MODELS",
    "create_agent_action_model",
    "ProgressScore",
]

