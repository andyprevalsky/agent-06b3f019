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

EMAIL_SEND_BUTTON_PATTERNS = [
    "send",
    "send message",
    "send email",
    "send mail",
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

# Marketing / newsletter opt-in checkboxes ask the site to send info TO the
# shopper. That is not an outbound message the agent composed, so it must not
# trip the email_send write lock. Eventim checkout labels like
# "Send me info about other shows by this organizer" previously parked the
# agent on write_lock approval and blocked request_payment_card.
MARKETING_OPT_IN_PATTERNS = (
    "send me info",
    "send me update",
    "send me news",
    "send me email",
    "send me offer",
    "send me deal",
    "send me promo",
    "email me about",
    "email me info",
    "keep me informed",
    "subscribe to",
    "sign me up for",
)

# Purchase/order button text patterns (case-insensitive)
# These are matched as full phrases to avoid false positives (e.g. "place" alone)
PURCHASE_BUTTON_PHRASES = [
    "buy now",
    "place your order",
    "place order",
    "complete purchase",
    "complete order",
    "confirm order",
    "confirm purchase",
    "confirm and pay",
    "submit order",
    "pay now",
    "proceed to pay",
    "checkout now",
    "complete checkout",
    "confirm your return",
    "confirm return",
    "complete return",
    "submit return",
]


def normalize_write_lock_text(text: str) -> str:
    """Normalize text for write-lock phrase matching."""
    return re.sub(r"\s+", "", text or "").lower()


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


def _is_one_time_code_action(normalized: str) -> bool:
    """Return True when the label asks the site for a one-time code.

    Content test, anywhere in the label. A code is issued to the account being
    signed into, never composed for a third party, so the phrasing and the word
    order carry no risk signal worth gating on.
    """
    if ONE_TIME_CODE_TOKEN_RE.search(normalized) is not None:
        return True
    return any(pattern in normalized for pattern in ONE_TIME_CODE_PATTERNS)


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


def _is_marketing_opt_in_action(normalized: str) -> bool:
    """Return True when the label opts into receiving marketing/info from the site.

    Content test, anywhere in the label. Opting in asks the merchant to email the
    shopper later; it is not composing and sending an outbound message now.
    """
    return any(pattern in normalized for pattern in MARKETING_OPT_IN_PATTERNS)


def is_email_send_button(element_text: str) -> bool:
    """Check whether any local action signal is an outbound send.

    Three independent exemptions clear a signal: asking for a one-time code
    (content, anywhere in the label), marketing/newsletter opt-in (content,
    anywhere in the label), and resending (positional prefix). Each
    newline-delimited signal is still classified on its own, so an exempt label
    can never unlock a neighbouring send control or action-bearing attribute.
    """
    if not element_text:
        return False

    for candidate in element_text.splitlines():
        normalized = re.sub(r"\s+", " ", candidate.lower()).strip()
        if not normalized:
            continue
        if (
            _is_one_time_code_action(normalized)
            or _is_email_otp_retry(normalized)
            or _is_marketing_opt_in_action(normalized)
        ):
            continue
        if any(pattern == normalized or pattern in normalized for pattern in EMAIL_SEND_BUTTON_PATTERNS):
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

    text_lower = normalize_write_lock_text(element_text)

    for phrase in PURCHASE_BUTTON_PHRASES:
        if normalize_write_lock_text(phrase) in text_lower:
            logger.debug(f"Element text '{element_text}' matched purchase pattern: {phrase}")
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
        action_type: "payment", "purchase", "social_post", or "email_send"
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
