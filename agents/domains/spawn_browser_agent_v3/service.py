"""Service layer for spawn-browser-agent-v3 domain.

Business logic orchestration: context building, session file extraction,
prompt construction, and usage calculation.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import structlog

from browser_tools.schemas import AVAILABLE_ACTIONS
from domains.spawn_browser_agent_v3.config import STEEL_COST_CENTS_PER_MS
from domains.spawn_browser_agent_v3.repo import (
    download_file_from_steel,
    list_session_files,
)
from providers.rose.browser_use import build_browser_use_system_prompt
from utils.error_utils import extract_error_message
from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY, format_required_output_schema_system_section

logger = structlog.get_logger()

EMAIL_OTP_BROWSER_INSTRUCTION = (
    "Do not open webmail or inbox websites to retrieve OTP codes. "
    "Recent email OTPs are fetched automatically and will appear as user messages."
)


def select_auth_assistance_current_url(current_url: str, visited_urls: List[str]) -> str:
    """Prefer a pre-submit auth URL with continuation query params for live handoff resume."""
    if not current_url:
        return current_url

    try:
        current = urlparse(current_url)
    except Exception:
        return current_url

    if current.query:
        return current_url

    for candidate_url in reversed(visited_urls):
        if candidate_url == current_url:
            continue
        try:
            candidate = urlparse(candidate_url)
        except Exception:
            continue
        if not candidate.query:
            continue
        if (
            candidate.scheme == current.scheme
            and candidate.netloc == current.netloc
            and candidate.path == current.path
        ):
            return candidate_url

    return current_url


@dataclass
class AuthRuntimeState:
    """Tracks auth ladder attempts that are observable inside this worker."""

    password_ids: set[str] = field(default_factory=set)
    passwords_attempted: set[str] = field(default_factory=set)
    email_otp_available: bool = False
    email_otp_attempted: bool = False
    minted_present: bool = False
    minted_attemptable: bool = False
    minted_ids: set[str] = field(default_factory=set)
    minted_attempted: bool = False
    guest_unavailable: bool = True
    guest_attempted: bool = False

    @classmethod
    def from_auth_options(cls, auth_options: Optional[Dict[str, Any]]) -> "AuthRuntimeState":
        auth_options = auth_options or {}
        passwords = auth_options.get("passwords") or []
        email_otp = auth_options.get("email_otp") or auth_options.get("emailOtp") or {}
        minted = auth_options.get("minted")
        email_otp_match = (
            email_otp.get("match_for_site_account")
            or email_otp.get("matchForSiteAccount")
            or email_otp.get("attemptable")
        )

        state = cls(
            password_ids={
                str(p.get("id") or p.get("ref"))
                for p in passwords
                if (p.get("id") or p.get("ref")) and not p.get("disabled")
            },
            # A connected inbox alone is not an auth path for this realm. Treat
            # email OTP as a blocker only when auth-options found a site-account
            # match, or a caller explicitly marks the OTP path attemptable.
            email_otp_available=bool(email_otp.get("available") and email_otp_match),
            minted_present=bool(minted),
        )

        if minted:
            minted_id = (
                minted.get("id") or minted.get("accountLabel") or minted.get("account_label") or minted.get("email")
            )
            if minted_id:
                state.minted_ids.add(str(minted_id))
            state.minted_attemptable = bool(
                minted.get("email")
                or minted.get("agentEmail")
                or minted.get("agent_email")
                or minted.get("accountLabel")
                or minted.get("account_label")
            )

        return state

    def mark_credential_ref(self, credential_ref: Optional[Dict[str, Any]]) -> None:
        if not credential_ref:
            return
        kind = credential_ref.get("kind")
        credential_id = str(credential_ref.get("id") or "")
        if kind == "password" and credential_id:
            self.passwords_attempted.add(credential_id)
        elif kind in ("email_otp", "sms_otp"):
            self.email_otp_attempted = True
        elif kind in ("minted", "minted_account"):
            self.minted_attempted = True
            if credential_id:
                self.minted_ids.add(credential_id)

    def mark_guest_attempted(self) -> None:
        self.guest_attempted = True

    def restrict_password_ids_to_attemptable(self, attemptable_ids: set[str]) -> None:
        """Only block user assistance on passwords this session can actually inject."""
        self.password_ids.intersection_update(attemptable_ids)
        self.passwords_attempted.intersection_update(attemptable_ids)

    def snapshot(self) -> Dict[str, Any]:
        password_exhausted = self.password_ids.issubset(self.passwords_attempted)
        email_exhausted = (not self.email_otp_available) or self.email_otp_attempted
        minted_exhausted = (not self.minted_present) or (self.minted_attemptable and self.minted_attempted)
        guest_exhausted = self.guest_unavailable or self.guest_attempted
        return {
            "password": {
                "available": bool(self.password_ids),
                "attempted_ids": sorted(self.passwords_attempted),
                "remaining_ids": sorted(self.password_ids - self.passwords_attempted),
                "exhausted_or_unavailable": password_exhausted,
            },
            "email_otp": {
                "available": self.email_otp_available,
                "attempted": self.email_otp_attempted,
                "exhausted_or_unavailable": email_exhausted,
            },
            "minted": {
                "present": self.minted_present,
                "attemptable": self.minted_attemptable,
                "attempted": self.minted_attempted,
                "credential_ids": sorted(self.minted_ids),
                "exhausted_or_unavailable": minted_exhausted,
            },
            "guest": {
                "unavailable": self.guest_unavailable,
                "attempted": self.guest_attempted,
                "exhausted_or_unavailable": guest_exhausted,
            },
        }

    def user_assistance_guard(self) -> tuple[bool, str, Dict[str, Any]]:
        snapshot = self.snapshot()
        blockers = []
        for key in ("password", "email_otp", "minted", "guest"):
            if not snapshot[key]["exhausted_or_unavailable"]:
                blockers.append(key)
        if blockers:
            return False, "Automated authentication options remain: " + ", ".join(blockers), snapshot
        return True, "All automated authentication options exhausted or unavailable.", snapshot


# ========================================
# SAFE TIME
# ========================================


def safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox."""
    try:
        return time.time()
    except Exception:
        return 0.0


def build_auth_assistance_resume_user_message(
    *,
    auth_realm: Optional[str],
    handoff_mode: Optional[str],
) -> Dict[str, str]:
    """Build the post-human-auth cue injected into resumed browser-use calls."""
    realm = auth_realm or "the current site"
    mode = handoff_mode or "live browser session"
    return {
        "role": "user",
        "content": (
            "The user has completed the requested authentication assistance for "
            f"{realm} in the same {mode}. Continue from the current page state exactly as it is now. "
            "Do not call request_user_assistance_for_authentication again for this same auth realm unless "
            "the page presents a new authentication blocker that still requires human input. "
            "Do not undo user-entered changes made during assistance; inspect the current DOM/state and "
            "continue toward the task from that state."
        ),
    }


# ========================================
# CONTEXT SUMMARY BUILDER
# ========================================


def build_context_summary(
    success: bool,
    close_reasoning: str,
    visited_urls: list,
    reasoning_messages: list,
    action_summary: list,
    error_context: Optional[str] = None,
) -> str:
    """Build detailed execution context summary for main agent."""
    summary_parts = []

    status = "\u2705 SUCCESS" if success else "\u274c FAILED"
    summary_parts.append(f"**Status**: {status}")

    if close_reasoning:
        summary_parts.append(f"\n**Outcome**: {close_reasoning}")

    if error_context:
        summary_parts.append(f"\n**Error**: {error_context}")

    if visited_urls:
        last_urls = visited_urls[-5:]
        summary_parts.append(f"\n**URLs Visited** ({len(visited_urls)} total, showing last {len(last_urls)}):")
        for i, url in enumerate(last_urls, 1):
            summary_parts.append(f"  {i}. {url}")

    if reasoning_messages:
        last_reasoning = reasoning_messages[-3:]
        summary_parts.append(f"\n**Agent Reasoning** (last {len(last_reasoning)}):")
        for i, reasoning in enumerate(last_reasoning, 1):
            summary_parts.append(f"  {i}. {reasoning}")

    if action_summary:
        last_actions = action_summary[-10:]
        summary_parts.append(f"\n**Actions Taken** ({len(action_summary)} total, showing last {len(last_actions)}):")
        for action in last_actions:
            summary_parts.append(f"  \u2022 {action}")

    return "\n".join(summary_parts)


# ========================================
# SESSION FILE EXTRACTION
# ========================================


async def extract_session_files(
    session_id: str, user_id: str, config: Any, exclude_paths: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """Extract all files from a Steel browser session.

    1. List files in session (direct Steel API call)
    2. Download each file from Steel (direct Steel API call)
    3. Upload to Supabase storage (direct Supabase API call)
    4. Return list of FilePointer dicts
    """
    from helpers.attachments import upload_to_storage

    session_files = await list_session_files(session_id)
    if not session_files:
        logger.info("No files to extract from session", session_id=session_id)
        return []

    exclude_set = set(exclude_paths or [])
    if exclude_set:
        original_count = len(session_files)
        session_files = [f for f in session_files if f.get("path") not in exclude_set]
        if len(session_files) < original_count:
            logger.info(f"[Extract] Filtered out {original_count - len(session_files)} uploaded file(s)")

    logger.info(f"[Extract] Found {len(session_files)} file(s) to extract in session {session_id}")

    output_files: List[Dict[str, Any]] = []

    for file_info in session_files:
        file_path = file_info.get("path", "")
        if not file_path:
            continue

        logger.info(f"[Extract] Processing: {file_path}")

        downloaded = await download_file_from_steel(session_id, file_path)
        if not downloaded:
            logger.warning(f"[Extract] Failed to download: {file_path}")
            continue

        try:
            file_pointer = await upload_to_storage(
                user_id=user_id,
                file_content=downloaded["content"],
                filename=downloaded["filename"],
                mime_type=downloaded["mime_type"],
            )
            output_files.append(file_pointer)
            logger.info(f"[Extract] Uploaded: {downloaded['filename']} -> {file_pointer['storage_path']}")
        except Exception as e:
            logger.warning(f"[Extract] Failed to upload {downloaded['filename']}: {extract_error_message(e)}")
            continue

    logger.info(
        f"[Extract] Extracted {len(output_files)}/{len(session_files)} files",
        session_id=session_id,
    )
    return output_files


# ========================================
# BROWSER SYSTEM PROMPT
# ========================================


def get_browser_system_prompt(
    goal: str, custom_instructions: str = "", available_files: Optional[List[str]] = None
) -> str:
    """Build the v3 browser-spawner system prompt.

    Static portion (above SYSTEM_PROMPT_DYNAMIC_BOUNDARY) is globally
    cacheable: it delegates to ``build_browser_use_system_prompt`` so the
    Rose pool prompt and the v3 prompt share one source of truth (no
    duplicated rules, screenshot guidance, or safety bullets).

    Dynamic portion (below the boundary) varies per call: ``goal``,
    ``custom_instructions``, and ``available_files``.
    """
    # 1. Static (canonical) browser system prompt. Identical across every
    #    spawn and across the Rose pool path. AVAILABLE_ACTIONS is the
    #    catalog of browser_use actions the v3 executor implements; the
    #    invariant test asserts every entry exists in BROWSER_USE_TOOLS.
    static_prompt = build_browser_use_system_prompt(AVAILABLE_ACTIONS)

    # 2. Dynamic per-spawn addendum. Goal, custom instructions, and the
    #    available-files list all vary BETWEEN spawns (and would otherwise
    #    contaminate a globally-cacheable prefix), so they live below the
    #    SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker.
    files_section = ""
    if available_files:
        files_section = (
            "\n\n# Available Files for Upload\n"
            "The following files are available to upload using the upload_file action.\n"
            'To upload a file, find a file input element (<input type="file">) and use '
            "upload_file with the filename.\n"
            f"AVAILABLE FILES FOR UPLOAD: {', '.join(available_files)}"
        )

    custom_section = ""
    if custom_instructions:
        custom_section = f"\n\n# Custom Instructions\n{custom_instructions}"

    dynamic_prompt = f"\n\n# Current Goal\n{goal}{files_section}{custom_section}"

    return static_prompt + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamic_prompt


def build_browser_dynamic_system_context(
    custom_instructions: str = "",
    available_files: Optional[List[str]] = None,
    response_schema: Optional[Dict[str, Any]] = None,
) -> str:
    """Build dynamic system context for one browser-agent task."""
    files_section = ""
    if available_files:
        files_section = (
            "\n\n# Available Files for Upload\n"
            "The following files are available to upload using the upload_file action.\n"
            'To upload a file, find a file input element (<input type="file">) and use '
            "upload_file with the filename.\n"
            f"AVAILABLE FILES FOR UPLOAD: {', '.join(available_files)}"
        )

    custom_section = ""
    if custom_instructions:
        custom_section = custom_instructions

    schema_section = format_required_output_schema_system_section(response_schema)
    sections = [section.strip() for section in (custom_section, files_section, schema_section) if section.strip()]
    return "\n\n".join(sections)


def build_browser_task_prompt(goal: str) -> str:
    """Build the first user message for a browser task."""
    return f"# Current Goal\n{goal}"


# ========================================
# USAGE CALCULATION
# ========================================


def build_usage_items(
    total_input_tokens: int,
    total_output_tokens: int,
    model_pricing: Dict[str, Any],
    execution_time_ms: float,
) -> List[Dict[str, Any]]:
    """Build standardized usage items for cost tracking."""
    return [
        {
            "type": "llm",
            "cost_cents": round(
                (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"]
                + (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                4,
            ),
            "provider": "Rose 1 Browser Use",
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens,
        },
        {
            "type": "service",
            "cost_cents": round(execution_time_ms * STEEL_COST_CENTS_PER_MS, 4),
            "provider": "Steel.dev Browser",
        },
    ]


# ========================================
# ACTION TITLE BUILDER
# ========================================


def build_action_titles(  # noqa: C901
    action_name: str,
    unified_action: Dict[str, Any],
    element_desc: Optional[str],
    coords: Optional[Dict],
    secret_refs: Optional[Dict[str, str]],
) -> tuple[str, str, str]:
    """Build human-readable title_progress, title_done, and resolved action_name.

    Returns:
        (title_progress, title_done, resolved_action_name)
    """
    title_progress = f"{action_name}..."
    title_done = action_name
    resolved_action_name = action_name

    if action_name == "click":
        if element_desc:
            title_progress = f"Clicking {element_desc}"
            title_done = f"Clicked {element_desc}"
        elif coords:
            title_progress = f"Clicking at ({coords.get('x', '?')}, {coords.get('y', '?')})"
            title_done = f"Clicked at ({coords.get('x', '?')}, {coords.get('y', '?')})"
        else:
            title_progress = "Clicking..."
            title_done = "Clicked"
    elif action_name == "input_text":
        text = unified_action.get("params", {}).get("text", "")
        display_text = "[encrypted_data]" if (secret_refs and text in secret_refs) else text[:25]
        if element_desc:
            title_progress = f"Typing into {element_desc}"
            title_done = f"Typed '{display_text}' into {element_desc}"
        elif coords:
            title_progress = f"Typing at ({coords.get('x', '?')}, {coords.get('y', '?')})"
            title_done = f"Typed '{display_text}' at ({coords.get('x', '?')}, {coords.get('y', '?')})"
        else:
            title_progress = "Typing..."
            title_done = f"Typed '{display_text}'"
    elif action_name == "goto":
        url = unified_action.get("params", {}).get("url", "")[:50]
        title_progress = f"Navigating \u2192 {url}"
        title_done = f"Navigated \u2192 {url}"
    elif action_name == "scroll":
        direction = unified_action.get("params", {}).get("direction", "down")
        amount = unified_action.get("params", {}).get("amount", 300)
        title_progress = f"Scrolling {direction} {amount}px..."
        title_done = f"Scrolled {direction} {amount}px"
        resolved_action_name = f"scroll_{direction}"
    elif action_name == "press_key":
        key = unified_action.get("params", {}).get("key", "?")
        title_progress = f"Pressing {key}..."
        title_done = f"Pressed {key}"
    elif action_name == "extract":
        title_progress = "Extracting data..."
        title_done = "Extracted data"
    elif action_name == "wait":
        time_ms = unified_action.get("params", {}).get("time_ms", 1000)
        title_progress = f"Waiting {time_ms}ms..."
        title_done = f"Waited {time_ms}ms"
    elif action_name == "select_dropdown":
        value = unified_action.get("params", {}).get("value", "?")
        if element_desc:
            title_progress = f"Selecting '{value}' from {element_desc}"
            title_done = f"Selected '{value}' from {element_desc}"
        else:
            title_progress = f"Selecting '{value}'..."
            title_done = f"Selected '{value}'"
    elif action_name == "upload_file":
        filename = unified_action.get("params", {}).get("filename", "file")
        if element_desc:
            title_progress = f"Uploading {filename} to {element_desc}"
            title_done = f"Uploaded {filename} to {element_desc}"
        else:
            title_progress = f"Uploading {filename}..."
            title_done = f"Uploaded {filename}"
    elif action_name == "screenshot":
        title_progress = "Taking screenshot..."
        title_done = "Screenshot captured"
    elif action_name == "request_user_assistance_for_authentication":
        title_progress = "Requesting authentication assistance..."
        title_done = "Requested authentication assistance"
    elif action_name == "request_payment_card":
        total_cents = unified_action.get("params", {}).get("total_cents", 0)
        merchant = unified_action.get("params", {}).get("merchant", "merchant")
        title_progress = f"Requesting payment card for {merchant}"
        title_done = f"Payment card requested (${total_cents / 100:.2f})"

    return title_progress, title_done, resolved_action_name
