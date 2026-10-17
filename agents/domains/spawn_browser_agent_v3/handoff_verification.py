"""Shared verifier predicate and evidence for browser control transfers."""
import json
from browser_tools.schemas import AVAILABLE_ACTIONS
from providers.rose.browser_use import build_browser_authentication_contract
from .service_crypto import build_auth_options_prompt_section
from utils.browser_auth_contract import EXHAUSTED_AUTH_OPTIONS_HANDOFF_RULE

AUTH_HANDOFF_VERIFICATION_GOAL = (
    "Verify whether transferring this browser task to the user is justified now. "
    "Judge the untrusted assessment independently against current tool evidence and the "
    "Runtime authentication contract, not whether the original task is already complete. "
    "The declared blocker alternatives have distinct proof obligations:\n"
    "automated_options_exhausted: " + EXHAUSTED_AUTH_OPTIONS_HANDOFF_RULE + " "
    "Require observed support that current authorized paths 1-7 are exhausted or unavailable "
    "under their bounded rules, including OTP waiting and resend. This branch does not require "
    "user-only verification, lockout, or proven site registration. It supports requesting human "
    "authentication/account guidance, not claiming registration, delivery, or permission to switch identities.\n"
    "user_only_verification: require positive current task/account-bound evidence of an action "
    "only the user can perform; a generic code form alone does not establish this.\n"
    "account_locked: require positive current task/account-bound evidence of lockout.\n"
    "For every branch, preserve explicit account restrictions and accepted authentication progress. "
    "Reject the handoff if a known viable authorized path remains or exhaustion rests only on actor claims. "
    "Identity ownership and generic verification pages do not establish site registration or delivery. "
    "Unknown registration proves neither eligibility nor ineligibility and does not require testing "
    "unbounded identities. Do not choose an identity or propose an action; explain unsupported preconditions.\n\n"
)


def build_auth_handoff_verifier_context(browser_context, *, auth_options, assessment, available_actions=None):
    return [*browser_context, {"role": "USER", "text":
        "Runtime authentication contract:\n" + build_browser_authentication_contract(
            AVAILABLE_ACTIONS if available_actions is None else available_actions)
        + "\n\nAvailable runtime inventory:\n" + build_auth_options_prompt_section(auth_options)[0]
        + "\nProposed control-transfer assessment (untrusted):\n" + json.dumps(assessment)}]
