"""Bind an explicit model auth assessment to the current inventory and page.

This validates the model's per-recipient accounting, not site registration or
semantic truth. It never selects an identity, submits a form, or reads an inbox.
"""
from typing import Any, Dict, Optional
import re


def auth_recipient_options(options: Dict[str, Any]) -> list[dict[str, str]]:
    recipients: list[dict[str, str]] = []
    email = options.get("email_otp") or options.get("emailOtp") or {}
    if email.get("available"):
        for address in email.get("connected_emails") or email.get("connectedEmails") or []:
            if isinstance(address, str) and address:
                recipients.append({"method": "email_otp", "recipient": address})
    minted = options.get("minted") or {}
    if not minted.get("disabled"):
        address = minted.get("email") or minted.get("agentEmail") or minted.get("agent_email")
        if not address:
            label = minted.get("accountLabel") or minted.get("account_label")
            if isinstance(label, str) and re.fullmatch(r"[^@\s]+@[^@\s]+", label):
                address = label
        phone = minted.get("phone") or minted.get("agentPhone") or minted.get("agent_phone")
        if address:
            recipients.append({"method": "email_otp", "recipient": str(address)})
        if phone:
            recipients.append({"method": "sms_otp", "recipient": str(phone)})
    # Same address may be both a connected inbox and the minted identity.
    return [{"method": method, "recipient": recipient}
            for method, recipient in dict.fromkeys((x["method"], x["recipient"]) for x in recipients)]


def _recipient_receipts_bound(recipient: str, steps: list[int], entries: Dict[int, Any], *, method: str) -> bool:
    """Bind cited input and later observation, not the semantic site verdict."""
    def same_recipient(text: Any) -> bool:
        if text == recipient:
            return True
        if method != "sms_otp" or not isinstance(text, str) or not isinstance(recipient, str):
            return False
        # Formatting may change while typing a known phone number. Do not infer
        # a country code, match a suffix, or extract digits from arbitrary text.
        if not all(re.fullmatch(r"\+?[0-9() .\-]+", value) for value in (text, recipient)):
            return False
        def digits(value: str) -> str:
            return re.sub(r"\D", "", value)
        return bool(digits(recipient)) and digits(text) == digits(recipient)

    inputs = [step for step in steps if entries[step].get("action") == "input_text"
              and same_recipient((entries[step].get("params") or {}).get("text"))]
    def has_observation(entry: Dict[str, Any]) -> bool:
        result = entry.get("result") or {}
        return isinstance(result, dict) and any(
            key in result and result[key] is not None and result[key] != ""
            for key in ("url", "current_url", "title", "dom_tree", "formatted_state", "value")
        )
    return any(entries[step].get("action") != "input_text" and step > input_step
               and has_observation(entries[step])
               for input_step in inputs for step in steps)


def auth_assistance_assessment_result(
    assessment: Any, *, auth_options: Dict[str, Any], auth_realm: str, current_url: str, action_history: list[dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """None permits normal handoff; a tool result returns control to the planner.

    The model remains responsible for applicability using the actual task and
    page. Missing metadata is not an assertion that an identity is eligible.
    """
    options = auth_recipient_options(auth_options)
    def incomplete(reason: str) -> Dict[str, Any]:
        return {"success": False, "error": "authentication_assessment_incomplete",
                "reason": reason, "auth_realm": auth_realm, "current_url": current_url,
                "supplied_recipient_options": options}
    if not isinstance(assessment, dict):
        return incomplete("The assistance call did not include a per-recipient assessment.")
    if assessment.get("auth_realm") != auth_realm or assessment.get("page_url") != current_url:
        return incomplete("The assessment does not describe the current realm and page URL.")
    reason = assessment.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        return incomplete("The current authentication blocker has no evidence description.")
    past_attempts = assessment.get("attempted_recipient_options") or []
    if not isinstance(past_attempts, list):
        return incomplete("Past authentication attempts are malformed.")
    entries_by_step = {entry.get("step"): entry for entry in action_history}
    for attempt in past_attempts:
        if not isinstance(attempt, dict) or attempt.get("method") not in {"email_otp", "sms_otp"}:
            return incomplete("A past authentication attempt has no recognized method.")
        steps = attempt.get("evidence_steps") or []
        if not isinstance(steps, list) or not steps or any(type(step) is not int or step not in entries_by_step for step in steps):
            return incomplete("A past attempt has no valid action receipts.")
        if not _recipient_receipts_bound(attempt.get("recipient"), steps, entries_by_step, method=attempt["method"]):
            return incomplete("A past recipient lacks its cited input and later observation receipts.")
    blocker = assessment.get("blocker")
    # All blockers account for the same supplied inventory. A restricted or
    # accepted challenge can make alternatives not_applicable/unavailable; it
    # does not remove them from the assessment or authorize switching accounts.
    if blocker not in {"automated_options_exhausted", "user_only_verification", "account_locked"}:
        return incomplete("The assessment has no recognized authentication blocker.")
    rows = assessment.get("recipient_options")
    if not isinstance(rows, list):
        return incomplete("The assistance call has no recipient-option assessments.")
    catalog = {(x["method"], x["recipient"]) for x in options}
    observed_steps = {entry.get("step") for entry in action_history}
    seen: set[tuple[str, str]] = set()
    remaining = []
    for row in rows:
        if not isinstance(row, dict):
            return incomplete("A recipient-option assessment is malformed.")
        key = (row.get("method"), row.get("recipient"))
        if not all(isinstance(part, str) for part in key) or key not in catalog or key in seen:
            return incomplete("A recipient option is duplicated or is not in the current supplied inventory.")
        seen.add(key)
        if not isinstance(row.get("status"), str) or row.get("status") not in {"remaining", "exhausted", "not_applicable", "unavailable"} or not str(row.get("evidence") or "").strip():
            return incomplete("A recipient option lacks its disposition and evidence.")
        evidence_steps = row.get("evidence_steps") or []
        if not isinstance(evidence_steps, list) or any(type(step) is not int or step not in observed_steps for step in evidence_steps):
            return incomplete("An outcome cites an action receipt that is absent from this browser history.")
        if row["status"] == "exhausted" and not _recipient_receipts_bound(row["recipient"], evidence_steps, entries_by_step, method=row["method"]):
            return incomplete("An exhausted recipient option lacks its own input and later observation receipts.")
        if row["status"] == "remaining":
            remaining.append({"method": key[0], "recipient": key[1], "evidence": row["evidence"]})
    if seen != catalog:
        return incomplete("Some supplied recipients have no individual applicability or outcome assessment.")
    if remaining:
        return {"success": False, "error": "authentication_options_remaining",
                "auth_realm": auth_realm, "current_url": current_url,
                "remaining_recipient_options": remaining}
    return None
