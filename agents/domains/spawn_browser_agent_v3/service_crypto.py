"""Cryptography and payment services for spawn-browser-agent-v3 domain.

Payment decryption, password handling, and OTP extraction.
"""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import structlog

from domains.spawn_browser_agent_v3.repo import fetch_recent_emails
from helpers.error_utils import extract_error_message

logger = structlog.get_logger()


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


def extract_otp_from_text(text: str) -> Optional[str]:
    """Extract OTP code from email text using regex patterns."""
    # Patterns ordered by specificity (most specific first)
    patterns = [
        # 6-digit codes with context
        r"(?:verification|security|auth|login|sign.?in|confirm)\s*(?:code|pin|otp)[\s:]+(\d{6})\b",
        r"\b(\d{6})\s*(?:is\s+)?(?:your|the)\s+(?:verification|security|auth|one.?time|otp|login)\s*(?:code|pin)?",
        r"(?:code|pin|otp)[\s:]+(\d{6})\b",
        r"\b(\d{6})\b.*(?:expires?|valid|verify|enter|use)",
        # 4-digit PINs
        r"(?:pin|code)[\s:]+(\d{4})\b",
        r"\b(\d{4})\s*(?:is\s+)?(?:your|the)\s+(?:pin|code|otp)",
        # 8-digit codes
        r"(?:code|otp)[\s:]+(\d{8})\b",
    ]

    # Skip if text contains low-confidence keywords
    low_confidence_keywords = [
        "order",
        "tracking",
        "receipt",
        "invoice",
        "account number",
        "reference",
        "transaction id",
    ]
    lower_text = text.lower()
    if any(kw in lower_text for kw in low_confidence_keywords):
        for pattern in patterns[:3]:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                return match.group(1)
        return None

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)

    return None


async def fetch_recent_otps(user_id: str, api_url: str, api_key: str) -> str:
    """Fetch recent emails and extract OTP codes. Returns formatted prompt section."""
    try:
        since = (datetime.utcnow() - timedelta(minutes=10)).isoformat() + "Z"
        emails = await fetch_recent_emails(user_id, api_url, api_key, since, limit=20)

        if not emails:
            return ""

        otps = []
        for email in emails:
            body_text = email.get("bodyText", "")
            if not body_text:
                continue

            code = extract_otp_from_text(body_text)
            if code:
                email_date = datetime.fromisoformat(email.get("date", "").replace("Z", "+00:00"))
                age_seconds = (datetime.now(email_date.tzinfo) - email_date).total_seconds()

                if age_seconds > 600:
                    continue

                age_str = f"{int(age_seconds)}s ago" if age_seconds < 60 else f"{int(age_seconds / 60)}m ago"
                ttl_seconds = max(0, 300 - int(age_seconds))
                ttl_str = f"{ttl_seconds}s" if ttl_seconds < 60 else f"{int(ttl_seconds / 60)}m"

                sender = email.get("fromName") or email.get("from", "unknown")
                otps.append(f'- "{code}" from {sender} (received {age_str}, expires in ~{ttl_str})')

        if not otps:
            return ""

        # Deduplicate by code
        seen_codes: set[str] = set()
        unique_otps = []
        for otp_line in otps:
            code = otp_line.split('"')[1]
            if code not in seen_codes:
                seen_codes.add(code)
                unique_otps.append(otp_line)

        return f"""RECENTLY RECEIVED OTP CODES (auto-refreshed every turn):
{chr(10).join(unique_otps)}

When choosing OTP delivery method: PREFER EMAIL over SMS. SMS OTPs require the user's Mac to be actively receiving messages, while email is more reliable.
If waiting for an OTP that hasn't arrived yet, take another action and check next turn."""

    except Exception as e:
        logger.warning("Failed to fetch OTPs from email", error=str(e))
    return ""


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

    card_number = payment_data.get("card_number", "")
    card_last_four = card_number[-4:] if len(card_number) >= 4 else "****"

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

AUTOPAY ENABLED (limit: ${autopay_limit_dollars:.2f}):
Payment card ending in {card_last_four} is available for checkout.

When you reach a payment page, type these exact values into the corresponding fields:
- Card number field: card_number
- Cardholder name field: card_name
- Expiry field: card_expiry
- CVV field: card_cvv

The values will be automatically filled with the user's saved card information.

Billing Address:
{billing_address}{contact_info}

PAYMENT RULES:
- If order total <= ${autopay_limit_dollars:.2f}: Complete payment using the card refs above
- If order total > ${autopay_limit_dollars:.2f}: Use send_message_to_user with is_question=true to request approval before paying
- Always verify the total before entering card details
- Double-check the billing address matches before submitting"""


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
