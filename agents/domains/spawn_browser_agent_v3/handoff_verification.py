"""Shared verifier predicate and evidence for browser control transfers."""
import json
from browser_tools.schemas import AVAILABLE_ACTIONS
from providers.rose.browser_use import build_browser_authentication_contract
from .service_crypto import build_auth_options_prompt_section

AUTH_HANDOFF_VERIFICATION_GOAL = (
            "Verify whether transferring this browser task to the user is justified now. "
            "Full credit requires observed support for the proposed need for user action, "
            "including why available authorized automation cannot satisfy the original goal. "
            "Judge the proposal independently; its assessment is a claim, not ground truth. "
            "Identity ownership does not establish site registration. A generic verification "
            "page does not establish that a submitted identity is registered or required. "
            "Do not infer eligibility or ineligibility of untested identities. Preserve explicit "
            "account restrictions and genuine device approval, locked-account or unreadable-channel "
            "requirements when supported by the goal and observations. Do not choose an identity "
            "or propose an action; explain any unsupported precondition.\n\n"
)


def build_auth_handoff_verifier_context(browser_context, *, auth_options, assessment, available_actions=None):
    return [*browser_context, {"role": "USER", "text":
        "Runtime authentication contract:\n" + build_browser_authentication_contract(
            AVAILABLE_ACTIONS if available_actions is None else available_actions)
        + "\n\nAvailable runtime inventory:\n" + build_auth_options_prompt_section(auth_options)[0]
        + "\nProposed control-transfer assessment (untrusted):\n" + json.dumps(assessment)}]
