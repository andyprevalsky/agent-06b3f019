"""Immutable Rose execution overlays, separate from native artifact identity.

This module is shared by Python 3.11 and 3.12 and imports only the standard
library. Changing any text requires a new version and snapshot approval.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

BASE_PROTOCOL_VERSION = "text-world-model-v3"
BASE_PROTOCOL_SHA256 = "97f84f61fefa7665c18d9fd46253a4f710f5b64f186c19b18a957bd7b8a88122"
BASE_SYSTEM_SHA256 = "acae5f4de354cbd8e0e4753bbbf913a1100b8eeeb7af9ba84ed47f513d1b75ce"
DEFAULT_EXECUTION_POLICY = "upstream"
PUBLIC_AFFORDANCES_POLICY = "rose-virtual-public-affordances-v1"
PUBLIC_AFFORDANCES_VERSION = "1"
PUBLIC_AFFORDANCES_SHA256 = "49d9d1f0430a5d8ee6aaaff9dd8783075a857b9c171e76ebe620a22e9ec7ba79"
PUBLIC_AFFORDANCES_TEXT = """When the delegated tool discovers or inspects public environment content that is not already concretely observed, instantiate plausible virtual pages and affordances consistent with explicit state and history. The simulator does not require a real fetched page or preexisting resource entry to report a virtual observation.

Official, authentic and verified in a delegated goal describe what the virtual agent must observe on virtual pages. Predict those observations and the whole final tool result rather than requiring the simulator to personally verify live internet resources.

A prior bounded failure to find or verify a route is not a global assertion that every page, channel or later discovery lacks one. Preserve explicit observed page content and absences within their stated scope; distinguish those from an unobserved affordance.

Do not guarantee a form or successful action at every site. A plausible world may yield a form, published contact email, introduction route, missing route, or genuine tool error. Respect the instantiated page, required fields, and delegated action.

A simple virtual name/email/message inquiry may be completed with established identities and a truthful message when the delegated goal authorizes it. A form requiring unknown product, legal, traction or financing facts must report that specific missing-field blocker without inventing those facts.

Only completed virtual effects produce matching submission/send receipts and state changes. Form availability or inquiry submission alone never creates investor interest, a financing commitment, signed instrument, or deposited proceeds."""


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ExecutionPolicy:
    name: str
    version: str
    text: str
    effective_system_sha256: str

    def metadata(self) -> dict:
        return {
            "policy_id": self.name,
            "policy_version": self.version,
            "policy_sha256": text_sha256(self.text),
            "base_system_sha256": BASE_SYSTEM_SHA256,
            "effective_system_sha256": self.effective_system_sha256,
        }

    def apply(self, request):
        message = request.messages[0]
        if message.role != "system" or text_sha256(message.content) != BASE_SYSTEM_SHA256:
            raise ValueError("Execution policy requires the exact pinned native base system")
        system = message.content + ("\n\n" + self.text if self.text else "")
        if text_sha256(system) != self.effective_system_sha256:
            raise ValueError("Execution policy text differs from its immutable version")
        if not self.text:
            return request
        return request.model_copy(
            update={"messages": (message.model_copy(update={"content": system}), *request.messages[1:])}
        )


_POLICIES = {
    DEFAULT_EXECUTION_POLICY: ExecutionPolicy(
        DEFAULT_EXECUTION_POLICY,
        "1",
        "",
        BASE_SYSTEM_SHA256,
    ),
    PUBLIC_AFFORDANCES_POLICY: ExecutionPolicy(
        PUBLIC_AFFORDANCES_POLICY,
        PUBLIC_AFFORDANCES_VERSION,
        PUBLIC_AFFORDANCES_TEXT,
        "fcb2596385c9456e62d6e21f3fe1ac6b64b693e833c3e4bb0a78e1f4fe21007f",
    ),
}


def execution_policy(name: str = DEFAULT_EXECUTION_POLICY) -> ExecutionPolicy:
    if name not in _POLICIES:
        raise ValueError("Unknown WMH execution policy; choose an immutable registered version")
    policy = _POLICIES[name]
    if policy.name == PUBLIC_AFFORDANCES_POLICY and text_sha256(policy.text) != PUBLIC_AFFORDANCES_SHA256:
        raise ValueError("WMH execution policy text changed without a new version")
    return policy


def execution_identity(
    policy_name: str,
    world_model_id: str,
    world_model_manifest_sha256: str,
    *,
    base_protocol_sha256: str = BASE_PROTOCOL_SHA256,
) -> dict:
    if base_protocol_sha256 != BASE_PROTOCOL_SHA256:
        raise ValueError("WMH execution policy base protocol identity differs from the pinned runtime")
    if not isinstance(world_model_id, str) or not world_model_id:
        raise ValueError("Execution identity requires a verified native artifact ID")
    if (
        not isinstance(world_model_manifest_sha256, str)
        or len(world_model_manifest_sha256) != 64
        or any(c not in "0123456789abcdef" for c in world_model_manifest_sha256)
    ):
        raise ValueError("Execution identity requires the verified native manifest digest")
    identity = {
        "schema": "rose.wmh_native_execution.v1",
        "base_world_model_id": world_model_id,
        "base_world_model_manifest_sha256": world_model_manifest_sha256,
        "base_protocol_version": BASE_PROTOCOL_VERSION,
        "base_protocol_sha256": base_protocol_sha256,
        **execution_policy(policy_name).metadata(),
    }
    material = json.dumps(identity, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {**identity, "execution_sha256": text_sha256(material)}


def validate_execution_identity(identity: dict, policy_name: str, *, system: str | None = None) -> dict:
    if not isinstance(identity, dict):
        raise ValueError("Missing WMH execution identity")
    expected = execution_identity(
        policy_name, identity.get("base_world_model_id"), identity.get("base_world_model_manifest_sha256")
    )
    if identity != expected:
        raise ValueError("WMH execution identity differs from the selected policy")
    if system is not None and text_sha256(system) != expected["effective_system_sha256"]:
        raise ValueError("WMH system text differs from the declared execution identity")
    return expected


def bind_execution_suite(source: str | Path, output: str | Path, policy_name: str) -> dict:
    source, output = Path(source), Path(output)
    if source.resolve() == output.resolve():
        raise ValueError("Execution binding must preserve the original corpus suite")
    raw = source.read_bytes()
    suite = json.loads(raw)
    if (
        suite.get("schema") != "rose.wmh_conformance_suite.v1"
        or suite.get("status") != "passed"
        or not isinstance(suite.get("examples"), list)
        or not suite["examples"]
        or len(suite["examples"]) != suite.get("requested_examples")
    ):
        raise ValueError("Execution binding requires a complete native conformance suite")
    suite["native_execution_identity"] = execution_identity(
        policy_name, suite.get("native_world_model_id"), suite.get("native_world_model_manifest_sha256")
    )
    suite["native_execution_binding"] = {"source_suite_sha256": hashlib.sha256(raw).hexdigest()}
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=output.name + ".", suffix=".tmp", dir=output.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(suite, handle, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
            handle.write("\n")
        os.replace(name, output)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return suite


def cache_policy_identity(messages: list[dict]) -> dict | None:
    if not messages or messages[0].get("role") != "system":
        return None
    digest = text_sha256(messages[0].get("content", ""))
    for policy in _POLICIES.values():
        if digest == policy.effective_system_sha256:
            return policy.metadata()
    return None
