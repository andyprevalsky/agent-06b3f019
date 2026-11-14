"""Realm-scoped credential hydration for browser-agent sessions.

The backend owns selection/injection of browser state. This module owns the
worker-only half: decrypting password/passkey material, creating secret refs,
and producing safe auth inventory for genuine browser tool results.
"""

from __future__ import annotations

import asyncio
import base64
import copy
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization

from .service import AuthRuntimeState
from .service_crypto import build_auth_options_prompt_section, decrypt_password_with_key


@dataclass
class RealmCredentialState:
    auth_realm: str
    auth_options: Dict[str, Any]
    auth_options_section: str
    password_secret_refs: Dict[str, str]
    password_origins: Dict[str, str]
    credential_refs_by_secret_ref: Dict[str, Dict[str, str]]
    auth_runtime_state: AuthRuntimeState
    decrypted_passkeys: list[Dict[str, Any]]
    passkey_ref_by_credential_id: Dict[str, Dict[str, str]]
    auth_credential_ref: Optional[Dict[str, str]]


def unknown_realm_credential_state(auth_realm: str) -> RealmCredentialState:
    """Invalidate active secrets without claiming discovery found no options."""
    options = {"realm": auth_realm}
    return RealmCredentialState(
        auth_realm=auth_realm, auth_options=options, auth_options_section="",
        password_secret_refs={}, password_origins={}, credential_refs_by_secret_ref={},
        auth_runtime_state=AuthRuntimeState.from_auth_options(options),
        decrypted_passkeys=[], passkey_ref_by_credential_id={}, auth_credential_ref=None,
    )


def _enabled_ids(items: list[Dict[str, Any]]) -> set[str]:
    return {str(item.get("id")) for item in items if item.get("id") and not item.get("disabled")}


async def build_realm_credential_state(
    payload: Dict[str, Any],
    *,
    decryption_key: Optional[str],
    decrypt_secret: Callable[[str, Any], Optional[str]] = decrypt_password_with_key,
    target_url: Optional[str] = None,
) -> RealmCredentialState:
    """Hydrate a complete realm or explicit neutral inventory without partial auth."""
    auth_options = copy.deepcopy(payload.get("auth_options") or {})
    auth_realm = str(payload.get("auth_realm") or auth_options.get("realm") or "")
    if not auth_realm:
        # The neutral initializer owns this exact empty inventory. Do not
        # accept incomplete web-realm payloads or retain any prior secrets.
        neutral_options = {
            "realm": "", "steel_session": None, "cookie_bundles": [],
            "passwords": [], "passkeys": [],
            "email_otp": {"available": False, "connected_emails": [], "match_for_site_account": None},
            "readable_identifiers": [], "minted": None,
        }
        if (
            target_url == "about:blank"
            and payload.get("auth_realm") == ""
            and auth_options == neutral_options
            and payload.get("passwords") == []
            and payload.get("passkeys") == []
            and payload.get("auth_credential_ref") is None
        ):
            return RealmCredentialState(
                auth_realm="", auth_options=auth_options, auth_options_section="",
                password_secret_refs={}, password_origins={}, credential_refs_by_secret_ref={},
                auth_runtime_state=AuthRuntimeState.from_auth_options(auth_options),
                decrypted_passkeys=[], passkey_ref_by_credential_id={}, auth_credential_ref=None,
            )
        raise RuntimeError("Credential payload is missing auth_realm")
    auth_options["realm"] = auth_realm

    # Disabled credentials are diagnostic history, not attemptable browser state.
    auth_options["passwords"] = [item for item in (auth_options.get("passwords") or []) if not item.get("disabled")]
    session_passwords = payload.get("passwords") or []
    session_passkeys = payload.get("passkeys") or []
    (
        auth_options_section,
        encrypted_password_refs,
        password_origins,
        credential_refs_by_secret_ref,
    ) = build_auth_options_prompt_section(auth_options, session_passwords)

    enabled_password_ids = _enabled_ids(auth_options.get("passwords") or [])
    available_password_ids = {
        ref["id"] for ref in credential_refs_by_secret_ref.values() if ref.get("kind") == "password" and ref.get("id")
    }
    missing_password_ids = enabled_password_ids - available_password_ids
    if missing_password_ids:
        raise RuntimeError(
            f"Credential payload for {auth_realm} is missing password material: {sorted(missing_password_ids)}"
        )

    enabled_passkey_ids = _enabled_ids(auth_options.get("passkeys") or [])
    session_passkey_ids = {str(item.get("id")) for item in session_passkeys if item.get("id")}
    missing_passkey_ids = enabled_passkey_ids - session_passkey_ids
    if missing_passkey_ids:
        raise RuntimeError(
            f"Credential payload for {auth_realm} is missing passkey material: {sorted(missing_passkey_ids)}"
        )

    needs_private_key = bool(encrypted_password_refs or session_passkeys)
    if needs_private_key and not decryption_key:
        raise RuntimeError(f"Credential decryption key is unavailable for {auth_realm}")

    private_key = None
    if needs_private_key:
        try:
            private_key = serialization.load_pem_private_key(
                base64.b64decode(decryption_key or ""),
                password=None,
                backend=default_backend(),
            )
        except Exception as error:
            raise RuntimeError(f"Credential decryption key is invalid for {auth_realm}") from error

    async def decrypt_required(label: str, encrypted: str) -> str:
        decrypted = await asyncio.to_thread(decrypt_secret, encrypted, private_key)
        if not decrypted:
            raise RuntimeError(f"Failed to decrypt {label} for {auth_realm}")
        return decrypted

    password_secret_refs: Dict[str, str] = {}
    if encrypted_password_refs:
        decrypted_passwords = await asyncio.gather(
            *[
                decrypt_required(f"password ref {secret_ref}", encrypted)
                for secret_ref, encrypted in encrypted_password_refs.items()
            ]
        )
        password_secret_refs = dict(zip(encrypted_password_refs, decrypted_passwords))

    decrypted_passkeys: list[Dict[str, Any]] = []
    passkey_ref_by_credential_id: Dict[str, Dict[str, str]] = {}
    if session_passkeys:
        decrypted_private_keys = await asyncio.gather(
            *[
                decrypt_required(
                    f"passkey {passkey.get('id') or passkey.get('credentialId')}",
                    str(passkey.get("encryptedPrivateKey") or ""),
                )
                for passkey in session_passkeys
            ]
        )
        for source, private_key_value in zip(session_passkeys, decrypted_private_keys):
            credential_id = source.get("credentialId")
            rp_id = source.get("rpId")
            credential_row_id = source.get("id")
            if not credential_id or not rp_id or not credential_row_id:
                raise RuntimeError(f"Passkey payload for {auth_realm} is incomplete")
            decrypted_passkeys.append(
                {
                    "credentialId": credential_id,
                    "privateKey": private_key_value,
                    "rpId": rp_id,
                    "userHandle": source.get("userHandle"),
                    "signCount": source.get("signCount") or 0,
                }
            )
            passkey_ref_by_credential_id[str(credential_id)] = {
                "kind": "passkey",
                "id": str(credential_row_id),
            }

    auth_runtime_state = AuthRuntimeState.from_auth_options(auth_options)
    auth_runtime_state.restrict_password_ids_to_attemptable(available_password_ids)

    credential_ref = payload.get("auth_credential_ref")
    return RealmCredentialState(
        auth_realm=auth_realm,
        auth_options=auth_options,
        auth_options_section=auth_options_section,
        password_secret_refs=password_secret_refs,
        password_origins=password_origins,
        credential_refs_by_secret_ref=credential_refs_by_secret_ref,
        auth_runtime_state=auth_runtime_state,
        decrypted_passkeys=decrypted_passkeys,
        passkey_ref_by_credential_id=passkey_ref_by_credential_id,
        auth_credential_ref=credential_ref if isinstance(credential_ref, dict) else None,
    )


class OwnedCredentialTasks:
    """Activity-local credential work; no task may outlive its browser owner."""

    def __init__(self) -> None:
        self.tasks: set[asyncio.Task] = set()
        self.closed = False
        self.control_error: Optional[BaseException] = None
        self.status: Dict[str, str] = {}
        self.latest: Dict[str, asyncio.Task] = {}

    def check(self) -> None:
        if self.control_error is not None:
            raise self.control_error

    def start(self, work: Callable[[], Any], *, label: Optional[str] = None) -> Optional[asyncio.Task]:
        self.check()
        if self.closed or len(self.tasks) >= 8:
            if label:
                self.status[label] = "error"
            return None
        task = asyncio.create_task(work())
        self.tasks.add(task)
        if label:
            self.status[label] = "pending"
            self.latest[label] = task
        def done(finished: asyncio.Task) -> None:
            self.tasks.discard(finished)
            if label and self.latest.get(label) is finished:
                self.status[label] = "error" if finished.cancelled() or finished.exception() is not None else "ready"
            if not finished.cancelled():
                error = finished.exception()
                if error is not None:
                    from helpers.workflow_generation import WorkflowGenerationSealed
                    if isinstance(error, WorkflowGenerationSealed):
                        self.control_error = error
        task.add_done_callback(done)
        return task

    async def close(self) -> None:
        self.closed = True
        pending = tuple(self.tasks)
        if pending:
            # A short terminal grace period lets already-issued uploads settle;
            # browser execution never joins them. Only this owner's tasks count.
            try:
                _, unfinished = await asyncio.wait(pending, timeout=1)
            finally:
                # Cancellation of the owner during its grace period must still
                # cancel its own work, never somebody else's loop tasks.
                for task in pending:
                    if not task.done():
                        task.cancel()
            if unfinished:
                await asyncio.wait(unfinished, timeout=0.1)


class AsyncCredentialPreparation:
    """Single current session/realm, immediate status reads, no polling waits."""

    def __init__(self, owner: OwnedCredentialTasks, prepare: Callable[..., Any]) -> None:
        self.owner, self.prepare = owner, prepare
        self.scope: Any = None
        self.task: Optional[asyncio.Task] = None
        self.state: Dict[str, Any] = {}
        self.revision = 0

    def invalidate(self) -> None:
        self.revision += 1
        self.scope = None
        self.state = {}
        if self.task is not None and not self.task.done():
            self.task.cancel()
        self.task = None

    def request(self, url: str, scope: Any, realm: str) -> Dict[str, Any]:
        self.owner.check()
        if scope != self.scope:
            self.invalidate()
            self.scope = scope
            self.state = {"auth_realm": realm, "credential_preparation_status": "pending"}
            revision = self.revision
            def current() -> bool:
                return not self.owner.closed and revision == self.revision and scope == self.scope
            async def run() -> None:
                from helpers.workflow_generation import WorkflowGenerationSealed
                try:
                    result = await self.prepare(url, current)
                except (asyncio.CancelledError, WorkflowGenerationSealed):
                    raise
                except Exception:
                    if current():
                        # Provider/decryption exceptions can contain secret values.
                        self.state = {"auth_realm": realm, "credential_preparation_status": "error",
                                      "credential_preparation_error": "Saved credential preparation failed"}
                else:
                    if current():
                        self.state = {"auth_realm": realm, "credential_preparation_status": "ready"}
                        if isinstance(result, dict):
                            for key in ("cookies_injected", "cookie_count", "password_count", "passkey_count",
                                        "passkeys_newly_injected"):
                                value = result.get(key)
                                if (key == "cookies_injected" and type(value) is bool
                                        or key != "cookies_injected" and type(value) is int and value >= 0):
                                    self.state[key] = value
                            if result.get("credential_preparation_error"):
                                self.state.update(credential_preparation_status="error",
                                                  credential_preparation_error="Saved credential preparation failed")
            self.task = self.owner.start(run)
            if self.task is None:
                self.state.update(credential_preparation_status="error",
                                  credential_preparation_error="Saved credential preparation unavailable")
        return dict(self.state)


def missing_credential_reference(value: Any, available: Dict[str, str]) -> bool:
    """Never type an unresolved private-reference placeholder into a page."""
    import re
    if isinstance(value, str):
        references = re.findall(r"\{\{secret:([^{}]+)\}\}", value)
        if (value.startswith("pwd:") and not any(char.isspace() for char in value)
                or value in {"card_number", "card_name", "card_expiry", "card_cvv"}):
            references.append(value)
        return any(ref not in available for ref in references)
    if isinstance(value, dict):
        return any(missing_credential_reference(item, available) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(missing_credential_reference(item, available) for item in value)
    return False
