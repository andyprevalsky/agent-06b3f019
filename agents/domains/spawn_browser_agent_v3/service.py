"""Service layer for spawn-browser-agent-v3 domain.

Business logic orchestration: context building, session file extraction,
prompt construction, and usage calculation.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import structlog

from browser_tools.schemas import AVAILABLE_ACTIONS
from domains.spawn_browser_agent_v3 import tilion_worker as tilion_files
from domains.spawn_browser_agent_v3.config import (
    BROWSER_USE_COST_CENTS_PER_MS,
    BROWSER_USE_PRICING_POOL,
    KERNEL_COST_CENTS_PER_MS,
    STEEL_COST_CENTS_PER_MS,
    TILION_ACTION_CREDITS,
    TILION_CAPTCHA_CREDITS,
    TILION_CENTS_PER_CREDIT,
    TILION_COST_CENTS_PER_MS,
    TILION_DIRECT_CREDITS_PER_MB,
    TILION_PREMIUM_CREDITS_PER_MB,
)
from domains.spawn_browser_agent_v3.repo import (
    download_session_file,
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
        if candidate.scheme == current.scheme and candidate.netloc == current.netloc and candidate.path == current.path:
            return candidate_url

    return current_url


# Guest/anonymous CTAs that make step 6 observable. Once seen in-page, the
# auth-assistance hard gate requires a guest attempt before step 8.
GUEST_PAGE_COMPLETION_OPTION_RE = re.compile(
    r"(?:"
    r"check\s*out as guest|"
    r"continue as guest|"
    r"order as guest|"
    r"guest check\s*out|"
    r"book as guest|"
    r"continue without (?:signing|logging|an account|creating)|"
    r"book without (?:signing|logging|an account)|"
    r"no account (?:needed|required)|"
    r"skip (?:sign|log)\s*in"
    r")",
    re.IGNORECASE,
)

GUEST_CLICK_COMPLETION_OPTION_RE = re.compile(
    r"(?:"
    r"check\s*out as guest|"
    r"continue as guest|"
    r"order as guest|"
    r"guest check\s*out|"
    r"book as guest|"
    r"continue without (?:signing|logging|an account|creating)|"
    r"book without (?:signing|logging|an account)|"
    r"reserve without|"
    r"i['’]?ll\s+reserve|"
    r"i\s+will\s+reserve|"
    r"pay at the property|"
    r"no account (?:needed|required)|"
    r"skip (?:sign|log)\s*in"
    r")",
    re.IGNORECASE,
)


def text_indicates_guest_completion_option(text: Optional[str]) -> bool:
    """True when page copy offers a guest/anonymous completion path."""
    if not text:
        return False
    return bool(GUEST_PAGE_COMPLETION_OPTION_RE.search(text))


def clicked_text_indicates_guest_completion_option(text: Optional[str]) -> bool:
    """True when clicked control copy offers guest/anonymous completion."""
    if not text:
        return False
    return bool(GUEST_CLICK_COMPLETION_OPTION_RE.search(text))


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
    # Guest is only a hard-gate blocker after a guest CTA has been observed on
    # the page. Defaulting unavailable=True previously skipped step 6 entirely.
    guest_unavailable: bool = False
    guest_option_seen: bool = False
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
        guest = auth_options.get("guest") or {}
        guest_unavailable = bool(guest.get("unavailable")) if isinstance(guest, dict) else False

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
            guest_unavailable=guest_unavailable,
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

    def observe_page_text(self, text: Optional[str]) -> None:
        """Record that a guest/anonymous CTA appeared in the live page."""
        if text_indicates_guest_completion_option(text):
            self.guest_option_seen = True

    def observe_clicked_element_text(self, text: Optional[str]) -> None:
        """Record a guest/anonymous CTA click as exhausting step 6."""
        if clicked_text_indicates_guest_completion_option(text):
            self.guest_option_seen = True
            self.guest_attempted = True

    def restrict_password_ids_to_attemptable(self, attemptable_ids: set[str]) -> None:
        """Only block user assistance on passwords this session can actually inject."""
        self.password_ids.intersection_update(attemptable_ids)
        self.passwords_attempted.intersection_update(attemptable_ids)

    def snapshot(self) -> Dict[str, Any]:
        password_exhausted = self.password_ids.issubset(self.passwords_attempted)
        email_exhausted = (not self.email_otp_available) or self.email_otp_attempted
        minted_exhausted = (not self.minted_present) or (self.minted_attemptable and self.minted_attempted)
        # Guest is N/A until a guest CTA is observed; once seen it must be
        # attempted (or explicitly marked unavailable) before auth assistance.
        guest_exhausted = (
            (not self.guest_option_seen) or self.guest_unavailable or self.guest_attempted
        )
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
                "option_seen": self.guest_option_seen,
                "attempted": self.guest_attempted,
                "exhausted_or_unavailable": guest_exhausted,
            },
        }


# ========================================
# SAFE TIME
# ========================================


def safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox."""
    try:
        return time.time()
    except Exception:
        return 0.0


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
    *,
    goal: str,
) -> str:
    """Build detailed execution context summary for main agent."""
    summary_parts = []

    # One line, so a goal can never open its own line with a **Status** heading
    # ahead of the real one (status parsers read the first such line).
    goal_line = " ".join(line.strip() for line in (goal or "").splitlines() if line.strip())
    if goal_line:
        summary_parts.append(f"**Goal**: {goal_line}\n")

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


def build_best_effort_response(
    reasoning_messages: list,
    action_summary: list,
    visited_urls: list,
) -> str:
    """Best-effort answer surfaced when the browser agent terminates WITHOUT a
    clean ``attempt_completion`` (e.g. it exhausts its step budget).

    Mirrors ``run_agent``'s ``best_effort_response`` (loop/run_agent.py): a
    browser sub-agent that loops to its ceiling without ever completing must
    still hand the parent usable output instead of an empty payload, so the
    parent can act on the partial evidence rather than hallucinate or re-spawn.

    Preference order: the agent's most recent synthesized reasoning (its last
    "thinking" \u2014 the closest thing to a final synthesized answer), then the
    tail of the action trail, then the last URL reached. Returns ``""`` only
    when no evidence was accumulated at all.
    """
    for reasoning in reversed(reasoning_messages or []):
        if reasoning and str(reasoning).strip():
            return str(reasoning).strip()

    if action_summary:
        tail = "; ".join(str(a) for a in action_summary[-5:])
        return f"No summary was produced before the step budget ran out. Last actions: {tail}"

    if visited_urls:
        return f"No summary was produced before the step budget ran out. Last URL reached: {visited_urls[-1]}"

    return ""


async def build_browser_verifier_context(
    goal: str,
    current_url: str,
    browser_state: dict,
    action_history: Any,
    config: Any,
    session_id: str,
    payment_card_evidence: Optional[Dict[str, Any]] = None,
    browser_checkpoints: Optional[List[Dict[str, Any]]] = None,
    user_instruction_messages: Optional[List[Dict[str, str]]] = None,
    verification_goal: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Assemble the verifier context from final-state browser ground truth.

    Shared by the ``attempt_completion`` path (grade a claimed completion) and
    the max-steps terminal path (final synthesis pass to salvage partial
    structured data, mirroring ``run_agent``'s final verifier run). Pure data
    assembly plus one ``list_session_files`` read \u2014 no LLM call, no side
    effects on the caller.
    """
    all_action_entries = action_history.get_entries()
    window, older = all_action_entries[-30:], all_action_entries[:-30]

    def approved_card(entry: Dict[str, Any]) -> bool:
        return entry.get("action") == "request_payment_card" and (entry.get("result") or {}).get("status") == "approved"

    def has_auth_context(entry: Dict[str, Any]) -> bool:
        return "auth_context" in (entry.get("result") or {})

    # Some receipts prove a fact that later receipts do not repeat: the approved
    # card request, and the observed sign-in options (stored only when they
    # change). Carry the latest older one forward when it ages out of the
    # verifier's bounded history, keeping the same 30-receipt size.
    carried = []
    for proves in (approved_card, has_auth_context):
        if not any(proves(entry) for entry in window):
            carrier = next((entry for entry in reversed(older) if proves(entry)), None)
            if carrier is not None and carrier not in carried:
                carried.append(carrier)
    carried.sort(key=lambda entry: entry.get("step", 0))
    # Make room by dropping the oldest receipts that prove neither fact.
    drop = {
        id(entry)
        for entry in [e for e in window if not (approved_card(e) or has_auth_context(e))][: len(carried)]
    }
    action_entries = [*carried, *(entry for entry in window if id(entry) not in drop)]
    action_details_lines = []
    for entry in action_entries:
        step = entry.get("step", "?")
        ea = entry.get("action", "unknown")
        er = entry.get("result", {})
        # Match the runtime's convention (handler treats a missing `success` as
        # success): defaulting to False here would mislabel completed steps as
        # failed in the verifier's action log and corrupt the salvaged verdict.
        esuccess = er.get("success", True)
        estatus = "\u2705 Success" if esuccess else f"\u274c Failed: {er.get('error', 'unknown')}"

        line = f"Step {step}: {ea} - {estatus}"
        if ea == "screenshot" and esuccess:
            line += " (visible viewport capture)"
        # Native target mechanics live outside params. Preserve the already
        # privacy-projected, step-owned attempt; a failed action proves no effect.
        if type(step) is int and ea in AVAILABLE_ACTIONS:
            target = {}
            if type(entry.get("index")) is int and entry["index"] >= 0:
                target["index"] = entry["index"]
            coords = entry.get("coordinates")
            if isinstance(coords, dict) and set(coords) == {"x", "y"} and all(
                type(v) in (int, float) and float("-inf") < v < float("inf") for v in coords.values()
            ):
                target["coordinates"] = coords
            if target:
                if isinstance(entry.get("element_description"), str):
                    target["element_description"] = entry["element_description"]
                line += f"\n  Recorded target attempt (page data): {target}"
        eparams = entry.get("params", {})
        if eparams:
            display_params = {k: v for k, v in eparams.items() if k not in ["screenshot", "dom_tree"]}
            if display_params:
                line += f"\n  Params: {display_params}"
        display_result = {k: v for k, v in er.items() if k not in ["success", "error", "screenshot", "dom_tree", "formatted_state"]}
        if display_result:
            line += f"\n  Result: {display_result}"
        action_details_lines.append(line)

    actions_text = "\n\n".join(action_details_lines)
    # Each delivered native observation keeps its own receipt identity and
    # existing per-tool/aggregate verifier admission. Do not bury many DOM
    # observations inside the single compact action-history TOOL_RESULT.
    observation_evidence = [
        {"role": "TOOL", "text": "",
         "metadata": {"toolName": entry["action"], "toolStatus": "FINISHED", "browser_action_step": entry["step"],
                      "structured_response": {"step": entry["step"], "formatted_state": entry["result"]["formatted_state"]}}}
        for entry in reversed(all_action_entries)
        if type(entry.get("step")) is int and entry.get("action") == "read_browser_state"
        and isinstance((entry.get("result") or {}).get("formatted_state"), str)
        and entry["result"]["formatted_state"]
    ]


    # Executed JavaScript returns are attributable tool output, not native
    # DOM ground truth. Keep request and returned value together per step so
    # the compact history's cap cannot silently remove the middle results.
    # get_entries() applies the existing history privacy projection; normal
    # per-tool/aggregate verifier budgets still apply to these receipts.
    evaluation_evidence = [
        {"role": "TOOL", "text": "Recorded JavaScript request and returned value; not independent DOM confirmation.",
         "metadata": {"toolName": "evaluate", "title": "Recorded JavaScript request and returned value; not independent DOM confirmation.", "toolStatus": "FINISHED" if entry["result"].get("success", True) else "ERROR",
                      "browser_action_step": entry["step"],
                      "structured_response": {"step": entry["step"], "params": entry.get("params", {}),
                                              "result": {key: entry["result"][key] for key in ("success", "error", "value") if key in entry["result"]}}}}
        for entry in reversed(all_action_entries)
        if type(entry.get("step")) is int and entry.get("action") == "evaluate"
        and isinstance(entry.get("result"), dict) and "value" in entry["result"]
    ]

    page_stats = browser_state.get("page_stats", {})
    scroll_pos = browser_state.get("scroll_position", {})
    pages_above = scroll_pos.get("pages_above", 0)
    total_pages = scroll_pos.get("total_pages", 1)

    # C10: Browser verifier infers from action_history + final-state
    # ground truth. Multi-step browser tasks would balloon if we
    # duplicated every raw step DOM inside compact history. Delivered native
    # read observations now have separate exact-step evidence under the same
    # verifier admission budgets; we retain final-state DOM and final-state
    # screenshot reference. The verifier reconstructs the journey
    # from action_history and grounds the answer in the FINAL state.
    #
    # Browser-sourced ground truth lives in the user prompt, not
    # a TOOL message. LLM-generated tool results (e.g. `extract`)
    # are reward-hackable; the DOM tree comes straight from
    # DOMService and is the only safe substrate for verifying a
    # claimed answer.
    dom_tree = browser_state.get("dom_tree", "") or ""
    # A blank placeholder frame (capture failed) is not rendered-page evidence.
    final_screenshot_b64 = None if browser_state.get("screenshot_placeholder") else browser_state.get("screenshot")
    session_files = await _session_files_for_listing(config, session_id)
    files_text = "Downloaded Files in Session:\n"
    if session_files:
        for f in session_files:
            files_text += f"  - {f.get('path', 'unknown')} ({f.get('size', 0)} bytes)\n"
    else:
        files_text += "  (no files downloaded)\n"

    pre_write_checkpoint_sections = []
    preserved_evidence_sections = []
    pre_write_number = 0
    preserved_number = 0
    for checkpoint in browser_checkpoints or []:
        if not isinstance(checkpoint, dict):
            continue
        checkpoint_dom = str(checkpoint.get("dom_tree") or "")
        if not checkpoint_dom:
            continue
        kind = str(checkpoint.get("kind") or "pre_write")
        if kind == "preserved_evidence":
            preserved_number += 1
            section_title = f"### Preserved page evidence {preserved_number}"
            section_description = (
                "This snapshot was extracted directly from the browser during the run; "
                "it is browser ground truth, not an agent claim. Prefer it over later pages when those "
                "pages no longer show the load-bearing facts."
            )
            destination = preserved_evidence_sections
        else:
            pre_write_number += 1
            section_title = f"### Pre-write checkpoint {pre_write_number}"
            section_description = (
                "This snapshot was extracted directly from the browser before an irreversible action; "
                "it is browser ground truth, not an agent claim."
            )
            destination = pre_write_checkpoint_sections
        destination.append(
            "\n\n".join(
                [
                    section_title,
                    section_description,
                    f"URL: {checkpoint.get('url') or 'Unknown'}",
                    f"Title: {checkpoint.get('title') or 'Unknown'}",
                    "DOM Tree:\n" + checkpoint_dom,
                ]
            )
        )

    checkpoints_text = ""
    if pre_write_checkpoint_sections:
        checkpoints_text = (
            "\n\n## Browser Ground Truth (PRE-WRITE CHECKPOINTS)\n"
            + "\n\n".join(pre_write_checkpoint_sections)
        )
    if preserved_evidence_sections:
        checkpoints_text += (
            "\n\n## Browser Ground Truth (PRESERVED PAGE EVIDENCE)\n"
            + "\n\n".join(preserved_evidence_sections)
        )

    user_prompt = (
        f"Goal: {verification_goal or goal}\n\n"
        + (f"Original browser task: {goal}\n\n" if verification_goal else "")
        +
        "## Browser Ground Truth (FINAL STATE)\n"
        "Read the DOM independently and decide whether the goal is satisfied. "
        "Do NOT rely on what the agent reported - only on what the page actually shows. "
        "The action_history below shows the URL transitions taken to reach this final state.\n\n"
        f"URL: {current_url}\n"
        f"Title: {browser_state.get('title', 'Unknown')}\n"
        f"Interactive Elements: {page_stats.get('interactive', 0)}\n"
        f"Scroll Position: Page {pages_above + 1} of {total_pages}\n\n"
        "### DOM Tree (browser-extracted final-state page content)\n"
        f"{dom_tree}"
        f"{checkpoints_text}"
    )

    # C11: the final-state screenshot rides through to the
    # verifier as a multimodal image content block. The DOM
    # tree (in user_prompt above) remains the source of truth;
    # the image is supplementary. Wiring lives in
    # helpers/llm.py:build_verifier_context_messages \u2014 when
    # `metadata.screenshot_b64` is present on a TOOL message,
    # it's flushed as `{type: image, source: {type: base64,
    # media_type, data}}` instead of being inlined as text.
    return [
        {"role": "USER", "text": user_prompt},
        *[
            {"role": "USER", "text": message["content"]}
            for message in user_instruction_messages or []
        ],
        {
            "role": "TOOL",
            "text": f"Browser Agent Execution Log ({len(action_entries)} actions shown - URL transitions, tool inputs/outputs):\n\n{actions_text}",
            "metadata": {
                "toolName": "action_history",
                "toolStatus": "FINISHED",
            },
        },
        {
            "role": "TOOL",
            "text": files_text,
            "metadata": {
                "toolName": "session_files",
                "toolStatus": "FINISHED",
            },
        },
        # Validated last-four digits from the trusted card-issuance boundary are
        # the only non-browser evidence allowed through; PAN/expiry/CVC excluded.
        *([payment_card_evidence] if payment_card_evidence else []),
        # Final-state screenshot \u2014 emitted as a multimodal
        # image block by build_verifier_context_messages when
        # screenshot_b64 is set in metadata. Body text stays
        # short (no b64 inlining).
        {
            "role": "TOOL",
            "text": (
                "Final-state screenshot attached (b64-encoded PNG of "
                "the visible viewport). Treat the DOM tree above as "
                "ground truth; the screenshot is supplementary."
                if final_screenshot_b64
                else "No final-state screenshot included; DOM tree is the verifier ground truth."
            ),
            "metadata": {
                "toolName": "final_screenshot",
                "toolStatus": "FINISHED",
                "screenshot_b64": final_screenshot_b64 or "",
            },
        },
    ] + observation_evidence[:1] + sorted(
        # Keep the latest independent native observation first. Admit remaining
        # step-owned receipts newest first across both kinds, so old native
        # history cannot consume the whole budget ahead of recent evaluations.
        # Stable sorting keeps native observations first for equal steps.
        observation_evidence[1:] + evaluation_evidence,
        key=lambda receipt: receipt["metadata"]["browser_action_step"],
        reverse=True,
    )


def append_completion_evidence(
    message: str,
    *,
    browser_url: str | None = None,
    structured_response: Optional[Dict[str, Any]] = None,
) -> str:
    """Add deterministic final evidence that should not depend on model wording."""
    extra_parts: List[str] = []
    structured_response = structured_response or {}
    _ = browser_url  # retained for call-site compat; never path-matched

    order_id = structured_response.get("order_confirmation_id")
    if order_id and "payment confirmed" not in message.lower():
        extra_parts.append(f"\n**Confirmation**: Payment confirmed\nOrder ID: {order_id}")

    if structured_response:
        lines = ["\n**Extracted Output:**"]
        for key, value in structured_response.items():
            label = str(key).replace("_", " ").title()
            if isinstance(value, list):
                display_value = ", ".join(str(item) for item in value)
            else:
                display_value = str(value)
            lines.append(f"- **{label}:** {display_value}")
        extra_parts.append("\n".join(lines))

    if not extra_parts:
        return message
    return f"{message}\n{''.join(extra_parts)}"


# ========================================
# SESSION FILE EXTRACTION
# ========================================


async def _session_files_for_listing(config: Any, session_id: str) -> List[Dict[str, Any]]:
    """Session downloads: Tilion's live in the worker ledger (its file routes
    fail while the worker holds CDP); other providers list via the backend.

    After a Tilion -> Kernel/Steel switch the ledger moved to the new session
    while new downloads land in the new provider's files, so list both.
    """
    ledger = tilion_files.list_downloads(session_id) if tilion_files.owns_download_session(session_id) else []
    if tilion_files.is_tilion_session(session_id):
        return ledger
    return [*ledger, *(await list_session_files(config, session_id) or [])]


async def extract_session_files(
    session_id: str, user_id: str, config: Any, exclude_paths: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """Extract all files from a browser session.

    1. List files through the provider-neutral backend
    2. Download each file through the provider-neutral backend
    3. Upload to Supabase storage (direct Supabase API call)
    4. Return list of FilePointer dicts
    """
    from helpers.attachments import upload_to_storage

    session_files = await _session_files_for_listing(config, session_id)
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

        # Route by ledger membership: Tilion paths are absolute like other providers'.
        in_ledger = tilion_files.has_download(session_id, file_path)
        if in_ledger:
            # Already durable in attachment storage when it landed: reuse it.
            stored_pointer = tilion_files.download_file_pointer(session_id, file_path)
            if stored_pointer is not None:
                output_files.append(stored_pointer)
                continue

        downloaded = (
            tilion_files.read_download(session_id, file_path)
            if in_ledger
            else await download_session_file(config, session_id, file_path)
        )
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
    #    spawn and across the Rose pool path. AVAILABLE_ACTIONS comes from the
    #    canonical Pydantic browser-tool registry; BROWSER_USE_TOOLS supplies
    #    rich provider-facing descriptions for those registered actions.
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

# Internal-only suffix that splits a model's Fast-Mode replays from its paid
# calls in the usage ledger. It contains NUL so it can never collide with a real
# model name, and it must NEVER escape into an emitted usage row.
_DEMO_CACHE_LEDGER_MARKER = "\x00fast_cache"
_CACHE_SEQUENCE_LEDGER_MARKER = "\x00cache_sequence:"


def accumulate_model_usage(
    usage_by_model: Dict[str, Dict[str, int]],
    actual_model: Optional[str],
    input_tokens: int,
    output_tokens: int,
    cache_read_input_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    from_fast_cache: bool = False,
    cache_sequence_id: Optional[str] = None,
) -> None:
    """Add one LLM call's tokens to the per-actual-model usage ledger.

    Keyed by the model the inference ACTUALLY ran on (`actual_model`), which is
    what decides price: the browser pool races several underlying models, and a
    `-claude`/`-gpt` suffix means the step ran on the user's own compute token
    (billed $0 by `AgentWorkflow._track_usage`).

    Cached input is tracked in its own buckets because `_track_usage` prices
    cache reads/writes separately from uncached input; dropping them here bills
    every cache hit at the full input rate.

    Fast-Mode replays are a SEPARATE bucket from paid calls on the same model,
    never a sticky flag on a shared one: `_track_usage` zero-prices any row
    marked `from_fast_cache` and skips pricing entirely, so merging one replay
    into a model's paid bucket would make every paid token on that model free.
    The ledger key is therefore (actual_model, from_fast_cache); each bucket
    carries its own `model` so the emitted row still reports the plain name.

    Calls carrying a provider cache sequence remain separate ledger rows. The
    benchmark ratchet needs every inference in that sequence (including its
    first write) to measure genuine within-run reuse; collapsing those calls
    into one per-model row destroys both their multiplicity and identity.
    """
    model = str(actual_model or "")
    # NUL can never occur in a model name, so this cannot collide with a real
    # model whose name happens to end in the marker text.
    key = f"{model}{_DEMO_CACHE_LEDGER_MARKER}" if from_fast_cache else model
    sequence_id = str(cache_sequence_id or "").strip()
    if sequence_id:
        key = (
            f"{key}{_CACHE_SEQUENCE_LEDGER_MARKER}{sequence_id}"
            f"\x00call:{len(usage_by_model)}"
        )
    bucket = usage_by_model.setdefault(
        key,
        {
            "model": model,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "from_fast_cache": 1 if from_fast_cache else 0,
            **({"cache_sequence_id": sequence_id} if sequence_id else {}),
        },
    )
    bucket["input_tokens"] += int(input_tokens or 0)
    bucket["output_tokens"] += int(output_tokens or 0)
    bucket["cache_read_input_tokens"] = int(bucket.get("cache_read_input_tokens") or 0) + int(
        cache_read_input_tokens or 0
    )
    bucket["cache_creation_input_tokens"] = int(bucket.get("cache_creation_input_tokens") or 0) + int(
        cache_creation_input_tokens or 0
    )


def build_browser_llm_usage_items(
    total_input_tokens: int,
    total_output_tokens: int,
    model_pricing: Dict[str, Any],
    usage_by_model: Optional[Dict[str, Dict[str, int]]] = None,
    *,
    pricing_pool: str = BROWSER_USE_PRICING_POOL,
) -> List[Dict[str, Any]]:
    """Build one llm usage row per model that ACTUALLY ran inference.

    `model` must be the real `actual_model` from each LLM call, never a static
    pool constant: (1) the browser pool races several underlying models at
    different prices, and (2) `AgentWorkflow._track_usage` routes models whose
    name ends in `-claude`/`-gpt` to a $0 direct-compute-token branch that a
    pool name can never match — so a hardcoded pool bills the user's own
    compute-token steps as paid waterfall usage.

    Callers that genuinely have no per-model breakdown pass `usage_by_model`
    empty/None and get the historical single aggregate row, priced at
    ``pricing_pool`` (the pool the browser steps ran on).

    Token conservation: with a populated ledger the emitted rows sum exactly to
    the ledger; the `total_*` args are only the single-row fallback's totals.
    """
    model_rows = usage_by_model or {"": {"input_tokens": total_input_tokens, "output_tokens": total_output_tokens}}
    items: List[Dict[str, Any]] = []
    for ledger_key, usage in model_rows.items():
        input_tokens = int((usage or {}).get("input_tokens") or 0)
        output_tokens = int((usage or {}).get("output_tokens") or 0)
        # The ledger key is (model, from_fast_cache); the bucket carries the
        # plain model. Test on PRESENCE, not truthiness: a Fast-Mode replay with
        # no `actual_model` has an empty-but-present `model`, and falling back on
        # falsiness emitted the raw key — a NUL-bearing "\x00fast_cache" string
        # that is truthy, so it also defeated the pricing-pool fallback below and
        # rode into `_track_usage` and the stored usage records.
        raw_model = (usage or {}).get("model")
        if raw_model is None:
            # Hand-built ledger (no `model` key): the key IS the model name.
            # Strip internal markers defensively so they can never reach a
            # usage row, even when a test or legacy caller constructs the
            # ledger without going through `accumulate_model_usage`.
            model = str(ledger_key).split(_DEMO_CACHE_LEDGER_MARKER, 1)[0]
            model = model.split(_CACHE_SEQUENCE_LEDGER_MARKER, 1)[0]
        else:
            model = str(raw_model)
        items.append(
            {
                "type": "llm",
                # Unattributed tokens price at the pool the steps ran on.
                "model": model or pricing_pool,
                "cost_cents": round(
                    (input_tokens / 1000) * model_pricing.get("input_cents_per_1k", 0)
                    + (output_tokens / 1000) * model_pricing.get("output_cents_per_1k", 0),
                    4,
                ),
                "provider": "Rose 1 Browser Use",
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                # Forwarded so `_track_usage` can apply its cache discount and
                # zero out Fast-Mode replays; omitting them bills every cached
                # browser step at the full uncached input rate.
                "cache_read_input_tokens": int((usage or {}).get("cache_read_input_tokens") or 0),
                "cache_creation_input_tokens": int((usage or {}).get("cache_creation_input_tokens") or 0),
                "from_fast_cache": bool((usage or {}).get("from_fast_cache")),
                **(
                    {"cache_sequence_id": str((usage or {}).get("cache_sequence_id"))}
                    if (usage or {}).get("cache_sequence_id")
                    else {}
                ),
            }
        )
    return items


def build_usage_items(
    total_input_tokens: int,
    total_output_tokens: int,
    model_pricing: Dict[str, Any],
    execution_time_ms: float,
    usage_by_model: Optional[Dict[str, Dict[str, int]]] = None,
    *,
    fast_mode_cache_enabled: bool = False,
    provider: Optional[str] = None,
    pricing_pool: str = BROWSER_USE_PRICING_POOL,
    session_creates: int = 1,
    tilion_premium_bytes: int = 0,
    tilion_direct_bytes: int = 0,
    tilion_page_proxy_bytes: Optional[int] = None,
    tilion_actions: int = 0,
    tilion_captcha_solves: int = 0,
) -> List[Dict[str, Any]]:
    """Build standardized usage items for cost tracking.

    One llm row per ACTUAL inference model (see `build_browser_llm_usage_items`)
    plus one browser-time `service` row, which is not per-model. `model_pricing`
    is the browser-pool pricing the caller resolved; the pre-computed
    `cost_cents` on llm rows is informational only — the workflow recomputes
    from `model` + tokens and remains the single source of cost truth, applying
    the cache discount to the `cache_*` counters each row now carries.

    When Fast Mode is on for this browser session — or every LLM decision was
    a replay/soft-complete (`from_fast_cache`) — zero the Kernel/Steel service
    row so OAi-demo warm paths stay ~$0. Mixed ledgers (soft + mislabeled live
    rows) previously still billed wall-clock cents under the live-LLM check
    alone (verify19 ~4.5¢ Kernel on child d24898d1).

    Tilion also bills a fixed 2 credits per session create; ``session_creates``
    counts the creates this browser activity is charged for. Its bytes dominate
    spend: CDP bytes relayed to the worker bill per MB at the direct or premium
    (residential/ISP/mobile) rate, and premium sessions also bill the pages' own
    proxy traffic (``tilion_page_proxy_bytes``; None while unobserved, so the
    row is then a floor).
    """
    browser_provider = (provider or os.getenv("BROWSER_PROVIDER", "kernel")).strip().lower()
    if browser_provider == "kernel":
        service_provider, cost_per_ms = "Kernel Browser", KERNEL_COST_CENTS_PER_MS
    elif browser_provider == "steel":
        service_provider, cost_per_ms = "Steel.dev Browser", STEEL_COST_CENTS_PER_MS
    elif browser_provider == "browser-use":
        service_provider, cost_per_ms = "Browser Use Browser", BROWSER_USE_COST_CENTS_PER_MS
    elif browser_provider == "tilion":
        service_provider, cost_per_ms = "Tilion Browser", TILION_COST_CENTS_PER_MS
    else:
        raise ValueError(f"Unsupported browser provider for usage: {browser_provider}")
    llm_items = build_browser_llm_usage_items(
        total_input_tokens,
        total_output_tokens,
        model_pricing,
        usage_by_model,
        pricing_pool=pricing_pool,
    )
    # Zero Kernel/Steel under Fast Mode or when there is no live LLM decision
    # (all replay/soft-complete, or empty ledger after soft-done). Warm OAi
    # demos otherwise pick up residual wall-clock cents.
    has_live_llm = any(not bool(item.get("from_fast_cache")) for item in llm_items)
    zero_service = bool(fast_mode_cache_enabled) or not has_live_llm
    fixed_cost = 0.0
    if browser_provider == "tilion":
        megabyte = 1_048_576
        credits = (
            2 * max(session_creates, 0)
            + TILION_DIRECT_CREDITS_PER_MB * max(tilion_direct_bytes, 0) / megabyte
            + TILION_PREMIUM_CREDITS_PER_MB
            * (max(tilion_premium_bytes, 0) + max(tilion_page_proxy_bytes or 0, 0))
            / megabyte
            + TILION_ACTION_CREDITS * max(tilion_actions, 0)
            + TILION_CAPTCHA_CREDITS * max(tilion_captcha_solves, 0)
        )
        fixed_cost = credits * TILION_CENTS_PER_CREDIT
    service_cost = 0.0 if zero_service else round(execution_time_ms * cost_per_ms + fixed_cost, 4)
    return [
        *llm_items,
        {
            "type": "service",
            "cost_cents": service_cost,
            "provider": service_provider,
        },
    ]


def browser_usage_items_to_tool_usage(usage_items: Optional[List[Dict[str, Any]]]) -> Dict[str, list]:
    """Map activity `usage_items` onto the workflow `_track_usage` payload shape.

    The workflow is THE single point where LLM cost is computed, so llm rows
    carry tokens + the model that produced them (never a pre-computed price);
    only service rows carry `cost_cents`.
    """
    tool_usage: Dict[str, list] = {"llm": [], "service": []}
    for item in usage_items or []:
        if item.get("type") == "llm":
            tool_usage["llm"].append(
                {
                    "tokens_in": item.get("input_tokens", 0),
                    "tokens_out": item.get("output_tokens", 0),
                    "model": item.get("model"),
                    "provider": item.get("provider", ""),
                    "cache_read_input_tokens": item.get("cache_read_input_tokens", 0),
                    "cache_creation_input_tokens": item.get("cache_creation_input_tokens", 0),
                    # Propagate demo-cache replay so replayed browser
                    # steps bill $0 instead of their replayed tokens.
                    "from_fast_cache": item.get("from_fast_cache", False),
                    **(
                        {"cache_sequence_id": item.get("cache_sequence_id")}
                        if item.get("cache_sequence_id")
                        else {}
                    ),
                }
            )
        else:
            tool_usage["service"].append(
                {
                    "cost_cents": item.get("cost_cents", 0),
                    "provider": item.get("provider", ""),
                }
            )
    return tool_usage


# ========================================
# ACTION TITLE BUILDER
# ========================================


def build_action_titles(
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
    elif action_name == "read_logs":
        pattern = str(unified_action.get("params", {}).get("pattern") or unified_action.get("params", {}).get("regex") or "").strip()
        scope = f" matching /{pattern[:40]}/" if pattern else ""
        title_progress = f"Reading browser logs{scope}..."
        title_done = f"Read browser logs{scope}"
    elif action_name == "read_network_requests":
        url_pattern = str(unified_action.get("params", {}).get("url_pattern") or "").strip()
        scope = f" matching '{url_pattern[:40]}'" if url_pattern else ""
        title_progress = f"Reading network requests{scope}..."
        title_done = f"Read network requests{scope}"
    elif action_name == "recover_from_challenge":
        title_progress = "Recovering from bot challenge..."
        title_done = "Recovered from bot challenge"
    elif action_name == "request_user_assistance_for_authentication":
        title_progress = "Requesting authentication assistance..."
        title_done = "Requested authentication assistance"
    elif action_name == "phone":
        title_progress = "Using cloud iPhone..."
        title_done = "Cloud iPhone result"
    elif action_name == "request_payment_card":
        total_cents = unified_action.get("params", {}).get("total_cents", 0)
        merchant = unified_action.get("params", {}).get("merchant", "merchant")
        title_progress = f"Requesting payment card for {merchant}"
        title_done = f"Payment card requested (${total_cents / 100:.2f})"

    return title_progress, title_done, resolved_action_name
