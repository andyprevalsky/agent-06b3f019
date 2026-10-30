"""Native policy refusal is an unacknowledged credential barrier, not a retry.

Only the caller of the native navigation operation may classify its exception.
No page text, model output, or generic action result can grant this authority.
"""
from __future__ import annotations

import hashlib
from typing import Any
from urllib.parse import urlsplit

_DENIAL = "navigation to a non-public address is blocked"
POLICY_FEEDBACK = (
    "The browser refused this navigation under its network access policy. "
    "Credential setup is not acknowledged. Only goto/open_new_tab to a different "
    "public HTTP(S) page, or switch_tab to a different page, may run until the "
    "new page's credential setup is acknowledged. Current-page interactions "
    "and completion are blocked. The access policy has not been bypassed."
)


def is_native_navigation_policy_denial(error: BaseException) -> bool:
    """Match the structured CDP error at the native navigation await only."""
    if type(error) is not RuntimeError or len(error.args) != 1:
        return False
    payload = error.args[0]
    return (
        type(payload) is dict
        and type(payload.get("code")) is int
        and payload["code"] == -32000
        and payload.get("message") == _DENIAL
    )


def url_digest(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def web_destination(url: Any) -> bool:
    if not isinstance(url, str):
        return False
    try:
        parsed = urlsplit(url)
        return (parsed.scheme in {"http", "https"} and bool(parsed.hostname)
                and parsed.username is None and parsed.password is None)
    except ValueError:
        return False


class NativeNavigationFailure(RuntimeError):
    """A Page.navigate errorText admitted only at its native result await."""


# Exact machine-code contract from browser-use's Page.navigate result adapter.
# Only observed transport failures belong here; policy/HTTP errors, aborted
# navigation, arbitrary parser errors and readiness exceptions do not.
_NAVIGATION_TRANSPORT_FAILURES = {
    "Navigation failed: net::ERR_EMPTY_RESPONSE": "net::ERR_EMPTY_RESPONSE",
    "Navigation failed: net::ERR_CONNECTION_CLOSED": "net::ERR_CONNECTION_CLOSED",
}


def native_navigation_failure(error: BaseException) -> NativeNavigationFailure | None:
    if type(error) is not RuntimeError or len(error.args) != 1 or type(error.args[0]) is not str:
        return None
    code = _NAVIGATION_TRANSPORT_FAILURES.get(error.args[0])
    return NativeNavigationFailure(code) if code is not None else None


class NavigationPolicyBarrier:
    """Keep a denied document's obligation until another bound reload succeeds."""

    checkpoint_key = "navigation_policy_barrier"
    feedback = POLICY_FEEDBACK
    result_code = "native_navigation_policy_denied"
    context_flag = "navigation_policy_restricted"
    title = "Navigation refused by browser policy"
    observation_title = "Navigation policy restriction"
    discard_message = "Native navigation policy refused credential reload."

    def __init__(self, task_id: str, restored: Any = None) -> None:
        self.task_id = task_id
        self._record: dict[str, Any] | None = None
        if restored is not None:
            if (
                type(restored) is not dict
                or set(restored) != {"version", "task_id", "session_id", "target_id", "url_sha256", "denied_url_sha256s"}
                or type(restored.get("version")) is not int
                or restored["version"] != 1
                or restored.get("task_id") != task_id
                or any(not isinstance(restored.get(k), str) or not restored[k]
                       for k in ("task_id", "session_id", "target_id", "url_sha256"))
                or len(restored["url_sha256"]) != 64
                or any(c not in "0123456789abcdef" for c in restored["url_sha256"])
                or type(restored.get("denied_url_sha256s")) is not list
                or not restored["denied_url_sha256s"]
                or any(not isinstance(d, str) or len(d) != 64
                       or any(c not in "0123456789abcdef" for c in d)
                       for d in restored["denied_url_sha256s"])
                or restored["url_sha256"] not in restored["denied_url_sha256s"]
            ):
                raise ValueError("Invalid navigation policy barrier checkpoint")
            self._record = {**restored, "denied_url_sha256s": list(restored["denied_url_sha256s"])}

    @property
    def active(self) -> bool:
        return self._record is not None

    def checkpoint(self) -> dict[str, Any] | None:
        return ({**self._record, "denied_url_sha256s": list(self._record["denied_url_sha256s"])}
                if self._record is not None else None)

    def deny(self, session_id: str, identity: dict[str, Any]) -> None:
        target = identity.get("target_id")
        url = identity.get("url")
        if not session_id or not isinstance(target, str) or not target or not web_destination(url):
            raise ValueError("Native policy denial has no bound document identity")
        denied = list(self._record["denied_url_sha256s"]) if self._record is not None else []
        digest = url_digest(url)
        if digest not in denied:
            denied.append(digest)
        self._record = {
            "version": 1, "task_id": self.task_id, "session_id": session_id,
            "target_id": target, "url_sha256": digest, "denied_url_sha256s": denied,
        }

    def permits_destination(self, url: Any) -> bool:
        return web_destination(url) and (
            self._record is None or url_digest(url) not in self._record["denied_url_sha256s"]
        )

    def acknowledge_other_document(self, identity: dict[str, Any]) -> None:
        if self.active and not self.permits_destination(identity.get("url")):
            raise ValueError("Denied document cannot acknowledge its own policy barrier")
        self._record = None


class NavigationFailureBarrier(NavigationPolicyBarrier):
    """Retain unacknowledged credentials after a typed failed navigation.

    Shares only the restrictive alternate-navigation/ACK protocol with policy
    refusal. A transport failure does not establish a policy denial or provider cause.
    """
    checkpoint_key = "navigation_failure_barrier"
    feedback = (
        "The browser navigation transport failed. Credential "
        "setup is not acknowledged. Only goto/open_new_tab to a different public "
        "HTTP(S) page, or switch_tab to a different page, may run until the new "
        "page's credential setup is acknowledged. Current-page interactions and "
        "completion are blocked. The cause of the transport failure is unknown."
    )
    result_code = "native_navigation_failed"
    context_flag = "navigation_failure_restricted"
    title = "Native navigation failed"
    observation_title = "Native navigation failed"
    discard_message = "Native navigation failed; credential reload remains unacknowledged."


def restore_navigation_barrier(task_id: str, runtime: dict[str, Any]) -> NavigationPolicyBarrier:
    policy = runtime.get(NavigationPolicyBarrier.checkpoint_key)
    failure = runtime.get(NavigationFailureBarrier.checkpoint_key)
    if policy is not None and failure is not None:
        raise ValueError("Conflicting navigation barrier checkpoints")
    if NavigationFailureBarrier.checkpoint_key in runtime and failure is None:
        raise ValueError("Invalid failed-navigation barrier checkpoint")
    if failure is not None:
        return NavigationFailureBarrier(task_id, failure)
    return NavigationPolicyBarrier(task_id, policy)
