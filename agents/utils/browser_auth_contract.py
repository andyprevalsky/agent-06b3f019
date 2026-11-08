"""Existing browser authentication contract shared by its decision consumers."""

OTP_DELIVERY_CONTRACT = 'OTP codes from email or SMS are automatically injected as user messages into your context as soon as they become available. If no OTP code is received after 60 seconds since requested, request a resend of the OTP code. If after another 60 seconds no OTP code is received, consider that authentication route exhausted and unusable.'


EXHAUSTED_AUTH_OPTIONS_HANDOFF_RULE = 'When authentication still blocks the task after steps 1-7 are exhausted or unavailable, call request_user_assistance_for_authentication (step 8). Do not call attempt_completion, send_message_to_user, or report a status instead.'


DISMISSIBLE_AUTH_PROMPT_RULE = (
    "A sign-in or sign-up prompt you can close or skip does not block the task, and closing it is not a "
    "login attempt. Unless you are signing in through steps 1-5 or signing up under the member-price rule "
    "below, close it and continue as a guest. Authentication blocks the task only when the step you need "
    "still requires signing in after that."
)


AUTH_ASSISTANCE_HANDOFF_RULE = (
    "Before calling request_user_assistance_for_authentication, leave the auth step you are blocked on "
    "open and visible, so the user can complete it without navigating."
)


def build_authentication_contract(*, recover_enabled: bool) -> str:
    """Render the unchanged actor Authentication policy for every consumer."""
    if recover_enabled:
        challenge_rule = (
            "- CAPTCHA, bot challenges, 'Bot or Not' walls, and access-denied interstitials "
            "are not authentication. recover_from_challenge is a relatively expensive way to "
            "force-open a blocked page or service - do not use it when an alternate path can "
            "complete the goal. Do not drag sliders, click verify buttons, or otherwise try "
            "to solve challenge widgets yourself. Never call "
            "request_user_assistance_for_authentication while a challenge interstitial is "
            "still visible."
        )
    else:
        challenge_rule = (
            "- CAPTCHA, bot challenges, 'Bot or Not' walls, and access-denied interstitials "
            "are not authentication. No challenge-recovery tool is available - wait briefly "
            "for the provider auto-solver, try an alternate URL or path to complete the "
            "goal, and do not drag sliders, click verify buttons, or otherwise try to solve "
            "challenge widgets yourself. Never call "
            "request_user_assistance_for_authentication while a challenge interstitial is "
            "still visible."
        )
    return f"""# Authentication

- Use the cheapest viable authentication path for this single site.
- Priority:
  - 1. Existing Steel/cookie session
  - 2. Passkey (if one is listed in Auth Options)
  - 3. Saved passwords
  - 4. Email OTP
  - 5. SMS OTP
  - 6. Guest/anonymous completion, if viable (prefer guest checkout over Sign in / Log in when both appear)
  - 7. Minted account
  - 8. request_user_assistance_for_authentication - only after 1-7 are exhausted or unavailable
- Cookie-based and existing Steel-session auth are applied automatically before you start.
- If a passkey is listed for this site and you are not already logged in, you MUST try the passkey path before any saved password. The passkey is pre-loaded into the browser's authenticator and signs silently once the site starts WebAuthn; no browser passkey popup is expected. First focus/click the username, email, or account field to trigger any passkey autofill/conditional WebAuthn. If the site asks for an identifier, enter the relevant account email/username from the page or saved credentials and continue, but do not type a password yet. If a "Sign in with a passkey", "Use passkey", or similar option appears, choose it. Wait briefly for navigation, OTP, or account access. Only fall through to saved passwords after the passkey option is absent, unavailable, or visibly fails.
- For saved passwords, use the listed private placeholder in your chosen browser tool and target. The runtime resolves it privately in input_text, evaluate, and other browser tools, and redacts credential values from observations. Enter each field explicitly.
- For multi-account sites, prefer the task-specific user context when present, then the freshest enabled cookie bundle.
- Sign in or sign up only with identities listed in Auth Options. Contact details in the goal or User Context describe the user: type them into profile fields, but they are not a sign-in or sign-up identity unless Auth Options lists them or the goal explicitly requires that account.
- When a site offers OTP delivery options, prefer email over SMS.
- {OTP_DELIVERY_CONTRACT}
- Do not open Sign in / Log in and call step 8 while a guest/anonymous path remains viable on the site. Exhaust step 6 first.
- {DISMISSIBLE_AUTH_PROMPT_RULE}
- If members pay less than guests and membership is free, sign up with the minted account instead of checking out as a guest; if sign-up fails, check out as a guest.
- {EXHAUSTED_AUTH_OPTIONS_HANDOFF_RULE}
- {AUTH_ASSISTANCE_HANDOFF_RULE}
{challenge_rule}
- Do not open webmail or inbox websites to retrieve OTP codes."""
