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
    attachment_urls: Optional[list[str]] = None  # Multiple attachment paths
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
    "event-planning": TestPrompt(
        name="event-planning",
        title="Test Event Planning",
        description="Tests coordination of event planning with budget constraints",
        prompt=(
            "I want to play volleyball with some friends this weekend in san francisco.\n"
            "Can you figure out who would be down and coordinate the space & procurment of equipment?\n"
            "Ensure its less then 30$ total"
        ),
        timeout=300,
        expected_tools=["web_search"],
    ),
    "message-person": TestPrompt(
        name="message-person",
        title="Test Message Person",
        description="Tests unified message_person tool with email and iMessage channels",
        prompt=(
            "Send an email and a imessage to myself, 972-977-7432, for testing purposes, "
            "don't ask any questions. The message should try to get me to launch this product."
        ),
        timeout=300,
        expected_tools=["message_person"],
    ),
    "agent-for-each": TestPrompt(
        name="agent-for-each",
        title="Test Agent For Each",
        description="Tests sub-agent for_each processing 12 CSV entities in parallel",
        prompt="Get me one interesting fact about each entity on the csv.",
        timeout=600,
        attachment_url="/test-assets/entities-12.csv",
        expected_tools=["spawn_sub_agents"],
    ),
    "build-boxing-payment": TestPrompt(
        name="build-boxing-payment",
        title="Build New Boxing Payment Flow",
        description="Tests building and hosting a full payment site with waivers, Stripe, and email confirmations",
        prompt=(
            "My Dad, George Prevalsky, needs a new site that is exclusively used for signing new clients. "
            "His existing billing solution is archaic and is causing him to be unable to take a vacation.\n"
            "We need to create and host a site that can be accessed via QR code or direct link.\n\n"
            "The site should include:\n"
            "- I've attached 4 waivers as PDFs (Adult Waiver & Release of Liability, Minor Waiver & Release of Liability, "
            "Adult Sparring Consent, Minor Sparring Consent). "
            "Signing is required for the liability waivers (adult and minor). "
            "The sparring consent waivers are included for reference but don't need to be part of the payment flow.\n"
            "- I've also attached the billing & payment terms and the membership terms as PDFs. "
            "Before paying, users must check a required opt-in checkbox agreeing to these terms "
            "(you can include this as part of the waiver signing step). The full text of the terms "
            "should be viewable on the site.\n"
            "- The classes are:\n"
            "  Boxing $225/month\n"
            "  Muay Thai $225/month\n"
            "  MMA $245/month\n"
            "  Jiujitsu $185/month\n"
            "  Kids Program $185/month\n"
            "  Unlimited classes $285/month\n"
            "- We need to support discount codes for Boxing & Muay Thai\n\n"
            "The flow will be:\n"
            "1. Pick your classes\n"
            "2. Sign your waivers and agree to the billing & membership terms (required checkboxes)\n"
            "3. Pay for the classes\n"
            "4. Get a confirmation email\n"
            "5. Send a confirmation email to georgeprevalsky@gmail.com that includes all relevant details "
            "of the payment & attachments of the signed waivers\n\n"
            "Here are the Stripe API keys:\n"
            "STRIPE_SECRET_KEY_TEST={{STRIPE_SECRET_KEY_TEST}}\n"
            "STRIPE_PUBLISHABLE_KEY_TEST={{STRIPE_PUBLISHABLE_KEY_TEST}}\n"
            "STRIPE_SECRET_KEY_PRODUCTION={{STRIPE_SECRET_KEY_PRODUCTION}}\n"
            "STRIPE_PUBLISHABLE_KEY_PRODUCTION={{STRIPE_PUBLISHABLE_KEY_PRODUCTION}}\n\n"
            "You can test the flow on Stripe test mode, and send confirmation emails to andy@roselabs.ai "
            "(since you have access to that email via the browser agent).\n\n"
            "Make sure the payment site includes all necessary information, is styled exceptionally well, "
            "and architecturally, is as simple as possible - we do NOT want to have to worry about maintenance.\n\n"
            "Return to me:\n"
            "- A link to the hosted site\n"
            "- A QR Code for the hosted site\n"
            "- A discount code that can be used exclusively for Boxing & Muay Thai purchases"
        ),
        timeout=900,
        attachment_urls=[
            "/test-assets/dallasmmaboxing-waivers/waiver_release_liability_adult.pdf",
            "/test-assets/dallasmmaboxing-waivers/waiver_release_liability_minor.pdf",
            "/test-assets/dallasmmaboxing-waivers/sparring_consent_adult.pdf",
            "/test-assets/dallasmmaboxing-waivers/sparring_consent_minor.pdf",
            "/test-assets/dallasmmaboxing-waivers/membership_terms_updated.pdf",
            "/test-assets/dallasmmaboxing-waivers/billing_payment_terms_final.pdf",
        ],
        requires_browser_agent=True,
        requires_claude_code=True,
        expected_tools=["spawn_browser_agent", "spawn_claude_code_agent", "spawn_sub_agents"],
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
        and not test.attachment_urls
        and not test.requires_browser_agent
        and not test.requires_claude_code
    ]


def get_all_test_names() -> list[str]:
    """Get all available test names."""
    return list(TEST_PROMPTS.keys())


def get_test_by_name(name: str) -> Optional[TestPrompt]:
    """Get a test by its name."""
    return TEST_PROMPTS.get(name)
