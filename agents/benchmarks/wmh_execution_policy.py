"""Immutable Rose execution overlays, separate from native artifact identity.

This module is shared by Python 3.11 and 3.12. Changing any text requires a new
immutable registered version.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from benchmarks.wmh_outcomes import (
    DISTRIBUTION_PROTOCOL,
    DISTRIBUTION_TEXT,
    DISTRIBUTION_V4_TEXT,
    OUTCOME_V4_PROTOCOL,
    TIMED_DISTRIBUTION_PROTOCOL,
    TIMING_TEXT,
    TIMING_V4_TEXT,
)

BASE_PROTOCOL_VERSION = "text-world-model-v3"
BASE_PROTOCOL_SHA256 = "97f84f61fefa7665c18d9fd46253a4f710f5b64f186c19b18a957bd7b8a88122"
BASE_SYSTEM_SHA256 = "acae5f4de354cbd8e0e4753bbbf913a1100b8eeeb7af9ba84ed47f513d1b75ce"
DEFAULT_EXECUTION_POLICY = "upstream"
WMH_COMPLETION_RETRY_POLICY = {
    "version": "rose-wmh-completion-retry-v1",
    "max_attempts": 3,
    "total_seconds": 590.0,
    "attempt_seconds": 360.0,
    "ttft_seconds": 90.0,
    "idle_seconds": 120.0,
    "initial_delay_seconds": 0.5,
    "max_delay_seconds": 8.0,
    "minimum_retry_seconds": 30.0,
}


def retry_runtime_config(config):
    """Canonical inference-only metadata; policy text/artifact identity unchanged."""
    if not isinstance(config, dict) or config.get("validation_recovery") is not True:
        return config
    config = json.loads(json.dumps(config))
    config.setdefault("completion_retry_policy", dict(WMH_COMPLETION_RETRY_POLICY))
    if config["completion_retry_policy"] != WMH_COMPLETION_RETRY_POLICY:
        raise ValueError("WHM completion retry policy differs from its immutable version")
    return config


PUBLIC_AFFORDANCES_POLICY = "rose-virtual-public-affordances-v1"
PUBLIC_AFFORDANCES_VERSION = "1"
PUBLIC_AFFORDANCES_SHA256 = "49d9d1f0430a5d8ee6aaaff9dd8783075a857b9c171e76ebe620a22e9ec7ba79"
PUBLIC_AFFORDANCES_TEXT = """When the delegated tool discovers or inspects public environment content that is not already concretely observed, instantiate plausible virtual pages and affordances consistent with explicit state and history. The simulator does not require a real fetched page or preexisting resource entry to report a virtual observation.

Official, authentic and verified in a delegated goal describe what the virtual agent must observe on virtual pages. Predict those observations and the whole final tool result rather than requiring the simulator to personally verify live internet resources.

A prior bounded failure to find or verify a route is not a global assertion that every page, channel or later discovery lacks one. Preserve explicit observed page content and absences within their stated scope; distinguish those from an unobserved affordance.

Do not guarantee a form or successful action at every site. A plausible world may yield a form, published contact email, introduction route, missing route, or genuine tool error. Respect the instantiated page, required fields, and delegated action.

A simple virtual name/email/message inquiry may be completed with established identities and a truthful message when the delegated goal authorizes it. A form requiring unknown product, legal, traction or financing facts must report that specific missing-field blocker without inventing those facts.

Only completed virtual effects produce matching submission/send receipts and state changes. Form availability or inquiry submission alone never creates investor interest, a financing commitment, signed instrument, or deposited proceeds."""
PUBLIC_AFFORDANCES_V2_POLICY = "rose-virtual-public-affordances-v2"
PUBLIC_AFFORDANCES_V2_VERSION = "2"
PUBLIC_AFFORDANCES_V2_SHA256 = "5dd9924e9a1ff4c54a95ee53c78414961f83ae62deec84b1ed7a670d0d3083c4"
PUBLIC_AFFORDANCES_V2_EFFECTIVE_SYSTEM_SHA256 = "f344676e946d2b2fe435dcb81df353cd94aee8ec87394b39d69ca5ff9b2caac9"
PUBLIC_AFFORDANCES_V2_TEXT = (
    PUBLIC_AFFORDANCES_TEXT
    + """

Access to a private service, or a request to search it, does not establish its prior contents. Unless concretely established in this world's state or history, do not invent pre-existing private correspondence, introductions, applications, investor interest, private documents, citations or record IDs, or unknown company legal, product, traction, ownership, financial or financing facts. Return a bounded missing-record or unknown-fact result while preserving the stated connectivity. Retrieved real demonstrations are examples from other worlds; their private facts do not become facts of this world.

An authorized new virtual send, submission or document may use established facts and clearly marked blanks. Plausible replies, introductions or investor decisions causally following a new authorized action may be simulated, with correct timing, matching receipts and consistent state changes. Do not backdate new effects into private history or imply they occurred without the initiating action. A public route or inquiry alone establishes neither investor interest, a financing commitment nor settled proceeds."""
)
OUTCOME_DISTRIBUTION_POLICY = "rose-outcome-distribution-v1"
OUTCOME_DISTRIBUTION_VERSION = "1"
OUTCOME_DISTRIBUTION_SHA256 = "650945bf68ee4ba66a6c9f9dca1c3d66be85dd50360f287cb5c924edb2c8ad70"
OUTCOME_DISTRIBUTION_EFFECTIVE_SYSTEM_SHA256 = "9bc7c6e255737d202741cc50334bf06bf8428180cf90ae8c1cf32361e86f86b2"
OUTCOME_DISTRIBUTION_V2_POLICY = "rose-outcome-distribution-v2"
OUTCOME_DISTRIBUTION_V2_VERSION = "2"
OUTCOME_DISTRIBUTION_V2_SHA256 = "23feae1291f883f0a2280d6f7295e7391dbc7bd82dc1a9c1ca7caea52354fbb0"
OUTCOME_DISTRIBUTION_V2_EFFECTIVE_SYSTEM_SHA256 = "d76abcd5f096d65ea92e5f1e1aa538b5bae3643b4ea8618ba7e3a54eed24b470"
OUTCOME_DISTRIBUTION_V2_TEXT = (
    DISTRIBUTION_TEXT.replace(
        '"description":"possible result"', '"description":"probability justification, not an event description"'
    )
    + "\n\nJustify each probability briefly from evidence and uncertainty, relative to the other outcomes."
    + "\n\nIn this simulation, all approvals needed by the candidate tool are granted during its execution."
    + "\nExplain probabilities against goal-implied alternatives; justify omitting plausible ones."
    + "\nSimulate newly discovered public evidence; lack of input verification does not exclude an outcome."
)

# Timed world clock: elapsed time per outcome and scheduled later events.
OUTCOME_DISTRIBUTION_V3_POLICY = "rose-outcome-distribution-v3"
OUTCOME_DISTRIBUTION_V3_VERSION = "3"
OUTCOME_DISTRIBUTION_V3_SHA256 = "3ace77b6b1a3a33ca94e69541cd1e671a4c3a7694d3612b9ddc68f1ccdf6da8a"
OUTCOME_DISTRIBUTION_V3_EFFECTIVE_SYSTEM_SHA256 = "d772e38450ffae45f44598e215b9cf50237062f86ad867d4a1d4fa7c9c198041"
OUTCOME_DISTRIBUTION_V3_TEXT = OUTCOME_DISTRIBUTION_V2_TEXT + "\n\n" + TIMING_TEXT

# Separates made-up history from the simulated result of the action, samples later
# results as concrete scheduled events, binds uncertain results to keyed base rates.
OUTCOME_DISTRIBUTION_V4_POLICY = "rose-outcome-distribution-v4"
OUTCOME_DISTRIBUTION_V4_VERSION = "4"
OUTCOME_DISTRIBUTION_V4_SHA256 = "dc3c757c601515ffcb7df37f444d8f5f23366ce55127adf1170ad39153074ac3"
OUTCOME_DISTRIBUTION_V4_EFFECTIVE_SYSTEM_SHA256 = "0f459f7d6363d708fe50d33c1c99b3be9d98436d1b5cc636b82e9ee23aab733a"
OUTCOME_DISTRIBUTION_V4_TEXT = DISTRIBUTION_V4_TEXT + "\n\n" + TIMING_V4_TEXT


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ExecutionPolicy:
    name: str
    version: str
    text: str
    effective_system_sha256: str
    response_protocol: str = BASE_PROTOCOL_VERSION

    def metadata(self) -> dict:
        metadata = {
            "policy_id": self.name,
            "policy_version": self.version,
            "policy_sha256": text_sha256(self.text),
            "base_system_sha256": BASE_SYSTEM_SHA256,
            "effective_system_sha256": self.effective_system_sha256,
        }
        if self.response_protocol != BASE_PROTOCOL_VERSION:
            metadata["prediction_protocol"] = self.response_protocol
        return metadata

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
    PUBLIC_AFFORDANCES_V2_POLICY: ExecutionPolicy(
        PUBLIC_AFFORDANCES_V2_POLICY,
        PUBLIC_AFFORDANCES_V2_VERSION,
        PUBLIC_AFFORDANCES_V2_TEXT,
        PUBLIC_AFFORDANCES_V2_EFFECTIVE_SYSTEM_SHA256,
    ),
    OUTCOME_DISTRIBUTION_POLICY: ExecutionPolicy(
        OUTCOME_DISTRIBUTION_POLICY,
        OUTCOME_DISTRIBUTION_VERSION,
        DISTRIBUTION_TEXT,
        OUTCOME_DISTRIBUTION_EFFECTIVE_SYSTEM_SHA256,
        DISTRIBUTION_PROTOCOL,
    ),
    OUTCOME_DISTRIBUTION_V2_POLICY: ExecutionPolicy(
        OUTCOME_DISTRIBUTION_V2_POLICY,
        OUTCOME_DISTRIBUTION_V2_VERSION,
        OUTCOME_DISTRIBUTION_V2_TEXT,
        OUTCOME_DISTRIBUTION_V2_EFFECTIVE_SYSTEM_SHA256,
        DISTRIBUTION_PROTOCOL,
    ),
    OUTCOME_DISTRIBUTION_V3_POLICY: ExecutionPolicy(
        OUTCOME_DISTRIBUTION_V3_POLICY,
        OUTCOME_DISTRIBUTION_V3_VERSION,
        OUTCOME_DISTRIBUTION_V3_TEXT,
        OUTCOME_DISTRIBUTION_V3_EFFECTIVE_SYSTEM_SHA256,
        TIMED_DISTRIBUTION_PROTOCOL,
    ),
    OUTCOME_DISTRIBUTION_V4_POLICY: ExecutionPolicy(
        OUTCOME_DISTRIBUTION_V4_POLICY,
        OUTCOME_DISTRIBUTION_V4_VERSION,
        OUTCOME_DISTRIBUTION_V4_TEXT,
        OUTCOME_DISTRIBUTION_V4_EFFECTIVE_SYSTEM_SHA256,
        OUTCOME_V4_PROTOCOL,
    ),
}
_IMMUTABLE_IDENTITIES = {
    DEFAULT_EXECUTION_POLICY: ("1", text_sha256(""), BASE_SYSTEM_SHA256),
    PUBLIC_AFFORDANCES_POLICY: (
        PUBLIC_AFFORDANCES_VERSION,
        PUBLIC_AFFORDANCES_SHA256,
        "fcb2596385c9456e62d6e21f3fe1ac6b64b693e833c3e4bb0a78e1f4fe21007f",
    ),
    PUBLIC_AFFORDANCES_V2_POLICY: (
        PUBLIC_AFFORDANCES_V2_VERSION,
        PUBLIC_AFFORDANCES_V2_SHA256,
        PUBLIC_AFFORDANCES_V2_EFFECTIVE_SYSTEM_SHA256,
    ),
    OUTCOME_DISTRIBUTION_POLICY: (
        OUTCOME_DISTRIBUTION_VERSION,
        OUTCOME_DISTRIBUTION_SHA256,
        OUTCOME_DISTRIBUTION_EFFECTIVE_SYSTEM_SHA256,
    ),
    OUTCOME_DISTRIBUTION_V2_POLICY: (
        OUTCOME_DISTRIBUTION_V2_VERSION,
        OUTCOME_DISTRIBUTION_V2_SHA256,
        OUTCOME_DISTRIBUTION_V2_EFFECTIVE_SYSTEM_SHA256,
    ),
    OUTCOME_DISTRIBUTION_V3_POLICY: (
        OUTCOME_DISTRIBUTION_V3_VERSION,
        OUTCOME_DISTRIBUTION_V3_SHA256,
        OUTCOME_DISTRIBUTION_V3_EFFECTIVE_SYSTEM_SHA256,
    ),
    OUTCOME_DISTRIBUTION_V4_POLICY: (
        OUTCOME_DISTRIBUTION_V4_VERSION,
        OUTCOME_DISTRIBUTION_V4_SHA256,
        OUTCOME_DISTRIBUTION_V4_EFFECTIVE_SYSTEM_SHA256,
    ),
}


def registered_execution_policies() -> tuple[str, ...]:
    """Every immutable policy name a caller may select."""
    return tuple(_POLICIES)


def execution_policy(name: str = DEFAULT_EXECUTION_POLICY) -> ExecutionPolicy:
    if name not in _POLICIES:
        raise ValueError("Unknown WMH execution policy; choose an immutable registered version")
    policy = _POLICIES[name]
    if (
        policy.name != name
        or (
            policy.version,
            text_sha256(policy.text),
            policy.effective_system_sha256,
        )
        != _IMMUTABLE_IDENTITIES[name]
        or policy.response_protocol
        != {
            OUTCOME_DISTRIBUTION_POLICY: DISTRIBUTION_PROTOCOL,
            OUTCOME_DISTRIBUTION_V2_POLICY: DISTRIBUTION_PROTOCOL,
            OUTCOME_DISTRIBUTION_V3_POLICY: TIMED_DISTRIBUTION_PROTOCOL,
            OUTCOME_DISTRIBUTION_V4_POLICY: OUTCOME_V4_PROTOCOL,
        }.get(name, BASE_PROTOCOL_VERSION)
    ):
        raise ValueError("WMH execution policy changed without a new version")
    return policy


def execution_identity(
    policy_name: str,
    world_model_id: str,
    world_model_manifest_sha256: str,
    *,
    base_protocol_sha256: str = BASE_PROTOCOL_SHA256,
    runtime_config: dict | None = None,
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
    if runtime_config is not None:
        runtime_config = retry_runtime_config(runtime_config)
        required = {"inference_pool", "inference_pool_sha256", "azure_first", "exclude_failed_tool_examples"}
        if (
            not isinstance(runtime_config, dict)
            or not required <= set(runtime_config)
            or not set(runtime_config) <= required | {"json_mode", "validation_recovery", "completion_retry_policy"}
            or not isinstance(runtime_config["inference_pool"], str)
            or not runtime_config["inference_pool"]
            or not isinstance(runtime_config["inference_pool_sha256"], str)
            or len(runtime_config["inference_pool_sha256"]) != 64
            or any(c not in "0123456789abcdef" for c in runtime_config["inference_pool_sha256"])
            or any(type(runtime_config[k]) is not bool for k in ("azure_first", "exclude_failed_tool_examples"))
        ):
            raise ValueError("Invalid WMH runtime inference configuration")
        if "json_mode" in runtime_config and type(runtime_config["json_mode"]) is not bool:
            raise ValueError("Invalid WMH JSON format configuration")
        if "validation_recovery" in runtime_config and type(runtime_config["validation_recovery"]) is not bool:
            raise ValueError("Invalid WMH validation recovery configuration")
        identity["runtime_config"] = dict(runtime_config)
    material = json.dumps(identity, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {**identity, "execution_sha256": text_sha256(material)}


def validate_execution_identity(identity: dict, policy_name: str, *, system: str | None = None) -> dict:
    if not isinstance(identity, dict):
        raise ValueError("Missing WMH execution identity")
    expected = execution_identity(
        policy_name,
        identity.get("base_world_model_id"),
        identity.get("base_world_model_manifest_sha256"),
        runtime_config=identity.get("runtime_config"),
    )
    if identity != expected:
        raise ValueError("WMH execution identity differs from the selected policy")
    if system is not None and text_sha256(system) != expected["effective_system_sha256"]:
        raise ValueError("WMH system text differs from the declared execution identity")
    return expected


def bind_execution_suite(
    source: str | Path, output: str | Path, policy_name: str, *, runtime_config: dict | None = None
) -> dict:
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
        policy_name,
        suite.get("native_world_model_id"),
        suite.get("native_world_model_manifest_sha256"),
        runtime_config=runtime_config,
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
    for name in _POLICIES:
        policy = execution_policy(name)
        if digest == policy.effective_system_sha256:
            return policy.metadata()
    return None
