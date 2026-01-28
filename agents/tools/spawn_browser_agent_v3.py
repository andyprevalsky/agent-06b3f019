"""Browser automation tool using run_agent loop + browser-use BrowserSession.

This is the v3 version that uses:
- browser-use BrowserSession for DOM extraction and CDP actions
- Rose API's rose-1-browser-use for LLM decisions
- Always captures screenshots after each action (no screenshot tool)
- Index-based element selection
"""

from typing import Dict, Any, Optional, AsyncGenerator, List, Tuple
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from datetime import timedelta, datetime, timezone
import structlog
import httpx
import time
import asyncio
import json
import uuid as uuid_module
import base64

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus, AssistantEvent
from temporalio.exceptions import ActivityError, CancelledError as TemporalCancelledError
from browser_tools.schemas import BROWSER_TOOL_MODELS, AVAILABLE_ACTIONS
from browser_tools.dom_service import DOMService, ActionHistory
from browser_tools.humanizer import BrowserHumanizer
from helpers.model_pricing import get_model_pricing_with_fallback
from helpers.prompts import build_verifier_prompt
from helpers.file_resolution import resolve_file_pointers_from_extracted, transform_schema_for_remote_session
from helpers.attachments import extract_attachments_from_context
from loop.activity_helper import call_temporal_activity_from_activity
from config import load_config
from helpers.error_utils import extract_error_message

logger = structlog.get_logger()


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox."""
    try:
        return time.time()
    except Exception:
        return 0.0


# ========================================
# MESSAGE HELPERS
# ========================================

async def save_browser_action_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    task_id: str,
    browser_url: str = "",
    action_type: str = "default",
    auxiliary: dict = None,
    tool_call_id: str = None,
    is_init_message: bool = False,
    is_completion_message: bool = False,
    output_schema: dict = None,
    steps_taken: int = None,
    total_steps: int = None,
):
    """Save browser sub-action message directly to DB.

    Args:
        is_init_message: If True, don't set subAgentId (shows in main chat as init)
        is_completion_message: If True, don't set subAgentId (shows in main chat as completion/error)
    """
    try:
        config = load_config()
        unique_tool_call_id = tool_call_id or str(uuid_module.uuid4())

        metadata = {
            "toolCallId": unique_tool_call_id,
            "toolName": "spawn_browser_agent",
            "toolStatus": status.value,
            "title": title,
            "task_id": task_id,
            "browser_url": browser_url,
            "action_type": action_type,
            "auxiliary": auxiliary or {}
        }

        # Include step progress for FE display
        if steps_taken is not None:
            metadata["steps_taken"] = steps_taken
        if total_steps is not None:
            metadata["total_steps"] = total_steps

        # Include output schema in init message for FE display
        if output_schema:
            metadata["output_schema"] = output_schema

        # Only set subAgentId for intermediate messages (not init or completion)
        # This ensures init and completion messages show in main chat
        if not is_init_message and not is_completion_message:
            metadata["subAgentId"] = task_id

        if status == MessageStatus.ERROR:
            metadata["error"] = True
        
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json={
                    "message": message,
                    "role": "TOOL",
                    "metadata": metadata
                }
            )
    except Exception as e:
        logger.error("Failed to save browser action message", error=extract_error_message(e))


async def save_browser_assistant_message(
    agent_id: str,
    message: str,
    task_id: str,
):
    """Save browser ASSISTANT message directly to DB."""
    try:
        config = load_config()
        metadata = {"subAgentId": task_id}
        
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json={
                    "message": message,
                    "role": "ASSISTANT",
                    "metadata": metadata
                }
            )
    except Exception as e:
        logger.error("Failed to save browser assistant message", error=extract_error_message(e))


async def request_write_lock_approval(
    agent_id: str,
    user_id: str,
    workflow_id: str,
    question: str,
    url: str,
    config,
    timeout_seconds: int = 300,  # 5 minute timeout
) -> Dict[str, Any]:
    """Request user approval for a write-locked action.

    Creates an attention request and polls for user response.

    Args:
        agent_id: Agent ID
        user_id: User ID
        workflow_id: Workflow/task ID for the attention request
        question: The approval question to show the user
        url: Current page URL (for context)
        config: Config object with backend API settings
        timeout_seconds: How long to wait for approval

    Returns:
        Dict with 'approved': True/False and optional 'response': str
    """
    import time as time_module

    try:
        # Create attention request
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/attention-requests",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json={
                    "user_id": user_id,
                    "agent_id": agent_id,
                    "workflow_id": workflow_id,
                    "question": question,
                    "metadata": {
                        "writePermission": True,
                        "url": url,
                    }
                }
            )

            if response.status_code not in [200, 201]:
                logger.error(f"Failed to create attention request: {response.status_code}")
                # Default to denied if we can't create the request
                return {"approved": False, "error": "Failed to create approval request"}

            request_data = response.json()
            request_id = request_data.get("id")

        if not request_id:
            return {"approved": False, "error": "No request ID returned"}

        logger.info(f"Created write lock attention request: {request_id}")

        # Poll for response
        start_time = time_module.time()
        poll_interval = 2  # seconds

        while time_module.time() - start_time < timeout_seconds:
            # Heartbeat while waiting
            activity.heartbeat(f"Waiting for write lock approval ({int(time_module.time() - start_time)}s)")

            # Check for response
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(
                    f"{config.backend.api_url}/api/attention-requests/{request_id}",
                    headers={"x-api-key": config.backend.api_key or ""}
                )

                if response.status_code == 200:
                    data = response.json()
                    user_response = data.get("userResponse")

                    if user_response is not None:
                        # User responded
                        response_lower = user_response.lower().strip()
                        approved = response_lower in ["yes", "y", "approve", "approved", "ok", "okay", "sure", "go ahead"]
                        denied = response_lower in ["no", "n", "deny", "denied", "cancel", "stop", "don't", "dont"]

                        if approved:
                            logger.info(f"Write lock approval granted: {user_response}")
                            return {"approved": True, "response": user_response}
                        elif denied:
                            logger.info(f"Write lock approval denied: {user_response}")
                            return {"approved": False, "response": user_response}
                        else:
                            # Ambiguous response - treat as approved (they typed something)
                            logger.info(f"Write lock ambiguous response (treating as approved): {user_response}")
                            return {"approved": True, "response": user_response}

            await asyncio.sleep(poll_interval)

        # Timeout - default to denied for safety
        logger.warning(f"Write lock approval timed out after {timeout_seconds}s")
        return {"approved": False, "error": "Approval request timed out"}

    except Exception as e:
        logger.error(f"Error requesting write lock approval: {e}")
        return {"approved": False, "error": str(e)}


# ========================================
# CONTEXT SUMMARY BUILDER
# ========================================

def build_context_summary(
    success: bool,
    close_reasoning: str,
    visited_urls: list,
    reasoning_messages: list,
    action_summary: list,
    error_context: str = None
) -> str:
    """Build detailed execution context summary for main agent."""
    summary_parts = []
    
    status = "✅ SUCCESS" if success else "❌ FAILED"
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
            summary_parts.append(f"  • {action}")
    
    return "\n".join(summary_parts)


# ========================================
# STEEL FILES HELPERS
# ========================================

async def list_session_files(session_id: str) -> List[Dict[str, Any]]:
    """
    List all files in a Steel browser session by calling Steel API directly.
    Returns list of file info dicts with path, size, lastModified.
    """
    import os
    steel_api_key = os.environ.get("STEEL_API_KEY")
    if not steel_api_key:
        logger.warning("STEEL_API_KEY not set, cannot list session files")
        return []

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"https://api.steel.dev/v1/sessions/{session_id}/files",
                headers={"steel-api-key": steel_api_key}
            )
            logger.info(f"[Steel Files API] session={session_id}, status={response.status_code}, body={response.text[:500]}")
            if response.status_code == 200:
                data = response.json()
                # Steel API returns files in "data" field (or "files" for backwards compat)
                files = data.get("data") or data.get("files") or data if isinstance(data, dict) else data
                logger.info(f"[Steel Files API] Parsed files count: {len(files) if isinstance(files, list) else 0}")
                return files if isinstance(files, list) else []
            else:
                logger.warning(
                    "Failed to list session files from Steel",
                    session_id=session_id,
                    status=response.status_code
                )
                return []
    except Exception as e:
        logger.warning(
            "Error listing session files from Steel",
            session_id=session_id,
            error=extract_error_message(e)
        )
        return []


async def download_file_from_steel(session_id: str, file_path: str) -> Optional[Dict[str, Any]]:
    """
    Download a file directly from Steel API.

    Args:
        session_id: Steel session ID
        file_path: File path as returned by Steel list API (e.g., "/files/tinified.zip")

    Returns:
        Dict with content (bytes), filename, mime_type, or None on failure
    """
    import os
    steel_api_key = os.environ.get("STEEL_API_KEY")
    if not steel_api_key:
        logger.warning("STEEL_API_KEY not set, cannot download file")
        return None

    # Steel download API expects relative path (strip leading /files/ if present)
    relative_path = file_path
    if relative_path.startswith("/files/"):
        relative_path = relative_path[7:]  # Remove "/files/"
    elif relative_path.startswith("/"):
        relative_path = relative_path[1:]  # Remove leading "/"

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(
                f"https://api.steel.dev/v1/sessions/{session_id}/files/{relative_path}",
                headers={"steel-api-key": steel_api_key},
            )
            if response.status_code == 200:
                # Extract filename from path
                filename = file_path.split("/")[-1] or "download"

                # Guess MIME type from extension
                ext = filename.split(".")[-1].lower() if "." in filename else ""
                mime_types = {
                    "pdf": "application/pdf",
                    "csv": "text/csv",
                    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "xls": "application/vnd.ms-excel",
                    "doc": "application/msword",
                    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "png": "image/png",
                    "jpg": "image/jpeg",
                    "jpeg": "image/jpeg",
                    "gif": "image/gif",
                    "zip": "application/zip",
                    "json": "application/json",
                    "txt": "text/plain",
                }
                mime_type = mime_types.get(ext, "application/octet-stream")

                logger.info(
                    f"[Steel] Downloaded {filename} ({len(response.content)} bytes)",
                    session_id=session_id,
                )
                return {
                    "content": response.content,
                    "filename": filename,
                    "mime_type": mime_type,
                }
            else:
                logger.warning(
                    f"[Steel] Failed to download file",
                    session_id=session_id,
                    path=file_path,
                    status=response.status_code,
                    response=response.text[:200],
                )
                return None
    except Exception as e:
        logger.warning(
            f"[Steel] Error downloading file",
            session_id=session_id,
            path=file_path,
            error=extract_error_message(e),
        )
        return None


async def extract_session_files(session_id: str, user_id: str, config, exclude_paths: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """
    Extract all files from a Steel browser session:
    1. List files in session (direct Steel API call)
    2. Download each file from Steel (direct Steel API call)
    3. Upload to Supabase storage (direct Supabase API call)
    4. Return list of FilePointer dicts

    This function does NOT go through the backend - it calls Steel and Supabase directly.

    Args:
        exclude_paths: List of Steel file paths to exclude (e.g., files we uploaded)
    """
    from helpers.attachments import upload_to_storage

    # 1. List files in session
    session_files = await list_session_files(session_id)
    if not session_files:
        logger.info("No files to extract from session", session_id=session_id)
        return []

    # Filter out excluded paths (e.g., files we uploaded to the session)
    exclude_set = set(exclude_paths or [])
    if exclude_set:
        original_count = len(session_files)
        session_files = [f for f in session_files if f.get("path") not in exclude_set]
        if len(session_files) < original_count:
            logger.info(f"[Extract] Filtered out {original_count - len(session_files)} uploaded file(s)")

    logger.info(f"[Extract] Found {len(session_files)} file(s) to extract in session {session_id}")

    # 2. Download each file and upload to Supabase
    output_files: List[Dict[str, Any]] = []

    for file_info in session_files:
        file_path = file_info.get("path", "")
        if not file_path:
            continue

        logger.info(f"[Extract] Processing: {file_path}")

        # Download from Steel
        downloaded = await download_file_from_steel(session_id, file_path)
        if not downloaded:
            logger.warning(f"[Extract] Failed to download: {file_path}")
            continue

        # Upload to Supabase storage
        try:
            file_pointer = await upload_to_storage(
                user_id=user_id,
                file_content=downloaded["content"],
                filename=downloaded["filename"],
                mime_type=downloaded["mime_type"],
            )
            output_files.append(file_pointer)
            logger.info(
                f"[Extract] Uploaded: {downloaded['filename']} -> {file_pointer['storage_path']}"
            )
        except Exception as e:
            logger.warning(
                f"[Extract] Failed to upload {downloaded['filename']}: {extract_error_message(e)}"
            )
            continue

    logger.info(
        f"[Extract] Extracted {len(output_files)}/{len(session_files)} files",
        session_id=session_id,
    )
    return output_files


# ========================================
# PAYMENT/AUTOPAY HELPERS
# ========================================

def decrypt_payment_info(encrypted_data: str, decryption_key_b64: str) -> Optional[Dict[str, Any]]:
    """Decrypt payment information using hybrid RSA+AES decryption."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    
    try:
        envelope_json = base64.b64decode(encrypted_data).decode('utf-8')
        envelope = json.loads(envelope_json)
        
        if envelope.get("version") != 1:
            return None
        
        private_key_pem = base64.b64decode(decryption_key_b64)
        private_key = serialization.load_pem_private_key(private_key_pem, password=None)
        
        encrypted_aes_key = base64.b64decode(envelope["encrypted_aes_key"])
        aes_key = private_key.decrypt(
            encrypted_aes_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None
            )
        )
        
        iv = base64.b64decode(envelope["iv"])
        ciphertext = base64.b64decode(envelope["ciphertext"])
        auth_tag = ciphertext[-16:]
        actual_ciphertext = ciphertext[:-16]
        
        cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv, auth_tag))
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(actual_ciphertext) + decryptor.finalize()
        
        return json.loads(plaintext.decode('utf-8'))
    except Exception as e:
        logger.error("Failed to decrypt payment info", error=extract_error_message(e))
        return None


def decrypt_password(encrypted_envelope: str, decryption_key_b64: str) -> Optional[str]:
    """Decrypt a password using the same RSA+AES scheme as payment info.

    Args:
        encrypted_envelope: Base64-encoded JSON envelope with encrypted_aes_key, iv, ciphertext
        decryption_key_b64: Base64-encoded RSA private key

    Returns:
        Decrypted password string, or None on failure
    """
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend

    try:
        # Decode envelope
        envelope_json = base64.b64decode(encrypted_envelope).decode('utf-8')
        envelope = json.loads(envelope_json)

        if envelope.get("version") != 1:
            return None

        # Load RSA private key
        private_key_pem = base64.b64decode(decryption_key_b64)
        private_key = serialization.load_pem_private_key(private_key_pem, password=None, backend=default_backend())

        # Decrypt AES key with RSA-OAEP
        encrypted_aes_key = base64.b64decode(envelope["encrypted_aes_key"])
        aes_key = private_key.decrypt(
            encrypted_aes_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None
            )
        )

        # Decrypt password with AES-GCM
        iv = base64.b64decode(envelope["iv"])
        ciphertext = base64.b64decode(envelope["ciphertext"])
        auth_tag = ciphertext[-16:]
        actual_ciphertext = ciphertext[:-16]

        cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv, auth_tag), backend=default_backend())
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(actual_ciphertext) + decryptor.finalize()

        return plaintext.decode('utf-8')
    except Exception as e:
        logger.error("Failed to decrypt password", error=extract_error_message(e))
        return None


def decrypt_password_with_key(encrypted_envelope: str, private_key: Any) -> Optional[str]:
    """Decrypt a password using a pre-loaded RSA private key.

    This is an optimized version that avoids re-loading the private key on each call.
    Use this when decrypting many passwords in a loop.

    Args:
        encrypted_envelope: Base64-encoded JSON envelope with encrypted_aes_key, iv, ciphertext
        private_key: Pre-loaded RSA private key object

    Returns:
        Decrypted password string, or None on failure
    """
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend

    try:
        # Decode envelope
        envelope_json = base64.b64decode(encrypted_envelope).decode('utf-8')
        envelope = json.loads(envelope_json)

        if envelope.get("version") != 1:
            return None

        # Decrypt AES key with RSA-OAEP (key already loaded)
        encrypted_aes_key = base64.b64decode(envelope["encrypted_aes_key"])
        aes_key = private_key.decrypt(
            encrypted_aes_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None
            )
        )

        # Decrypt password with AES-GCM
        iv = base64.b64decode(envelope["iv"])
        ciphertext = base64.b64decode(envelope["ciphertext"])
        auth_tag = ciphertext[-16:]
        actual_ciphertext = ciphertext[:-16]

        cipher = Cipher(algorithms.AES(aes_key), modes.GCM(iv, auth_tag), backend=default_backend())
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(actual_ciphertext) + decryptor.finalize()

        return plaintext.decode('utf-8')
    except Exception as e:
        logger.error("Failed to decrypt password with pre-loaded key", error=extract_error_message(e))
        return None


def build_autopay_prompt_section(payment_data: Dict[str, Any], encrypted_envelope: str) -> str:
    """Build the autopay section for the browser agent system prompt.

    Uses reference IDs for card data that will be decrypted at typing time.
    The LLM never sees the actual card number, CVV, etc.
    """
    autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
    autopay_limit_dollars = autopay_limit_cents / 100

    # Get last 4 digits for display (from unencrypted metadata)
    card_number = payment_data.get("card_number", "")
    card_last_four = card_number[-4:] if len(card_number) >= 4 else "****"

    billing_lines = [
        payment_data.get("billing_street_address", ""),
        payment_data.get("billing_address_line2", ""),
        f"{payment_data.get('billing_city', '')}, {payment_data.get('billing_state', '')} {payment_data.get('billing_zipcode', '')}",
        payment_data.get("billing_country", "")
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

    Uses simple refs like pwd:username, adding @domain suffix only for duplicates.

    Returns:
        Tuple of (prompt_section, ref_to_encrypted_map)
        - prompt_section: Text to add to system prompt
        - ref_to_encrypted_map: Maps short refs to encrypted blobs for lookup
    """
    if not passwords:
        return "", {}

    # First pass: count username occurrences to detect duplicates
    username_counts: Dict[str, int] = {}
    for pwd in passwords:
        username = pwd.get("username", "")
        username_counts[username] = username_counts.get(username, 0) + 1

    # Second pass: build refs (add @domain suffix for duplicates)
    lines = []
    ref_to_encrypted: Dict[str, str] = {}

    for pwd in passwords:
        origin = pwd.get("origin", "")
        username = pwd.get("username", "")
        encrypted = pwd.get("encryptedPassword", "")

        # Simple ref format: pwd:username
        if username_counts.get(username, 0) <= 1:
            ref = f"pwd:{username}"
        else:
            # Duplicate username across sites - add @domain suffix
            from urllib.parse import urlparse
            parsed = urlparse(origin) if origin.startswith("http") else urlparse(f"https://{origin}")
            domain = parsed.netloc or origin
            if domain.startswith("www."):
                domain = domain[4:]
            short_domain = domain.split(".")[0]  # "linkedin" from "linkedin.com"
            ref = f"pwd:{username}@{short_domain}"

        ref_to_encrypted[ref] = encrypted
        lines.append(f"- {origin} | {username} | ref: {ref}")

    prompt_section = f"""

AVAILABLE PASSWORDS (type the ref into password fields):
{chr(10).join(lines)}

To log in, type the ref (e.g., pwd:andy@email.com) into the password field.
It will be automatically decrypted."""

    return prompt_section, ref_to_encrypted


def extract_otp_from_text(text: str) -> Optional[str]:
    """Extract OTP code from email text using regex patterns."""
    import re

    # Patterns ordered by specificity (most specific first)
    patterns = [
        # 6-digit codes with context
        r'(?:verification|security|auth|login|sign.?in|confirm)\s*(?:code|pin|otp)[\s:]+(\d{6})\b',
        r'\b(\d{6})\s*(?:is\s+)?(?:your|the)\s+(?:verification|security|auth|one.?time|otp|login)\s*(?:code|pin)?',
        r'(?:code|pin|otp)[\s:]+(\d{6})\b',
        r'\b(\d{6})\b.*(?:expires?|valid|verify|enter|use)',
        # 4-digit PINs
        r'(?:pin|code)[\s:]+(\d{4})\b',
        r'\b(\d{4})\s*(?:is\s+)?(?:your|the)\s+(?:pin|code|otp)',
        # 8-digit codes
        r'(?:code|otp)[\s:]+(\d{8})\b',
    ]

    # Skip if text contains low-confidence keywords
    low_confidence_keywords = ['order', 'tracking', 'receipt', 'invoice', 'account number', 'reference', 'transaction id']
    lower_text = text.lower()
    if any(kw in lower_text for kw in low_confidence_keywords):
        # Still try high-confidence patterns
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
    from datetime import datetime, timedelta

    try:
        # Fetch emails from last 10 minutes
        since = (datetime.utcnow() - timedelta(minutes=10)).isoformat() + "Z"

        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{api_url}/api/integrations/email/messages",
                params={"since": since, "limit": 20},
                headers={
                    "X-API-Key": api_key,
                    "x-user-id": user_id,
                },
            )

            if response.status_code == 404:
                # Gmail not connected - not an error, just no OTPs available
                return ""

            if response.status_code != 200:
                logger.warning("Failed to fetch emails for OTP", status=response.status_code)
                return ""

            data = response.json()
            emails = data.get("emails", [])

            if not emails:
                return ""

            # Extract OTPs from emails
            otps = []
            for email in emails:
                body_text = email.get("bodyText", "")
                if not body_text:
                    continue

                code = extract_otp_from_text(body_text)
                if code:
                    email_date = datetime.fromisoformat(email.get("date", "").replace("Z", "+00:00"))
                    age_seconds = (datetime.now(email_date.tzinfo) - email_date).total_seconds()

                    # Skip if code is too old (> 10 min)
                    if age_seconds > 600:
                        continue

                    age_str = f"{int(age_seconds)}s ago" if age_seconds < 60 else f"{int(age_seconds / 60)}m ago"
                    ttl_seconds = max(0, 300 - int(age_seconds))  # 5 min typical TTL
                    ttl_str = f"{ttl_seconds}s" if ttl_seconds < 60 else f"{int(ttl_seconds / 60)}m"

                    sender = email.get("fromName") or email.get("from", "unknown")
                    otps.append(f'- "{code}" from {sender} (received {age_str}, expires in ~{ttl_str})')

            if not otps:
                return ""

            # Deduplicate by code
            seen_codes = set()
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
# EXTRACT LLM CALL (gpt-4.1-mini)
# ========================================

async def _call_extract_llm(
    instruction: str,
    page_content: str,
    current_url: str,
) -> str:
    """Call gpt-4.1-mini via OpenRouter to extract structured data from page.
    
    Args:
        instruction: User's extraction instruction
        page_content: DOM tree or page text content
        current_url: Current page URL for context
        
    Returns:
        Extracted content as string
    """
    config = load_config()
    
    # Truncate page content if too long (gpt-4.1-mini has ~128k context)
    max_content_len = 50000
    truncated_content = page_content[:max_content_len]
    if len(page_content) > max_content_len:
        truncated_content += f"\n\n... [truncated {len(page_content) - max_content_len} chars]"
    
    system_prompt = """You are a data extraction assistant. Extract information from the provided web page content according to the user's instruction.

Be precise and only extract what is asked for. If the requested information is not found, say so clearly.

Return the extracted data in a clear, structured format."""

    user_prompt = f"""URL: {current_url}

PAGE CONTENT:
{truncated_content}

EXTRACTION INSTRUCTION:
{instruction}

Extract the requested information from the page content above."""

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                config.openrouter.base_url + "/chat/completions",
                headers={
                    "Authorization": f"Bearer {config.openrouter.api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://roselabs.ai",
                    "X-Title": "Rose Browser Agent Extract"
                },
                json={
                    "model": "openai/gpt-4.1-mini",
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    "max_tokens": 4096,
                    "temperature": 0.1
                }
            )
            
            if response.status_code != 200:
                logger.error(f"Extract LLM error: {response.status_code} - {response.text[:500]}")
                return f"Extraction failed: HTTP {response.status_code}"
            
            result = response.json()
            content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            return content or "No content extracted"
            
    except Exception as e:
        logger.error(f"Extract LLM call failed: {e}")
        return f"Extraction failed: {str(e)}"


# ========================================
# ROSE API BROWSER-USE CALL
# ========================================

async def call_rose_browser_use(
    task: str,
    browser_state: Dict[str, Any],
    action_history: list,
    config: Any,
) -> Dict[str, Any]:
    """Call Rose API rose-1-browser-use endpoint.

    Args:
        task: The browser automation task/goal
        browser_state: Current browser state (url, dom_tree, screenshot, viewport, scroll_position)
        action_history: List of previous action entries
        config: App config with Rose API credentials

    Returns:
        Dict with 'action' (UnifiedAction) and metadata
    """
    # Generate unique request ID for tracing through edge function
    request_id = str(uuid_module.uuid4())[:8]

    request_body = {
        "model": "rose-labs/rose-1-browser-use",
        "task": task,
        "browser_state": browser_state,
        "action_history": action_history,
        "available_actions": AVAILABLE_ACTIONS,
    }

    # Log full request for debugging (truncate screenshot to avoid huge logs)
    log_body = {
        **request_body,
        "browser_state": {
            **browser_state,
            "screenshot": f"<base64 {len(browser_state.get('screenshot', ''))} chars>" if browser_state.get('screenshot') else None,
            "dom_tree": f"<{len(browser_state.get('dom_tree', ''))} chars>" if browser_state.get('dom_tree') else None,
        }
    }
    logger.info(f"📤 [{request_id}] Rose browser-use request", request_id=request_id, request=json.dumps(log_body, indent=2, default=str))

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            config.rose.api_url,
            headers={
                "Authorization": f"Bearer {config.rose.supabase_anon_key}",
                "x-api-key": config.rose.api_key,
                "x-request-id": request_id,
                "Content-Type": "application/json"
            },
            json=request_body
        )

        if response.status_code != 200:
            error_text = response.text
            logger.error(f"❌ [{request_id}] Rose API error: {response.status_code} - {error_text}", request_id=request_id)
            raise RuntimeError(f"Rose API error: {response.status_code}")

        result = response.json()
        # Include request_id in response for downstream logging
        result["request_id"] = request_id
        logger.info(f"📥 [{request_id}] Rose browser-use response", request_id=request_id, response=json.dumps(result, indent=2, default=str))
        return result


# ========================================
# BROWSER ACTION EXECUTION
# ========================================

def get_element_description(element, max_length: int = 40) -> str:
    """Get a human-readable description of a DOM element.
    
    Args:
        element: EnhancedDOMTreeNode from browser-use
        max_length: Max length of the description
        
    Returns:
        Human-readable string like '<button>Submit' or '<input placeholder="Search">'
    """
    if not element:
        return "unknown"
    
    tag = element.tag_name.lower() if element.tag_name else "element"
    attrs = element.attributes or {}
    
    # Try to get meaningful identifier in order of preference
    identifier = ""
    
    # 1. Text content (for buttons, links, etc.)
    try:
        text = element.get_all_children_text()
        if text and len(text.strip()) > 0:
            text = text.strip()[:30]
            identifier = f'"{text}"'
    except:
        pass
    
    # 2. Placeholder (for inputs)
    if not identifier and attrs.get("placeholder"):
        identifier = f'placeholder="{attrs["placeholder"][:20]}"'
    
    # 3. aria-label
    if not identifier and attrs.get("aria-label"):
        identifier = f'"{attrs["aria-label"][:20]}"'
    
    # 4. name attribute  
    if not identifier and attrs.get("name"):
        identifier = f'name="{attrs["name"][:15]}"'
    
    # 5. id attribute
    if not identifier and attrs.get("id"):
        identifier = f'#{attrs["id"][:15]}'
    
    # 6. type for inputs
    if not identifier and tag == "input" and attrs.get("type"):
        identifier = f'type="{attrs["type"]}"'
    
    # Build description
    if identifier:
        desc = f"<{tag} {identifier}>"
    else:
        desc = f"<{tag}>"
    
    return desc[:max_length]


async def move_visual_cursor(dom_service: DOMService, x: int, y: int) -> None:
    """Move the injected visual cursor to coordinates."""
    try:
        session = dom_service.session
        if not session:
            return
        cdp_session = await session.get_or_create_cdp_session(focus=True)
        await cdp_session.cdp_client.send.Runtime.evaluate(
            params={
                "expression": f"if (window.__moveRoseCursor) window.__moveRoseCursor({x}, {y});",
                "returnByValue": True
            },
            session_id=cdp_session.session_id
        )
    except:
        pass  # Visual cursor is optional


def _get_domain_from_url(url: str) -> str:
    """Extract domain from URL for approval tracking."""
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url.lower())
        domain = parsed.netloc
        if domain.startswith("www."):
            domain = domain[4:]
        return domain
    except:
        return ""


def _is_approval_valid(approvals: Dict, approval_type: str, current_url: str, timeout_seconds: int = 120) -> bool:
    """Check if an existing approval is still valid for the current domain.

    Approval is valid if:
    - Same domain as when approved
    - Less than timeout_seconds have passed (default 2 minutes)
    """
    import time as time_module

    if not approvals:
        return False

    approval = approvals.get(approval_type, {})
    if not approval.get("domain") or not approval.get("approved_at"):
        return False

    current_domain = _get_domain_from_url(current_url)
    approved_domain = approval["domain"]
    approved_at = approval["approved_at"]

    # Check domain matches
    if current_domain != approved_domain:
        return False

    # Check timeout
    if time_module.time() - approved_at > timeout_seconds:
        return False

    return True


async def execute_action(
    dom_service: DOMService,
    action_history: ActionHistory,
    action: Dict[str, Any],
    available_file_paths: Optional[Dict[str, str]] = None,
    session_id: Optional[str] = None,
    config: Any = None,
    humanizer: Optional[BrowserHumanizer] = None,
    secret_refs: Optional[Dict[str, str]] = None,
    password_origins: Optional[Dict[str, str]] = None,
    current_url: str = "",
    write_lock_enabled: bool = True,
    write_lock_approvals: Optional[Dict[str, Dict]] = None,
) -> Dict[str, Any]:
    """Execute a browser action using browser-use events.

    Args:
        dom_service: DOMService wrapping browser-use BrowserSession
        action_history: ActionHistory for recording actions
        action: UnifiedAction dict with action, index, coordinates, params, thinking
        available_file_paths: Dict mapping filename -> remote path for file uploads
        session_id: Steel session ID for localStorage injection
        config: App config for backend API calls
        humanizer: BrowserHumanizer for human-like mouse/keyboard interactions
        secret_refs: Dict mapping encrypted/ref values to decrypted values (passwords, cards)
        password_origins: Dict mapping encrypted password -> expected origin for validation
        current_url: Current page URL for domain checking
        write_lock_enabled: Whether write lock is enabled for this agent
        write_lock_approvals: Dict tracking approved domains by type (mutated on approval):
            {"payment": {"domain": str, "approved_at": float}, "social_post": {...}}

    Returns:
        Result dict with success, message, and any additional data
        May return {"status": "needs_write_approval", ...} if write lock triggered
    """
    from browser_use.browser.events import (
        ClickElementEvent,
        ClickCoordinateEvent,
        TypeTextEvent,
        SendKeysEvent,
        ScrollEvent,
        NavigateToUrlEvent,
        GoBackEvent,
        WaitEvent,
        GetDropdownOptionsEvent,
        SelectDropdownOptionEvent,
        SwitchTabEvent,
        CloseTabEvent,
    )
    from browser_tools.write_lock import (
        is_social_domain,
        is_submit_button,
        is_payment_field,
        get_write_lock_approval_question,
    )

    session = dom_service.session
    if not session:
        return {"success": False, "error": "Browser not connected"}
    
    action_name = action.get("action", "")
    index = action.get("index")
    params = action.get("params", {})
    thinking = action.get("thinking")
    coords = action.get("coordinates")
    
    try:
        # Get element from selector map if index provided
        element = None
        if index is not None:
            element = dom_service.selector_map.get(index)
            if not element:
                return {"success": False, "error": f"Element with index {index} not found"}
        
        # Execute action based on type
        if action_name == "click":
            # Write lock check for social posting
            if write_lock_enabled and element:
                # Get element text for submit button detection
                # Note: EnhancedDOMTreeNode uses get_all_children_text() method, not text_content attribute
                element_text = element.get_all_children_text() if hasattr(element, 'get_all_children_text') else ''
                if is_social_domain(current_url) and is_submit_button(element_text):
                    # Check if we already have valid approval for this domain
                    if not _is_approval_valid(write_lock_approvals, "social_post", current_url):
                        logger.info(
                            "Write lock triggered: social posting detected",
                            url=current_url,
                            element_text=element_text[:50]
                        )
                        return {
                            "status": "needs_write_approval",
                            "approval_type": "social_post",
                            "question": get_write_lock_approval_question(
                                action_type="social_post",
                                url=current_url,
                                element_text=element_text[:100]
                            ),
                            "element_text": element_text[:100],
                            "url": current_url,
                        }
                    else:
                        logger.info(
                            "Write lock bypassed: existing approval valid",
                            approval_type="social_post",
                            url=current_url
                        )

            if element:
                # Index-based click (DOM models)
                # Get element coordinates for humanizer (cursor movement handled internally)
                coord_tuple = await dom_service.get_element_coordinates(index)
                element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None

                # Browser-use highlight (fire-and-forget)
                asyncio.create_task(session.highlight_interaction_element(element))

                # Human-like mouse movement + click
                if humanizer and element_coords:
                    await humanizer.click_at_coords(element_coords["x"], element_coords["y"])
                else:
                    # Fallback to browser-use if no humanizer or no coordinates
                    if not humanizer:
                        logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use ClickElementEvent")
                    else:
                        logger.error(f"⚠️ HUMANIZATION FALLBACK: No coordinates for element {index}, using browser-use ClickElementEvent (not humanized!)")
                    event = session.event_bus.dispatch(ClickElementEvent(node=element))
                    await event
                    await event.event_result(raise_if_any=True, raise_if_none=False)

                await action_history.record_action(
                    dom_service=dom_service,
                    action="click",
                    thinking=thinking,
                    index=index,
                    coordinates=element_coords,
                    result={"success": True}
                )
                return {"success": True, "message": ""}
            elif coords:
                # Coordinate-based click (vision models like Yutori)
                # Cursor movement handled internally by humanizer

                # Browser-use highlight (fire-and-forget)
                asyncio.create_task(session.highlight_coordinate_click(int(coords["x"]), int(coords["y"])))

                # Human-like mouse movement + click
                if humanizer:
                    await humanizer.click_at_coords(int(coords["x"]), int(coords["y"]))
                else:
                    logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use ClickCoordinateEvent")
                    event = session.event_bus.dispatch(ClickCoordinateEvent(
                        coordinate_x=int(coords["x"]),
                        coordinate_y=int(coords["y"])
                    ))
                    await event
                    await event.event_result(raise_if_any=True, raise_if_none=False)

                await action_history.record_action(
                    dom_service=dom_service,
                    action="click",
                    thinking=thinking,
                    coordinates=coords,
                    result={"success": True}
                )
                return {"success": True, "message": ""}
            else:
                return {"success": False, "error": "Click requires either element index or coordinates"}
        
        elif action_name == "input_text":
            text = params.get("text", "")
            display_text = text  # What we show in action history (may be redacted)

            # Check if this is a password or card reference that needs decryption
            if secret_refs and text in secret_refs:
                # ALWAYS redact in display/logs, even if validation fails
                display_text = "[encrypted_data]"

                # Check if it's a password (needs origin validation)
                if password_origins and text in password_origins:
                    expected_origin = password_origins[text]
                    # Use current_url passed from caller (browser_state.url)
                    from urllib.parse import urlparse
                    current_domain = urlparse(current_url).netloc.lower() if current_url else ""
                    expected_domain = urlparse(expected_origin).netloc.lower() if expected_origin else ""

                    # Fuzzy domain match (handle auth.amazon.com vs amazon.com)
                    def get_base_domain(domain: str) -> str:
                        parts = domain.split('.')
                        if len(parts) >= 2:
                            return '.'.join(parts[-2:])
                        return domain

                    if get_base_domain(current_domain) != get_base_domain(expected_domain):
                        logger.warning("🔐 Password origin mismatch", expected=expected_domain, got=current_domain)
                        return {
                            "success": False,
                            "error": f"Password origin mismatch: expected {expected_domain}, got {current_domain}"
                        }

                # Decrypt and replace text for typing
                text = secret_refs[text]
                logger.info("🔐 Typing encrypted credential (password/card)", redacted=True)

            # Write lock check for payment fields
            if write_lock_enabled and element and index is not None:
                if await is_payment_field(session, element, index):
                    # Check if we already have valid approval for this domain
                    if not _is_approval_valid(write_lock_approvals, "payment", current_url):
                        # Get element description for the approval question
                        element_text = getattr(element, 'text_content', '') or ''
                        tag_name = getattr(element, 'tag_name', '') or getattr(element, 'node_name', 'input')
                        field_desc = f"{tag_name} field"
                        if element_text:
                            field_desc = f"{tag_name}: {element_text[:50]}"

                        logger.info(
                            "Write lock triggered: payment field detected",
                            url=current_url,
                            field_desc=field_desc
                        )
                        return {
                            "status": "needs_write_approval",
                            "approval_type": "payment",
                            "question": get_write_lock_approval_question(
                                action_type="payment",
                                url=current_url,
                                field_description=field_desc
                            ),
                            "field_description": field_desc,
                            "url": current_url,
                        }
                    else:
                        logger.info(
                            "Write lock bypassed: existing approval valid",
                            approval_type="payment",
                            url=current_url
                        )

            if element:
                # Index-based input (DOM models)
                # Get element coordinates for humanizer (cursor movement handled internally)
                coord_tuple = await dom_service.get_element_coordinates(index)
                element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None

                # Browser-use highlight (fire-and-forget)
                asyncio.create_task(session.highlight_interaction_element(element))

                # Human-like click to focus, then type
                if humanizer and element_coords:
                    await humanizer.click_at_coords(element_coords["x"], element_coords["y"])
                    await humanizer.type_text(text)
                else:
                    # Fallback to browser-use
                    if not humanizer:
                        logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use TypeTextEvent")
                    else:
                        logger.error(f"⚠️ HUMANIZATION FALLBACK: No coordinates for element {index}, using browser-use TypeTextEvent (not humanized!)")
                    event = session.event_bus.dispatch(TypeTextEvent(node=element, text=text))
                    await event
                    await event.event_result(raise_if_any=True, raise_if_none=False)

                await action_history.record_action(
                    dom_service=dom_service,
                    action="input_text",
                    thinking=thinking,
                    index=index,
                    coordinates=element_coords,
                    params={"text": display_text},  # Use display_text to redact secrets
                    result={"success": True}
                )
                return {"success": True, "message": "", "typed_text": display_text}
            elif coords:
                # Coordinate-based input (vision models like Yutori)
                # Cursor movement handled internally by humanizer

                # Browser-use highlight (fire-and-forget)
                asyncio.create_task(session.highlight_coordinate_click(int(coords["x"]), int(coords["y"])))

                # Human-like click to focus, then type
                if humanizer:
                    await humanizer.click_at_coords(int(coords["x"]), int(coords["y"]))
                    await humanizer.type_text(text)
                else:
                    logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use events")
                    # First click to focus the element
                    click_event = session.event_bus.dispatch(ClickCoordinateEvent(
                        coordinate_x=int(coords["x"]),
                        coordinate_y=int(coords["y"])
                    ))
                    await click_event
                    await click_event.event_result(raise_if_any=True, raise_if_none=False)
                    await asyncio.sleep(0.1)
                    type_event = session.event_bus.dispatch(SendKeysEvent(keys=text))
                    await type_event
                    await type_event.event_result(raise_if_any=True, raise_if_none=False)

                await action_history.record_action(
                    dom_service=dom_service,
                    action="input_text",
                    thinking=thinking,
                    coordinates=coords,
                    params={"text": display_text},  # Use display_text to redact secrets
                    result={"success": True}
                )
                return {"success": True, "message": "", "typed_text": display_text}
            else:
                # Fallback: no index or coords - type to currently focused element
                if humanizer:
                    await humanizer.type_text(text)
                else:
                    logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use SendKeysEvent")
                    type_event = session.event_bus.dispatch(SendKeysEvent(keys=text))
                    await type_event
                    await type_event.event_result(raise_if_any=True, raise_if_none=False)

                await action_history.record_action(
                    dom_service=dom_service,
                    action="input_text",
                    thinking=thinking,
                    params={"text": display_text},  # Use display_text to redact secrets
                    result={"success": True}
                )
                return {"success": True, "message": "", "typed_text": display_text}
        
        elif action_name == "press_key":
            key = params.get("key", "")
            if humanizer:
                await humanizer.press_key(key)
            else:
                logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use SendKeysEvent")
                event = session.event_bus.dispatch(SendKeysEvent(keys=key))
                await event
                await event.event_result(raise_if_any=True, raise_if_none=False)

            await action_history.record_action(
                dom_service=dom_service,
                action="press_key",
                thinking=thinking,
                params={"key": key},
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "scroll":
            direction = params.get("direction", "down")
            amount = params.get("amount", 300)

            # Convert direction to delta_y (positive = down, negative = up)
            delta_y = amount if direction == "down" else -amount

            # Human-like scrolling with momentum
            if humanizer:
                await humanizer.scroll(delta_y)
            else:
                logger.warning("⚠️ HUMANIZATION FALLBACK: No humanizer available, using browser-use ScrollEvent")
                event = session.event_bus.dispatch(ScrollEvent(
                    direction=direction,
                    amount=amount,
                    node=element if index is not None else None
                ))
                await event
                await event.event_result(raise_if_any=True, raise_if_none=False)

            await action_history.record_action(
                dom_service=dom_service,
                action="scroll",
                thinking=thinking,
                index=index,
                params={"direction": direction, "amount": amount},
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "goto":
            url = params.get("url", "")
            # Auto-add https:// if no scheme provided
            if url and not url.startswith(("http://", "https://", "about:", "file:")):
                url = f"https://{url}"
                logger.info(f"🔗 Auto-added https:// to URL: {url}")
            event = session.event_bus.dispatch(NavigateToUrlEvent(url=url))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)

            # Inject localStorage for this origin after navigation
            if session_id and config:
                try:
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    origin = f"{parsed.scheme}://{parsed.netloc}"
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        inject_response = await client.post(
                            f"{config.backend.api_url}/api/browser-session/{session_id}/inject-localStorage",
                            headers={
                                "x-api-key": config.backend.api_key or "",
                                "Content-Type": "application/json"
                            },
                            json={"origin": origin}
                        )
                        if inject_response.status_code == 200:
                            result_data = inject_response.json()
                            if result_data.get("injected"):
                                logger.info(f"💾 Injected {result_data.get('count', 0)} localStorage entries for {origin}")
                        else:
                            logger.warning(f"Failed to inject localStorage: HTTP {inject_response.status_code}")
                except Exception as e:
                    logger.warning(f"Failed to inject localStorage for {url}: {e}")

            await action_history.record_action(
                dom_service=dom_service,
                action="goto",
                thinking=thinking,
                params={"url": url},
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "navback":
            event = session.event_bus.dispatch(GoBackEvent())
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            
            await action_history.record_action(
                dom_service=dom_service,
                action="navback",
                thinking=thinking,
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "wait":
            time_ms = params.get("time_ms", 1000)
            seconds = time_ms / 1000.0
            # WaitEvent uses seconds (float), not timeout_ms
            event = session.event_bus.dispatch(WaitEvent(seconds=seconds))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            
            await action_history.record_action(
                dom_service=dom_service,
                action="wait",
                thinking=thinking,
                params={"time_ms": time_ms},
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "dropdown_options":
            if not element:
                return {"success": False, "error": "Dropdown requires an element index"}
            event = session.event_bus.dispatch(GetDropdownOptionsEvent(node=element))
            await event
            options = await event.event_result(raise_if_any=True, raise_if_none=False)
            
            return {"success": True, "message": f"Dropdown options: {options}", "options": options}
        
        elif action_name == "select_dropdown":
            if not element:
                return {"success": False, "error": "Dropdown requires an element index"}
            value = params.get("value", "")
            # SelectDropdownOptionEvent uses 'text' param, not 'value'
            event = session.event_bus.dispatch(SelectDropdownOptionEvent(node=element, text=value))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)
            
            await action_history.record_action(
                dom_service=dom_service,
                action="select_dropdown",
                thinking=thinking,
                index=index,
                params={"value": value},
                result={"success": True}
            )
            return {"success": True, "message": ""}
        
        elif action_name == "evaluate":
            code = params.get("code", "")
            cdp_session = await session.get_or_create_cdp_session(focus=True)
            result = await cdp_session.cdp_client.send.Runtime.evaluate(
                params={"expression": code, "returnByValue": True},
                session_id=cdp_session.session_id
            )
            value = result.get("result", {}).get("value")
            
            await action_history.record_action(
                dom_service=dom_service,
                action="evaluate",
                thinking=thinking,
                params={"code": code},
                result={"success": True, "value": value}
            )
            return {"success": True, "message": f"Executed JS, result: {value}", "value": value}
        
        elif action_name == "extract":
            instruction = params.get("instruction", "")
            extract_links = params.get("extract_links", False)
            
            # Use browser-use's native markdown extraction
            from browser_use.dom.markdown_extractor import extract_clean_markdown
            
            try:
                # Extract clean markdown (filters ads, noise)
                content, content_stats = await extract_clean_markdown(
                    browser_session=session,
                    extract_links=extract_links
                )
                current_url = await session.get_current_page_url()
                
                # Call gpt-4.1-mini for extraction
                extracted_content = await _call_extract_llm(
                    instruction=instruction,
                    page_content=content,
                    current_url=current_url,
                )
                
                await action_history.record_action(
                    dom_service=dom_service,
                    action="extract",
                    thinking=thinking,
                    params={"instruction": instruction},
                    result={"success": True, "content": extracted_content}
                )
                return {"success": True, "message": extracted_content, "content": extracted_content}
            except Exception as e:
                logger.error(f"Extract failed: {e}")
                return {"success": False, "error": str(e)}
        
        elif action_name == "done":
            text = params.get("text", "")
            await action_history.record_action(
                dom_service=dom_service,
                action="done",
                thinking=thinking,
                params={"text": text},
                result={"success": True}
            )
            return {"success": True, "done": True, "message": text}
        
        elif action_name == "attempt_completion":
            await action_history.record_action(
                dom_service=dom_service,
                action="attempt_completion",
                thinking=thinking,
                params={},
                result={"success": True}
            )
            return {"success": True, "attempt_completion": True}
        
        elif action_name == "send_message_to_user":
            message = params.get("message", "")
            reason = params.get("reason", "other")
            await action_history.record_action(
                dom_service=dom_service,
                action="send_message_to_user",
                thinking=thinking,
                params={"message": message, "reason": reason},
                result={"success": True}
            )
            return {"success": True, "message_to_user": True, "message": message, "reason": reason}

        elif action_name == "upload_file":
            from browser_use.browser.events import UploadFileEvent

            filename = params.get("filename", "")
            if not filename:
                return {"success": False, "error": "Missing 'filename' parameter"}

            # Validate file is available
            if not available_file_paths or filename not in available_file_paths:
                available_files = list(available_file_paths.keys()) if available_file_paths else []
                return {
                    "success": False,
                    "error": f"File '{filename}' not available. Available files: {available_files}"
                }

            if not element:
                return {"success": False, "error": "upload_file requires an element index for the file input"}

            # Check if it's a file input
            if not session.is_file_input(element):
                return {"success": False, "error": f"Element {index} is not a file input (<input type='file'>)"}

            remote_path = available_file_paths[filename]

            # Get coordinates for humanizer cursor movement
            coord_tuple = await dom_service.get_element_coordinates(index)
            element_coords = {"x": coord_tuple[0], "y": coord_tuple[1]} if coord_tuple else None
            if humanizer and element_coords:
                await humanizer.click_at_coords(element_coords["x"], element_coords["y"])

            # Dispatch UploadFileEvent with the remote path
            event = session.event_bus.dispatch(UploadFileEvent(node=element, file_path=remote_path))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)

            await action_history.record_action(
                dom_service=dom_service,
                action="upload_file",
                thinking=thinking,
                index=index,
                coordinates=element_coords,
                params={"filename": filename},
                result={"success": True}
            )

            logger.info(f"📎 Uploaded file '{filename}' to element {index}")
            return {
                "success": True,
                "message": "",
                "uploaded": filename,
                "to_index": index
            }

        elif action_name == "switch_tab":
            tab_id = params.get("tab_id")
            if not tab_id:
                return {"success": False, "error": "Missing 'tab_id' parameter"}

            tabs = await session.get_tabs()
            target = next((t for t in tabs if t.target_id.endswith(tab_id)), None)
            if not target:
                available_tabs = [f"{t.target_id[-4:]} ({t.title or t.url})" for t in tabs]
                return {"success": False, "error": f"Tab '{tab_id}' not found. Available: {available_tabs}"}

            event = session.event_bus.dispatch(SwitchTabEvent(target_id=target.target_id))
            await event

            await action_history.record_action(
                dom_service=dom_service,
                action="switch_tab",
                thinking=thinking,
                params={"tab_id": tab_id},
                result={"success": True, "switched_to": target.target_id[-4:]}
            )
            logger.info(f"🔀 Switched to tab {tab_id} ({target.title or target.url})")
            return {"success": True, "message": "", "switched_to": tab_id}

        elif action_name == "close_tab":
            tab_id = params.get("tab_id")

            if tab_id:
                tabs = await session.get_tabs()
                target = next((t for t in tabs if t.target_id.endswith(tab_id)), None)
                if not target:
                    available_tabs = [f"{t.target_id[-4:]} ({t.title or t.url})" for t in tabs]
                    return {"success": False, "error": f"Tab '{tab_id}' not found. Available: {available_tabs}"}
                target_id = target.target_id
            else:
                focused = session.get_focused_target()
                if not focused:
                    return {"success": False, "error": "No current tab to close"}
                target_id = focused.target_id
                tab_id = target_id[-4:]

            event = session.event_bus.dispatch(CloseTabEvent(target_id=target_id))
            await event

            await action_history.record_action(
                dom_service=dom_service,
                action="close_tab",
                thinking=thinking,
                params={"tab_id": tab_id},
                result={"success": True, "closed": tab_id}
            )
            logger.info(f"❌ Closed tab {tab_id}")
            return {"success": True, "message": "", "closed_tab": tab_id}

        elif action_name == "open_new_tab":
            url = params.get("url") or "about:blank"

            event = session.event_bus.dispatch(NavigateToUrlEvent(url=url, new_tab=True))
            await event
            await event.event_result(raise_if_any=True, raise_if_none=False)

            # Get the new tab's target_id
            focused = session.get_focused_target()
            new_tab_id = focused.target_id[-4:] if focused else None

            await action_history.record_action(
                dom_service=dom_service,
                action="open_new_tab",
                thinking=thinking,
                params={"url": url},
                result={"success": True, "new_tab_id": new_tab_id}
            )
            logger.info(f"➕ Opened new tab {new_tab_id} with URL: {url}")
            return {"success": True, "message": "", "new_tab_id": new_tab_id, "url": url}

        else:
            return {"success": False, "error": f"Unknown action: {action_name}"}
            
    except Exception as e:
        logger.error(f"Action {action_name} failed: {e}")
        # Record failed action (preserve coordinates for debugging)
        await action_history.record_action(
            dom_service=dom_service,
            action=action_name,
            thinking=thinking,
            index=index,
            coordinates=coords,
            params=params,
            result={"success": False, "error": str(e)}
        )
        return {"success": False, "error": str(e)}


# ========================================
# BROWSER SYSTEM PROMPT
# ========================================

def get_browser_system_prompt(
    goal: str,
    current_url: str,
    custom_instructions: str = "",
    available_files: Optional[List[str]] = None
) -> str:
    """Build browser agent system prompt.

    Args:
        goal: The task goal
        current_url: Current browser URL
        custom_instructions: Additional instructions
        available_files: List of filenames available for upload
    """
    current_time = datetime.now().strftime("%B %d, %Y at %I:%M %p")

    # Build available files section if files are present
    files_section = ""
    if available_files:
        files_section = f"""
AVAILABLE FILES FOR UPLOAD:
The following files are available to upload using the upload_file action.
To upload a file, find a file input element (<input type="file">) and use upload_file with the filename.
Files: {', '.join(available_files)}
"""

    return f"""Current time: {current_time}

CURRENT GOAL: {goal}
CURRENT URL: {current_url}
{files_section}
You will receive:
1. The current DOM tree with indexed elements like [1] button "Submit", [2] input[type=text], etc.
2. A screenshot of the current page
3. History of your previous actions and their results

To interact with elements, use their index number from the DOM tree.

AVAILABLE ACTIONS:
- click: Click an element by index
- input_text: Type text into an input element
- press_key: Press keyboard keys (Enter, Tab, Escape, etc.)
- scroll: Scroll the page up or down
- goto: Navigate to a URL
- navback: Go back in browser history
- wait: Wait for a specified time
- dropdown_options: Get options from a dropdown
- select_dropdown: Select an option from a dropdown
- evaluate: Execute JavaScript
- extract: Extract structured data from the page
- upload_file: Upload a file to a file input element (requires filename from available_files)
- attempt_completion: Signal you believe the task is complete
- send_message_to_user: Request user assistance

CRITICAL SAFETY RULES:
- NEVER delete or close any user account
- NEVER sign legal agreements on the user's behalf (accepting Terms of Service checkboxes is acceptable)
- When making payments or posting to social media, you may be asked to confirm with the user first

{custom_instructions}

Think step-by-step about what action to take next. Always prefer using element indices from the DOM tree for precise interactions."""


# ========================================
# TEMPORAL ACTIVITY (V3 - browser-use)
# ========================================

@activity.defn
async def spawn_browser_agent_activity_v3(
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    task_id: Optional[str] = None,
    session_id: Optional[str] = None,
    cdp_url: Optional[str] = None,
    is_resume: bool = False,
    output_schema: Optional[Dict[str, Any]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    write_lock_enabled: bool = True,
    start_url: str = "",
) -> Dict[str, Any]:
    """
    Browser agent activity using browser-use BrowserSession + Rose API.

    Key changes from v2:
    - Uses browser-use BrowserSession instead of Stagehand
    - Calls Rose API rose-1-browser-use for LLM decisions
    - Always takes screenshots after actions (no screenshot tool)
    - Index-based element selection

    Args:
        output_schema: Response schema from parent agent's tool call (required for sub-agents)
        attachments: List of FilePointer dicts for files to upload to the browser session
        write_lock_enabled: Whether to require approval for high-risk actions (payments, social posts)
        start_url: URL to navigate to automatically before starting the agent loop
    """
    from helpers.llm import check_progress
    from tools.knowledge_base import query_blueprints_activity

    dom_service = None
    action_history = ActionHistory()
    browser_url = None
    current_url = ""  # Initialize early for exception handlers
    config = load_config()
    start_time = _safe_time()

    # Token tracking for usage
    total_input_tokens = 0
    total_output_tokens = 0

    # Execution tracking
    visited_urls = []
    reasoning_messages = []
    action_summary = []

    # Write lock approval state - tracks approved domains by type to avoid repeated prompts
    # Structure: {"payment": {"domain": str, "approved_at": float}, "social_post": {...}}
    write_lock_approvals: Dict[str, Dict] = {}

    # Use response schema from parent agent's tool call (required)
    response_schema = output_schema
    if not response_schema:
        raise ValueError("output_schema is required for browser agent - parent agent must provide structured output schema in tool call")
    logger.info("Using response schema from tool call", fields=len(response_schema.get("fields", [])))
    
    # Passwords from session response (consolidates /init and /task endpoints)
    session_passwords: List[Dict[str, Any]] = []

    try:
        # ===== SESSION INITIALIZATION =====
        fingerprint_injection = None  # Will be populated from backend response
        if is_resume and task_id:
            logger.info("🔍 Fetching session info for resumed task", task_id=task_id)
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{config.backend.api_url}/api/browser-session/task/{task_id}",
                    headers={"x-api-key": config.backend.api_key or ""}
                )
                if response.status_code == 200:
                    session_info = response.json()
                    session_id = session_info.get("session_id")
                    browser_url = session_info.get("debug_url")
                    cdp_url = session_info.get("ws_url")  # CDP WebSocket URL
                    fingerprint_injection = session_info.get("fingerprint_injection")  # For CDP re-injection
                    session_passwords = session_info.get("passwords", [])
                else:
                    raise RuntimeError(f"Failed to fetch session info: HTTP {response.status_code}")
            activity.heartbeat(f"Resuming task {task_id}")
        else:
            activity.heartbeat("Initializing browser session")
            async with httpx.AsyncClient(timeout=120.0) as client:  # 120s for session init + user data injection
                response = await client.post(
                    f"{config.backend.api_url}/api/browser-session/init",
                    headers={"x-api-key": config.backend.api_key or "", "Content-Type": "application/json"},
                    json={"user_id": user_id, "agent_id": agent_id}
                )
                if response.status_code not in [200, 201]:
                    raise Exception(f"Failed to init session: {response.text}")

                session_data = response.json()
                task_id = session_data["task_id"]
                session_id = session_data["session_id"]
                browser_url = session_data["debug_url"]
                cdp_url = session_data.get("ws_url")  # CDP WebSocket URL from Steel
                fingerprint_injection = session_data.get("fingerprint_injection")  # For CDP re-injection
                session_passwords = session_data.get("passwords", [])
            
            # Init message - include output_schema for FE display
            await save_browser_action_message(
                agent_id=agent_id, title="Browser Ready", task_id=task_id,
                message="", status=MessageStatus.FINISHED, browser_url=browser_url,
                action_type="browser", tool_call_id=tool_call_id, is_init_message=True,
                output_schema=response_schema
            )
            await save_browser_action_message(
                agent_id=agent_id, title="Task Started", task_id=task_id,
                message=goal, status=MessageStatus.FINISHED, browser_url=browser_url,
                action_type="task_started"
            )
        
        # ===== BROWSER-USE SESSION INITIALIZATION =====
        if not cdp_url:
            raise RuntimeError("No CDP URL provided - backend must return ws_url from Steel")
        
        activity.heartbeat(f"Connecting via CDP: {cdp_url[:50]}...")
        
        dom_service = DOMService(cdp_url=cdp_url)
        await dom_service.connect()

        logger.info(f"🌐 Connected to browser via CDP")

        # Initialize humanizer for human-like mouse movements and typing
        # Architecture:
        # - browser-use Page (dom_page): For DOM operations (evaluate, coordinate lookup) - READ ONLY
        # - Playwright Page (input_page): For Input events (mouse, keyboard) - WRITE ONLY
        # These use different CDP domains so no race conditions
        from playwright.async_api import async_playwright

        # Get browser-use Page for DOM operations
        dom_page = await dom_service.session.get_current_page()

        # Create separate Playwright CDP connection for input events
        playwright_instance = await async_playwright().start()
        playwright_browser = await playwright_instance.chromium.connect_over_cdp(cdp_url)
        playwright_context = playwright_browser.contexts[0]
        input_page = playwright_context.pages[0]

        # ===== APPLY FINGERPRINT INJECTION VIA CDP =====
        # CDP settings (Network.setUserAgentOverride, init scripts) don't persist across connections.
        # The backend applied them and closed its connection, so we must re-apply them here.
        if fingerprint_injection:
            from helpers.fingerprint_injection import apply_fingerprint_injection
            injection_success = await apply_fingerprint_injection(input_page, fingerprint_injection)
            if injection_success:
                logger.info("🔐 Applied fingerprint injection via CDP (Sec-CH-UA-Platform, init scripts)")
            else:
                logger.warning("⚠️ Failed to apply fingerprint injection - browser may leak real fingerprint")
        else:
            logger.info("🔐 No fingerprint injection data provided - using Steel defaults")

        # Create humanizer with both pages
        humanizer = BrowserHumanizer(
            dom_page=dom_page,      # browser-use Page for evaluate(), DOM reads
            input_page=input_page,  # Playwright Page for mouse/keyboard input
            fast=False
        )
        logger.info(f"🤖 BrowserHumanizer initialized (browser-use for DOM, Playwright for input)")

        # Initialize cursor at starting position
        await humanizer.initialize_cursor(start_pos=(640, 400))

        # ===== UPLOAD ATTACHMENTS TO STEEL SESSION =====
        available_file_paths: Dict[str, str] = {}  # filename -> remote path
        if attachments:
            logger.info(f"📎 Uploading {len(attachments)} attachments to Steel session")
            from helpers.attachments import download_from_storage

            for fp in attachments:
                try:
                    filename = fp.get("original_filename", "")
                    storage_path = fp.get("storage_path", "")
                    if not filename or not storage_path:
                        logger.warning(f"Skipping invalid attachment: {fp}")
                        continue

                    # Download file from Supabase Storage
                    activity.heartbeat(f"Downloading {filename}...")
                    file_content = await download_from_storage(storage_path)

                    # Upload to Steel session via backend API
                    activity.heartbeat(f"Uploading {filename} to browser session...")
                    async with httpx.AsyncClient(timeout=60.0) as client:
                        response = await client.post(
                            f"{config.backend.api_url}/api/browser-session/{session_id}/files",
                            headers={"x-api-key": config.backend.api_key or ""},
                            files={"file": (filename, file_content, fp.get("mime_type", "application/octet-stream"))}
                        )
                        if response.status_code in [200, 201]:
                            upload_result = response.json()
                            remote_path = upload_result.get("path", f"/tmp/{filename}")
                            available_file_paths[filename] = remote_path
                            logger.info(f"📎 Uploaded {filename} -> {remote_path}")
                        else:
                            logger.error(f"Failed to upload {filename}: HTTP {response.status_code} - {response.text[:200]}")

                except Exception as e:
                    logger.error(f"Failed to upload attachment {fp.get('original_filename', '?')}: {e}")

            if available_file_paths:
                logger.info(f"📎 Available files for browser: {list(available_file_paths.keys())}")

        # Visual cursor is now handled by CursorVisualizer inside BrowserHumanizer
        # It's injected on demand and re-injected on navigation
        
        # ===== HIJACK IMG.SRC TO REPLACE BROWSER-USE LOGO WITH ROSE LOGO =====
        try:
            logo_hijack_script = """
                (() => {
                    const ROSE_LOGO_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjIxIDYyIDIyMCAyMjIiIHdpZHRoPSIyMjAiIGhlaWdodD0iMjIyIj4KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLDMwMykgc2NhbGUoMC4xLC0wLjEpIiBmaWxsPSIjZmZmZmZmIj4KICAgIDxwYXRoIGQ9Ik0xMjc2IDIzNzggYy0xNDUgLTE5MiAtMjMxIC00NDIgLTIxMSAtNjE2IDggLTY4IDQxIC0yMDIgNjEgLTI1MSA4IC0xOSAxMyAtMzUgMTEgLTM3IC0yIC0yIC0zMCA3IC02MiAyMSAtMjQ5IDEwMCAtNTM3IDU0IC03ODQgLTEyNCAtMzYgLTI1IC02OSAtNDkgLTc1IC01MyAtMTcgLTExIDIyIC00NiAxMTkgLTEwNSAxNjMgLTEwMSAzMDAgLTE0NCA0NjAgLTE0NCA5MiAtMSAyMjYgMjQgMzAxIDU2IDIwIDggMzggMTUgMzkgMTUgMiAwIC0xMCAtMzkgLTI1IC04NyAtNjkgLTIxMyAtNTggLTM5NSAzNiAtNjAwIDMxIC02OSAxMzYgLTIzNyAxNTQgLTI0OCAxMCAtNiAxMTQgMTQ0IDE1MiAyMjAgMzcgNzMgNzUgMTk5IDg4IDI5MyAxNCAxMDEgMSAyMDYgLTQwIDMzMCAtMTUgNDggLTI3IDg4IC0yNiA4OSAxIDIgMjYgLTcgNTUgLTE4IDE5NSAtNzQgNDIzIC02NiA2MTEgMjIgOTggNDYgMjE3IDExOCAyNDUgMTQ5IDE4IDIwIDE4IDIxIC0xIDM1IC0xNzcgMTM5IC0zOTYgMjI1IC01NzAgMjI1IC03OSAwIC0xOTUgLTIzIC0yODIgLTU2IC00NCAtMTYgLTYzIC0yMCAtNTkgLTExIDI3IDcyIDYwIDE5NiA2OCAyNjAgMTcgMTMyIC0xNyAzMDAgLTg5IDQ0MiAtMzYgNzIgLTEyNCAyMDkgLTE0MSAyMTkgLTUgNCAtMjEgLTggLTM1IC0yNnogbTQwIC05MzUgYzcgLTQ2IDUwIC05MiAxMDkgLTExOSAyNyAtMTMgNDEgLTIzIDMxIC0yMyAtMTEgLTEgLTM4IC0xMiAtNjIgLTI2IC00OSAtMjkgLTgzIC05MCAtODUgLTE1MSAtMSAtMzcgLTIgLTM2IC05IDEzIC00IDI5IC0xNyA2NyAtMjggODUgLTIyIDM1IC04NiA3NyAtMTE4IDc5IC0xMSAwIDEgOSAyNiAyMCA3OSAzNSAxMTggOTAgMTIxIDE2OCAxIDI1IDMgMjggNiAxMSAyIC0xNCA2IC0zOSA5IC01N3oiLz4KICA8L2c+Cjwvc3ZnPg==';

                    // Only hijack once per context
                    if (window.__roseSrcHijacked) return;
                    window.__roseSrcHijacked = true;

                    // Store original property descriptor
                    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');

                    // Hijack img.src setter to intercept browser-use logo
                    Object.defineProperty(HTMLImageElement.prototype, 'src', {
                        get: function() {
                            return originalDescriptor.get.call(this);
                        },
                        set: function(value) {
                            if (value && typeof value === 'string' && value.includes('browser-use.com')) {
                                value = ROSE_LOGO_URL;
                                this.alt = 'Rose';
                            }
                            return originalDescriptor.set.call(this, value);
                        },
                        enumerable: originalDescriptor.enumerable,
                        configurable: originalDescriptor.configurable
                    });

                    // Also intercept setAttribute('src', ...) calls
                    const originalSetAttribute = Element.prototype.setAttribute;
                    Element.prototype.setAttribute = function(name, value) {
                        if (this instanceof HTMLImageElement && name === 'src' &&
                            value && typeof value === 'string' && value.includes('browser-use.com')) {
                            value = ROSE_LOGO_URL;
                            this.alt = 'Rose';
                        }
                        return originalSetAttribute.call(this, name, value);
                    };
                })();
            """
            # Register for future documents
            await cdp_session.cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
                params={"source": logo_hijack_script, "runImmediately": True},
                session_id=cdp_session.session_id
            )

            # Also run immediately on all existing pages to replace already-loaded logos
            immediate_replace_script = """
                (() => {
                    const ROSE_LOGO_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjIxIDYyIDIyMCAyMjIiIHdpZHRoPSIyMjAiIGhlaWdodD0iMjIyIj4KICA8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLDMwMykgc2NhbGUoMC4xLC0wLjEpIiBmaWxsPSIjZmZmZmZmIj4KICAgIDxwYXRoIGQ9Ik0xMjc2IDIzNzggYy0xNDUgLTE5MiAtMjMxIC00NDIgLTIxMSAtNjE2IDggLTY4IDQxIC0yMDIgNjEgLTI1MSA4IC0xOSAxMyAtMzUgMTEgLTM3IC0yIC0yIC0zMCA3IC02MiAyMSAtMjQ5IDEwMCAtNTM3IDU0IC03ODQgLTEyNCAtMzYgLTI1IC02OSAtNDkgLTc1IC01MyAtMTcgLTExIDIyIC00NiAxMTkgLTEwNSAxNjMgLTEwMSAzMDAgLTE0NCA0NjAgLTE0NCA5MiAtMSAyMjYgMjQgMzAxIDU2IDIwIDggMzggMTUgMzkgMTUgMiAwIC0xMCAtMzkgLTI1IC04NyAtNjkgLTIxMyAtNTggLTM5NSAzNiAtNjAwIDMxIC02OSAxMzYgLTIzNyAxNTQgLTI0OCAxMCAtNiAxMTQgMTQ0IDE1MiAyMjAgMzcgNzMgNzUgMTk5IDg4IDI5MyAxNCAxMDEgMSAyMDYgLTQwIDMzMCAtMTUgNDggLTI3IDg4IC0yNiA4OSAxIDIgMjYgLTcgNTUgLTE4IDE5NSAtNzQgNDIzIC02NiA2MTEgMjIgOTggNDYgMjE3IDExOCAyNDUgMTQ5IDE4IDIwIDE4IDIxIC0xIDM1IC0xNzcgMTM5IC0zOTYgMjI1IC01NzAgMjI1IC03OSAwIC0xOTUgLTIzIC0yODIgLTU2IC00NCAtMTYgLTYzIC0yMCAtNTkgLTExIDI3IDcyIDYwIDE5NiA2OCAyNjAgMTcgMTMyIC0xNyAzMDAgLTg5IDQ0MiAtMzYgNzIgLTEyNCAyMDkgLTE0MSAyMTkgLTUgNCAtMjEgLTggLTM1IC0yNnogbTQwIC05MzUgYzcgLTQ2IDUwIC05MiAxMDkgLTExOSAyNyAtMTMgNDEgLTIzIDMxIC0yMyAtMTEgLTEgLTM4IC0xMiAtNjIgLTI2IC00OSAtMjkgLTgzIC05MCAtODUgLTE1MSAtMSAtMzcgLTIgLTM2IC05IDEzIC00IDI5IC0xNyA2NyAtMjggODUgLTIyIDM1IC04NiA3NyAtMTE4IDc5IC0xMSAwIDEgOSAyNiAyMCA3OSAzNSAxMTggOTAgMTIxIDE2OCAxIDI1IDMgMjggNiAxMSAyIC0xNCA2IC0zOSA5IC01N3oiLz4KICA8L2c+Cjwvc3ZnPg==';

                    // Replace any existing browser-use logos
                    document.querySelectorAll('img').forEach(img => {
                        if (img.src && img.src.includes('browser-use.com')) {
                            img.src = ROSE_LOGO_URL;
                            img.alt = 'Rose';
                        }
                    });
                })();
            """

            # Run on all existing page targets
            try:
                page_targets = await dom_service._session._cdp_get_all_pages()
                for target in page_targets:
                    try:
                        target_id = target.get('targetId')
                        if target_id:
                            temp_session = await dom_service._session.get_or_create_cdp_session(target_id, focus=False)
                            await temp_session.cdp_client.send.Runtime.evaluate(
                                params={"expression": immediate_replace_script},
                                session_id=temp_session.session_id
                            )
                    except Exception:
                        pass  # Skip targets that can't be accessed
            except Exception as e:
                logger.debug(f"Could not replace logos on existing pages: {e}")

            logger.info("🎨 Hijacked img.src to replace browser-use logo with Rose logo")
        except Exception as e:
            logger.warning(f"Failed to replace logo: {e}")
        
        # ===== FETCH USER PROFILE =====
        user_profile = {}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{config.backend.api_url}/api/user-settings",
                    headers={"X-API-Key": config.backend.api_key, "x-user-id": user_id}
                )
                if resp.status_code == 200:
                    user_profile = resp.json()
        except:
            pass
        
        # Build shipping section
        shipping_section = ""
        if user_profile.get("addressLine1"):
            addr_lines = [
                user_profile.get("name", ""),
                user_profile["addressLine1"],
                user_profile.get("addressLine2", ""),
                f"{user_profile.get('city', '')}, {user_profile.get('state', '')} {user_profile.get('postalCode', '')}",
                user_profile.get("country", "United States")
            ]
            shipping_address = "\n".join(line for line in addr_lines if line)
            shipping_section = f"\n\nUSER SHIPPING ADDRESS:\n{shipping_address}\n\nIMPORTANT: During checkout, verify shipping address matches."
        
        # Build autopay section (with reference IDs, not plaintext)
        autopay_section = ""
        encrypted_payment = user_profile.get("encryptedPaymentInformation")
        card_refs: Dict[str, str] = {}  # For type interception
        if encrypted_payment and config.payment.decryption_key:
            payment_data = decrypt_payment_info(encrypted_payment, config.payment.decryption_key)
            if payment_data:
                autopay_limit_cents = payment_data.get("autoagentpaylimit_cents", 0)
                if autopay_limit_cents > 0:
                    autopay_section = build_autopay_prompt_section(payment_data, encrypted_payment)
                    # Store card refs for type interception
                    card_refs = {
                        "card_number": payment_data.get("card_number", ""),
                        "card_name": payment_data.get("cardholder_name", ""),
                        "card_expiry": payment_data.get("card_expiry", ""),
                        "card_cvv": payment_data.get("card_cvv", ""),
                    }
                else:
                    autopay_section = "\n\nPAYMENT AUTHORIZATION:\nAutopay DISABLED. For ALL purchases, use send_message_to_user to get explicit approval."

        # Use passwords from session response (no separate fetch needed)
        passwords_section = ""
        ref_to_encrypted: Dict[str, str] = {}  # short_ref -> encrypted_blob
        password_lookup: Dict[str, Dict[str, str]] = {}  # encrypted -> {origin, username}
        if session_passwords:
            passwords_section, ref_to_encrypted = build_passwords_prompt_section(session_passwords)
            # Build lookup for type interception (encrypted -> origin/username)
            for pwd in session_passwords:
                encrypted = pwd.get("encryptedPassword", "")
                if encrypted:
                    password_lookup[encrypted] = {
                        "origin": pwd.get("origin", ""),
                        "username": pwd.get("username", ""),
                    }
            logger.info(f"Loaded {len(session_passwords)} passwords from session response")

        # Build secret_refs for type interception (short_ref -> decrypted value)
        secret_refs: Dict[str, str] = {}
        password_origins: Dict[str, str] = {}  # short_ref -> origin for validation

        # Add card refs (no decryption needed, we already have the values from payment_data)
        for ref, value in card_refs.items():
            if value:
                secret_refs[ref] = value

        # Add password refs using short refs (decrypt each password)
        # ref_to_encrypted maps: short_ref -> encrypted_blob
        # password_lookup maps: encrypted_blob -> {origin, username}
        # OPTIMIZED: Pre-load RSA key once and decrypt in parallel to avoid blocking
        if config.payment.decryption_key and ref_to_encrypted:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.backends import default_backend

            # Pre-load RSA private key ONCE (was loading 667 times before!)
            private_key_pem = base64.b64decode(config.payment.decryption_key)
            private_key = serialization.load_pem_private_key(
                private_key_pem, password=None, backend=default_backend()
            )
            logger.info(f"Pre-loaded RSA key, decrypting {len(ref_to_encrypted)} passwords in parallel...")

            # Decrypt all passwords in parallel using thread pool
            async def decrypt_one(short_ref: str, encrypted: str) -> tuple[str, Optional[str]]:
                decrypted = await asyncio.to_thread(decrypt_password_with_key, encrypted, private_key)
                return (short_ref, decrypted)

            decrypt_tasks = [
                decrypt_one(short_ref, encrypted)
                for short_ref, encrypted in ref_to_encrypted.items()
            ]
            results = await asyncio.gather(*decrypt_tasks)

            # Process results
            for short_ref, decrypted in results:
                if decrypted:
                    # Map short ref to decrypted value for type interception
                    secret_refs[short_ref] = decrypted
                    # Map short ref to origin for validation
                    encrypted = ref_to_encrypted[short_ref]
                    info = password_lookup.get(encrypted, {})
                    password_origins[short_ref] = info.get("origin", "")

        logger.info(
            "Built secret refs for type interception",
            card_refs_count=len(card_refs),
            password_refs_count=len([k for k in secret_refs if k not in card_refs]),
        )

        # Base custom instructions (static parts - OTP added each iteration)
        base_custom_instructions = (
            "Your browser is in full screen mode. No search bar or navigation bar. "
            "Control+L will NOT focus the address bar - use the goto action to navigate to URLs. "
            "Browser cookies have been injected - assume the user is logged in until proven otherwise. "
            "Avoid login flows unless the site forces you to login to complete your directed goal."
            + shipping_section + autopay_section + passwords_section +
            "\n\nWhen a site offers OTP delivery options, ALWAYS prefer EMAIL over SMS. "
            "SMS OTPs require the user's Mac to be active; email is more reliable."
            "\n\nUse send_message_to_user when you need human help (login, CAPTCHA, payments over limit). "
            "Use attempt_completion tool when the task is done."
        )

        # Model pricing
        model_pricing = await get_model_pricing_with_fallback("rose-1-browser-use")

        # ===== AUTO-NAVIGATE TO START URL =====
        from browser_use.browser.events import NavigateToUrlEvent

        # Auto-add https:// if no scheme provided
        nav_url = start_url
        if not nav_url.startswith(("http://", "https://", "about:", "file:")):
            nav_url = f"https://{nav_url}"
            logger.info(f"🔗 Auto-added https:// to start URL: {nav_url}")

        # Post IN_PROGRESS message
        await save_browser_action_message(
            agent_id=agent_id, title=f"Navigating → {nav_url[:50]}",
            task_id=task_id,
            message="", status=MessageStatus.IN_PROGRESS,
            browser_url=browser_url, action_type="goto", tool_call_id=tool_call_id,
            steps_taken=0, total_steps=25
        )

        # Navigate
        event = dom_service.session.event_bus.dispatch(NavigateToUrlEvent(url=nav_url))
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)

        # Inject localStorage for this origin after navigation
        try:
            from urllib.parse import urlparse
            parsed = urlparse(nav_url)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            async with httpx.AsyncClient(timeout=5.0) as client:
                inject_response = await client.post(
                    f"{config.backend.api_url}/api/browser-session/{session_id}/inject-localStorage",
                    headers={
                        "x-api-key": config.backend.api_key or "",
                        "Content-Type": "application/json"
                    },
                    json={"origin": origin}
                )
                if inject_response.status_code == 200:
                    result_data = inject_response.json()
                    if result_data.get("injected"):
                        logger.info(f"💾 Injected {result_data.get('count', 0)} localStorage entries for {origin}")
                else:
                    logger.warning(f"Failed to inject localStorage: HTTP {inject_response.status_code}")
        except Exception as e:
            logger.warning(f"Failed to inject localStorage for {nav_url}: {e}")

        # Post FINISHED message
        await save_browser_action_message(
            agent_id=agent_id, title=f"Navigated → {nav_url[:50]}",
            task_id=task_id,
            message="", status=MessageStatus.FINISHED,
            browser_url=browser_url, action_type="goto", tool_call_id=tool_call_id,
            steps_taken=0, total_steps=25
        )

        logger.info(f"🌐 Auto-navigated to start URL: {nav_url}")

        # ===== MAIN AGENT LOOP =====
        max_iterations = 25
        iteration = 0

        while iteration < max_iterations:
            iteration += 1
            activity.heartbeat(f"Step {iteration}")

            # 0. Fetch recent OTPs at the start of each iteration
            otp_section = ""
            try:
                otp_section = await fetch_recent_otps(user_id, config.backend.api_url, config.backend.api_key)
            except Exception as e:
                logger.warning("Failed to fetch OTPs", error=str(e))

            # 1. Get current browser state (always includes screenshot)
            browser_state = await dom_service.get_browser_state(include_screenshot=True)
            current_url = browser_state.get("url", "")

            # Track URL changes
            if current_url and (not visited_urls or current_url != visited_urls[-1]):
                visited_urls.append(current_url)

            # 2. Build custom instructions with OTP section (refreshed each iteration)
            custom_instructions = base_custom_instructions
            if otp_section:
                custom_instructions += f"\n\n{otp_section}"

            # 3. Build enriched task from system prompt (single source of truth)
            # This includes: goal, current_url, all custom_instructions (shipping, autopay, passwords, OTP), available_files
            enriched_task = get_browser_system_prompt(
                goal, current_url, custom_instructions,
                available_files=list(available_file_paths.keys()) if available_file_paths else None
            )

            # 4. Call Rose API for next action
            try:
                # Tracing: log last action before Rose API call
                action_entries = action_history.get_entries()
                if action_entries:
                    last = action_entries[-1]
                    logger.info(
                        "🔍 [TRACE] Last action before Rose API",
                        action=last.get("action"),
                        has_thinking=bool(last.get("thinking")),
                        has_screenshot=bool(last.get("screenshot")),
                        thinking_preview=last.get("thinking", "")[:100] if last.get("thinking") else "NONE"
                    )

                llm_result = await call_rose_browser_use(
                    task=enriched_task,
                    browser_state=browser_state,
                    action_history=action_entries,
                    config=config,
                )

                # Track usage from Rose API response
                usage = llm_result.get("usage", {})
                total_input_tokens += usage.get("prompt_tokens", 0)
                total_output_tokens += usage.get("completion_tokens", 0)

            except Exception as e:
                logger.error(f"Rose API call failed: {e}")
                await asyncio.sleep(2)
                continue

            # Extract request_id for downstream logging
            rose_request_id = llm_result.get("request_id", "unknown")

            # 4. Extract action from response
            unified_action = llm_result.get("action", {})
            action_name = unified_action.get("action", "")
            thinking = unified_action.get("thinking", "")
            actual_model = llm_result.get("actual_model", "unknown")
            model_short = actual_model.split('/')[-1] if '/' in actual_model else actual_model
            
            if thinking:
                reasoning_messages.append(thinking)
                # Post thinking as assistant message
                await save_browser_assistant_message(agent_id, thinking, task_id)
            
            # Track action (full detail for error debugging)
            action_summary.append(f"{action_name}: {str(unified_action)[:500]}")
            if len(action_summary) > 20:
                action_summary[:] = action_summary[-20:]
            
            # 5. Handle special actions
            if action_name == "send_message_to_user":
                message = unified_action.get("params", {}).get("message", "")
                reason = unified_action.get("params", {}).get("reason", "other")
                
                logger.info("Browser agent requested user attention", reason=reason)
                
                # Disconnect from browser (session stays alive)
                await dom_service.disconnect()
                
                # Pause session
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        await client.post(
                            f"{config.backend.api_url}/api/browser-session/close",
                            headers={"x-api-key": config.backend.api_key or ""},
                            json={"session_id": session_id, "pause": True, "current_url": current_url}
                        )
                except Exception as e:
                    logger.warning(f"Failed to pause session: {e}")
                
                await save_browser_action_message(
                    agent_id=agent_id, title="Browser Session Paused", task_id=task_id,
                    message=message, status=MessageStatus.FINISHED,
                    browser_url=browser_url, action_type="session_paused"
                )
                
                # Calculate usage
                execution_time_ms = (_safe_time() - start_time) * 1000
                usage_items = [
                    {
                        "type": "llm",
                        "cost_cents": round(
                            (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"] + 
                            (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                            4
                        ),
                        "provider": "Rose 1 Browser Use",
                        "input_tokens": total_input_tokens,
                        "output_tokens": total_output_tokens
                    },
                    {
                        "type": "service",
                        # Steel.dev: $1/hour = 100 cents / 3,600,000 ms
                        "cost_cents": round(execution_time_ms / 36000, 4),
                        "provider": "Steel.dev Browser"
                    }
                ]

                return {
                    "status": "needs_user_help",
                    "message": message,
                    "reason": reason,
                    "task_id": task_id,
                    "session_id": session_id,
                    "browser_url": browser_url,
                    "original_goal": goal,
                    "execution_time_ms": execution_time_ms,
                    "usage_items": usage_items
                }
            
            if action_name in ("attempt_completion", "done"):
                close_reasoning = unified_action.get("params", {}).get("reasoning", "") or unified_action.get("params", {}).get("text", "")
                
                # Don't send task_complete yet - wait for verifier to confirm
                # Run verifier
                verifier_call_id = str(uuid_module.uuid4())
                try:
                    await save_browser_action_message(
                        agent_id=agent_id, title="⚖️ Verifying completion", task_id=task_id,
                        message="", status=MessageStatus.IN_PROGRESS,
                        browser_url=browser_url, action_type="system", tool_call_id=verifier_call_id
                    )
                    
                    # Build verifier context with rich action details
                    # Get last 30 actions with full details
                    action_entries = action_history.get_entries()[-30:]
                    action_details_lines = []
                    for entry in action_entries:
                        step = entry.get("step", "?")
                        action = entry.get("action", "unknown")
                        result = entry.get("result", {})
                        success = result.get("success", False)
                        status = "✅ Success" if success else f"❌ Failed: {result.get('error', 'unknown')}"

                        line = f"Step {step}: {action} - {status}"
                        # NOTE: Intentionally excluding entry["thinking"] - prone to reward hacking
                        params = entry.get("params", {})
                        if params:
                            # Remove verbose data like screenshots
                            display_params = {k: v for k, v in params.items() if k not in ["screenshot", "dom_tree"]}
                            if display_params:
                                line += f"\n  Params: {display_params}"
                        action_details_lines.append(line)
                    
                    actions_text = "\n\n".join(action_details_lines)
                    
                    # Build current page state
                    page_stats = browser_state.get("page_stats", {})
                    scroll_pos = browser_state.get("scroll_position", {})
                    pages_above = scroll_pos.get("pages_above", 0)
                    total_pages = scroll_pos.get("total_pages", 1)
                    
                    page_state = f"""Current Page State:
- URL: {current_url}
- Title: {browser_state.get('title', 'Unknown')}
- Interactive Elements: {page_stats.get('interactive', 0)}
- Scroll Position: Page {pages_above + 1} of {total_pages}"""

                    # List files in session so verifier knows what's been downloaded
                    session_files = await list_session_files(session_id)
                    files_text = "Downloaded Files in Session:\n"
                    if session_files:
                        for f in session_files:
                            files_text += f"  - {f.get('path', 'unknown')} ({f.get('size', 0)} bytes)\n"
                    else:
                        files_text += "  (no files downloaded)\n"

                    # Only expose tool results to verifier, not assistant reasoning
                    # (assistant messages are prone to reward hacking)
                    verifier_context = [
                        # Message 1: USER - Goal
                        {"role": "USER", "text": f"Goal: {goal}"},
                        # Message 2: TOOL - Current page state
                        {"role": "TOOL", "text": page_state, "metadata": {"toolName": "browser_state", "toolStatus": "FINISHED"}},
                        # Message 3: TOOL - Action execution log (last 30)
                        {"role": "TOOL", "text": f"Browser Agent Execution Log ({len(action_entries)} actions shown):\n\n{actions_text}", "metadata": {"toolName": "action_history", "toolStatus": "FINISHED"}},
                        # Message 4: TOOL - Downloaded files in session
                        {"role": "TOOL", "text": files_text, "metadata": {"toolName": "session_files", "toolStatus": "FINISHED"}}
                    ]
                    
                    verifier_prompt = build_verifier_prompt("EXECUTE", f"Goal: {goal}\n\nVerify browser task completion.")

                    # Transform output_schema for remote session: file_pointer -> session_file_pointer
                    # This ensures the verifier only extracts the file path, not full FilePointer metadata
                    remote_session_schema = transform_schema_for_remote_session(response_schema)

                    # Try ultra first with 7s timeout, fallback to lite on timeout
                    try:
                        progress_result = await call_temporal_activity_from_activity(
                            check_progress,
                            args=[verifier_context, verifier_prompt, "rose-labs/rose-1-ultra", "EXECUTE", remote_session_schema],
                            start_to_close_timeout=timedelta(seconds=7),
                        )
                    except TimeoutError:
                        logger.warning("Verifier ultra timeout, falling back to lite")
                        progress_result = await call_temporal_activity_from_activity(
                            check_progress,
                            args=[verifier_context, verifier_prompt, "rose-labs/rose-1-lite", "EXECUTE", remote_session_schema],
                            start_to_close_timeout=timedelta(seconds=15),
                        )
                    
                    v_usage = progress_result.get("usage", {})
                    total_input_tokens += v_usage.get("prompt_tokens", 0)
                    total_output_tokens += v_usage.get("completion_tokens", 0)
                    
                    score = progress_result.get("score", 0.0)
                    v_reasoning = progress_result.get("reasoning", "")
                    
                    await save_browser_action_message(
                        agent_id=agent_id, title=f"⚖️ Progress: {score * 100:.0f}%", task_id=task_id,
                        message=v_reasoning, status=MessageStatus.FINISHED,
                        browser_url=browser_url, action_type="system", tool_call_id=verifier_call_id
                    )
                    
                    if score >= 1.0:
                        # Task complete
                        execution_time_ms = (_safe_time() - start_time) * 1000
                        structured_response = progress_result.get("structured_response")

                        # Extract files from session BEFORE closing (requires active session)
                        # 1. Download all files from Steel and upload to Supabase
                        # Exclude files we uploaded to avoid re-extracting them
                        uploaded_paths = list(available_file_paths.values()) if available_file_paths else []
                        output_files = await extract_session_files(session_id, user_id, config, exclude_paths=uploaded_paths)

                        # 2. Resolve file pointers in structured_response using extracted files
                        if structured_response and output_files:
                            structured_response = resolve_file_pointers_from_extracted(
                                structured_response=structured_response,
                                output_schema=response_schema,
                                extracted_files=output_files,
                            )
                            logger.info(
                                "Resolved file pointers in browser agent response",
                                agent_id=agent_id,
                                file_count=len(output_files)
                            )

                        # Disconnect and close session
                        await dom_service.disconnect()
                        try:
                            async with httpx.AsyncClient(timeout=10.0) as client:
                                await client.post(
                                    f"{config.backend.api_url}/api/browser-session/close",
                                    headers={"x-api-key": config.backend.api_key or ""},
                                    json={"session_id": session_id, "pause": False}
                                )
                        except:
                            pass

                        # Build context summary
                        context_message = build_context_summary(
                            success=True,
                            close_reasoning=close_reasoning,
                            visited_urls=visited_urls,
                            reasoning_messages=reasoning_messages,
                            action_summary=action_summary
                        )

                        # Send task_complete message so FE shows completion card
                        # Use original tool_call_id + is_completion_message to update main chat
                        await save_browser_action_message(
                            agent_id=agent_id,
                            title="✓ Task Completed",
                            task_id=task_id,
                            message=context_message,
                            status=MessageStatus.FINISHED,
                            browser_url=browser_url,
                            action_type="task_complete",
                            tool_call_id=tool_call_id,
                            is_completion_message=True,
                        )

                        usage_items = [
                            {
                                "type": "llm",
                                "cost_cents": round(
                                    (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"] +
                                    (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                                    4
                                ),
                                "provider": "Rose 1 Browser Use",
                                "input_tokens": total_input_tokens,
                                "output_tokens": total_output_tokens
                            },
                            {
                                "type": "service",
                                # Steel.dev: $1/hour = 100 cents / 3,600,000 ms
                                "cost_cents": round(execution_time_ms / 36000, 4),
                                "provider": "Steel.dev Browser"
                            }
                        ]

                        return {
                            "status": "completed",
                            "success": True,
                            "message": context_message,
                            "browser_url": browser_url,
                            "usage_items": usage_items,
                            "execution_time_ms": execution_time_ms,
                            "structured_response": structured_response,
                            "output_files": output_files  # FilePointer dicts for yielding as AssistantEvent
                        }
                    
                    # Not complete - record verifier feedback as thinking for next iteration
                    # This shows up naturally in all model contexts as assistant thinking
                    verifier_feedback_thinking = f"""I just checked in with verifier for the task and it said:
<verifier_response>
Score: {score:.0%}
Reasoning: {v_reasoning}
</verifier_response>

Based on this feedback, I need to continue working on the task and address the issues mentioned."""

                    # Emit thinking to FE so user can see verifier feedback
                    await save_browser_assistant_message(agent_id, verifier_feedback_thinking, task_id)
                    
                    # Emit "Continuing" action to FE
                    continuing_tool_call_id = str(uuid_module.uuid4())
                    await save_browser_action_message(
                        agent_id=agent_id, title="Continuing task...", task_id=task_id,
                        message=f"Verifier score: {score:.0%} - continuing to work on task",
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url, action_type="system", tool_call_id=continuing_tool_call_id
                    )

                    # Get current screenshot for the feedback action (Yutori needs observation/assistant pairs)
                    current_state = await dom_service.get_browser_state(include_screenshot=True)
                    current_screenshot = current_state.get("screenshot")

                    await action_history.record_action(
                        dom_service=dom_service,
                        action="wait",  # Neutral action - processing feedback
                        thinking=verifier_feedback_thinking,
                        result={"success": True, "message": "Verifier feedback processed"},
                        screenshot=current_screenshot  # Include screenshot for Yutori observation/assistant pairs
                    )

                    logger.info(
                        "🔍 [TRACE] Recorded verifier feedback action",
                        step=len(action_history),
                        has_screenshot=bool(current_screenshot),
                        thinking_preview=verifier_feedback_thinking[:200]
                    )
                    
                except Exception as verifier_error:
                    logger.error(f"Verifier failed: {verifier_error}")
                    await save_browser_action_message(
                        agent_id=agent_id, title="⚠️ Verification failed", task_id=task_id,
                        message=f"Error: {str(verifier_error)[:200]}", 
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url, action_type="error", tool_call_id=verifier_call_id
                    )
                
                continue
            
            # 6. Execute regular action
            tool_call_id_action = str(uuid_module.uuid4())
            
            # Build title with human-readable element descriptions
            title_progress = f"{action_name}..."
            title_done = action_name
            
            # Get element description if we have an index
            idx = unified_action.get("index")
            coords = unified_action.get("coordinates")
            element_desc = None
            if idx is not None:
                element = dom_service.selector_map.get(idx)
                if element:
                    element_desc = get_element_description(element)
            
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
                # Redact secrets in display title
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
                title_progress = f"Navigating → {url}"
                title_done = f"Navigated → {url}"
            elif action_name == "scroll":
                direction = unified_action.get("params", {}).get("direction", "down")
                amount = unified_action.get("params", {}).get("amount", 300)
                title_progress = f"Scrolling {direction} {amount}px..."
                title_done = f"Scrolled {direction} {amount}px"
                # Override action_name with direction-specific type for correct icon
                action_name = f"scroll_{direction}"
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

            # Prepend model name to title_done for visibility (dev only)
            # if config.environment != "production":
            #     title_done = f"[{model_short}] {title_done}"

            # Get coordinates for cursor overlay (vision models have coords, index models need lookup)
            coords_for_cursor = coords  # From unified_action.get("coordinates")
            if not coords_for_cursor and idx is not None:
                coord_tuple = await dom_service.get_element_coordinates(idx)
                if coord_tuple:
                    coords_for_cursor = {"x": coord_tuple[0], "y": coord_tuple[1]}

            # Post IN_PROGRESS - use action_name for icon mapping
            await save_browser_action_message(
                agent_id=agent_id, title=title_progress, task_id=task_id,
                message="", status=MessageStatus.IN_PROGRESS,
                browser_url=browser_url, action_type=action_name, tool_call_id=tool_call_id_action,
                steps_taken=iteration, total_steps=max_iterations,
                auxiliary={"coordinates": coords_for_cursor} if coords_for_cursor else None
            )

            # Execute action (with write lock check and humanizer)
            result = await execute_action(
                dom_service, action_history, unified_action, available_file_paths,
                session_id=session_id,
                config=config,
                humanizer=humanizer,
                secret_refs=secret_refs,
                password_origins=password_origins,
                current_url=current_url,
                write_lock_enabled=write_lock_enabled,
                write_lock_approvals=write_lock_approvals,
            )

            # Handle write lock approval request
            if result.get("status") == "needs_write_approval":
                approval_type = result.get("approval_type", "unknown")
                question = result.get("question", "Rose wants to perform a write action. Approve?")

                logger.info(
                    "Write lock approval required",
                    approval_type=approval_type,
                    url=current_url
                )

                # Create attention request and wait for user response
                approval_result = await request_write_lock_approval(
                    agent_id=agent_id,
                    user_id=user_id,
                    workflow_id=task_id,  # Use task_id as workflow_id for browser agent
                    question=question,
                    url=current_url,
                    config=config
                )

                if approval_result.get("approved"):
                    logger.info("Write lock approval granted, recording for domain")

                    # Record approval for this domain (avoids repeated prompts for same type+domain)
                    import time as time_module
                    write_lock_approvals[approval_type] = {
                        "domain": _get_domain_from_url(current_url),
                        "approved_at": time_module.time(),
                    }
                    logger.info(
                        "Write lock approval recorded",
                        approval_type=approval_type,
                        domain=write_lock_approvals[approval_type]["domain"]
                    )

                    # Re-execute the action (approval state will allow it through)
                    result = await execute_action(
                        dom_service, action_history, unified_action, available_file_paths,
                        session_id=session_id,
                        config=config,
                        humanizer=humanizer,
                        secret_refs=secret_refs,
                        password_origins=password_origins,
                        current_url=current_url,
                        write_lock_enabled=write_lock_enabled,
                        write_lock_approvals=write_lock_approvals,
                    )
                else:
                    logger.info("Write lock approval denied by user")
                    await save_browser_action_message(
                        agent_id=agent_id, title="Action blocked by user", task_id=task_id,
                        message=f"User denied permission for {approval_type}",
                        status=MessageStatus.FINISHED,
                        browser_url=browser_url, action_type="system", tool_call_id=tool_call_id_action
                    )
                    # Continue to next iteration - agent will decide what to do
                    continue

            # Post FINISHED - use action_name for icon mapping, include coordinates for cursor ripple
            if result.get("success", True):
                logger.info(f"Action {action_name} successful", agent_id=agent_id, title=title_done, task_id=task_id)
                await save_browser_action_message(
                    agent_id=agent_id, title=title_done, task_id=task_id,
                    message=result.get("message", ""), status=MessageStatus.FINISHED,
                    browser_url=browser_url, action_type=action_name, tool_call_id=tool_call_id_action,
                    steps_taken=iteration, total_steps=max_iterations,
                    auxiliary={"coordinates": coords_for_cursor} if coords_for_cursor else None
                )
            else:
                logger.error(f"Action {action_name} failed",  agent_id=agent_id, title=title_done, task_id=task_id,
                    message=result.get("error", "Failed"), status=MessageStatus.ERROR,
                    browser_url=browser_url, action_type="error", tool_call_id=tool_call_id_action
                )
                await save_browser_action_message(
                    agent_id=agent_id, title=title_done, task_id=task_id,
                    message=result.get("error", "Failed"), status=MessageStatus.ERROR,
                    browser_url=browser_url, action_type="error", tool_call_id=tool_call_id_action,
                    steps_taken=iteration, total_steps=max_iterations,
                    auxiliary={"coordinates": coords_for_cursor} if coords_for_cursor else None
                )
            
            # Small delay between iterations
            await asyncio.sleep(0.5)
        
        # Max iterations reached
        logger.warning(f"Max iterations reached: {max_iterations}")
        
        await dom_service.disconnect()
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    f"{config.backend.api_url}/api/browser-session/close",
                    headers={"x-api-key": config.backend.api_key or ""},
                    json={"session_id": session_id, "pause": False}
                )
        except:
            pass
        
        context_message = build_context_summary(
            success=False,
            close_reasoning=f"Max iterations ({max_iterations}) reached",
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary
        )
        
        # Send task_complete message so FE shows completion card
        # Use original tool_call_id + is_completion_message to update main chat
        await save_browser_action_message(
            agent_id=agent_id,
            title="Task Incomplete - Max Steps Reached",
            task_id=task_id,
            message=context_message,
            status=MessageStatus.FINISHED,
            browser_url=browser_url,
            action_type="task_complete",
            tool_call_id=tool_call_id,
            is_completion_message=True,
        )
        
        execution_time_ms = (_safe_time() - start_time) * 1000
        usage_items = [
            {
                "type": "llm",
                "cost_cents": round(
                    (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"] + 
                    (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                    4
                ),
                "provider": "Rose 1 Browser Use",
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens
            },
            {
                "type": "service",
                # Steel.dev: $1/hour = 100 cents / 3,600,000 ms
                "cost_cents": round(execution_time_ms / 36000, 4),
                "provider": "Steel.dev Browser"
            }
        ]

        return {
            "status": "max_iterations",
            "success": False,
            "message": context_message,
            "browser_url": browser_url,
            "usage_items": usage_items,
            "execution_time_ms": execution_time_ms
        }
        
    except asyncio.CancelledError:
        # Activity was cancelled (user paused the agent)
        logger.info("🔴 Browser agent activity cancelled (paused)")

        # Cleanup - disconnect from browser but keep session alive
        if dom_service:
            try:
                await dom_service.disconnect()
            except:
                pass

        # Pause the session (not close) so it can be resumed
        if session_id:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        f"{config.backend.api_url}/api/browser-session/close",
                        headers={"x-api-key": config.backend.api_key or ""},
                        json={"session_id": session_id, "pause": True, "current_url": current_url}
                    )
            except Exception as e:
                logger.warning(f"Failed to pause session on cancel: {e}")

        # Send task_complete message so FE hides the browser chip
        # Use original tool_call_id + is_completion_message to update main chat
        if task_id:
            try:
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Browser Session Cancelled",
                    task_id=task_id,
                    message="Agent paused by user",
                    status=MessageStatus.FINISHED,
                    browser_url=browser_url or "",
                    action_type="task_complete",
                    tool_call_id=tool_call_id,
                    is_completion_message=True,
                )
            except:
                pass

        # Return cancelled status
        return {
            "status": "cancelled",
            "task_id": task_id,
            "session_id": session_id,
            "browser_url": browser_url,
            "message": "Browser agent cancelled by user"
        }

    except Exception as e:
        logger.error("Browser automation failed", error=extract_error_message(e))

        # Cleanup
        if dom_service:
            try:
                await dom_service.disconnect()
            except:
                pass

        if session_id:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        f"{config.backend.api_url}/api/browser-session/close",
                        headers={"x-api-key": config.backend.api_key or ""},
                        json={"session_id": session_id}
                    )
            except:
                pass

        error_context = f"Failed during: {action_summary[-1] if action_summary else 'initialization'}"
        error_message = build_context_summary(
            success=False,
            close_reasoning=extract_error_message(e),
            visited_urls=visited_urls,
            reasoning_messages=reasoning_messages,
            action_summary=action_summary,
            error_context=error_context
        )

        # Use original tool_call_id + is_completion_message to update main chat
        if task_id:
            try:
                await save_browser_action_message(
                    agent_id=agent_id,
                    title="Task Failed",
                    task_id=task_id,
                    message=error_message,
                    status=MessageStatus.ERROR,
                    browser_url=browser_url or "",
                    action_type="task_complete",
                    tool_call_id=tool_call_id,
                    is_completion_message=True,
                )
            except:
                pass

        raise


# ========================================
# WORKFLOW HELPER & MANAGER
# ========================================

class SpawnBrowserAgentManagerV3(ToolManager):
    """Manager using browser-use BrowserSession + Rose API."""
    
    tool_name = "spawn_browser_agent"
    
    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Spawn browser agent with browser-use + Rose API."""
        start_url = tool_call.get("start_url", "")
        goal = tool_call.get("goal", "")
        output_schema = tool_call.get("output_schema")  # Response schema from parent's tool call
        requested_attachments = tool_call.get("attachments")  # List of filenames from tool call
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id

        # Resolve requested attachments from workflow context
        # TODO: Browser agent attachment support - files need to be made accessible via URL
        attachments = []
        if requested_attachments and hasattr(workflow_instance, 'context'):
            context_attachments = extract_attachments_from_context(workflow_instance.context)
            filename_to_pointer = {fp.original_filename: fp for fp in context_attachments}

            for filename in requested_attachments:
                if filename in filename_to_pointer:
                    fp = filename_to_pointer[filename]
                    attachments.append({
                        "id": fp.id,
                        "storage_path": fp.storage_path,
                        "original_filename": fp.original_filename,
                        "mime_type": fp.mime_type,
                        "size_bytes": fp.size_bytes,
                        "created_at": fp.created_at,
                    })
                else:
                    logger.warning(
                        "[BrowserAgent] Attachment not found in context",
                        agent_id=agent_id,
                        filename=filename,
                        available_files=list(filename_to_pointer.keys())
                    )

        logger.info("Browser agent starting (v3)", goal=goal, has_output_schema=output_schema is not None, num_attachments=len(attachments))

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Starting up a browser",
            message='',
            status=MessageStatus.IN_PROGRESS
        )

        try:
            # Get write_lock_enabled from workflow (defaults to True if not available)
            write_lock_enabled = getattr(workflow_instance, 'write_lock_enabled', True)

            # Start activity with limited retries (expensive/long-running)
            # Args: user_id, agent_id, goal, tool_call_id, task_id, session_id, cdp_url, is_resume, output_schema, attachments, write_lock_enabled, start_url
            activity_handle = workflow.start_activity(
                spawn_browser_agent_activity_v3,
                args=[user_id, agent_id, goal, tool_call_id, None, None, None, False, output_schema, attachments if attachments else None, write_lock_enabled, start_url],
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=120),
                cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # Poll for pause while activity runs
            was_cancelled = False
            while not activity_handle.done():
                if workflow_instance.is_paused:
                    logger.info("🔴 Cancelling browser agent due to pause")
                    activity_handle.cancel()
                    was_cancelled = True
                    break
                await workflow.sleep(1)  # Use workflow.sleep for determinism

            # Get result
            result = None
            try:
                result = await activity_handle
            except (asyncio.CancelledError, ActivityError) as e:
                # Check if it's a cancellation (either direct or wrapped by Temporal)
                if isinstance(e, ActivityError):
                    if not isinstance(e.cause, (asyncio.CancelledError, TemporalCancelledError)):
                        raise  # Re-raise non-cancellation errors
                was_cancelled = True
                result = {"status": "cancelled", "message": "Browser agent cancelled by user"}

            # Handle cancelled
            if was_cancelled or (result and result.get("status") == "cancelled"):
                logger.info("🔴 Browser agent cancelled")
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Browser Session Paused",
                    message="User paused the browser agent",
                    status=MessageStatus.FINISHED,
                    metadata={"action_type": "session_paused"}
                )
                return

            # Build standardized usage for workflow cost tracking
            tool_usage = {"llm": [], "service": []}
            if result.get("usage_items"):
                for item in result["usage_items"]:
                    if item.get("type") == "llm":
                        tool_usage["llm"].append({
                            "tokens_in": item.get("input_tokens", 0),
                            "tokens_out": item.get("output_tokens", 0),
                            "model": item.get("model"),
                            "provider": item.get("provider", ""),
                        })
                    else:
                        tool_usage["service"].append({
                            "cost_cents": item.get("cost_cents", 0),
                            "provider": item.get("provider", ""),
                        })

            # Post output files as separate ASSISTANT messages (like spawn_claude_code)
            output_files = result.get("output_files", [])
            if output_files:
                logger.info(
                    "[BrowserAgent] Posting output files as ASSISTANT messages",
                    agent_id=agent_id,
                    file_count=len(output_files),
                )
                for fp in output_files:
                    yield AssistantEvent(
                        message="",  # Empty text for file-only messages
                        file_pointer=fp,
                    )

            # Yield final result with usage for tracking
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Browser automation complete",
                message=result.get("message", ""),
                status=MessageStatus.FINISHED,
                data={"usage": tool_usage}
            )

        except Exception as e:
            # Let CancelledError propagate - workflow handles it
            if isinstance(e, asyncio.CancelledError):
                raise

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Browser automation failed",
                message=str(e),
                status=MessageStatus.ERROR
            )
            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SpawnBrowserAgentManagerV3] = None


def get_manager() -> SpawnBrowserAgentManagerV3:
    """Get or create spawn_browser_agent manager singleton."""
    global _manager
    if _manager is None:
        _manager = SpawnBrowserAgentManagerV3()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def spawn_browser_agent(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for spawn_browser_agent.

    Spawns an autonomous browser agent with a high-level goal.

    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'goal'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_browser_agent")
        # Track usage from final event (included in data field)
        if event.data and event.data.get("usage"):
            await workflow_instance._track_usage(event.data["usage"], tool_name="spawn_browser_agent")

