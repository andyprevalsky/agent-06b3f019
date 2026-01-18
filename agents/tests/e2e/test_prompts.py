"""
E2E Test Prompts

Test definitions imported from the frontend TestPromptsSelector.
Each test includes metadata about what features it requires.

NOTE: Tests cannot run in parallel - each test spawns a real agent.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class TestPrompt:
    """Definition of a test prompt."""
    name: str  # Unique test identifier (kebab-case)
    title: str  # Human-readable title
    description: str  # What this test verifies
    prompt: str  # The goal to send to the agent
    timeout: int = 300  # Timeout in seconds (default 5 min)
    attachment_url: Optional[str] = None  # Optional attachment path
    requires_browser_agent: bool = False  # Whether it needs browser agent
    requires_claude_code: bool = False  # Whether it needs Claude Code agent
    expected_patterns: Optional[list[str]] = None  # Patterns to verify in output
    expected_tools: Optional[list[str]] = None  # Tools that should be called
    is_chat_mode: bool = False  # If True, poll for response messages instead of COMPLETED status


# All test prompts - mirroring front-end/src/components/terminal/TestPromptsSelector.tsx
TEST_PROMPTS: dict[str, TestPrompt] = {
    "chat-mode": TestPrompt(
        name="chat-mode",
        title="Test Chat Mode",
        description="Tests chat mode web search flow",
        prompt="whats the latest news?",
        timeout=120,
        expected_tools=["web_search"],
        is_chat_mode=True,
    ),
    "browser-agent": TestPrompt(
        name="browser-agent",
        title="Test Browser Agent",
        description="Tests browser agent with Amazon shopping task",
        prompt="Get me a black beanie < 35$ and well-made",
        timeout=600,  # Browser tasks take longer
        requires_browser_agent=True,
        expected_tools=["spawn_browser_agent"],
    ),
    "spawn-sub-agents": TestPrompt(
        name="spawn-sub-agents",
        title="Test Spawn Sub Agents",
        description="Tests recursive sub-agent spawning with depth parameter",
        prompt=(
            "Spawn 2 sub-agents with the same goal as yourself, this is for debugging "
            "of the systems max depth parameter. Current Depth Left == 2, when spawning "
            "a sub-agent decrease this count by 1. If Depth Left == 0, then output a "
            "random integer between 0 - 10. If Depth > 0 then output the multiplication "
            "of each sub agent you spawned."
        ),
        timeout=300,
        expected_tools=["spawn_sub_agents"],
    ),
    "web-search": TestPrompt(
        name="web-search",
        title="Test Web Search",
        description="Tests web search tool with a news query",
        prompt="Get me the latest news.",
        timeout=120,
        expected_tools=["web_search"],
        is_chat_mode=True,
    ),
    "people-search": TestPrompt(
        name="people-search",
        title="Test People Search",
        description="Tests Exa people search tool",
        prompt="Use people_search to get me info about Andy Prevalsky",
        timeout=120,
        expected_tools=["people_search"],
        is_chat_mode=True,
    ),
    "parallel-tool-calls": TestPrompt(
        name="parallel-tool-calls",
        title="Test Parallel Tool Calls",
        description="Tests parallel execution of multiple tools in one turn",
        prompt=(
            "Do 3 parallel web_searches to get data for the best of each of these items\n"
            "1. Cities to live in in your 20s\n"
            "2. place to vacation\n"
            "3. cheapest cost of living in NA\n\n"
            "no questions ask\n"
            "start in execute mode\n"
            "no sub agents"
        ),
        timeout=180,
        expected_tools=["web_search"],
    ),
    "claude-code-agent": TestPrompt(
        name="claude-code-agent",
        title="Test Claude Code Agent",
        description="Tests Claude Code agent in ephemeral E2B sandbox",
        prompt=(
            "Starting from 27, how many steps does it take to reach 1 in the Collatz "
            "sequence? List all the numbers. Use Claude Code and no sub agents"
        ),
        timeout=300,
        requires_claude_code=True,
        expected_tools=["spawn_claude_code_agent"],
    ),
    "dag-executor": TestPrompt(
        name="dag-executor",
        title="Test DAG Executor",
        description="Tests DAG executor with plan mode (no web searches during planning)",
        prompt=(
            "Do 3 parallel web_searches to get data for the best of each of these items\n"
            "1. Cities to live in in your 20s\n"
            "2. place to vacation\n"
            "3. cheapest cost of living in NA\n\n"
            "no questions ask\n"
            "start in plan mode\n"
            "dont use any websearches in plan mode\n"
            "no sub agents"
        ),
        timeout=180,
        expected_tools=["web_search"],
    ),
    "image-handling": TestPrompt(
        name="image-handling",
        title="Test Image Handling",
        description="Tests image attachment processing with rs.jpeg",
        prompt="make this red",
        timeout=180,
        attachment_url="/test-assets/rs.jpeg",
    ),
    "files-in-sub-agents": TestPrompt(
        name="files-in-sub-agents",
        title="Test Files in Sub Agents",
        description="Tests file_pointer output schema with sub-agents creating color variants",
        prompt=(
            "turn this file into 4 different color variants, yellow, red, blue, green, "
            "use a spawn_sub_agent for each one, no claude code agents in main agent, "
            "instruct each sub agent to use claude code to do the color transformation"
        ),
        timeout=600,
        attachment_url="/test-assets/rs.jpeg",
        expected_tools=["spawn_sub_agents"],
    ),
    "files-in-browser-agent": TestPrompt(
        name="files-in-browser-agent",
        title="Test Files in Browser Agent",
        description="Tests browser agent file upload with TinyPNG",
        prompt=(
            "upload this image to tinypng.com and compress it\n\n"
            "no sub agents\n"
            "no questions asked"
        ),
        timeout=600,
        attachment_url="/test-assets/rs.jpeg",
        requires_browser_agent=True,
        expected_tools=["spawn_browser_agent"],
    ),
}


def get_basic_tests() -> list[TestPrompt]:
    """
    Get tests that don't require attachments, browser agent, or Claude Code.
    These are the "basic" tests that should reliably pass.
    """
    return [
        test for test in TEST_PROMPTS.values()
        if not test.attachment_url
        and not test.requires_browser_agent
        and not test.requires_claude_code
    ]


def get_all_test_names() -> list[str]:
    """Get all available test names."""
    return list(TEST_PROMPTS.keys())


def get_test_by_name(name: str) -> Optional[TestPrompt]:
    """Get a test by its name."""
    return TEST_PROMPTS.get(name)
