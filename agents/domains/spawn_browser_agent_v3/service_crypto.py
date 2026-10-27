"""Cryptography and payment services for spawn-browser-agent-v3 domain.

Payment decryption, password handling, and OTP extraction.
"""

from __future__ import annotations

import asyncio
import base64
import html
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import structlog

from domains.spawn_browser_agent_v3.repo import (
    fetch_recent_emails,
    fetch_recent_imessages,
    fetch_recent_sms_messages,
)
from utils.error_utils import extract_error_message

logger = structlog.get_logger()

MIN_USABLE_EMAIL_OTP_TTL_SECONDS = 30
CHROMIUM_UNIX_EPOCH_OFFSET_SECONDS = 11644473600
UNIX_MS_VS_CHROMIUM_MICROSECONDS_BOUNDARY = 10000000000000
PAYMENT_CARD_SECRET_REFS = ("card_number", "card_name", "card_expiry", "card_cvv")
PAYMENT_CARD_ENTRY_RULE = (
    "Use request_payment_card only if checkout requires you to enter new card details. "
    "If a valid saved payment method is already selected and no card entry is required, "
    "do not call request_payment_card; continue with that saved method."
)


# ========================================
# RATE LIMIT EXTRACTION
# ========================================


def _normalize_rate_limited_until(value: Any) -> Optional[str]:
    """Normalize a reset timestamp (epoch seconds or ISO string) to UTC ISO format."""
    if value is None:
        return None

    # Epoch seconds (int/float or numeric string)
    try:
        if isinstance(value, (int, float)):
            if value > 0:
                dt = datetime.fromtimestamp(float(value), tz=timezone.utc)
                return dt.isoformat().replace("+00:00", "Z")
        elif isinstance(value, str) and value.strip().isdigit():
            dt = datetime.fromtimestamp(float(value.strip()), tz=timezone.utc)
            return dt.isoformat().replace("+00:00", "Z")
    except Exception:
        pass

    # ISO string
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            pass

    return None


def _cookie_timestamp_iso(value: Any) -> str:
    if value is None or value == "":
        return "unknown freshness"
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return "unknown freshness"
        try:
            numeric = int(stripped)
        except ValueError:
            return stripped
    elif isinstance(value, (int, float)):
        numeric = int(value)
    else:
        return str(value)

    try:
        if numeric > UNIX_MS_VS_CHROMIUM_MICROSECONDS_BOUNDARY:
            seconds = numeric / 1_000_000 - CHROMIUM_UNIX_EPOCH_OFFSET_SECONDS
        elif numeric > 10_000_000_000:
            seconds = numeric / 1_000
        else:
            seconds = numeric
        return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return str(value)


def extract_rate_limited_until(llm_result: Dict[str, Any]) -> Optional[str]:  # noqa: C901
    """Extract rateLimitedUntil from known fields and fallback text."""
    if not isinstance(llm_result, dict):
        return None

    # 1) Canonical fields
    for key in ("rateLimitedUntil", "rate_limited_until", "rateLimitedUntilIso"):
        normalized = _normalize_rate_limited_until(llm_result.get(key))
        if normalized:
            return normalized

    # 2) Known headers payload
    headers = llm_result.get("rateLimitHeaders") or llm_result.get("rate_limit_headers") or {}
    if isinstance(headers, dict):
        for key in (
            "unifiedReset",
            "anthropic-ratelimit-unified-reset",
            "anthropic-ratelimit-unified-5h-reset",
            "anthropic-ratelimit-unified-7d-reset",
        ):
            normalized = _normalize_rate_limited_until(headers.get(key))
            if normalized:
                return normalized

        retry_after = headers.get("retryAfter") or headers.get("retry-after")
        try:
            retry_after_s = int(str(retry_after).strip()) if retry_after is not None else None
            if retry_after_s and retry_after_s > 0:
                dt = datetime.now(timezone.utc).timestamp() + retry_after_s
                return datetime.fromtimestamp(dt, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            pass

    # 3) Search text fields for epoch/ISO hints
    text_candidates = [
        llm_result.get("message"),
        llm_result.get("details"),
        llm_result.get("error"),
        llm_result.get("rateLimitMessage"),
    ]
    text_blob = " ".join(str(t) for t in text_candidates if t)
    if text_blob:
        # ISO-like date
        iso_match = re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", text_blob)
        if iso_match:
            normalized = _normalize_rate_limited_until(iso_match.group(0))
            if normalized:
                return normalized

        # Epoch seconds in anthropic reset headers (10+ digits)
        epoch_match = re.search(r"\b(\d{10,})\b", text_blob)
        if epoch_match:
            normalized = _normalize_rate_limited_until(epoch_match.group(1))
            if normalized:
                return normalized

        # retry-after style
        retry_match = re.search(r"retry[- ]after[:=]?\s*(\d+)", text_blob, flags=re.IGNORECASE)
        if retry_match:
            try:
                retry_after_s = int(retry_match.group(1))
                if retry_after_s > 0:
                    dt = datetime.now(timezone.utc).timestamp() + retry_after_s
                    return datetime.fromtimestamp(dt, tz=timezone.utc).isoformat().replace("+00:00", "Z")
            except Exception:
                pass

    return None


# ========================================
# PAYMENT / AUTOPAY
# ========================================


def decrypt_payment_info(encrypted_data: str, decryption_key_b64: str) -> Optional[Dict[str, Any]]:
    """Decrypt payment information using hybrid RSA+AES decryption."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    try:
        envelope_json = base64.b64decode(encrypted_data).decode("utf-8")
        envelope = json.loads(envelope_json)

        if envelope.get("version") != 1:
            return None

        private_key_pem = base64.b64decode(decryption_key_b64)
        private_key = serialization.load_pem_private_key(private_key_pem, password=None)

        encrypted_aes_key = base64.b64decode(envelope["encrypted_aes_key"])
        aes_key = private_key.decrypt(
            encrypted_aes_key,
            padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
        )

        iv = base64.b64decode(envelope["iv"])
        ciphertext = base64.b64decode(envelope["ciphertext"])
        auth_tag = ciphertext[-16:]
        actual_ciphertext = ciphertext[:-16]

        cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv, auth_tag))
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(actual_ciphertext) + decryptor.finalize()

        return json.loads(plaintext.decode("utf-8"))
    except Exception as e:
        logger.error("Failed to decrypt payment info", error=extract_error_message(e))
        return None


def decrypt_password(encrypted_envelope: str, decryption_key_b64: str) -> Optional[str]:
    """Decrypt a password using the same RSA+AES scheme as payment info."""
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    try:
        envelope_json = base64.b64decode(encrypted_envelope).decode("utf-8")
        envelope = json.loads(envelope_json)

        if envelope.get("version") != 1:
            return None

        private_key_pem = base64.b64decode(decryption_key_b64)
        private_key = serialization.load_pem_private_key(private_key_pem, password=None, backend=default_backend())

        encrypted_aes_key = base64.b64decode(envelope["encrypted_aes_key"])
        aes_key = private_key.decrypt(
            encrypted_aes_key,
            padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
        )

        iv = base64.b64decode(envelope["iv"])
        ciphertext = base64.b64decode(envelope["ciphertext"])
        auth_tag = ciphertext[-16:]
        actual_ciphertext = ciphertext[:-16]

        cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv, auth_tag), backend=default_backend())
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(actual_ciphertext) + decryptor.finalize()

        return plaintext.decode("utf-8")
    except Exception as e:
        logger.error("Failed to decrypt password", error=extract_error_message(e))
        return None


def decrypt_password_with_key(encrypted_envelope: str, private_key: Any) -> Optional[str]:
    """Decrypt a password using a pre-loaded RSA private key.

    Optimized version that avoids re-loading the private key on each call.
    """
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    try:
        envelope_json = base64.b64decode(encrypted_envelope).decode("utf-8")
        envelope = json.loads(envelope_json)

        if envelope.get("version") != 1:
            return None

        encrypted_aes_key = base64.b64decode(envelope["encrypted_aes_key"])
        aes_key = private_key.decrypt(
            encrypted_aes_key,
            padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
        )

        iv = base64.b64decode(envelope["iv"])
        ciphertext = base64.b64decode(envelope["ciphertext"])
        auth_tag = ciphertext[-16:]
        actual_ciphertext = ciphertext[:-16]

        cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv, auth_tag), backend=default_backend())
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(actual_ciphertext) + decryptor.finalize()

        return plaintext.decode("utf-8")
    except Exception as e:
        logger.error("Failed to decrypt password with pre-loaded key", error=extract_error_message(e))
        return None


# ========================================
# OTP EXTRACTION
# ========================================


@dataclass(frozen=True)
class ExtractedOTP:
    """Structured OTP extracted from a recent email."""

    code: str
    sender: str
    received_at: str
    age_seconds: int
    ttl_seconds: int
    credential_id: Optional[str] = None
    source_message_id: Optional[str] = None
    subject: str = ""
    credential_kind: str = "email_otp"
    channel: str = "email"
    # Set instead of a code when the mail carries sign-in / verification links.
    links: List[str] = field(default_factory=list)


# Keyword groups shared across OTP patterns. Kept broad so we catch the common
# providers (Google "G-123456", "one-time passcode", "access code", etc.) while
# still requiring OTP context adjacent to the digits — this is the comprehensive
# filter that keeps conversational numbers (addresses, prices) from being read
# as codes. Mirrors isLikelyOtpMessage in the mac-app i-message-reader.
_OTP_CONTEXT = r"verification|security|auth|login|sign.?in|confirm|access|one.?time|2fa|two.?factor"
_OTP_NOUN = r"code|pin|otp|passcode|password"

# High-confidence patterns: an explicit OTP keyword sits right next to the
# digits, so these are safe even when low-confidence words (order, invoice…)
# are also present in the message.
HIGH_CONFIDENCE_OTP_PATTERNS = [
    # Google-style "G-123456"
    r"\bG-(\d{4,8})\b",
    # "<context> <noun>: 123456"
    rf"(?:{_OTP_CONTEXT})\s*(?:{_OTP_NOUN})[\s:#=]+(\d{{4,8}})\b",
    # "123456 is your <context> code"
    rf"\b(\d{{4,8}})\s*(?:is\s+)?(?:your|the)\s+(?:[A-Za-z][A-Za-z0-9 ._-]{{0,20}}\s+)?(?:{_OTP_CONTEXT})\s*(?:{_OTP_NOUN})?\b",
    # "code/otp/passcode is/=/: 123456"
    rf"(?:{_OTP_NOUN})\s*(?:is|:|=|#)\s*(\d{{4,8}})\b",
    # "your [Brand] code is 123456"
    rf"(?:your|the)\s+(?:[A-Za-z0-9][A-Za-z0-9 ._-]{{0,30}}\s+)?(?:{_OTP_NOUN})\s+(?:is\s+)?(\d{{4,8}})\b",
]

# General patterns add looser matches used only when no low-confidence keyword is
# present in the message.
GENERAL_OTP_PATTERNS = HIGH_CONFIDENCE_OTP_PATTERNS + [
    # digits followed by expiry/usage context
    r"\b(\d{4,8})\b[^\n]{0,40}?(?:expires?|valid for|verify|enter|use this|do not share|don.?t share)",
    # bare "code: 1234" / "1234 is your code"
    r"(?:pin|code)[\s:#=]+(\d{4})\b",
    r"\b(\d{4})\s*(?:is\s+)?(?:your|the)\s+(?:pin|code|otp)",
]

LOW_CONFIDENCE_KEYWORDS = [
    "order",
    "tracking",
    "receipt",
    "invoice",
    "account number",
    "reference",
    "transaction id",
]


def extract_otp_from_text(text: str) -> Optional[str]:
    """Extract an OTP/verification code from message text using regex patterns.

    Requires OTP context adjacent to the digits, so ordinary numbers (addresses,
    prices, order totals) are not mistaken for codes. When the message also
    contains low-confidence words (order, invoice, …) only the high-confidence
    patterns run.
    """
    lower_text = text.lower()
    patterns = (
        HIGH_CONFIDENCE_OTP_PATTERNS
        if any(kw in lower_text for kw in LOW_CONFIDENCE_KEYWORDS)
        else GENERAL_OTP_PATTERNS
    )

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)

    return None


def _email_otp_search_text(email: Dict) -> str:
    """Build searchable email text; minted inboxes often have OTPs only in HTML."""
    body_text = str(email.get("bodyText") or "")
    body_html = str(email.get("bodyHtml") or "")
    if not body_html:
        return body_text
    html_text = re.sub(r"<[^>]+>", " ", body_html)
    html_text = html.unescape(html_text)
    html_text = re.sub(r"\s+", " ", html_text).strip()
    return f"{body_text}\n{html_text}".strip()


def _format_duration(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    return f"{int(seconds / 60)}m"


# The ref the minted identity's new-account password is typed by (see back-end
# providers/mintedAccountPassword.ts).
MINTED_NEW_PASSWORD_REF = "pwd:new"
MAX_EMAIL_LINKS = 5
MINTED_INBOX_LABEL = "primitive"


def extract_email_links(email: Dict) -> List[str]:
    """Distinct http(s) links of a mail, in reading order (anchors first, then plain text)."""
    body_html = str(email.get("bodyHtml") or "")
    body_text = str(email.get("bodyText") or "")
    # Attribute spelling and spacing vary across mailers (`HREF = "..."`).
    found = [
        html.unescape(url)
        for url in re.findall(r"href\s*=\s*[\"'](https?://[^\"']+)[\"']", body_html, flags=re.IGNORECASE)
    ]
    found += [url.rstrip(".,;)") for url in re.findall(r"https?://[^\s<>\"']+", body_text)]
    return list(dict.fromkeys(found))[:MAX_EMAIL_LINKS]


def format_otp_user_message(otp: ExtractedOTP) -> str:
    """Format one OTP as a USER-role message for the browser-use conversation."""
    if otp.links:
        links = "\n".join(f"  - {link}" for link in otp.links)
        return (
            "Recently received email with no code:\n"
            f"- From: {otp.sender}\n"
            f"- Subject: {otp.subject}\n"
            f"- Received: {_format_duration(max(0, otp.age_seconds))} ago\n"
            f"- Links:\n{links}\n\n"
            "Open a link only if the current site said it emailed you one."
        )
    channel_label = "SMS" if otp.channel == "sms" else "email"
    preference = (
        "Use this code only if the current site requested an SMS or phone OTP."
        if otp.channel == "sms"
        else "Use this code only if the current site requested an email OTP. Prefer email OTP over SMS."
    )
    return (
        f"Recently received {channel_label} OTP code:\n"
        f"- Code: {otp.code}\n"
        f"- From: {otp.sender}\n"
        f"- Received: {_format_duration(max(0, otp.age_seconds))} ago\n"
        f"- Expires in approximately: {_format_duration(max(0, otp.ttl_seconds))}\n\n"
        f"{preference}"
    )


def is_usable_email_otp(otp: ExtractedOTP) -> bool:
    """Return whether an email OTP has enough remaining lifetime to act on."""
    return otp.ttl_seconds >= MIN_USABLE_EMAIL_OTP_TTL_SECONDS


async def fetch_recent_otps(user_id: str, api_url: str, api_key: str) -> List[ExtractedOTP]:
    """Fetch recent email/SMS messages and extract OTP codes as structured records."""
    try:
        since = (datetime.utcnow() - timedelta(minutes=10)).isoformat() + "Z"
        sources = ("email", "agentphone_sms", "imessage")
        results = await asyncio.gather(
            fetch_recent_emails(user_id, api_url, api_key, since, limit=20),
            fetch_recent_sms_messages(user_id, api_url, api_key, since, limit=20),
            fetch_recent_imessages(user_id, api_url, api_key, since, limit=20),
            return_exceptions=True,
        )
        for source, result in zip(sources, results):
            if isinstance(result, BaseException):
                logger.warning("OTP source fetch failed", source=source, error=str(result)[:200])
        emails, agentphone_messages, imessages = (
            [] if isinstance(result, BaseException) else result for result in results
        )
        # Treat agent-phone SMS and inbound iMessages as one SMS-style source.
        # Agent-phone is listed first so it wins on duplicate codes (the loop
        # below dedups by code via ``seen_codes``).
        sms_messages = agentphone_messages + imessages

        if not emails and not sms_messages:
            return []

        otps: List[ExtractedOTP] = []
        seen_codes: set[str] = set()
        for email in emails:
            body_text = _email_otp_search_text(email)
            code = extract_otp_from_text(body_text) if body_text else None
            # A mail to the agent's own inbox that carries no code may carry the
            # sign-in link a site sent instead (an HTML-only mail has no
            # searchable text at all); it is keyed by its message id.
            links: List[str] = []
            if not code and MINTED_INBOX_LABEL in (email.get("labels") or []):
                links = extract_email_links(email)
                if links:
                    code = f"link:{email.get('id') or email.get('messageId') or links[0]}"
            if not body_text and not code:
                continue
            if code:
                if code in seen_codes:
                    continue

                try:
                    email_date = datetime.fromisoformat(email.get("date", "").replace("Z", "+00:00"))
                except Exception:
                    continue
                age_seconds = (datetime.now(email_date.tzinfo) - email_date).total_seconds()

                if age_seconds > 600:
                    continue

                ttl_seconds = max(0, 300 - int(age_seconds))
                if ttl_seconds < MIN_USABLE_EMAIL_OTP_TTL_SECONDS:
                    continue

                sender = email.get("fromName") or email.get("from", "unknown")
                seen_codes.add(code)
                otps.append(
                    ExtractedOTP(
                        code=code,
                        sender=sender,
                        received_at=email.get("date", ""),
                        age_seconds=max(0, int(age_seconds)),
                        ttl_seconds=ttl_seconds,
                        credential_id=(
                            email.get("credentialId")
                            or email.get("credential_id")
                            or email.get("emailCredentialId")
                            or email.get("email_credential_id")
                        ),
                        source_message_id=(
                            email.get("id")
                            or email.get("messageId")
                            or email.get("message_id")
                            or email.get("threadId")
                        ),
                        subject=email.get("subject", ""),
                        links=links,
                    )
                )

        for message in sms_messages:
            body = str(message.get("body") or "")
            if not body:
                continue

            code = extract_otp_from_text(body)
            if not code or code in seen_codes:
                continue

            try:
                message_date = datetime.fromisoformat(str(message.get("date", "")).replace("Z", "+00:00"))
            except Exception:
                continue
            age_seconds = (datetime.now(message_date.tzinfo) - message_date).total_seconds()
            if age_seconds > 600:
                continue

            ttl_seconds = max(0, 300 - int(age_seconds))
            if ttl_seconds < MIN_USABLE_EMAIL_OTP_TTL_SECONDS:
                continue

            seen_codes.add(code)
            otps.append(
                ExtractedOTP(
                    code=code,
                    sender=str(message.get("from") or "unknown"),
                    received_at=str(message.get("date") or ""),
                    age_seconds=max(0, int(age_seconds)),
                    ttl_seconds=ttl_seconds,
                    credential_id=(
                        message.get("credentialId")
                        or message.get("credential_id")
                        or message.get("credentialPhone")
                        or message.get("credential_phone")
                        or message.get("to")
                    ),
                    source_message_id=(message.get("id") or message.get("messageId") or message.get("message_id")),
                    credential_kind="sms_otp",
                    channel="sms",
                )
            )

        return otps

    except Exception as e:
        logger.warning("Failed to fetch OTPs from email/SMS", error=str(e))
    return []


from browser_tools.secret_refs import _is_masked_secret_ref, mask_secret_values, secret_placeholder  # noqa: E402, F401


# ========================================
# AUTH OPTIONS PROMPT BUILDING
# ========================================

# Dev tunnel hosts fronting a local stack; only these (plus localhost) may
# override their realm with ?authRealm=. Keep in sync with the backend's
# canonicalAuthRealm (back-end/src/providers/authRealm.ts).
# Hosted benchmark fixture realms (back-end/src/domains/auth-test-site).
FIXTURE_REALM_PATTERN = re.compile(r"^rose-shop-[0-9a-z]+$")

AUTH_REALM_OVERRIDE_HOST_SUFFIXES = (
    ".ngrok-free.dev",
    ".ngrok-free.app",
    ".ngrok.app",
    ".ngrok.io",
    ".trycloudflare.com",
)


def auth_realm_from_url(url: str) -> str:
    """Best-effort realm derivation for the auth-options request."""
    if not url:
        return ""
    parsed_input = urlparse(url)
    looks_like_host_port = bool(re.match(r"^[^/?#]+:\d+(?:[/?#]|$)", url))
    if (
        parsed_input.scheme
        and parsed_input.scheme not in {"http", "https"}
        and not looks_like_host_port
    ):
        return ""
    parsed = urlparse(url if url.startswith(("http://", "https://")) else f"https://{url}")
    host = (parsed.hostname or parsed.path.split("/")[0]).lower()
    if host.startswith("www."):
        host = host[4:]
    local_host = host in {"localhost", "127.0.0.1"}
    if local_host or host.endswith(AUTH_REALM_OVERRIDE_HOST_SUFFIXES):
        query = parse_qs(parsed.query)
        override = (query.get("authRealm") or query.get("auth_realm") or [""])[0]
        if override:
            override_host = auth_realm_from_url(override)
            # Anyone can open a tunnel on these domains, so a tunnel may only
            # claim a hosted-fixture realm, never a real site's credentials.
            if override_host and (local_host or FIXTURE_REALM_PATTERN.match(override_host)):
                return override_host
    if host == "aws.amazon.com" or host.endswith(".aws.amazon.com"):
        return "aws.amazon.com"
    if host == "amazon.com" or host.endswith(".amazon.com"):
        return "amazon.com"
    if host == "uber.com" or host.endswith(".uber.com"):
        return "uber.com"
    return host


def signed_in_realm_for_secret_refs(used_refs: Any, url: str) -> str:
    """Realm where an action just typed a saved (or newly minted) password.

    This is the sign-in evidence the browser close sends as ``signed_in_sites``:
    the backend marks that site's login in the user's browser template as
    validated, which wins its keep-best rule. Card and other non-password refs
    are not a sign-in. Empty when there is no evidence. The backend
    canonicalizes the host to its registrable domain.
    """
    if not any(isinstance(ref, str) and ref.startswith("pwd:") for ref in (used_refs or ())):
        return ""
    return auth_realm_from_url(url or "")


def auth_realm_matches_url(auth_realm: str, url: str) -> bool:
    """Return whether a backend-authoritative realm owns this URL host."""
    if not auth_realm or not url:
        return False
    normalized_realm = auth_realm.lower().lstrip(".").removeprefix("www.")
    parsed = urlparse(url if url.startswith(("http://", "https://")) else f"https://{url}")
    host = (parsed.hostname or "").lower().removeprefix("www.")
    derived_realm = auth_realm_from_url(url)
    if derived_realm == normalized_realm:
        return True
    # A canonicalizer override (for example signin.aws.amazon.com ->
    # aws.amazon.com) is an authoritative boundary. Only apply the ordinary
    # subdomain fallback when canonicalization left the hostname untouched.
    if derived_realm != host:
        return False
    return host == normalized_realm or host.endswith(f".{normalized_realm}")


def _password_ref(origin: str, username: str, username_counts: Dict[str, int]) -> str:
    if username_counts.get(username, 0) <= 1:
        return f"pwd:{username}"

    parsed = urlparse(origin) if origin.startswith("http") else urlparse(f"https://{origin}")
    domain = parsed.netloc or origin
    if domain.startswith("www."):
        domain = domain[4:]
    short_domain = domain.split(".")[0]
    return f"pwd:{username}@{short_domain}"


def _disabled_label(item: Dict[str, Any]) -> str:
    disabled = bool(item.get("disabled") or item.get("disabledAt"))
    return "disabled" if disabled else "enabled"


def _index_session_passwords(passwords: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    by_id: Dict[Any, Dict[str, Any]] = {}
    by_origin_username_all: Dict[Any, List[Dict[str, Any]]] = {}
    by_ref_all: Dict[Any, List[Dict[str, Any]]] = {}
    by_username: Dict[str, List[Dict[str, Any]]] = {}
    has_ids = False

    for pwd in passwords or []:
        if pwd.get("id"):
            has_ids = True
            by_id[pwd["id"]] = pwd
        if pwd.get("origin") and pwd.get("username"):
            by_origin_username_all.setdefault((pwd.get("origin"), pwd.get("username")), []).append(pwd)
        if pwd.get("ref"):
            by_ref_all.setdefault(pwd["ref"], []).append(pwd)
        if pwd.get("username"):
            by_username.setdefault(pwd["username"], []).append(pwd)

    unique_by_origin_username = {key: items[0] for key, items in by_origin_username_all.items() if len(items) == 1}
    unique_by_ref = {ref: items[0] for ref, items in by_ref_all.items() if len(items) == 1}
    unique_by_username = {username: items[0] for username, items in by_username.items() if len(items) == 1}

    return {
        "has_ids": has_ids,
        "by_id": by_id,
        "by_origin_username": unique_by_origin_username,
        "by_ref": unique_by_ref,
        "by_username_all": by_username,
        "by_username": unique_by_username,
    }


def _matching_session_password(
    auth_password: Dict[str, Any],
    ref: str,
    password_index: Dict[str, Any],
    realm: str,
) -> Optional[Dict[str, Any]]:
    if auth_password.get("encryptedPassword"):
        return auth_password

    password_id = auth_password.get("id")
    if password_id and password_id in password_index["by_id"]:
        return password_index["by_id"][password_id]
    if password_id:
        return None

    if ref in password_index["by_ref"]:
        return password_index["by_ref"][ref]

    origin = auth_password.get("origin")
    username = auth_password.get("username")
    if origin and username and (origin, username) in password_index["by_origin_username"]:
        return password_index["by_origin_username"][(origin, username)]

    if username and username in password_index["by_username"]:
        return password_index["by_username"][username]

    if username and username in password_index["by_username_all"]:
        realm_matches = [
            pwd
            for pwd in password_index["by_username_all"][username]
            if auth_realm_from_url(pwd.get("origin", "")) == realm
        ]
        if len(realm_matches) == 1:
            return realm_matches[0]

    return None


def _dedupe_secret_ref(ref: str, credential_id: str, seen_refs: set[str]) -> str:
    if ref not in seen_refs:
        seen_refs.add(ref)
        return ref

    suffix_source = credential_id or ref
    suffix = re.sub(r"[^A-Za-z0-9_-]+", "", suffix_source)[:8] or "dup"
    candidate = f"{ref}#{suffix}"
    counter = 2
    while candidate in seen_refs:
        candidate = f"{ref}#{suffix}-{counter}"
        counter += 1
    seen_refs.add(candidate)
    return candidate


def build_auth_options_prompt_section(
    auth_options: Optional[Dict[str, Any]],
    session_passwords: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, Dict[str, str], Dict[str, str], Dict[str, Dict[str, str]]]:
    """Build auth instructions and per-realm auth options.

    Returns:
        prompt_section, ref_to_encrypted_password, password_origins,
        credential_refs_by_secret_ref.
    """
    auth_options = auth_options or {}
    realm = auth_options.get("realm") or "this site"

    steel_session = auth_options.get("steel_session") or auth_options.get("steelSession")
    cookie_bundles = auth_options.get("cookie_bundles") or auth_options.get("cookieBundles") or []
    passwords = auth_options.get("passwords") or []
    email_otp = auth_options.get("email_otp") or auth_options.get("emailOtp") or {}
    minted = auth_options.get("minted")
    # Inboxes and phones whose one-time codes the runtime delivers to the agent.
    readable = {str(value).lower() for value in auth_options.get("readable_identifiers") or []}

    def _reachable(identifier: Any) -> str:
        return " (codes sent here reach you automatically)" if str(identifier).lower() in readable else ""

    lines: List[str] = [f"# Auth Options for {realm}"]

    if steel_session:
        context_id = steel_session.get("contextId") or steel_session.get("context_id") or "(unknown context)"
        authenticated_at = steel_session.get("authenticatedAt") or steel_session.get("authenticated_at") or "unknown"
        lines.append(
            f"- Steel session: {context_id} ({_disabled_label(steel_session)}, authenticated {authenticated_at})"
        )
    else:
        lines.append("- Steel session: none")

    lines.append("- Cookie bundles:")
    if cookie_bundles:
        for bundle in cookie_bundles:
            bundle_id = bundle.get("id", "(missing id)")
            source = bundle.get("browserSource") or bundle.get("browser_source") or "unknown"
            profile = bundle.get("browserProfile") or bundle.get("browser_profile") or "default"
            freshest = _cookie_timestamp_iso(bundle.get("freshestCookieUtc") or bundle.get("freshest_cookie_utc"))
            lines.append(
                f"  - id: {bundle_id} | {source}/{profile} | {_disabled_label(bundle)} | freshestCookieUtc: {freshest}"
            )
    else:
        lines.append("  - none")

    ref_to_encrypted: Dict[str, str] = {}
    password_origins: Dict[str, str] = {}
    credential_refs_by_secret_ref: Dict[str, Dict[str, str]] = {}
    password_index = _index_session_passwords(session_passwords)
    username_counts: Dict[str, int] = {}
    for pwd in passwords:
        username = pwd.get("username", "")
        username_counts[username] = username_counts.get(username, 0) + 1

    lines.append("- Passwords:")
    seen_secret_refs: set[str] = set()
    unavailable_password_count = 0
    if passwords:
        for pwd in passwords:
            origin = pwd.get("origin", "")
            username = pwd.get("username", "")
            ref = pwd.get("ref") or _password_ref(origin, username, username_counts)
            matched = _matching_session_password(pwd, ref, password_index, realm if isinstance(realm, str) else "")
            encrypted = (matched or {}).get("encryptedPassword", "")
            origin_for_ref = pwd.get("origin") or (matched or {}).get("origin", "")
            credential_id = pwd.get("id") or (matched or {}).get("id") or ref
            display_origin = origin_for_ref or "saved password"

            if pwd.get("browserSource") == "agent_passwordless":
                # A minted identity's account on a code- or link-only site: no password to type.
                credential_refs_by_secret_ref[str(username)] = {"kind": "password", "id": str(credential_id)}
                lines.append(
                    f"  - {display_origin} | {username}{_reachable(username)} | no password (sign in with a code "
                    f"or link sent to it) | {_disabled_label(pwd)}"
                )
                continue

            if not encrypted:
                unavailable_password_count += 1
                lines.append(
                    f"  - {display_origin} | {username} | unavailable in this session | {_disabled_label(pwd)}"
                )
                continue

            ref = _dedupe_secret_ref(ref, str(credential_id), seen_secret_refs)
            ref_to_encrypted[ref] = encrypted
            if origin_for_ref:
                password_origins[ref] = origin_for_ref
            credential_refs_by_secret_ref[ref] = {"kind": "password", "id": str(credential_id)}

            lines.append(
                f"  - {display_origin} | {username}{_reachable(username)} | ref: {secret_placeholder(ref)} "
                f"| {_disabled_label(pwd)}"
            )
        if unavailable_password_count:
            lines.append(
                f"  - {unavailable_password_count} saved password(s) were omitted as refs because this session "
                "did not include decryptable password material for them."
            )
    else:
        lines.append("  - none")

    passkeys = auth_options.get("passkeys") or []
    enabled_passkeys = [pk for pk in passkeys if not pk.get("disabled")]
    if enabled_passkeys:
        rp_ids = ", ".join(sorted({pk.get("rpId", realm) for pk in enabled_passkeys}))
        lines.append(
            f"- Passkey: available for {rp_ids}. It is already loaded into the browser's authenticator. "
            "Try this before any saved password. Focus the username/email/account field first to trigger "
            "passkey autofill or conditional WebAuthn. If the site asks for an identifier, enter the relevant "
            'account email/username and continue, but do not type a password yet. Choose "Sign in with a passkey", '
            '"Use passkey", or similar if offered. No browser passkey popup is expected; the authenticator signs silently.'
        )
    else:
        lines.append("- Passkey: none")

    accounts_end = len(lines)
    available = bool(email_otp.get("available"))
    connected = email_otp.get("connected_emails") or email_otp.get("connectedEmails") or []
    match = email_otp.get("match_for_site_account") or email_otp.get("matchForSiteAccount")
    if available:
        connected_text = ", ".join(connected) if connected else "connected email available"
        match_text = f"; likely match: {match}" if match else ""
        lines.append(f"- Email OTP: available ({connected_text}{match_text})")
    else:
        lines.append("- Email OTP (user's inboxes): unavailable, none connected")

    if minted:
        minted_id = minted.get("id") or minted.get("accountLabel") or minted.get("account_label") or minted.get("email")
        minted_email = (
            minted.get("email")
            or minted.get("agentEmail")
            or minted.get("agent_email")
            or minted.get("accountLabel")
            or minted.get("account_label")
        )
        minted_phone = minted.get("phone") or minted.get("agentPhone") or minted.get("agent_phone")
        if minted_email:
            phone_clause = f" | Phone -> {minted_phone}" if minted_phone else ""
            # The password to create the account with. Typing the ref saves it, so
            # the account can be signed into again on a later run.
            new_password = minted.get("newPassword") or minted.get("new_password") or {}
            new_password_ref = str(new_password.get("ref") or "")
            new_password_encrypted = str(new_password.get("encryptedPassword") or "")
            password_clause = ""
            if new_password_ref and new_password_encrypted:
                ref_to_encrypted[new_password_ref] = new_password_encrypted
                credential_refs_by_secret_ref[new_password_ref] = {
                    "kind": "minted_account",
                    "id": str(minted_id or minted_email),
                }
                # "Sign-up": a first run typed the ref into sign-in forms when it read "New password".
                password_clause = f" | Sign-up password ref (new accounts only): {secret_placeholder(new_password_ref)}"
            lines.append(
                f"- Minted account: Email -> {minted_email} (codes mailed here reach you automatically)"
                f"{phone_clause}{password_clause} | {_disabled_label(minted)}"
            )
            credential_refs_by_secret_ref[str(minted_email)] = {
                "kind": "minted_account",
                "id": str(minted_id or minted_email),
            }
            if minted_phone:
                credential_refs_by_secret_ref[str(minted_phone)] = {
                    "kind": "minted_account",
                    "id": str(minted_id or minted_phone),
                }
        else:
            lines.append(
                "- Minted account: present but missing agent email; this runtime cannot attempt it, "
                "so do not treat minted as exhausted."
            )
    else:
        lines.append("- Minted account: none")

    # What exists for this site, apart from the identities codes reach.
    lines = [
        lines[0],
        "- Accounts for this site:",
        *[f"  {line}" for line in lines[1:accounts_end]],
        "- Identities you can use (codes sent to these reach you automatically):",
        *[f"  {line}" for line in lines[accounts_end:]],
    ]
    return "\n".join(lines), ref_to_encrypted, password_origins, credential_refs_by_secret_ref


# ========================================
# PASSWORD PROMPT BUILDING
# ========================================


def build_autopay_prompt_section(payment_data: Dict[str, Any], encrypted_envelope: str) -> str:
    """Build the autopay section for the browser agent system prompt.

    Uses reference IDs for card data that will be decrypted at typing time.
    The LLM never sees the actual card number, CVV, etc.
    """
    autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
    autopay_limit_dollars = autopay_limit_cents / 100

    billing_lines = [
        payment_data.get("billing_street_address", ""),
        payment_data.get("billing_address_line2", ""),
        f"{payment_data.get('billing_city', '')}, {payment_data.get('billing_state', '')} {payment_data.get('billing_zipcode', '')}",
        payment_data.get("billing_country", ""),
    ]
    billing_address = "\n".join(line for line in billing_lines if line.strip())

    contact_info = ""
    if payment_data.get("billing_phone"):
        contact_info += f"\nPhone: {payment_data['billing_phone']}"
    if payment_data.get("billing_email"):
        contact_info += f"\nEmail: {payment_data['billing_email']}"

    return f"""
## Billing Address
{billing_address}{contact_info}

## Payment Information
AUTOPAY ENABLED (limit: ${autopay_limit_dollars:.2f}): {PAYMENT_CARD_ENTRY_RULE}

If new card details are required, first read the full itemized receipt off the page (each product: name, image URL if visible, unit price in cents, quantity, line total in cents; plus every fee, the subtotal, and the final total), then call request_payment_card with it BEFORE touching any payment field.

Do not type any card details yet, and do not ask the user to enter a card. The one-time card is minted on demand only after you call request_payment_card and the user approves; its secret refs are then provided for you to type into the payment fields."""


def has_payment_card_secret_refs(secret_refs: Optional[Dict[str, Any]]) -> bool:
    """Return true when a one-time payment card is already available as secret refs."""
    refs = secret_refs or {}
    return all(bool(refs.get(ref)) for ref in PAYMENT_CARD_SECRET_REFS)


def build_payment_card_resume_prompt_section(payment_card_refs: Dict[str, Any]) -> str:
    """Build resume instructions for an already approved one-time payment card."""
    if not has_payment_card_secret_refs(payment_card_refs):
        return ""

    return """
## One-Time Payment Card
Payment approval is complete and the one-time card is ready. Do not call request_payment_card again for this checkout.

Use these private credential placeholders with your chosen browser action and target:
- Card number field: {{secret:card_number}}
- Cardholder name field: {{secret:card_name}}
- Expiry field: {{secret:card_expiry}}
- CVV field: {{secret:card_cvv}}

The runtime resolves placeholders privately in any browser tool, including input_text and evaluate. Enter each field explicitly; no fields are filled automatically.

After filling the payment fields, submit the checkout form and continue until the merchant confirmation page is shown."""


def payment_card_ready_tool_result(last4: Optional[str] = None) -> Dict[str, Any]:
    """Final tool outcome after outer-loop approval+mint replaces a parked awaiting result."""
    safe_last4 = last4 if isinstance(last4, str) and re.fullmatch(r"\d{4}", last4) else None
    result: Dict[str, Any] = {
        "success": True,
        "status": "payment_card_ready",
        "message": (
            "Payment approval is complete and the one-time card is ready. "
            "Do not call request_payment_card again. Use the private placeholders "
            "{{secret:card_number}}, {{secret:card_name}}, {{secret:card_expiry}}, and "
            "{{secret:card_cvv}} with your chosen browser action and target. "
            "The runtime resolves them privately; enter each field explicitly."
        ),
    }
    if safe_last4 is not None:
        result["last4"] = safe_last4
    return result


def _is_awaiting_payment_card_approval_result(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    return result.get("status") == "awaiting_payment_card_approval"


def _tool_message_content_is_awaiting_payment_card(content: Any) -> bool:
    if not isinstance(content, str) or "awaiting_payment_card_approval" not in content:
        return False
    try:
        parsed = json.loads(content)
    except (TypeError, ValueError, json.JSONDecodeError):
        return True
    return _is_awaiting_payment_card_approval_result(parsed)


def finalize_parked_payment_card_approval_history(
    resume_state: Dict[str, Any],
    *,
    last4: Optional[str] = None,
) -> Dict[str, Any]:
    """Rewrite parked request_payment_card awaiting outcomes to payment_card_ready.

    The browser activity parks with ``awaiting_payment_card_approval`` while the
    outer Temporal loop runs approval+mint. On resume that stale tool result is
    still the last turn the model sees, so it waits for minutes (and AgentCard
    may close the unused card before the second browser can reuse last4).
    Completing the parked tool result is the real post-mint outcome — not a
    recovery nudge.
    """
    if not isinstance(resume_state, dict):
        return resume_state
    ready = payment_card_ready_tool_result(last4)

    def completed_result(previous: Any) -> Dict[str, Any]:
        return {**(previous if isinstance(previous, dict) else {}), **ready}

    history = resume_state.get("action_history")
    if isinstance(history, list):
        for entry in history:
            if not isinstance(entry, dict):
                continue
            if entry.get("action") != "request_payment_card":
                continue
            if _is_awaiting_payment_card_approval_result(entry.get("result")):
                entry["result"] = completed_result(entry["result"])

    simulated = resume_state.get("simulated_action_entries")
    if isinstance(simulated, list):
        for entry in simulated:
            if not isinstance(entry, dict):
                continue
            if entry.get("action") != "request_payment_card":
                continue
            if _is_awaiting_payment_card_approval_result(entry.get("result")):
                entry["result"] = completed_result(entry["result"])

    for turns_key in ("browser_turn_messages", "simulated_turn_messages"):
        turns = resume_state.get(turns_key)
        if not isinstance(turns, list):
            continue
        for message in turns:
            if not isinstance(message, dict):
                continue
            if message.get("role") != "tool":
                continue
            # Compact resumes may omit tool name; only rewrite awaiting payment rows.
            name = message.get("name")
            if name not in {None, "", "request_payment_card"}:
                continue
            if _tool_message_content_is_awaiting_payment_card(message.get("content")):
                try:
                    previous = json.loads(message["content"])
                except (TypeError, ValueError):
                    previous = {}
                message["content"] = json.dumps(
                    completed_result(previous), separators=(",", ":"), ensure_ascii=False
                )
                message["name"] = "request_payment_card"

    return resume_state


def build_passwords_prompt_section(passwords: List[Dict[str, Any]]) -> Tuple[str, Dict[str, str]]:
    """Build the passwords section for the browser agent system prompt.

    Returns:
        Tuple of (prompt_section, ref_to_encrypted_map)
    """
    if not passwords:
        return "", {}

    # First pass: count username occurrences to detect duplicates
    username_counts: Dict[str, int] = {}
    for pwd in passwords:
        username = pwd.get("username", "")
        username_counts[username] = username_counts.get(username, 0) + 1

    # Second pass: build refs
    lines = []
    ref_to_encrypted: Dict[str, str] = {}

    for pwd in passwords:
        origin = pwd.get("origin", "")
        username = pwd.get("username", "")
        encrypted = pwd.get("encryptedPassword", "")

        if username_counts.get(username, 0) <= 1:
            ref = f"pwd:{username}"
        else:
            from urllib.parse import urlparse

            parsed = urlparse(origin) if origin.startswith("http") else urlparse(f"https://{origin}")
            domain = parsed.netloc or origin
            if domain.startswith("www."):
                domain = domain[4:]
            short_domain = domain.split(".")[0]
            ref = f"pwd:{username}@{short_domain}"

        ref_to_encrypted[ref] = encrypted
        lines.append(f"- {origin} | {username} | ref: {ref}")

    prompt_section = f"""

AVAILABLE PASSWORDS (type the ref into password fields):
{chr(10).join(lines)}

To log in, type the ref (e.g., pwd:andy@email.com) into the password field.
It will be automatically decrypted."""

    return prompt_section, ref_to_encrypted
