"""Shared distribution protocol for the Python 3.11 provider and 3.12 simulator.

task + state + action -> model-generated outcomes + probabilities + patches
                     -> validate every branch -> one invocation-bound draw
                     -> selected native transition -> revision-checked commit

Patches use the add/replace/remove subset of JSON Patch. Unmentioned state is
retained; container replacement/removal is explicit, never an implicit merge.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from copy import deepcopy

from utils.world_model_observation import effective_world_model_content

DISTRIBUTION_PROTOCOL = "rose-outcome-distribution-v1"
DISTRIBUTION_SCHEMA = "rose.wmh_outcome_distribution.v1"
DISTRIBUTION_TEXT = """For this execution mode, replace the single-transition JSON output contract above with an outcome distribution. Infer 1 to 6 plausible, mutually exclusive possible results of this exact candidate action, conditional on the full task, delegated goal, initial context, current environment state, and visible history. Generate the possibilities yourself; do not use fixed event labels or force success or failure. When the result is genuinely certain, one outcome with probability 1 is sufficient. Retrieved demonstrations illustrate tool response format and behavior in other worlds; they do not determine this world's outcome frequencies.

Return only JSON with this exact shape:
{"schema":"rose.wmh_outcome_distribution.v1","outcomes":[{"id":"unique_short_id","probability":1.0,"description":"possible result","tool_results":[{"call_id":"exact supplied id","content":"complete predicted tool response","is_error":false}],"state_patch":[]}]}

Each probability must be a finite number between 0 and 1, and the probabilities must sum to 1. Each outcome must contain exactly one complete result per supplied call_id in the original order. Keep the observed tool response format, including browser statuses, confirmations and concrete blockers when appropriate. Supply complete possible observations, not instructions for a later renderer. These are simulated possibilities, not reports that any real tool was executed. The runner will sample one outcome using these probabilities; do not choose an outcome yourself. Probability estimates express your uncertainty and are not externally calibrated.

state_patch is an ordered JSON Patch array against the supplied environment_state. Use only {"op":"add","path":"/key","value":...}, {"op":"replace","path":"/existing/key","value":...}, or {"op":"remove","path":"/existing/key"}. Paths are JSON pointers: escape ~ as ~0 and / as ~1; array indices are zero-based, and /array/- appends only for add. Parent paths must already exist, replace/remove targets must exist, and the empty root path is forbidden. An empty patch retains the state unchanged. Preserve all unrelated state and prior facts, including existing lists; append new entries rather than replacing their history. Each patch belongs solely to its own outcome and must contain only effects of that possible result. Availability alone creates no submission receipt; inquiry submission alone creates no investor interest, financing commitment or settled funds. Do not invent unknown private company facts or pre-existing private records to fill a branch."""


def _digest(value):
    material = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(material.encode()).hexdigest()


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key in outcome distribution")
        result[key] = value
    return result


def _pointer(path):
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("State patch requires a non-root JSON pointer")
    parts = path[1:].split("/")
    if any(re.search(r"~(?![01])", part) for part in parts):
        raise ValueError("Invalid JSON pointer escape")
    return [part.replace("~1", "/").replace("~0", "~") for part in parts]


def _index(part, length, *, insert=False):
    if insert and part == "-":
        return length
    if not re.fullmatch(r"0|[1-9][0-9]*", part):
        raise ValueError("Invalid state patch array index")
    value = int(part)
    if value >= length + int(insert):
        raise ValueError("State patch array index out of bounds")
    return value


def apply_state_patch(base_state: dict, patch: list) -> dict:
    if not isinstance(base_state, dict) or not isinstance(patch, list):
        raise ValueError("State patch requires an object snapshot and an array of operations")
    state = deepcopy(base_state)
    for operation in patch:
        if not isinstance(operation, dict) or operation.get("op") not in {"add", "replace", "remove"}:
            raise ValueError("Unsupported state patch operation")
        op = operation["op"]
        keys = {"op", "path"} if op == "remove" else {"op", "path", "value"}
        if set(operation) != keys:
            raise ValueError("Invalid state patch operation keys")
        parts = _pointer(operation["path"])
        parent = state
        for part in parts[:-1]:
            if isinstance(parent, dict) and part in parent:
                parent = parent[part]
            elif isinstance(parent, list):
                parent = parent[_index(part, len(parent))]
            else:
                raise ValueError("State patch parent does not exist")
        key = parts[-1]
        if isinstance(parent, dict):
            if op != "add" and key not in parent:
                raise ValueError("State patch target does not exist")
            if op == "remove":
                del parent[key]
            else:
                parent[key] = deepcopy(operation["value"])
        elif isinstance(parent, list):
            index = _index(key, len(parent), insert=op == "add")
            if op == "add":
                parent.insert(index, deepcopy(operation["value"]))
            elif op == "remove":
                parent.pop(index)
            else:
                parent[index] = deepcopy(operation["value"])
        else:
            raise ValueError("State patch parent is not a container")
    json.dumps(state, allow_nan=False)
    return state


def parse_distribution(content: str, *, base_state: dict, expected_call_ids: tuple[str, ...]) -> dict:
    if not isinstance(content, str) or not isinstance(base_state, dict) or not expected_call_ids:
        raise ValueError("Outcome distribution requires native state and candidate call identities")
    raw = content.strip()
    if raw.startswith("```") and raw.endswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    distribution = json.loads(raw, object_pairs_hook=_unique_object)
    json.dumps(distribution, allow_nan=False)
    if (
        not isinstance(distribution, dict)
        or set(distribution) != {"schema", "outcomes"}
        or distribution["schema"] != DISTRIBUTION_SCHEMA
        or not isinstance(distribution["outcomes"], list)
        or not 1 <= len(distribution["outcomes"]) <= 6
    ):
        raise ValueError("Invalid outcome distribution envelope")
    outcomes, seen = [], set()
    for outcome in distribution["outcomes"]:
        if not isinstance(outcome, dict) or set(outcome) != {
            "id",
            "probability",
            "description",
            "tool_results",
            "state_patch",
        }:
            raise ValueError("Invalid outcome keys")
        identity, probability = outcome["id"], outcome["probability"]
        if not isinstance(identity, str) or not identity.strip() or identity in seen:
            raise ValueError("Outcome IDs must be nonempty and unique")
        seen.add(identity)
        if type(probability) not in (int, float) or not 0 <= probability <= 1 or not math.isfinite(probability):
            raise ValueError("Outcome probabilities must be finite numbers between 0 and 1")
        if not isinstance(outcome["description"], str) or not outcome["description"].strip():
            raise ValueError("Outcome requires a description")
        results = outcome["tool_results"]
        if not isinstance(results, list) or len(results) != len(expected_call_ids):
            raise ValueError("Outcome requires exactly one result per candidate call")
        for result, call_id in zip(results, expected_call_ids):
            if (
                not isinstance(result, dict)
                or set(result) != {"call_id", "content", "is_error"}
                or result["call_id"] != call_id
                or not isinstance(result["content"], str)
                or not effective_world_model_content(result["content"]).strip()
                or type(result["is_error"]) is not bool
            ):
                raise ValueError("Invalid outcome tool observation or call identity")
        state = apply_state_patch(base_state, outcome["state_patch"])
        outcomes.append(
            {**outcome, "transition": {"message": "", "tool_results": results, "state": state, "terminal": False}}
        )
    total = math.fsum(outcome["probability"] for outcome in outcomes)
    if not math.isclose(total, 1.0, rel_tol=0, abs_tol=1e-9):
        raise ValueError("Outcome probabilities must sum to 1")
    return {
        "outcomes": outcomes,
        "total_probability": total,
        "distribution_sha256": _digest(distribution),
        "base_state_sha256": _digest(base_state),
    }


def select_outcome(distribution: dict, draw: float) -> tuple[dict, dict]:
    if type(draw) not in (int, float) or not 0 <= draw < 1 or not math.isfinite(draw):
        raise ValueError("Outcome draw must be a finite number in [0, 1)")
    # Correct floating-point sum roundoff only; invalid totals are never repaired.
    threshold = draw * distribution["total_probability"]
    cumulative, selected = 0.0, None
    for outcome in distribution["outcomes"]:
        if outcome["probability"] == 0:
            continue
        selected = outcome
        cumulative = math.fsum((cumulative, outcome["probability"]))
        if threshold < cumulative:
            break
    if selected is None:
        raise ValueError("Outcome distribution has no positive probability")
    return selected["transition"], {
        "schema": "rose.wmh_outcome_selection.v1",
        "draw": draw,
        "selected_outcome_id": selected["id"],
        "probability": selected["probability"],
        "total_probability": distribution["total_probability"],
        "distribution_sha256": distribution["distribution_sha256"],
        "base_state_sha256": distribution["base_state_sha256"],
        "outcomes": [
            {key: outcome[key] for key in ("id", "probability", "description")} for outcome in distribution["outcomes"]
        ],
    }
