"""Write lock detection heuristics for browser agent actions.

This module provides functions to detect high-risk browser actions:
1. Payment field detection - before entering card details
2. Social posting detection - before clicking submit on social media
3. Purchase button detection - before clicking checkout/order buttons
4. Email sending detection - before clicking send buttons

When write lock is enabled and a high-risk action is detected,
the agent must request user approval before proceeding.
"""

import logging
import re
from typing import Any, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Social media and forum domains
SOCIAL_DOMAINS = [
    # Major social platforms
    "twitter.com",
    "x.com",
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "reddit.com",
    "threads.net",
    "tiktok.com",
    "youtube.com",
    "pinterest.com",
    "tumblr.com",
    "snapchat.com",
    # Messaging/Community
    "discord.com",
    "slack.com",
    "telegram.org",
    "whatsapp.com",
    # Publishing platforms
    "medium.com",
    "substack.com",
    "dev.to",
    "hashnode.com",
    "blogger.com",
    "wordpress.com",
    # Forums
    "quora.com",
    "stackoverflow.com",
    "news.ycombinator.com",
]

# Forum URL patterns (match partial URLs)
FORUM_URL_PATTERNS = [
    "/forum/",
    "/forums/",
    "/discuss/",
    "/discussion/",
    "/community/",
    "/board/",
    "/boards/",
    "discourse.",
    "phpbb",
    "vbulletin",
]

AUTH_FLOW_URL_PATTERNS = [
    "login",
    "auth",
    "signup",
    # X hosts signup/login substeps under /i/jf/onboarding/... URLs that do
    # not always include "login" or "signup" in the current route.
    "onboarding",
]

# Payment field patterns (case-insensitive, check name, id, autocomplete, placeholder)
PAYMENT_FIELD_PATTERNS = [
    "card",
    "cc-",
    "credit",
    "debit",
    "cvv",
    "cvc",
    "csv",
    "expir",
    "payment",
    "billing",
    "cardnumber",
    "card-number",
    "card_number",
    "securitycode",
    "security-code",
    "security_code",
]

# Payment autocomplete values (exact matches)
PAYMENT_AUTOCOMPLETE_VALUES = [
    "cc-number",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-csc",
    "cc-name",
    "cc-given-name",
    "cc-family-name",
    "cc-type",
]

PAYMENT_AUTOCOMPLETE_TOKENS = frozenset(PAYMENT_AUTOCOMPLETE_VALUES)


def autocomplete_indicates_payment(autocomplete: str) -> bool:
    """Return True if any whitespace-separated autocomplete token is a payment token.

    The HTML ``autocomplete`` attribute is a space-separated token list (e.g.
    ``"section-checkout billing cc-number"``), so exact-string equality misses
    valid payment fields and lets them evade the write lock. Match on tokens.
    """
    if not autocomplete:
        return False
    return any(token in PAYMENT_AUTOCOMPLETE_TOKENS for token in autocomplete.split())

# Submit button text patterns (case-insensitive contains)
SUBMIT_BUTTON_PATTERNS = [
    "post",
    "tweet",
    "reply",
    "comment",
    "send",
    "publish",
    "share",
    "submit",
]

SUBMIT_BUTTON_EXCLUSION_PATTERNS = [
    "continue",
    "next",
    "log in",
    "login",
    "sign up",
    "signup",
    "create account",
]

# A resend action re-issues something the site already sent; it never composes a
# new outbound message, so it is not a write the user needs to approve. The test
# is purely positional — the label must START with one of these — so ordinary
# sends ("Send message", "Send email") are untouched.
EMAIL_OTP_RETRY_PREFIXES = ("resend", "re-send")

# A one-time code is something the site sends TO the account being signed into.
# It is never a message composed for a third party, so no control that asks for
# one is a write the user needs to approve — regardless of how the label is
# phrased or where in the label the phrase appears. This is deliberately a
# substring test, not a prefix test: "Send new email verification code",
# "Get verification code", and "Email me a security code" are all the same
# action, and making the agent park on any of them wedges the run on an approval
# that nobody is there to answer.
ONE_TIME_CODE_PATTERNS = (
    "verification code",
    "confirmation code",
    "security code",
    "one-time code",
    "one time code",
    "one-time password",
    "login code",
    "sign-in code",
    "sign in code",
    "access code",
    "passcode",
)

# Bare "code" requests ("Send code", "Text me a code", "Get a new code", "Send
# code to •••-7432") are the same one-time-code action. The trailing clause is
# bounded so sharing content ("Send code snippet", "Send discount code to a
# friend") still locks.
_ONE_TIME_CODE_REQUEST_RE = re.compile(
    r"\b(?:send|resend|get|request|email|text|sms)"
    r"(?:\s+(?:me|us|a|an|the|new|another|my|your))*"
    r"\s+codes?"
    r"(?:\s+(?:again|instead|now|to|via|by)\b.*)?$"
)

# Sign-in links, password resets, and verification messages are delivered TO
# the account being signed into, exactly like a one-time code. Matched against
# the word-split form, so "sign-in" is written "sign in".
ACCOUNT_SELF_DELIVERY_PATTERNS = (
    "magic link",
    "sign in link",
    "login link",
    "log in link",
    "reset link",
    "password reset",
    "reset password",
    "reset my password",
    "verification email",
    "verification text",
    "verification link",
    "verification sms",
)

# "Send me …" asks the site to send something to the shopper (receipts, order
# texts, reminders, marketing opt-ins such as Eventim's "Send me info about
# other shows by this organizer", which once blocked request_payment_card). The
# phrase is removed before the leftover-send test so a co-located real send
# ("Send me a copy and send") still locks. Opt-ins without "send" ("Subscribe
# to", "Keep me informed") never contain a send word in the first place.
_SEND_TO_SELF_RE = re.compile(r"\bsend me\b")

# A send action is a word that STARTS with "send" (send, sendBtn → "send btn",
# sendmsg). "send" inside another word — resend, godsend, and camelCase ids like
# showResendMessageLink — is not a send.
_SEND_WORD_RE = re.compile(r"\bsend")
_SPECIFIC_EMAIL_SEND_RE = re.compile(r"\bsend (?:e ?)?mail\b")

# In-product AI composers submit a prompt to the current product. That is not
# an outbound message to a third party, so it must not trip email_send.
# Agent 37b7bb31 (2026-09-09): ChatGPT ``Send prompt`` after an image upload
# parked the run on write_lock approval for a tattoo edit.
AI_COMPOSER_SUBMIT_PHRASES = (
    "send prompt",
    "submit prompt",
)

# Generic composer labels that are email_send elsewhere ("Send", "Send
# message") become composer submits only on known AI-assistant hosts.
AI_COMPOSER_SUBMIT_EXACT = frozenset({
    "send",
    "send message",
    "submit",
    "send prompt",
    "submit prompt",
})

AI_ASSISTANT_COMPOSER_HOSTS = (
    "chatgpt.com",
    "chat.openai.com",
    "claude.ai",
    "gemini.google.com",
)

# Purchase/order button text patterns (case-insensitive)
# These are matched as full phrases to avoid false positives (e.g. "place" alone)
PURCHASE_BUTTON_PHRASES = [
    "buy now",
    "buy it now",
    "buy with prime",
    "place your order",
    "place order",
    "complete your purchase",
    "complete your order",
    "complete purchase",
    "complete order",
    "confirm your purchase",
    "confirm order",
    "confirm purchase",
    "confirm and pay",
    "submit your order",
    "submit order",
    "pay now",
    "proceed to pay",
    "checkout now",
    "complete checkout",
    "order and pay",
    "purchase now",
    "finish order",
    "finish and pay",
]

# Return/refund confirmation phrases are a separate irreversible gate from purchase.
# Bundling them under purchase forced purchase-shaped notification metadata that
# return pages cannot satisfy (no PDP rating / product_url).
RETURN_BUTTON_PHRASES = [
    "confirm your return",
    "confirm return",
    "complete return",
    "submit return",
]

# Amazon SPR final-commit routes. Intermediate wizard Continues live under
# `/spr/returns/cart` and must NOT lock; only the contract/confirm commit does.
# Agent 785a3207 (2026-09-28 browser-amazon-return): Continue on
# `/spr/returns/contract/…` submitted the refund with no write_lock attention
# because the CTA is labeled "Continue", not "Confirm your return".
RETURN_COMMIT_URL_PATH_PATTERNS = (
    "/spr/returns/contract",
    "/spr/returns/confirm",
)

# Exact (whitespace-stripped) labels that commit a return on RETURN_COMMIT URLs.
# Do not use bare substring "return" — "Return to your orders" must stay open.
RETURN_COMMIT_CONTINUE_LABELS = frozenset({
    "continue",
    "submit",
    "confirm",
})

# Wizard-step Continues that share `/spr/returns/contract` with the final commit.
# Agent c1b33ca5 (2026-09-28 browser-amazon-return): clicked
# ``resolutions-section-continue-button`` (Continue after picking Visa refund)
# intending to reach drop-off selection; write_lock treated it as the final
# commit, so the approval lacked a named drop-off and the judge failed.
# Agent cf4935f5 (2026-09-29): same button via shadow ``input type=submit``;
# signal was only ``submit\nContinue`` until ancestor ids were joined into
# ``_element_write_lock_signal``. These machine ids must keep Continue unlocked;
# phrase-only Continues on the same URL still lock (agent 785a3207 final commit).
RETURN_COMMIT_CONTINUE_EXCLUSION_MARKERS = (
    "resolutions-section-continue",
    "productconditioncontinue",
    "reasoncontinue",
    "methodcontinue",
)

# Legal/consent copy often quotes the purchase button ("By clicking Buy Now, you
# agree…"). That prose is not a submit control. Eventim checkout (2026-08-10
# agent e20e5a4e) matched "buy now" inside Terms of Purchase text, forced a
# purchase write-lock notification, and blocked request_payment_card.
PURCHASE_CONSENT_PROSE_PATTERNS = [
    "by clicking",
    "you agree",
    "terms of purchase",
    "terms of service",
    "privacy policy",
    "privacy practices",
    "acknowledge our",
]

# Buy-Now-Pay-Later / informational finance chrome contains "buy now" but is not
# a charge commit. Match on whitespace-stripped forms.
# Do NOT use bare "paylater" — that would exclude real charge commits like
# "Place order — pay later" (normalizes to …placeorder…paylater…). Keep BNPL
# product chrome (`buynowpaylater`) and learn-more copy (`learnaboutbuy`).
PURCHASE_INFORMATIONAL_EXCLUSION_PATTERNS = [
    "buynowpaylater",
    "learnaboutbuy",
]

# Fulfillment / routing words merchants insert between purchase verbs
# ("Place Pickup Order", "Complete Delivery Purchase"). Transparent for matching
# so the existing place/complete/confirm/submit + order/purchase phrases still hit.
# Deliberately does NOT include "now" or "your" — those are part of base phrases
# like "pay now" / "place your order".
_PURCHASE_FULFILLMENT_TRANSPARENT_RE = re.compile(
    r"\b(?:"
    r"pick[\s-]?up|delivery|shipping|take[\s-]?out|to[\s-]?go|"
    r"curbside|drive[\s-]?thru|same[\s-]?day|express|priority|asap|"
    r"for\s+pickup|for\s+delivery"
    r")\b",
    re.IGNORECASE,
)


def normalize_write_lock_text(text: str) -> str:
    """Normalize text for write-lock phrase matching."""
    return re.sub(r"\s+", "", text or "").lower()


def _purchase_signal_match_forms(signal: str) -> list[str]:
    """Return normalized forms of a click signal for purchase phrase matching.

    Form 0: raw whitespace-stripped label (legacy).
    Form 1: ``&`` → ``and``, fulfillment-mode words removed, then whitespace-stripped
    so ``Place Pickup Order`` / ``Confirm & Pay`` collapse onto base phrases.
    """
    spaced = re.sub(r"\s+", " ", (signal or "").lower()).strip()
    if not spaced:
        return []
    spaced = spaced.replace("&", " and ")
    forms = [normalize_write_lock_text(spaced)]
    collapsed = _PURCHASE_FULFILLMENT_TRANSPARENT_RE.sub(" ", spaced)
    collapsed = re.sub(r"\s+", " ", collapsed).strip()
    collapsed_norm = normalize_write_lock_text(collapsed)
    if collapsed_norm and collapsed_norm not in forms:
        forms.append(collapsed_norm)
    return forms


def _is_purchase_informational_exclusion(normalized: str) -> bool:
    """True when the label is BNPL / learn-more chrome, not a charge commit.

    Strip non-alphanumerics so ``Buy now, pay later`` collapses to the same
    ``buynowpaylater`` form as ``Buy Now Pay Later``. Do not use bare
    ``paylater`` — that would also match charge commits like
    ``Place order — pay later``.
    """
    alnum = re.sub(r"[^a-z0-9]", "", normalized or "")
    if not alnum:
        return False
    return any(pattern in alnum for pattern in PURCHASE_INFORMATIONAL_EXCLUSION_PATTERNS)

_DOM_IDENTIFIER_SIGNAL = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")


def is_dom_identifier_write_lock_signal(signal: str) -> bool:
    """Return True for CSS-like id/name tokens that are not user-visible labels.

    Fandango checkout (2026-08-20 agent 1c3003ef): clicking the email sign-in
    input ``#buynow-email-si`` joined the machine id into the write-lock signal.
    After whitespace stripping, phrase ``buy now`` matched inside ``buynow-…``
    and forced a purchase write lock before ``request_payment_card``.
    """
    text = (signal or "").strip()
    if not text or any(ch.isspace() for ch in text):
        return False
    if "-" not in text and "_" not in text:
        return False
    return bool(_DOM_IDENTIFIER_SIGNAL.fullmatch(text))


_SUBMIT_INPUT_TYPES = frozenset({"submit", "button", "image"})


def is_click_write_lock_eligible_control(element: Any) -> bool:
    """Return whether a click target may raise a click write-lock approval.

    Andy (2026-08-21): plain inputs never trigger click write locks — only
    buttons / form submits. Payment-field typing stays on the separate
    ``input_text`` path. Coordinate clicks (``element is None``) keep using
    text heuristics.
    """
    if element is None:
        return True

    tag = str(
        getattr(element, "tag_name", "") or getattr(element, "node_name", "") or ""
    ).strip().lower()
    # Missing / mock tags are not form-field exclusions.
    if not tag or tag.startswith("<") or "magicmock" in tag:
        return True

    attrs = getattr(element, "attributes", None) or {}
    if not isinstance(attrs, dict):
        attrs = {}
    input_type = str(attrs.get("type") or "").strip().lower()

    if tag in {"textarea", "select", "option"}:
        return False
    if tag == "input":
        return input_type in _SUBMIT_INPUT_TYPES
    return True


def is_social_domain(url: str) -> bool:
    """Check if URL is a social media or forum domain.

    Args:
        url: The current page URL

    Returns:
        True if the URL matches a social media or forum pattern
    """
    if not url:
        return False

    try:
        parsed = urlparse(url.lower())
        domain = parsed.netloc
        full_url = url.lower()

        if any(pattern in full_url for pattern in AUTH_FLOW_URL_PATTERNS):
            logger.debug(f"URL {url} matched auth-flow pattern; skipping social write lock")
            return False

        # Remove www. prefix for matching
        if domain.startswith("www."):
            domain = domain[4:]

        # Check exact domain matches
        for social_domain in SOCIAL_DOMAINS:
            if domain == social_domain or domain.endswith("." + social_domain):
                logger.debug(f"URL {url} matched social domain: {social_domain}")
                return True

        # Check forum URL patterns
        for pattern in FORUM_URL_PATTERNS:
            if pattern in full_url:
                logger.debug(f"URL {url} matched forum pattern: {pattern}")
                return True

        return False
    except Exception as e:
        logger.warning(f"Error parsing URL {url}: {e}")
        return False


def is_submit_button(element_text: str) -> bool:
    """Check if element text indicates a submit/post button.

    Args:
        element_text: The text content of the button element

    Returns:
        True if the text contains submit-like patterns
    """
    if not element_text:
        return False

    text_lower = normalize_write_lock_text(element_text)

    for pattern in SUBMIT_BUTTON_EXCLUSION_PATTERNS:
        if normalize_write_lock_text(pattern) in text_lower:
            logger.debug(f"Element text '{element_text}' matched submit exclusion pattern: {pattern}")
            return False

    for pattern in SUBMIT_BUTTON_PATTERNS:
        if normalize_write_lock_text(pattern) in text_lower:
            logger.debug(f"Element text '{element_text}' matched submit pattern: {pattern}")
            return True

    return False


ONE_TIME_CODE_TOKEN_RE = re.compile(r"\botps?\b")


def _action_words(text: str) -> str:
    """Split a click signal into lowercase words, including DOM identifiers.

    Click signals mix visible labels with id/name attributes
    (``showResendMessageLink``, ``resend_sms_code``, ``auth-resend-cta``).
    Splitting camelCase and separators lets word-level tests see ``resend`` as
    its own word instead of matching ``send`` inside it.
    """
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text or "")
    spaced = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", spaced)
    words = re.sub(r"[^a-z0-9]+", " ", spaced.lower())
    words = re.sub(r"\bre\s+send", "resend", words)
    return " ".join(words.split())


def _is_one_time_code_action(normalized: str, words: str = "") -> bool:
    """Return True when the label asks the site for a one-time code or sign-in message.

    Content test, anywhere in the label. A code, sign-in link, reset, or
    verification message is issued to the account being signed into, never
    composed for a third party, so the phrasing and the word order carry no
    risk signal worth gating on.
    """
    words = words or _action_words(normalized)
    if ONE_TIME_CODE_TOKEN_RE.search(words) is not None:
        return True
    if any(pattern in normalized for pattern in ONE_TIME_CODE_PATTERNS):
        return True
    if _ONE_TIME_CODE_REQUEST_RE.search(words) is not None:
        return True
    return any(re.search(rf"\b{pattern}\b", words) for pattern in ACCOUNT_SELF_DELIVERY_PATTERNS)


def _is_email_otp_retry(normalized: str) -> bool:
    """Return True when the label's action is a resend rather than a new send.

    Deliberately positional and nothing else: no email/code/destination
    inspection. A resend re-issues something the site already decided to send, so
    it is never a new outbound write, and the earlier destination and code-word
    tests only made safe retry labels fail closed and hang the run on an approval
    that never arrives.
    """
    return any(
        normalized == prefix or normalized.startswith(f"{prefix} ")
        for prefix in EMAIL_OTP_RETRY_PREFIXES
    )


def is_ai_assistant_composer_host(url: str) -> bool:
    """Return True when ``url`` is an in-product AI assistant composer host."""
    if not url:
        return False
    try:
        domain = urlparse(url.lower()).netloc
    except Exception:
        return False
    if domain.startswith("www."):
        domain = domain[4:]
    return any(domain == host or domain.endswith("." + host) for host in AI_ASSISTANT_COMPOSER_HOSTS)


def _is_ai_composer_submit(normalized: str, url: str = "") -> bool:
    """Return True when the label submits a prompt to an in-product AI composer.

    ``send prompt`` / ``submit prompt`` are content tests and never email,
    regardless of host. Bare ``send`` / ``send message`` / ``submit`` are
    composer submits only on known AI-assistant hosts so Gmail/iMessage
    stay locked.
    """
    if any(phrase in normalized for phrase in AI_COMPOSER_SUBMIT_PHRASES):
        return True
    return bool(url) and is_ai_assistant_composer_host(url) and normalized in AI_COMPOSER_SUBMIT_EXACT


def is_email_send_button(element_text: str, url: str = "") -> bool:
    """Check whether any local action signal is an outbound send.

    A send is a word starting with ``send`` in the word-split signal, so
    ``resend`` / ``godsend`` / ``showResendMessageLink`` are not sends while
    ``Send``, ``sendBtn``, and ``compose-send`` are. Exemptions: one-time code
    or sign-in delivery to the account (content, anywhere), resend (positional
    prefix), ``send me …`` (removed before the leftover-send test), and
    in-product AI composer submits (``send prompt`` anywhere; generic
    send/submit only on AI-assistant hosts). ``send email`` / ``send mail``
    beats the composer exemption. Each newline-delimited signal is classified
    on its own so an exempt label can never unlock a neighbouring send control
    or action-bearing attribute.
    """
    if not element_text:
        return False

    for candidate in element_text.splitlines():
        normalized = re.sub(r"\s+", " ", candidate.lower()).strip()
        words = _action_words(candidate)
        if not words:
            continue
        if _is_one_time_code_action(normalized, words) or _is_email_otp_retry(normalized):
            continue
        # Email-only phrases win over the AI composer exemption so a composite
        # label like "Send prompt and send email" cannot skip write-lock.
        # Do not hoist ``send message`` here — that is a composer submit on
        # ChatGPT/Claude/Gemini.
        if _SPECIFIC_EMAIL_SEND_RE.search(words):
            return True
        if _is_ai_composer_submit(words, url):
            continue
        if _SEND_WORD_RE.search(_SEND_TO_SELF_RE.sub(" ", words)):
            return True
    return False


def is_purchase_button(element_text: str) -> bool:
    """Check if element text indicates a purchase/order button.

    Args:
        element_text: The text content of the button element

    Returns:
        True if the text contains purchase/order phrases
    """
    if not element_text:
        return False

    # Callers join independent write-lock signals with newlines. Apply consent
    # exclusion only within the same signal that carries a purchase phrase so
    # "Terms of Service" in one signal cannot veto "Buy Now" in another.
    for signal in element_text.split("\n"):
        if is_dom_identifier_write_lock_signal(signal):
            logger.debug(
                f"Element signal '{signal[:80]}' skipped as DOM id/name, not a purchase label"
            )
            continue
        match_forms = _purchase_signal_match_forms(signal)
        if not match_forms:
            continue
        # Consent / BNPL exclusions apply to every match form of this signal.
        if any(
            normalize_write_lock_text(pattern) in form
            for form in match_forms
            for pattern in PURCHASE_CONSENT_PROSE_PATTERNS
        ):
            logger.debug(
                f"Element signal '{signal[:80]}' matched purchase consent-prose exclusion"
            )
            continue
        if any(_is_purchase_informational_exclusion(form) for form in match_forms):
            logger.debug(
                f"Element signal '{signal[:80]}' matched purchase informational exclusion"
            )
            continue

        for phrase in PURCHASE_BUTTON_PHRASES:
            phrase_norm = normalize_write_lock_text(phrase)
            if any(phrase_norm in form for form in match_forms):
                logger.debug(f"Element text '{signal[:80]}' matched purchase pattern: {phrase}")
                return True

    return False


def is_return_commit_url(url: str) -> bool:
    """True when the URL is an irreversible Amazon (or similar) return commit page.

    ``/spr/returns/confirmation/…`` is the *post*-submit receipt and must not
    match the ``/spr/returns/confirm`` commit pattern.
    """
    if not url:
        return False
    path = (urlparse(url).path or "").lower()
    if "/spr/returns/confirmation" in path:
        return False
    return any(pattern in path for pattern in RETURN_COMMIT_URL_PATH_PATTERNS)


# Amazon self-service return dead-end copy. Agent 338f26c8 (2026-09-28
# browser-amazon-return): after mis-selecting Barebells protein bars, Amazon
# showed "Your return request needs to be reviewed. Please contact customer
# service." The agent opened Contact Us, burned the remaining step budget,
# never reached a return write_lock, and the root respawned a second browser
# (exact count expected 1, got 2).
AMAZON_RETURN_SELF_SERVICE_BLOCK_MARKERS = (
    "your return request needs to be reviewed",
    "please contact customer service",
)

AMAZON_RETURN_SELF_SERVICE_BLOCK_NOTE = (
    "Amazon self-service return is blocked for this item "
    "(return request needs review / contact customer service). "
    "Do not open Contact Us. Abandon this item and select the next "
    "eligible non-excluded physical item, or report this exact blocker "
    "if no other eligible item remains."
)


def detect_amazon_return_self_service_block(url: str, page_text: str) -> Optional[str]:
    """Return a recovery note when Amazon blocks self-service return for an item.

    Matches only on ``/spr/returns/`` pages so generic Help/Contact copy on
    order-history does not fire.
    """
    if "/spr/returns/" not in (url or "").lower():
        return None
    text = (page_text or "").lower()
    if not text:
        return None
    if all(marker in text for marker in AMAZON_RETURN_SELF_SERVICE_BLOCK_MARKERS):
        return AMAZON_RETURN_SELF_SERVICE_BLOCK_NOTE
    return None


# Selected drop-off appears in the refund summary as ``Shipping (<name Dropoff>)``
# once the agent has chosen a method (agent 788d17cf / cf4935f5 amazon-return).
_AMAZON_RETURN_SHIPPING_DROPOFF_RE = re.compile(
    r"Shipping\s*\(\s*([^)]*Drop[\s-]?off[^)]*)\)",
    re.IGNORECASE,
)
_AMAZON_RETURN_SELECTED_DROPOFF_RE = re.compile(
    r"(Whole Foods(?:\s+Market)?\s+Drop[\s-]?off[^\n,]{0,60}"
    r"|Amazon Stores?\s+Drop[\s-]?off[^\n,]{0,60}"
    r"|Staples\s+Drop[\s-]?off[^\n,]{0,60}"
    r"|FedEx Office\s+Drop[\s-]?off[^\n,]{0,60}"
    r"|(?:The\s+)?UPS Store\s+Drop[\s-]?off[^\n,]{0,60}"
    r"|Kohl'?s\s+Drop[\s-]?off[^\n,]{0,60})",
    re.IGNORECASE,
)
_AMAZON_RETURN_VISA_RE = re.compile(
    r"Visa(?:\s+card)?\s+ending\s+in\s+(\d{4})",
    re.IGNORECASE,
)
_AMAZON_RETURN_REFUND_TOTAL_RE = re.compile(
    r"(?:Estimated\s+)?total\s+refund\s*[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)",
    re.IGNORECASE,
)
_AMAZON_RETURN_REFUND_SUBTOTAL_RE = re.compile(
    r"Refund\s+subtotal\s*[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)",
    re.IGNORECASE,
)


def extract_amazon_return_approval_fields(page_text: str) -> dict[str, str]:
    """Pull named drop-off / refund / payment from an Amazon return commit page.

    Used to enrich the deterministic write-lock fallback so approval copy still
    names the selected free drop-off when the notification fork is slow or killed
    (agent 788d17cf: fork in flight at timeout after Whole Foods was selected).
    """
    text = page_text or ""
    fields: dict[str, str] = {}
    shipping = _AMAZON_RETURN_SHIPPING_DROPOFF_RE.search(text)
    if shipping:
        fields["drop_off"] = re.sub(r"\s+", " ", shipping.group(1)).strip(" -:")
    else:
        # Prefer a drop-off whose own option/control is selected. Bound the
        # selection window to this match (and before the next drop-off) so a
        # later option's [checked] cannot select an earlier one.
        drop_matches = list(_AMAZON_RETURN_SELECTED_DROPOFF_RE.finditer(text))
        for index, match in enumerate(drop_matches):
            next_start = (
                drop_matches[index + 1].start()
                if index + 1 < len(drop_matches)
                else len(text)
            )
            option_end = min(next_start, match.end() + 40)
            window = text[match.start() : option_end].lower()
            # Reject negated markers (unchecked / aria-*-false / not selected).
            has_selection = False
            for marker in re.finditer(
                r"\b(checked|selected|pressed)\b",
                window,
            ):
                token = marker.group(1)
                start = marker.start()
                prefix = window[max(0, start - 12) : start]
                suffix = window[start : start + 18]
                negated_prefix = prefix.endswith("un") or prefix.rstrip().endswith("not")
                false_attr = (
                    f"{token}=false" in suffix
                    or f'{token}="false"' in suffix
                    or f"{token}='false'" in suffix
                )
                if negated_prefix or false_attr:
                    continue
                has_selection = True
                break
            if has_selection:
                fields["drop_off"] = re.sub(r"\s+", " ", match.group(1)).strip(" -:")
                break
        # Do not guess the first listed drop-off from "no box" alone — multiple
        # options can share that copy. Require shipping summary or selection
        # evidence before naming a drop-off in the approval question.

    visa = _AMAZON_RETURN_VISA_RE.search(text)
    if visa:
        fields["payment_method"] = f"Visa ending in {visa.group(1)}"

    # Prefer the displayed total; never promote a subtotal as the total refund.
    refund_total = _AMAZON_RETURN_REFUND_TOTAL_RE.search(text)
    if refund_total:
        fields["refund_amount"] = f"${refund_total.group(1)}"
        fields["refund_label"] = "Estimated total refund"
    else:
        refund_subtotal = _AMAZON_RETURN_REFUND_SUBTOTAL_RE.search(text)
        if refund_subtotal:
            fields["refund_amount"] = f"${refund_subtotal.group(1)}"
            fields["refund_label"] = "Refund subtotal"

    return fields


def _amazon_return_dropoff_terms(page_text: str, drop_off: str) -> str:
    """Describe free/no-box/no-label only when the page establishes those terms."""
    lower = (page_text or "").lower()
    terms: list[str] = []
    shipping_free = bool(
        re.search(
            r"shipping\s*\([^)]*drop[\s-]?off[^)]*\)\s*:\s*\$0\.00",
            lower,
        )
        or re.search(r"\bfree\s+(?:drop[\s-]?off|return\s+shipping)\b", lower)
    )
    if shipping_free:
        terms.append("free")
    if "no box" in lower or "no-box" in lower:
        terms.append("no-box")
    if "no label" in lower or "no-label" in lower:
        terms.append("no-label")
    if not terms:
        return f"Selected drop-off: {drop_off}."
    return f"Selected {'/'.join(terms)} drop-off: {drop_off}."


def enrich_return_write_lock_question(
    question: str,
    page_text: str,
    *,
    url: str = "",
    system_name: str = "Rose",
) -> str:
    """Ensure return write-lock approval text names the selected drop-off when visible."""
    fields = extract_amazon_return_approval_fields(page_text)
    drop_off = fields.get("drop_off")
    if not drop_off:
        return question

    payment = fields.get("payment_method") or "original payment method"
    amount = fields.get("refund_amount") or "the refund amount shown"
    refund_label = fields.get("refund_label") or "Refund"
    drop_off_line = _amazon_return_dropoff_terms(page_text, drop_off)
    domain = urlparse(url).netloc if url else "Amazon"
    lines = [
        "**Approval Needed**",
        "",
        f"{system_name} wants to confirm a return on **{domain}**.",
        "Action: Confirm return",
        f"Change: {refund_label} {amount} to {payment}. {drop_off_line}",
    ]
    if url:
        lines.append(f"**Page:** {url}")
    return "\n".join(lines)


def _has_return_commit_continue_exclusion(element_text: str) -> bool:
    """True when the click signal is a mid-wizard Continue on a commit URL."""
    haystack = normalize_write_lock_text(element_text)
    if not haystack:
        return False
    return any(marker in haystack for marker in RETURN_COMMIT_CONTINUE_EXCLUSION_MARKERS)


def _return_commit_label_tokens(element_text: str) -> list[str]:
    """Visible/type tokens from a click signal, excluding DOM id/name lines."""
    tokens: list[str] = []
    for signal in (element_text or "").split("\n"):
        if is_dom_identifier_write_lock_signal(signal):
            continue
        text_lower = normalize_write_lock_text(signal)
        if text_lower:
            tokens.append(text_lower)
    return tokens


def _is_return_commit_continue_signal(element_text: str) -> bool:
    """True for irreversible Continue/Submit/Confirm on a return commit URL.

    Agent 785a3207: final commit was ``submit\\nContinue`` (form submit).
    Agent 13e735c9: mid-wizard span ``Continue`` (no submit type) after picking
    Visa refund — must stay unlocked so drop-off can be selected first.
    Exclusion markers (resolutions-section-continue, …) also keep Continues open.
    """
    if _has_return_commit_continue_exclusion(element_text):
        return False
    tokens = _return_commit_label_tokens(element_text)
    if not tokens:
        return False
    token_set = set(tokens)
    if "confirm" in token_set:
        return True
    # Require submit+continue (form submit CTA). A bare type=submit token on a
    # return-commit URL is not enough — an unrelated unlabeled submit must not
    # mint a domain-scoped return approval that later lets the real commit through.
    if "submit" in token_set and "continue" in token_set:
        return True
    return False


def is_return_button(element_text: str, url: str = "") -> bool:
    """Check if element text indicates a return/refund confirmation control.

    Phrase matches ("Confirm your return", …) apply on any URL. On Amazon SPR
    contract/confirm commit URLs, form-submit Continues also lock; plain span
    Continues used mid-wizard do not.
    """
    if not element_text:
        return False

    on_return_commit_url = is_return_commit_url(url)

    for signal in element_text.split("\n"):
        if is_dom_identifier_write_lock_signal(signal):
            logger.debug(
                f"Element signal '{signal[:80]}' skipped as DOM id/name, not a return label"
            )
            continue
        text_lower = normalize_write_lock_text(signal)
        if not text_lower:
            continue
        for phrase in RETURN_BUTTON_PHRASES:
            if normalize_write_lock_text(phrase) in text_lower:
                logger.debug(f"Element text '{signal[:80]}' matched return pattern: {phrase}")
                return True

    if on_return_commit_url and _is_return_commit_continue_signal(element_text):
        logger.debug(
            f"Element text '{element_text[:80]}' matched return-commit Continue on {url[:80]}"
        )
        return True
    return False


async def is_payment_field(
    session: Any,
    element: Any,
    element_index: int,
) -> bool:
    """Check if element is a payment input field.

    Uses Playwright to get element attributes and check for payment patterns.

    Args:
        session: BrowserSession instance
        element: EnhancedDOMTreeNode element
        element_index: Element's backend_node_id

    Returns:
        True if the element appears to be a payment field
    """
    if not element:
        return False

    try:
        element_attrs = getattr(element, "attributes", None) or {}
        if isinstance(element_attrs, dict):
            attrs = {str(k).lower(): str(v).lower() for k, v in element_attrs.items() if v is not None}

            autocomplete = attrs.get("autocomplete", "")
            if autocomplete_indicates_payment(autocomplete):
                logger.info(f"Payment field detected: autocomplete='{autocomplete}'")
                return True

            for attr_name in ["name", "id", "placeholder", "aria-label"]:
                attr_value = attrs.get(attr_name, "")
                for pattern in PAYMENT_FIELD_PATTERNS:
                    if pattern in attr_value:
                        logger.info(f"Payment field detected: {attr_name}='{attr_value}' matches '{pattern}'")
                        return True

        if not session:
            return False

        # Get the Playwright page
        get_page = getattr(session, "get_page", None) or getattr(session, "get_current_page", None)
        if not callable(get_page):
            return False

        page = await get_page()
        if not page:
            return False

        # Get element attributes via CDP
        # We need to resolve the backend_node_id to a selector or use CDP directly
        try:
            # Use CDP to get node info
            result = await page.client.send("DOM.describeNode", {
                "backendNodeId": element_index
            })

            node = result.get("node", {})
            attributes = node.get("attributes", [])

            # Parse attributes into a dict (attributes come as [name, value, name, value, ...])
            attrs = {}
            for i in range(0, len(attributes), 2):
                if i + 1 < len(attributes):
                    attrs[attributes[i].lower()] = attributes[i + 1].lower()

            # Check autocomplete attribute (token-based match)
            autocomplete = attrs.get("autocomplete", "")
            if autocomplete_indicates_payment(autocomplete):
                logger.info(f"Payment field detected: autocomplete='{autocomplete}'")
                return True

            # Check name, id, placeholder for payment patterns
            for attr_name in ["name", "id", "placeholder", "aria-label"]:
                attr_value = attrs.get(attr_name, "")
                for pattern in PAYMENT_FIELD_PATTERNS:
                    if pattern in attr_value:
                        logger.info(f"Payment field detected: {attr_name}='{attr_value}' matches '{pattern}'")
                        return True

            # Check type="password" on payment domains (could be CVV)
            if attrs.get("type") == "password":
                # Check if we're on a payment-related domain
                url = page.url.lower() if page.url else ""
                payment_domains = ["stripe.com", "paypal.com", "checkout.", "payment.", "pay."]
                for domain in payment_domains:
                    if domain in url:
                        logger.info(f"Password field on payment domain detected: {url}")
                        return True

            return False

        except Exception as cdp_error:
            logger.warning(f"CDP error getting element attributes: {cdp_error}")

            # Fallback: check element text_content for payment hints
            text_content = getattr(element, "text_content", "") or ""
            text_lower = text_content.lower()
            for pattern in PAYMENT_FIELD_PATTERNS:
                if pattern in text_lower:
                    logger.info(f"Payment field detected via text content: '{text_content}'")
                    return True

            return False

    except Exception as e:
        logger.warning(f"Error checking payment field: {e}")
        return False


def get_write_lock_approval_question(
    action_type: str,
    url: str,
    element_text: Optional[str] = None,
    field_description: Optional[str] = None,
    system_name: str = "Rose",
) -> str:
    """Generate an approval question for a write lock violation.

    Args:
        action_type: "payment", "purchase", "return", "social_post", or "email_send"
        url: Current page URL
        element_text: Text of the element being interacted with
        field_description: Description of the field (for payment)
        system_name: Custom system name (default "Rose")

    Returns:
        Formatted approval question string
    """
    if action_type == "payment":
        return (
            f"**Payment Input Detected**\n\n"
            f"{system_name} wants to enter payment details.\n\n"
            f"**Field:** {field_description or 'Payment field'}\n"
            f"**Page:** {url}"
        )
    elif action_type == "purchase":
        domain = urlparse(url).netloc if url else "unknown"
        return (
            f"**Purchase Detected**\n\n"
            f"{system_name} wants to place an order on **{domain}**.\n\n"
            f"**Button:** {element_text or 'Place order'}\n"
            f"**Page:** {url}"
        )
    elif action_type == "return":
        domain = urlparse(url).netloc if url else "unknown"
        return (
            f"**Return Detected**\n\n"
            f"{system_name} wants to confirm a return on **{domain}**.\n\n"
            f"**Button:** {element_text or 'Confirm return'}\n"
            f"**Page:** {url}"
        )
    elif action_type == "social_post":
        domain = urlparse(url).netloc if url else "unknown"
        return (
            f"**Social Media Post Detected**\n\n"
            f"{system_name} wants to post content to **{domain}**.\n\n"
            f"**Button:** {element_text or 'Submit'}\n"
            f"**Page:** {url}"
        )
    elif action_type == "email_send":
        domain = urlparse(url).netloc if url else "unknown"
        return (
            f"**Email Send Detected**\n\n"
            f"{system_name} wants to send an email from **{domain}**.\n\n"
            f"**Button:** {element_text or 'Send'}\n"
            f"**Page:** {url}"
        )
    else:
        return (
            f"**Write Action Detected**\n\n"
            f"{system_name} wants to perform a write action.\n\n"
            f"**Page:** {url}"
        )
