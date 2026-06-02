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
    expected_patterns_env: Optional[list[str]] = None  # Env values that must appear in output
    expected_tools: Optional[list[str]] = None  # Tools that should be called
    expected_credential_ref_kinds: Optional[list[str]] = None  # Credential refs that must be logged
    expected_credential_ref_kinds_env: Optional[list[str]] = None  # Env-provided credential refs to assert
    expected_same_steel_session_auth_handoff: bool = False  # Auth assistance must stay on one Steel session
    auth_handoff_state: Optional[dict[str, str]] = None  # Direct live input handoff check values
    auth_handoff_state_env: Optional[dict[str, str]] = None  # Env names for live input handoff check
    credential_backprop_cases: Optional[list[dict]] = None  # DB-backed success/failure credential propagation cases
    start_phase: Optional[str] = None  # "plan" or "execute" to bypass chat-mode startup
    is_chat_mode: bool = False  # If True, poll for response messages instead of COMPLETED status
    required_env: Optional[list[str]] = None  # Live-service prerequisites for this e2e
    live_fixture: Optional[str] = None  # TTL-backed generated fixture name
    live_fixture_ttl_seconds: Optional[int] = None  # Per-fixture cache TTL override


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
        title="Test Spawn General-Purpose Agents",
        description="Tests recursive general-purpose agent spawning with depth parameter",
        prompt=(
            "Spawn 2 general-purpose agents with the same goal as yourself, this is for debugging "
            "of the systems max depth parameter. Current Depth Left == 2, when spawning "
            "a general-purpose agent decrease this count by 1. If Depth Left == 0, then output a "
            "random integer between 0 - 10. If Depth > 0 then output the multiplication "
            "of each general-purpose agent you spawned."
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
            "no general-purpose agents"
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
            "sequence? List all the numbers. Use Claude Code and no general-purpose agents"
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
            "no general-purpose agents"
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
        title="Test Files in General-Purpose Agents",
        description="Tests file_pointer output schema with general-purpose agents creating color variants",
        prompt=(
            "turn this file into 4 different color variants, yellow, red, blue, green, "
            "use a spawn_general_purpose_agent for each one, no claude code agents in main agent, "
            "instruct each general-purpose agent to use claude code to do the color transformation"
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
            "no general-purpose agents\n"
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
        description="Tests general-purpose-agent for_each processing 12 CSV entities in parallel",
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
    "e2e_sync_to_agent": TestPrompt(
        name="e2e_sync_to_agent",
        title="Browser Auth: Sync To Agent",
        description="Real mac-app scrape -> backend sync -> browser agent sees the freshly synced CookieBundle",
        prompt=(
            "Use the browser agent to open {{E2E_BROWSER_AUTH_SYNC_TARGET_URL}}. "
            "Verify the synced browser profile authentication is available for exactly "
            "{{E2E_BROWSER_AUTH_EXPECTED_ACCOUNT}}, then report the observed account label verbatim."
        ),
        timeout=900,
        requires_browser_agent=True,
        expected_patterns_env=["E2E_BROWSER_AUTH_EXPECTED_ACCOUNT"],
        expected_tools=["spawn_browser_agent"],
        expected_credential_ref_kinds=["cookie_bundle"],
        required_env=["E2E_BROWSER_AUTH_SYNC_TARGET_URL", "E2E_BROWSER_AUTH_EXPECTED_ACCOUNT"],
        live_fixture="browser_auth.sync_to_agent",
    ),
    "e2e_auth_options_scoped": TestPrompt(
        name="e2e_auth_options_scoped",
        title="Browser Auth: Scoped Options",
        description="Real browser agent receives only the target realm's auth_options",
        prompt=(
            "Use the browser agent to open {{E2E_BROWSER_AUTH_SCOPED_TARGET_URL}}. "
            "Confirm only the target realm account {{E2E_BROWSER_AUTH_EXPECTED_ACCOUNT}} is available "
            "and do not use credentials for any other realm. Report the account label verbatim."
        ),
        timeout=600,
        requires_browser_agent=True,
        expected_patterns_env=["E2E_BROWSER_AUTH_EXPECTED_ACCOUNT"],
        expected_tools=["spawn_browser_agent"],
        expected_credential_ref_kinds=["cookie_bundle"],
        required_env=["E2E_BROWSER_AUTH_SCOPED_TARGET_URL", "E2E_BROWSER_AUTH_EXPECTED_ACCOUNT"],
        live_fixture="browser_auth.auth_options_scoped",
    ),
    "e2e_steel_precedence": TestPrompt(
        name="e2e_steel_precedence",
        title="Browser Auth: Steel Precedence",
        description="Live Steel context auth is used ahead of scraped cookie injection",
        prompt=(
            "Use the browser agent to open {{E2E_STEEL_PRECEDENCE_TARGET_URL}}. "
            "Verify the existing Steel session is already signed in as {{E2E_BROWSER_AUTH_EXPECTED_ACCOUNT}} "
            "and complete without re-login. Report the account label verbatim."
        ),
        timeout=900,
        requires_browser_agent=True,
        expected_patterns_env=["E2E_BROWSER_AUTH_EXPECTED_ACCOUNT"],
        expected_tools=["spawn_browser_agent"],
        expected_credential_ref_kinds=["steel_session"],
        required_env=["E2E_STEEL_PRECEDENCE_TARGET_URL", "E2E_BROWSER_AUTH_EXPECTED_ACCOUNT"],
        live_fixture="browser_auth.steel_precedence",
    ),
    "e2e_cookie_fallthrough": TestPrompt(
        name="e2e_cookie_fallthrough",
        title="Browser Auth: Cookie Fallthrough",
        description="Empty Steel context falls through to a real CookieBundle and lands authenticated",
        prompt=(
            "Use the browser agent to open {{E2E_COOKIE_FALLTHROUGH_TARGET_URL}}. "
            "Verify the account authenticates through the synced browser cookies for "
            "{{E2E_BROWSER_AUTH_EXPECTED_ACCOUNT}} and record the account label verbatim."
        ),
        timeout=900,
        requires_browser_agent=True,
        expected_patterns_env=["E2E_BROWSER_AUTH_EXPECTED_ACCOUNT"],
        expected_tools=["spawn_browser_agent"],
        expected_credential_ref_kinds=["cookie_bundle"],
        required_env=["E2E_COOKIE_FALLTHROUGH_TARGET_URL", "E2E_BROWSER_AUTH_EXPECTED_ACCOUNT"],
        live_fixture="browser_auth.cookie_fallthrough",
    ),
    "e2e_email_otp_user_message": TestPrompt(
        name="e2e_email_otp_user_message",
        title="Browser Auth: Email OTP User Message",
        description="Real emailed OTP enters the browser-use conversation as a user message and completes login",
        prompt=(
            "Use the browser agent to open {{E2E_EMAIL_OTP_TARGET_URL}}. "
            "Request email OTP login for {{E2E_CONNECTED_EMAIL_ACCOUNT}}, use the received email code, "
            "and report successful authentication for that email address."
        ),
        timeout=1200,
        requires_browser_agent=True,
        expected_patterns_env=["E2E_CONNECTED_EMAIL_ACCOUNT"],
        expected_tools=["spawn_browser_agent"],
        expected_credential_ref_kinds=["email_otp"],
        required_env=["E2E_EMAIL_OTP_TARGET_URL", "E2E_CONNECTED_EMAIL_ACCOUNT"],
        live_fixture="browser_auth.email_otp_user_message",
    ),
    "e2e_user_assistance_handoff": TestPrompt(
        name="e2e_user_assistance_handoff",
        title="Browser Auth: User Assistance Handoff",
        description="Automation writes page state, live-view user mutates it, automation resumes in that same state",
        prompt=(
            "Use the browser agent to open https://www.selenium.dev/selenium/web/web-form.html. "
            "Find the text input identified by selector input[name=\"my-text\"] and type "
            "rose-auth-handoff-auto-20260522 into it with no leading or trailing spaces. "
            "Do not submit the form, press Enter, navigate away, or refresh. "
            "After the value is visibly present, call request_user_assistance_for_authentication exactly once. "
            "After user assistance completes, the expected final value is rose-auth-handoff-user-20260522. "
            "Do not navigate, refresh, or change the input after assistance; read the current value from that same "
            "input and report the observed value verbatim."
        ),
        timeout=1800,
        requires_browser_agent=True,
        expected_patterns=["rose-auth-handoff-user-20260522"],
        expected_tools=["spawn_browser_agent"],
        expected_credential_ref_kinds=["steel_session"],
        expected_same_steel_session_auth_handoff=True,
        auth_handoff_state={
            "input_selector": "input[name='my-text']",
            "automation_value": "rose-auth-handoff-auto-20260522",
            "interactive_value": "rose-auth-handoff-user-20260522",
        },
        start_phase="execute",
    ),
    "e2e_passkey_qr_handoff": TestPrompt(
        name="e2e_passkey_qr_handoff",
        title="Browser Auth: Passkey QR Handoff",
        description="Gating real Steel passkey QR flow with a real phone",
        prompt=(
            "Use the browser agent to open {{E2E_PASSKEY_TARGET_URL}}. "
            "Reach the passkey prompt, use the other-device QR handoff, and verify the Steel session is authenticated."
        ),
        timeout=1800,
        requires_browser_agent=True,
        expected_tools=["spawn_browser_agent"],
        expected_credential_ref_kinds=["steel_session"],
        required_env=["E2E_PASSKEY_TARGET_URL", "E2E_PASSKEY_PHONE_READY"],
        live_fixture="browser_auth.passkey_qr_handoff",
        live_fixture_ttl_seconds=60 * 60,
    ),
    "e2e_credential_backprop": TestPrompt(
        name="e2e_credential_backprop",
        title="Browser Auth: Credential Backprop",
        description="Real browser-agent outcomes clear disabledAt on success and set disabledAt/failureReason on auth failure",
        prompt="Runs the credential backprop success and auth-failure live fixture cases.",
        timeout=1200,
        requires_browser_agent=True,
        expected_tools=["spawn_browser_agent"],
        credential_backprop_cases=[
            {
                "name": "success",
                "title": "Credential Backprop Success",
                "description": "Successful browser run clears disabledAt/disabledReason on the referenced credential",
                "credential_fixture_case": "success",
                "credential_ref_kind": "password",
                "expected_terminal_status": "COMPLETED",
                "expected_before_disabled": True,
                "expected_after_disabled": False,
                "expected_propagation_outcome": "success",
                "prompt": (
                    "Use the browser agent to open {{TARGET_URL}}. "
                    "Use the saved credential for this site and complete the credential-backprop success path. "
                    "Do not ask questions, request user assistance, or use alternate credentials. "
                    "After the site shows the authenticated success state, report the credential-backprop success outcome."
                ),
            },
            {
                "name": "auth_failure",
                "title": "Credential Backprop Auth Failure",
                "description": "Observed auth failure disables the referenced credential and exposes failureReason",
                "credential_fixture_case": "auth_failure",
                "credential_ref_kind": "password",
                "expected_terminal_status": "COMPLETED",
                "expected_before_disabled": False,
                "expected_after_disabled": True,
                "expected_propagation_outcome": "auth_failed",
                "expected_failure_reason": "auth_exhausted",
                "prompt": (
                    "Use the browser agent to open {{TARGET_URL}}. "
                    "Use the saved credential for this site exactly as provided and attempt login once through the "
                    "normal username/password flow. Do not ask questions, request user assistance, use alternate "
                    "credentials, reset the password, or recover with a new login method. If the saved credential "
                    "is rejected, stop after confirming the site's authentication failure message and report that "
                    "the credential-backprop auth failure was observed."
                ),
            },
        ],
        start_phase="execute",
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
