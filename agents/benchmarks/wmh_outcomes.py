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
# Timed worlds: each outcome states its elapsed world time; later results are
# scheduled events revealed only to actions at or after their time.
TIMED_DISTRIBUTION_PROTOCOL = "rose-timed-outcome-distribution-v1"
TIMED_DISTRIBUTION_SCHEMA = "rose.wmh_timed_outcome_distribution.v1"
# Version 4 keeps the world clock and adds sampled scheduled results, keyed base
# rates and runner-recorded delivery of due events (see V4 notes below).
OUTCOME_V4_PROTOCOL = "rose-timed-outcome-distribution-v4"
OUTCOME_V4_SCHEMA = "rose.wmh_timed_outcome_distribution.v4"
TIMED_PROTOCOLS = frozenset({TIMED_DISTRIBUTION_PROTOCOL, OUTCOME_V4_PROTOCOL})
DISTRIBUTION_PROTOCOLS = frozenset({DISTRIBUTION_PROTOCOL, TIMED_DISTRIBUTION_PROTOCOL, OUTCOME_V4_PROTOCOL})
SCHEDULED_EVENTS_KEY = "scheduled_events"
BASE_RATES_KEY = "base_rates"
# The runner owns world time: as_of_utc is the pinned start and the clock keeps
# the present, so timed outcomes cannot rewrite it (one shared field made every
# fan-out patch conflict, serializing parallel steps).
RUNNER_OWNED_PATHS = frozenset({"/structured/as_of_utc"})
MAXIMUM_ELAPSED_MS = 366 * 86_400_000
DISTRIBUTION_TEXT = """For this execution mode, replace the single-transition JSON output contract above with an outcome distribution. Infer 1 to 6 plausible, mutually exclusive possible results of this exact candidate action, conditional on the full task, delegated goal, initial context, current environment state, and visible history. Generate the possibilities yourself; do not use fixed event labels or force success or failure. When the result is genuinely certain, one outcome with probability 1 is sufficient. Retrieved demonstrations illustrate tool response format and behavior in other worlds; they do not determine this world's outcome frequencies.

Return only JSON with this exact shape:
{"schema":"rose.wmh_outcome_distribution.v1","outcomes":[{"id":"unique_short_id","probability":1.0,"description":"possible result","tool_results":[{"call_id":"exact supplied id","content":"complete predicted tool response","is_error":false}],"state_patch":[]}]}

Each probability must be a finite number between 0 and 1, and the probabilities must sum to 1. Each outcome must contain exactly one complete result per supplied call_id in the original order. Keep the observed tool response format, including browser statuses, confirmations and concrete blockers when appropriate. Supply complete possible observations, not instructions for a later renderer. These are simulated possibilities, not reports that any real tool was executed. The runner will sample one outcome using these probabilities; do not choose an outcome yourself. Probability estimates express your uncertainty and are not externally calibrated.

state_patch is an ordered JSON Patch array against the supplied environment_state. Use only {"op":"add","path":"/key","value":...}, {"op":"replace","path":"/existing/key","value":...}, or {"op":"remove","path":"/existing/key"}. Paths are JSON pointers: escape ~ as ~0 and / as ~1; array indices are zero-based, and /array/- appends only for add. Parent paths must already exist, replace/remove targets must exist, and the empty root path is forbidden. An empty patch retains the state unchanged. Preserve all unrelated state and prior facts, including existing lists; append new entries rather than replacing their history. Each patch belongs solely to its own outcome and must contain only effects of that possible result. Availability alone creates no submission receipt; inquiry submission alone creates no investor interest, financing commitment or settled funds. Do not invent unknown private company facts or pre-existing private records to fill a branch."""


TIMING_TEXT = """World time for this execution mode: the candidate action's timestamp_ms is the current world time in milliseconds (UTC). Use the envelope schema "rose.wmh_timed_outcome_distribution.v1" and give every outcome an integer "elapsed_ms": the simulated time from that timestamp until this observation is complete (seconds for a sent message, minutes for a browser or research session, the waited interval for a wait). All other output rules above still apply.

A result that only happens later, such as a reply, an introduction, a meeting, a signature or a wire, is not part of this observation. Append it to /structured/scheduled_events as an object with an integer "available_at_ms" (the world time it happens), a "description" and its concrete details. The runner reveals each scheduled event only to actions at or after that time. Report a later result in an observation only once it appears in environment_state."""

# --- Version 4 (rose-outcome-distribution-v4) --------------------------------
# Runs 13-18 showed the earlier guard text conflating two different things:
# inventing history the action did not cause, and simulating the realistic
# result of the action itself. Later replies were deferred as placeholders and
# never sampled, and single-outcome certainty went unchecked. Version 4 states
# the distinction, samples every later result at action time as a concrete
# scheduled event, binds uncertain results to the world's keyed base rates and
# has the runner record delivery of due events. Earlier texts stay byte-identical.
DISTRIBUTION_V4_TEXT = """For this execution mode, replace the single-transition JSON output contract above with an outcome distribution. Infer 1 to 6 plausible, mutually exclusive results of this exact candidate action, conditional on the full task, delegated goal, initial context, current environment state and visible history. Generate the possibilities yourself; do not use fixed event labels or force success or failure. A single outcome with probability 1 is correct only when the state fully determines the result. Whenever a listed base rate applies, the result is uncertain: the distribution must contain both the event and its absence.

Return only JSON with this exact shape:
{"schema":"rose.wmh_timed_outcome_distribution.v4","base_rates":[{"key":"listed base rate key","given":null,"deviation_reason":null}],"outcomes":[{"id":"unique_short_id","probability":0.5,"description":"probability justification","elapsed_ms":60000,"base_rate_results":{"listed base rate key":true},"delivered_event_ids":[],"tool_results":[{"call_id":"exact supplied id","content":"complete predicted tool response","is_error":false}],"state_patch":[]}]}

Each probability must be a finite number between 0 and 1, and the probabilities must sum to 1. Each outcome must contain exactly one complete result per supplied call_id in the original order. Keep the observed tool response format, including browser statuses, confirmations and concrete blockers when appropriate. Supply complete observations, not instructions for a later renderer. These are simulated possibilities, not reports that any real tool was executed. The runner samples one outcome using these probabilities; do not choose an outcome yourself. Justify each probability briefly in its description from the evidence, relative to the other outcomes and the goal-implied alternatives; justify omitting plausible ones. In this simulation, all approvals needed by the candidate tool are granted during its execution.

Keep two things apart.
1. Do not make up history. Never fabricate pre-existing records that this action did not cause: earlier correspondence, introductions, applications, investor interest, commitments, signed documents, deposits, private documents, citations or record IDs, or company legal, product, traction, ownership or financial facts that the state and history do not establish. Retrieved demonstrations come from other worlds; their private facts are not facts of this world. When the action needs an unknown fact, such as a form field asking for unestablished traction figures, report that specific blocker. A request to submit or send without the content it needs yields that missing-information result, not a success.
2. Do simulate the result of the intended action. Research, lookups and inbox checks return realistic findings consistent with the fixture, including candidates inferred from its derived signals (for example warm contacts inferred from message counts, contact frequency and investor-like email domains), labeled as inferred. Public pages, forms and contact routes are instantiated plausibly. Sends and submissions are delivered, bounce or fail. Counterparties reply, pass, propose and hold meetings, commit, sign and wire at realistic rates. Missing prior evidence never rules out a result that this action itself can cause.

Base rates: structured.base_rates lists keyed base rates for this world. They are the default probability distribution for the matching result. When one matches a result this action can cause, declare it in base_rates and give every outcome a base_rate_results entry stating whether that event happens in the outcome. The probability of the outcomes in which it happens must equal the listed probability within 0.03 unless the state gives a concrete reason otherwise; state that reason in deviation_reason. Set "given" to an earlier declared key when the rate is conditional on that event (for example meeting acceptance given a reply); such a key appears in base_rate_results only for outcomes in which the given event happens. Record every outreach effect of an outcome, a completed send or form submission to a counterparty, by appending {"id":"unique record id","counterparty":"the recipient email address, or the organization's web domain for a form","channel":"email|form|sms|linkedin|other","kind":"send|form_submission","warm":true or false} to /structured/outreach (add the list when absent); warm is true only for a warm introduction or referral. Outreach to a counterparty with no delivered reply must declare the listed rate whose applies_to_outreach matches its warm value, without "given". A listed rate that names an applies_to tool must be declared whenever the candidate call matches it (same category, tool name and a nonempty named argument) and its precondition holds in the state; when several such rates share a group, declare the one that fits. When no base rate matches, use an empty base_rates list and empty base_rate_results objects.

state_patch is an ordered JSON Patch array against the supplied environment_state. Use only {"op":"add","path":"/key","value":...}, {"op":"replace","path":"/existing/key","value":...}, or {"op":"remove","path":"/existing/key"}. Paths are JSON pointers: escape ~ as ~0 and / as ~1; array indices are zero-based, and /array/- appends only for add. Parent paths must already exist, replace/remove targets must exist, and the empty root path is forbidden. An empty patch retains the state unchanged. Preserve all unrelated state and prior facts, including existing lists; append new entries rather than replacing their history. Each patch belongs solely to its own outcome and must contain only effects of that result, with matching receipts for completed effects."""


TIMING_V4_TEXT = """World time: the candidate action's timestamp_ms is the current world time in milliseconds (UTC). Give every outcome an integer elapsed_ms: the simulated time from that timestamp until this observation is complete (seconds for a sent message, minutes for a browser or research session, the waited interval for a wait). Each retrieved demonstration shows its real measured tool completion time as "elapsed_ms" and "elapsed"; ground elapsed_ms for similar actions in those measured times, together with the environment state.

A result that happens after this observation, such as a reply, a pass, a meeting proposal, a held meeting, a signature or a wire, is still decided now: sample it in this distribution. In each outcome where it happens, append one concrete event to /structured/scheduled_events: {"id":"unique event id","available_at_ms":integer world time after timestamp_ms,"kind":"reply|pass|meeting_proposal|meeting_held|meeting_cancelled|follow_up|introduction|commitment|signature|wire|bounce|other","channel":"where it arrives","from":"who acts","content":"the complete message or result exactly as it will be observed","observable_via":["each canonical action category that would observe it, such as message, explore, grep or browser"],"base_rate_key":"the declared base rate key it realizes, or null"}. In an outcome where it does not happen, add no event. Never schedule a possibility: an event is a sampled result that will happen at its time. A reply, pass or meeting proposal names the declared base rate it realizes.

Scheduled events are append-only; never modify or remove an existing one. An event whose available_at_ms is at or before timestamp_ms and that has no delivered_at_ms is due. When the candidate's category is listed in a due event's observable_via, every outcome must report that event concretely in its tool result and list its id in delivered_event_ids; the runner then records its delivery. Events after timestamp_ms are not in environment_state and must not be reported."""

BASE_RATE_TOLERANCE = 0.03
EVENT_KINDS = frozenset(
    {
        "reply",
        "pass",
        "meeting_proposal",
        "meeting_held",
        "meeting_cancelled",
        "follow_up",
        "introduction",
        "commitment",
        "signature",
        "wire",
        "bounce",
        "other",
    }
)
# A counterparty response is the sampled realization of a base rate.
RESPONSE_EVENT_KINDS = frozenset({"reply", "pass", "meeting_proposal"})
OBSERVATION_CATEGORIES = frozenset(
    {"browser", "message", "explore", "grep", "code", "payment", "vapi", "auth_approval", "for_each", "tool"}
)
_EVENT_KEYS = frozenset(
    {"id", "available_at_ms", "kind", "channel", "from", "content", "observable_via", "base_rate_key"}
)
_EVENT_OPTIONAL_KEYS = frozenset({"details"})
DELIVERED_AT_KEY = "delivered_at_ms"


def world_base_rates(state: dict) -> dict:
    """``{key: probability}`` for the world's keyed base rates (empty when none)."""
    structured = state.get("structured") if isinstance(state, dict) else None
    rates = structured.get(BASE_RATES_KEY) if isinstance(structured, dict) else None
    if not isinstance(rates, list):
        return {}
    result = {}
    for rate in rates:
        if (
            isinstance(rate, dict)
            and isinstance(rate.get("key"), str)
            and type(rate.get("probability")) in (int, float)
            and 0 < rate["probability"] < 1
        ):
            result[rate["key"]] = float(rate["probability"])
    return result


def _applies_to_call(entry: dict, action: dict) -> bool:
    arguments = action.get("arguments") if isinstance(action.get("arguments"), dict) else {}
    for target in entry.get("applies_to") or ():
        if (
            isinstance(target, dict)
            and target.get("category") == action.get("category")
            and target.get("tool") == action.get("name")
            and isinstance(arguments.get(target.get("argument")), str)
            and arguments[target["argument"]].strip()
        ):
            return True
    return False


def _replied(counterparty: str, keys: set, state: dict) -> bool:
    """Whether a delivered event realizing one of ``keys`` came from this counterparty
    (exact case-insensitive address or domain containment in its ``from``, not content reading)."""
    counterparty = counterparty.strip().lower() if isinstance(counterparty, str) else ""
    return bool(counterparty) and any(
        isinstance(event, dict)
        and DELIVERED_AT_KEY in event
        and event.get("base_rate_key") in keys
        and isinstance(event.get("from"), str)
        and counterparty in event["from"].lower()
        for event in _events(state)
    )


def _precondition_holds(entry: dict, action: dict, state: dict, *, counterparty: str | None = None) -> bool:
    """Structured state precondition on the counterparty taken from the call argument
    (or from an outreach record when ``counterparty`` is given)."""
    condition = entry.get("precondition")
    if condition is None:
        return True
    if counterparty is None:
        arguments = action.get("arguments") if isinstance(action.get("arguments"), dict) else {}
        counterparty = arguments.get(condition.get("counterparty_argument"))
    present = _replied(counterparty, set(condition.get("delivered_base_rate_keys") or ()), state)
    return present is condition.get("present")


def required_base_rate_groups(state: dict, action: dict | None) -> dict:
    """``{group: {keys}}`` of listed rates that this exact candidate call must declare."""
    structured = state.get("structured") if isinstance(state, dict) else None
    entries = structured.get(BASE_RATES_KEY) if isinstance(structured, dict) else None
    if not isinstance(action, dict) or not isinstance(entries, list):
        return {}
    listed = world_base_rates(state)
    groups: dict = {}
    for entry in entries:
        if (
            isinstance(entry, dict)
            and entry.get("key") in listed
            and _applies_to_call(entry, action)
            and _precondition_holds(entry, action, state)
        ):
            groups.setdefault(entry.get("group") or entry["key"], set()).add(entry["key"])
    return groups


def _events(state: dict) -> list:
    structured = state.get("structured") if isinstance(state, dict) else None
    events = structured.get(SCHEDULED_EVENTS_KEY) if isinstance(structured, dict) else None
    return events if isinstance(events, list) else []


def due_undelivered_events(state: dict, *, at_ms: int) -> list:
    """Events that have happened by ``at_ms`` and that no observation has delivered yet."""
    return [
        event
        for event in _events(state)
        if isinstance(event, dict)
        and type(event.get("available_at_ms")) is int
        and event["available_at_ms"] <= at_ms
        and DELIVERED_AT_KEY not in event
        and isinstance(event.get("id"), str)
    ]


def _validate_v4_declarations(distribution: dict, state: dict) -> list:
    declarations = distribution["base_rates"]
    if not isinstance(declarations, list):
        raise ValueError("base_rates must be a list of declarations")
    rates = world_base_rates(state)
    declared = []
    for declaration in declarations:
        if not isinstance(declaration, dict) or set(declaration) != {"key", "given", "deviation_reason"}:
            raise ValueError("Each base rate declaration needs exactly key, given and deviation_reason")
        key, given, reason = declaration["key"], declaration["given"], declaration["deviation_reason"]
        if key not in rates:
            raise ValueError("Declared base rate is not listed in structured.base_rates")
        if key in {d["key"] for d in declared}:
            raise ValueError("Each base rate may be declared once")
        if given is not None and given not in {d["key"] for d in declared}:
            raise ValueError("A conditional base rate must be given an earlier declared key")
        if reason is not None and (not isinstance(reason, str) or not reason.strip()):
            raise ValueError("deviation_reason must be null or a stated reason")
        declared.append(declaration)
    return declared


def _require_applicable_declarations(declared, state, action):
    keys = {declaration["key"] for declaration in declared}
    for group in required_base_rate_groups(state, action).values():
        if not keys & group:
            raise ValueError("A base rate that applies to this candidate tool call must be declared")


OUTREACH_KEY = "outreach"
OUTREACH_KINDS = frozenset({"send", "form_submission"})
_OUTREACH_FIELDS = frozenset({"id", "counterparty", "channel", "kind", "warm"})


def _outreach(state: dict) -> list:
    structured = state.get("structured") if isinstance(state, dict) else None
    records = structured.get(OUTREACH_KEY) if isinstance(structured, dict) else None
    return records if isinstance(records, list) else []


def _validate_outreach(base_state: dict, state: dict) -> list:
    """The new outreach records of one outcome: append-only, exact structured fields."""
    base, records = _outreach(base_state), _outreach(state)
    structured = state.get("structured") if isinstance(state, dict) else None
    if isinstance(structured, dict) and OUTREACH_KEY in structured and not isinstance(structured[OUTREACH_KEY], list):
        raise ValueError("structured.outreach must be a list")
    if records[: len(base)] != base:
        raise ValueError("The outreach ledger is append-only; existing records cannot change")
    seen = {r.get("id") for r in base if isinstance(r, dict)}
    added = records[len(base) :]
    for record in added:
        if not isinstance(record, dict) or set(record) != _OUTREACH_FIELDS:
            raise ValueError("An outreach record needs exactly id, counterparty, channel, kind and warm")
        if not isinstance(record["id"], str) or not record["id"].strip() or record["id"] in seen:
            raise ValueError("Outreach record IDs must be nonempty and unique")
        seen.add(record["id"])
        for field in ("counterparty", "channel"):
            if not isinstance(record[field], str) or not record[field].strip():
                raise ValueError("An outreach record needs a concrete counterparty and channel")
        if record["kind"] not in OUTREACH_KINDS or type(record["warm"]) is not bool:
            raise ValueError("Outreach kind must be send or form_submission and warm a boolean")
    return added


def _require_outreach_declarations(added: list, declared: list, base_state: dict) -> None:
    """Effect rule: recorded outreach to a counterparty without a delivered reply must
    declare the listed first-response rate whose applies_to_outreach matches its warmth."""
    if not added:
        return
    structured = base_state.get("structured") if isinstance(base_state, dict) else None
    entries = structured.get(BASE_RATES_KEY) if isinstance(structured, dict) else None
    listed = world_base_rates(base_state)
    keys = {declaration["key"] for declaration in declared if declaration["given"] is None}
    for record in added:
        for entry in entries if isinstance(entries, list) else ():
            target = entry.get("applies_to_outreach") if isinstance(entry, dict) else None
            if (
                isinstance(target, dict)
                and entry.get("key") in listed
                and target.get("warm") is record["warm"]
                and _precondition_holds(entry, {}, base_state, counterparty=record["counterparty"])
                and entry["key"] not in keys
            ):
                raise ValueError("Recorded outreach must declare its matching first-response base rate")


def _validate_v4_outcome(outcome, declared, base_events, state, *, at_ms, due_ids, required_ids, reserved_ids):
    results = outcome["base_rate_results"]
    if not isinstance(results, dict):
        raise ValueError("base_rate_results must be an object")
    expected = set()
    for declaration in declared:
        given = declaration["given"]
        if given is None or results.get(given) is True:
            expected.add(declaration["key"])
    if set(results) != expected or any(type(value) is not bool for value in results.values()):
        raise ValueError("base_rate_results must state each applicable declared base rate as true or false")
    delivered = outcome["delivered_event_ids"]
    if (
        not isinstance(delivered, list)
        or any(not isinstance(value, str) for value in delivered)
        or len(set(delivered)) != len(delivered)
    ):
        raise ValueError("delivered_event_ids must be a list of unique event IDs")
    if not set(delivered) <= due_ids:
        raise ValueError("Only due, undelivered scheduled events can be delivered")
    if not required_ids <= set(delivered):
        raise ValueError("A due scheduled event observable by this action must be delivered in every outcome")
    events = _events(state)
    if events[: len(base_events)] != base_events:
        raise ValueError("Scheduled events are append-only; existing events cannot change")
    seen = set(reserved_ids)
    for event in events[len(base_events) :]:
        if (
            not isinstance(event, dict)
            or not _EVENT_KEYS <= set(event)
            or not set(event) <= _EVENT_KEYS | _EVENT_OPTIONAL_KEYS
        ):
            raise ValueError("A scheduled event needs exactly the concrete event fields")
        if not isinstance(event["id"], str) or not event["id"].strip() or event["id"] in seen:
            raise ValueError("Scheduled event IDs must be nonempty and unique")
        seen.add(event["id"])
        at = event["available_at_ms"]
        if type(at) is not int or not at_ms < at <= at_ms + MAXIMUM_ELAPSED_MS:
            raise ValueError("A scheduled event happens at an integer world time after this action, within one year")
        if event["kind"] not in EVENT_KINDS:
            raise ValueError("Unknown scheduled event kind")
        for field in ("channel", "from", "content"):
            if not isinstance(event[field], str) or not event[field].strip():
                raise ValueError("A scheduled event needs a concrete channel, actor and content")
        via = event["observable_via"]
        if (
            not isinstance(via, list)
            or not via
            or any(value not in OBSERVATION_CATEGORIES for value in via)
            or len(set(via)) != len(via)
        ):
            raise ValueError("observable_via must list canonical action categories")
        if "details" in event and not isinstance(event["details"], dict):
            raise ValueError("Scheduled event details must be an object")
        key = event["base_rate_key"]
        if key is None:
            if event["kind"] in RESPONSE_EVENT_KINDS:
                raise ValueError("A counterparty response must realize a declared base rate")
        elif results.get(key) is not True:
            raise ValueError("A scheduled event realizes a base rate only in an outcome where it happens")


def _validate_v4_mass(declared, outcomes, rates):
    for declaration in declared:
        key, given = declaration["key"], declaration["given"]
        applicable = [o for o in outcomes if given is None or o["base_rate_results"].get(given) is True]
        happens = [o["probability"] for o in applicable if o["base_rate_results"][key] is True]
        absent = [o["probability"] for o in applicable if o["base_rate_results"][key] is False]
        if not any(p > 0 for p in happens) or not any(p > 0 for p in absent):
            raise ValueError("A result with an applicable base rate needs both outcomes with positive probability")
        share = math.fsum(happens) / math.fsum(happens + absent)
        if declaration["deviation_reason"] is None and abs(share - rates[key]) > BASE_RATE_TOLERANCE + 1e-9:
            raise ValueError("Outcome probabilities differ from the declared base rate without a stated reason")


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
    apply_state_patch_in_place(state, patch)
    json.dumps(state, allow_nan=False)
    return state


def apply_state_patch_in_place(state: dict, patch: list) -> bool:
    """Apply ``patch`` to ``state`` itself; True when every written value is finite JSON.

    Callers that already proved ``state`` finite can then skip re-encoding the
    whole state: its values are either unchanged or one of the written values.
    """
    if not isinstance(state, dict) or not isinstance(patch, list):
        raise ValueError("State patch requires an object snapshot and an array of operations")
    written_finite = True
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
        if op != "remove" and written_finite:
            try:
                json.dumps(operation["value"], allow_nan=False)
            except (TypeError, ValueError):
                written_finite = False
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
    return written_finite


def parse_distribution(
    content: str,
    *,
    base_state: dict,
    expected_call_ids: tuple[str, ...],
    timed: bool = False,
    protocol: str | None = None,
    at_ms: int | None = None,
    action_category: str | None = None,
    reserved_event_ids: frozenset = frozenset(),
    action_arguments: dict | None = None,
) -> dict:
    """Validate every branch. ``protocol`` selects version 4, which also needs the
    action's world time and category; ``reserved_event_ids`` are hidden future events.
    ``action_arguments`` (the canonical candidate call) enforces applicable base rates."""
    if not isinstance(content, str) or not isinstance(base_state, dict) or not expected_call_ids:
        raise ValueError("Outcome distribution requires native state and candidate call identities")
    v4 = protocol == OUTCOME_V4_PROTOCOL
    if v4:
        timed = True
        if action_category is None and isinstance(action_arguments, dict):
            action_category = action_arguments.get("category")
        if type(at_ms) is not int or not isinstance(action_category, str):
            raise ValueError("Version 4 distributions require the action's world time and category")
    raw = content.strip()
    if raw.startswith("```") and raw.endswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    distribution = json.loads(raw, object_pairs_hook=_unique_object)
    json.dumps(distribution, allow_nan=False)
    if (
        not isinstance(distribution, dict)
        or set(distribution) != ({"schema", "base_rates", "outcomes"} if v4 else {"schema", "outcomes"})
        or distribution["schema"]
        != (OUTCOME_V4_SCHEMA if v4 else TIMED_DISTRIBUTION_SCHEMA if timed else DISTRIBUTION_SCHEMA)
        or not isinstance(distribution["outcomes"], list)
        or not 1 <= len(distribution["outcomes"]) <= 6
    ):
        raise ValueError("Invalid outcome distribution envelope")
    if v4:
        declared = _validate_v4_declarations(distribution, base_state)
        _require_applicable_declarations(declared, base_state, action_arguments)
        base_events = _events(base_state)
        due = due_undelivered_events(base_state, at_ms=at_ms)
        due_ids = {event["id"] for event in due}
        required_ids = {
            event["id"]
            for event in due
            if isinstance(event.get("observable_via"), list) and action_category in event["observable_via"]
        }
        reserved = set(reserved_event_ids) | {
            event.get("id") for event in base_events if isinstance(event, dict) and isinstance(event.get("id"), str)
        }
    outcomes, seen = [], set()
    for outcome in distribution["outcomes"]:
        keys = (
            {"id", "probability", "description", "tool_results", "state_patch"}
            | ({"elapsed_ms"} if timed else set())
            | ({"base_rate_results", "delivered_event_ids"} if v4 else set())
        )
        if not isinstance(outcome, dict) or set(outcome) != keys:
            raise ValueError("Invalid outcome keys")
        if timed and (
            type(outcome["elapsed_ms"]) is not int or not 0 <= outcome["elapsed_ms"] <= MAXIMUM_ELAPSED_MS
        ):
            raise ValueError("Each timed outcome needs an integer elapsed_ms within one year")
        if timed and isinstance(outcome["state_patch"], list):
            outcome = {
                **outcome,
                "state_patch": [
                    op
                    for op in outcome["state_patch"]
                    if not (isinstance(op, dict) and op.get("path") in RUNNER_OWNED_PATHS)
                ],
            }
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
        if v4:
            _require_outreach_declarations(_validate_outreach(base_state, state), declared, base_state)
            _validate_v4_outcome(
                outcome,
                declared,
                base_events,
                state,
                at_ms=at_ms,
                due_ids=due_ids,
                required_ids=required_ids,
                reserved_ids=reserved,
            )
        outcomes.append(
            {**outcome, "transition": {"message": "", "tool_results": results, "state": state, "terminal": False}}
        )
    total = math.fsum(outcome["probability"] for outcome in outcomes)
    if not math.isclose(total, 1.0, rel_tol=0, abs_tol=1e-9):
        raise ValueError("Outcome probabilities must sum to 1")
    if v4:
        _validate_v4_mass(declared, outcomes, world_base_rates(base_state))
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
    selection = {
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
    if "elapsed_ms" in selected:
        selection["elapsed_ms"] = selected["elapsed_ms"]
    if "delivered_event_ids" in selected:
        selection["delivered_event_ids"] = list(selected["delivered_event_ids"])
        selection["base_rate_results"] = dict(selected["base_rate_results"])
    return selected["transition"], selection


def visible_world_state(state: dict, *, at_ms: int) -> tuple[dict, list]:
    """The state an action at ``at_ms`` may observe, and the future events withheld from it."""
    view = deepcopy(state)
    structured = view.get("structured")
    if not isinstance(structured, dict):
        return view, []
    events = structured.get(SCHEDULED_EVENTS_KEY)
    if not isinstance(events, list):
        structured[SCHEDULED_EVENTS_KEY] = []
        return view, []
    visible, hidden = [], []
    for event in events:
        at = event.get("available_at_ms") if isinstance(event, dict) else None
        (hidden if type(at) is int and at > at_ms else visible).append(event)
    structured[SCHEDULED_EVENTS_KEY] = visible
    return view, hidden


def restore_hidden_events(state: dict, hidden: list) -> dict:
    """Return a predicted state with the withheld future events put back."""
    if not hidden:
        return state
    restored = deepcopy(state)
    restored["structured"].setdefault(SCHEDULED_EVENTS_KEY, []).extend(deepcopy(hidden))
    return restored


def mark_delivered(state: dict, event_ids, *, at_ms: int) -> tuple[dict, bool]:
    """Runner-recorded delivery: stamp each delivered due event once; report whether any changed."""
    if not event_ids:
        return state, False
    marked = deepcopy(state)
    changed = False
    wanted = set(event_ids)
    for event in _events(marked):
        if isinstance(event, dict) and event.get("id") in wanted and DELIVERED_AT_KEY not in event:
            event[DELIVERED_AT_KEY] = at_ms
            changed = True
    return marked, changed
