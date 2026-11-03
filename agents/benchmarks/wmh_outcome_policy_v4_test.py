"""Owning regressions for policy rose-outcome-distribution-v4 (run from the WMH blackbox gate).

Runs 13-18: guard text conflated invented history with the realistic result of an
action, later replies were deferred as "may respond" placeholders and never
sampled, single-outcome certainty went unchecked, and the user's base rates were
not the inserted set.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy

import pytest

from benchmarks import wmh_execution_policy as policies
from benchmarks import wmh_outcomes as outcomes
from benchmarks.wmh_outcomes import OUTCOME_V4_PROTOCOL, OUTCOME_V4_SCHEMA, parse_distribution

START = 1_791_676_800_000
HOUR = 3_600_000


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def world(events=()):
    return {
        "structured": {
            "schema": "test",
            "as_of_utc": "2026-10-11T00:00:00Z",
            "base_rates": [
                {"key": "cold_reply", "probability": 0.07, "event": "cold reply", "applies_when": "cold"},
                {"key": "meeting_accepted", "probability": 0.45, "event": "accepts", "applies_when": "replied"},
            ],
            "scheduled_events": list(events),
        },
        "scratchpad": "",
    }


def reply_event(event_id="evt-reply-1", *, at=START + 2 * HOUR, key="cold_reply", kind="reply"):
    return {
        "id": event_id,
        "available_at_ms": at,
        "kind": kind,
        "channel": "email to tamara@roselabs.ai",
        "from": "Dana Lee <dana@example.vc>",
        "content": "Thanks Tamara, this is interesting. Could you send the deck?",
        "observable_via": ["message", "browser", "explore"],
        "base_rate_key": key,
    }


def outcome(identity, probability, *, results=None, patch=(), delivered=(), content="Email delivered", elapsed=30_000):
    return {
        "id": identity,
        "probability": probability,
        "description": "justification",
        "elapsed_ms": elapsed,
        "base_rate_results": dict(results or {}),
        "delivered_event_ids": list(delivered),
        "tool_results": [{"call_id": "call-1", "content": content, "is_error": False}],
        "state_patch": list(patch),
    }


def send_distribution(reply_probability=0.07, *, reason=None, event=None):
    event = event or reply_event()
    return {
        "schema": OUTCOME_V4_SCHEMA,
        "base_rates": [{"key": "cold_reply", "given": None, "deviation_reason": reason}],
        "outcomes": [
            outcome(
                "delivered_reply_later",
                reply_probability,
                results={"cold_reply": True},
                patch=[{"op": "add", "path": "/structured/scheduled_events/-", "value": event}],
            ),
            outcome("delivered_no_reply", round(1 - reply_probability, 10), results={"cold_reply": False}),
        ],
    }


def parse(payload, state=None, *, at=START, category="message", reserved=frozenset()):
    return parse_distribution(
        json.dumps(payload),
        base_state=world() if state is None else state,
        expected_call_ids=("call-1",),
        protocol=OUTCOME_V4_PROTOCOL,
        at_ms=at,
        action_category=category,
        reserved_event_ids=reserved,
    )


def test_earlier_policy_and_protocol_bytes_are_unchanged():
    assert _sha(outcomes.DISTRIBUTION_TEXT) == policies.OUTCOME_DISTRIBUTION_SHA256
    assert _sha(policies.OUTCOME_DISTRIBUTION_V2_TEXT) == policies.OUTCOME_DISTRIBUTION_V2_SHA256
    assert _sha(policies.OUTCOME_DISTRIBUTION_V3_TEXT) == policies.OUTCOME_DISTRIBUTION_V3_SHA256
    pinned = {
        "rose-virtual-public-affordances-v1": "49d9d1f0430a5d8ee6aaaff9dd8783075a857b9c171e76ebe620a22e9ec7ba79",
        "rose-virtual-public-affordances-v2": "5dd9924e9a1ff4c54a95ee53c78414961f83ae62deec84b1ed7a670d0d3083c4",
        "rose-outcome-distribution-v1": "650945bf68ee4ba66a6c9f9dca1c3d66be85dd50360f287cb5c924edb2c8ad70",
        "rose-outcome-distribution-v2": "23feae1291f883f0a2280d6f7295e7391dbc7bd82dc1a9c1ca7caea52354fbb0",
        "rose-outcome-distribution-v3": "3ace77b6b1a3a33ca94e69541cd1e671a4c3a7694d3612b9ddc68f1ccdf6da8a",
        "rose-outcome-distribution-v4": "dc3c757c601515ffcb7df37f444d8f5f23366ce55127adf1170ad39153074ac3",
    }
    for name, digest in pinned.items():
        assert _sha(policies.execution_policy(name).text) == digest, name
    assert policies.execution_policy("rose-outcome-distribution-v3").response_protocol == (
        outcomes.TIMED_DISTRIBUTION_PROTOCOL
    )
    v4 = policies.execution_policy("rose-outcome-distribution-v4")
    assert v4.version == "4" and v4.response_protocol == OUTCOME_V4_PROTOCOL
    assert v4.effective_system_sha256 == "0f459f7d6363d708fe50d33c1c99b3be9d98436d1b5cc636b82e9ee23aab733a"
    # The v3 timed protocol is unchanged: no v4 fields and no v4 checks.
    legacy = {
        "schema": "rose.wmh_timed_outcome_distribution.v1",
        "outcomes": [{k: v for k, v in outcome("only", 1.0).items() if k not in {"base_rate_results", "delivered_event_ids"}}],
    }
    parse_distribution(json.dumps(legacy), base_state=world(), expected_call_ids=("call-1",), timed=True)


def test_send_branches_on_a_concrete_sampled_reply_at_the_base_rate():
    parsed = parse(send_distribution())
    reply, silent = parsed["outcomes"]
    events = reply["transition"]["state"]["structured"]["scheduled_events"]
    assert events == [reply_event()] and silent["transition"]["state"]["structured"]["scheduled_events"] == []
    assert reply["probability"] == pytest.approx(0.07)
    for wrong in (0.5, 0.02, 0.2):
        with pytest.raises(ValueError, match="base rate"):
            parse(send_distribution(wrong))
    # A concrete stated reason may move the rate; it never removes the absent branch.
    parse(send_distribution(0.5, reason="The partner asked Tamara to send this exact update yesterday"))


def test_certain_outcome_is_rejected_when_a_base_rate_applies():
    payload = send_distribution()
    payload["outcomes"] = [dict(payload["outcomes"][0], probability=1.0)]
    with pytest.raises(ValueError, match="both outcomes"):
        parse(payload)
    zero = send_distribution()
    zero["outcomes"][1]["probability"], zero["outcomes"][0]["probability"] = 0.0, 1.0
    with pytest.raises(ValueError, match="both outcomes"):
        parse(zero)
    with pytest.raises(ValueError, match="both outcomes"):
        parse(dict(send_distribution(1.0, reason="certain"), outcomes=send_distribution(1.0)["outcomes"][:1]))


@pytest.mark.parametrize(
    "event",
    [
        # Run 13's placeholder shape: a possibility, not a sampled result.
        {"available_at_ms": START + HOUR, "description": "Investor may respond; no response guaranteed"},
        dict(reply_event(), probability=0.07),
        {k: v for k, v in reply_event().items() if k != "content"},
        dict(reply_event(), content="  "),
        dict(reply_event(), kind="possible_reply"),
        dict(reply_event(), base_rate_key=None),
        dict(reply_event(), available_at_ms=START),
        dict(reply_event(), observable_via=["inbox"]),
        dict(reply_event(), delivered_at_ms=START + 2 * HOUR),
    ],
)
def test_placeholder_or_unconcrete_scheduled_events_are_rejected(event):
    with pytest.raises(ValueError):
        parse(send_distribution(event=event))


def test_scheduled_events_are_append_only_and_realized_only_where_they_happen():
    existing = reply_event("evt-old", at=START - HOUR)
    existing["delivered_at_ms"] = START - HOUR
    state = world([existing])
    rewrite = send_distribution()
    rewrite["outcomes"][1]["state_patch"] = [
        {"op": "replace", "path": "/structured/scheduled_events/0/content", "value": "changed"}
    ]
    with pytest.raises(ValueError, match="append-only"):
        parse(rewrite, state)
    misplaced = send_distribution()
    misplaced["outcomes"][1]["state_patch"] = misplaced["outcomes"][0]["state_patch"]
    with pytest.raises(ValueError, match="realizes a base rate only"):
        parse(misplaced)
    with pytest.raises(ValueError, match="unique"):
        parse(send_distribution(), reserved=frozenset({"evt-reply-1"}))
    undeclared = send_distribution()
    undeclared["base_rates"] = [{"key": "warm_reply", "given": None, "deviation_reason": None}]
    with pytest.raises(ValueError, match="not listed"):
        parse(undeclared)


def test_conditional_base_rate_samples_meeting_acceptance_inside_the_reply_branch():
    proposal = dict(reply_event("evt-meeting"), kind="meeting_proposal", base_rate_key="meeting_accepted")

    def add(event):
        return [{"op": "add", "path": "/structured/scheduled_events/-", "value": event}]

    payload = {
        "schema": OUTCOME_V4_SCHEMA,
        "base_rates": [
            {"key": "cold_reply", "given": None, "deviation_reason": None},
            {"key": "meeting_accepted", "given": "cold_reply", "deviation_reason": None},
        ],
        "outcomes": [
            outcome("meeting", 0.0315, results={"cold_reply": True, "meeting_accepted": True}, patch=add(proposal)),
            outcome("reply_only", 0.0385, results={"cold_reply": True, "meeting_accepted": False}, patch=add(reply_event())),
            outcome("silent", 0.93, results={"cold_reply": False}),
        ],
    }
    parse(payload)
    broken = deepcopy(payload)
    broken["outcomes"][2]["base_rate_results"]["meeting_accepted"] = False
    with pytest.raises(ValueError, match="applicable declared"):
        parse(broken)


def test_due_events_must_be_delivered_by_an_observing_action_and_only_then():
    due = reply_event(at=START)
    state = world([due])
    check = {
        "schema": OUTCOME_V4_SCHEMA,
        "base_rates": [],
        "outcomes": [outcome("inbox", 1.0, delivered=["evt-reply-1"], content="1 new email from Dana Lee: ...")],
    }
    parse(check, state, at=START + HOUR, category="message")
    undelivered = deepcopy(check)
    undelivered["outcomes"][0]["delivered_event_ids"] = []
    with pytest.raises(ValueError, match="must be delivered"):
        parse(undelivered, state, at=START + HOUR, category="message")
    # A non-observing action need not report it; a future event cannot be delivered.
    parse(undelivered, state, at=START + HOUR, category="payment")
    with pytest.raises(ValueError, match="due"):
        parse(check, world([reply_event(at=START + 9 * HOUR)]), at=START + HOUR)
    marked, changed = outcomes.mark_delivered(state, ["evt-reply-1"], at_ms=START + HOUR)
    assert changed and marked["structured"]["scheduled_events"][0]["delivered_at_ms"] == START + HOUR
    assert outcomes.due_undelivered_events(marked, at_ms=START + 2 * HOUR) == []
    assert outcomes.mark_delivered(marked, ["evt-reply-1"], at_ms=START + 2 * HOUR)[1] is False


def test_explore_may_return_derived_warm_candidates_without_a_base_rate():
    research = {
        "schema": OUTCOME_V4_SCHEMA,
        "base_rates": [],
        "outcomes": [
            outcome(
                "candidates",
                1.0,
                content=(
                    "Inferred warm investor candidates (derived from message counts and fund email domains, "
                    "not verified relationships): Dana Lee (dana@example.vc, 64 messages, weekly)."
                ),
                patch=[{"op": "add", "path": "/structured/warm_candidates", "value": [{"email": "dana@example.vc"}]}],
                elapsed=600_000,
            )
        ],
    }
    parsed = parse(research, category="explore")
    assert parsed["outcomes"][0]["transition"]["state"]["structured"]["warm_candidates"]
    text = policies.execution_policy("rose-outcome-distribution-v4").text
    # The two-part standard is stated explicitly, and no earlier hedging survives.
    assert "Do not make up history." in text and "Do simulate the result of the intended action." in text
    assert "real measured tool completion time" in text
    for hedge in ("is not part of this observation", "examples, not constraints", "inquiry submission alone"):
        assert hedge not in text


def test_v4_response_schema_and_provider_boundary_validate_the_same_contract():
    from benchmarks.wmh_response_schema import response_model_for_protocol
    from benchmarks.wmh_rose_provider import _require_wmh_prediction

    model = response_model_for_protocol(OUTCOME_V4_PROTOCOL, expected_call_ids=("call-1",))
    model.model_validate(send_distribution())
    evidence = {
        "candidate_response": {
            "tool_calls": [{"call_id": "call-1", "arguments": {"category": "message", "timestamp_ms": START}}]
        },
        "environment_state": world(),
    }
    request = {"messages": [{"role": "user", "content": json.dumps(evidence)}]}
    kwargs = dict(protocol=OUTCOME_V4_PROTOCOL, expected_call_ids=("call-1",), base_state=world())
    _require_wmh_prediction(json.dumps(send_distribution()), {}, "m", request=request, **kwargs)
    with pytest.raises(Exception, match="base rate"):
        _require_wmh_prediction(json.dumps(send_distribution(0.5)), {}, "m", request=request, **kwargs)
    with pytest.raises(Exception, match="world time and category"):
        _require_wmh_prediction(json.dumps(send_distribution()), {}, "m", request=None, **kwargs)


USER_BASE_RATES = {
    "cold_reply": 0.07,
    "warm_reply": 0.35,
    "meeting_accepted": 0.45,
    "meeting_held": 0.85,
    "follow_up": 0.25,
    "verbal_commit": 0.05,
    "safe_signed": 0.95,
    "wire_settled": 0.95,
}


def test_canonical_user_base_rates_are_the_default_inserted_set(tmp_path):
    from benchmarks.benchmark_tasks import get_task_by_name
    from benchmarks.wmh_context_insertion import BASE_RATES_TEXT, load_canonical_base_rates, main

    assert {rate["key"]: rate["probability"] for rate in load_canonical_base_rates()} == USER_BASE_RATES
    out = tmp_path / "state.json"
    assert main(["--task", "raise-5m-rose-labs-brex", "--out", str(out)]) == 0
    state = json.loads(out.read_text())
    assert outcomes.world_base_rates(state) == USER_BASE_RATES
    assert state["scratchpad"].endswith(BASE_RATES_TEXT)
    # Researched examples are never inserted by default; the catalog seed is untouched.
    assert "outcome_distribution_examples" not in state["structured"]
    seed = get_task_by_name("raise-5m-rose-labs-brex").wmh_initial_state
    assert "base_rates" not in seed["structured"] and state["scratchpad"].startswith(seed["scratchpad"].rstrip())


def _network_state():
    columns = ["communicationFrequency", "email", "emailAddresses", "firstName", "id", "lastName",
               "messagesExchanged", "phoneNumber"]
    rows = [
        ["weekly", "dana@example.vc", ["dana@example.vc"], "Dana", "p1", "Lee", 64, None],
        ["rarely", "sam@acme.com", [], "Sam", "p2", "Roe", 1, "+1 (202) 555-0101"],
        ["rarely", None, ["kim@foundry.ventures"], "Kim", "p3", "Ito", 2, None],
        ["monthly", "pat@acme.com", [], "Pat", "p4", "Ng", 12, None],
    ]
    return {
        "structured": {
            "schema": "test",
            "as_of_utc": "2026-10-11T00:00:00Z",
            "network": {"static_full_network": {"row_columns": columns, "rows": rows, "shared_fields": {}}},
        },
        "scratchpad": "",
    }


def test_network_packet_carries_a_labeled_derived_warmth_signal():
    from benchmarks.wmh_context_insertion import derive_network_warmth

    state = derive_network_warmth(_network_state(), item_id="t")
    packet = state["structured"]["network"]["derived_warmth"]
    assert packet["source_verified"] is False and "not a source-verified" in packet["derivation"]
    rows = {row[0]: dict(zip(packet["columns"], row)) for row in packet["rows"]}
    assert rows["p1"]["derived_warmth"] == "strong" and rows["p1"]["investor_like_domain"] is True
    assert rows["p3"]["derived_warmth"] == "cold" and rows["p3"]["investor_like_domain"] is True
    assert rows["p4"]["derived_warmth"] == "warm" and "p2" not in rows
    assert packet["tier_counts"] == {"strong": 1, "warm": 1, "light": 0, "cold": 2}
    assert packet["investor_like_domain_contacts"] == 2
    # The original source rows are preserved unchanged.
    assert state["structured"]["network"]["static_full_network"] == _network_state()["structured"]["network"][
        "static_full_network"
    ]


def test_warm_metrics_are_computed_from_native_state_with_historical_and_new_leads_separate():
    from benchmarks.wmh_warm_metrics import warm_metrics

    def step(category, arguments, at):
        return {"action": {"name": f"rose.{category}", "arguments": {"category": category, "arguments": arguments,
                                                                      "timestamp_ms": at}}}

    new_reply = dict(reply_event("evt-new"), **{"from": "Ola Ade <ola@newfund.vc>", "delivered_at_ms": START + 5})
    pending = dict(reply_event("evt-pending"), **{"from": "Ivy <ivy@later.vc>"})
    retirement = {
        "history": [
            step("explore", {"goal": "research dana@example.vc and pat@acme.com"}, START),
            step("message", {"to": "dana@example.vc", "body": "Hi Dana"}, START + 1),
            step("browser", {"goal": "Email ola@newfund.vc a pitch"}, START + 2),
            step("message", {"to": "ola@newfund.vc", "body": "Thanks for replying"}, START + 10),
        ],
        "state": {"structured": {"scheduled_events": [new_reply, pending]}},
    }
    metrics = warm_metrics(_network_state(), retirement)
    assert metrics["historical"] == {
        "network_contacts": 4,
        "warm_leads": 2,
        "warm_investor_like_leads": 1,
        "warm_leads_followed_up": 1,
        "warm_investor_like_leads_followed_up": 1,
    }
    assert metrics["new"] == {"warm_leads": 1, "warm_leads_followed_up": 1}
    assert metrics["outreach_steps"] == 3 and metrics["committed_steps"] == 4


# --- Structured applicability: a matching send must declare its base rate ---------------


def _canonical_world(events=()):
    from benchmarks.wmh_context_insertion import load_canonical_base_rates

    state = world(events)
    state["structured"]["base_rates"] = load_canonical_base_rates()
    return state


def _call(name="message_transport_send", category="message", **arguments):
    # Shapes verified against native Run13-18 retirement receipts.
    if name == "message_transport_send" and not arguments:
        arguments = {"channel": "email", "to_email": "dana@example.vc", "from_email": "tamara@roselabs.ai",
                     "subject": "Rose Labs", "message": "Hi Dana"}
    return {"schema": "rose.canonical_action.v1", "category": category, "name": name, "arguments": arguments}


def _undeclared_send():
    return {"schema": OUTCOME_V4_SCHEMA, "base_rates": [], "outcomes": [outcome("delivered", 1.0)]}


def _parse_call(payload, state, action):
    return parse_distribution(
        json.dumps(payload),
        base_state=state,
        expected_call_ids=("call-1",),
        protocol=OUTCOME_V4_PROTOCOL,
        at_ms=START,
        action_arguments=action,
    )


def test_send_matching_applies_to_without_a_declaration_is_rejected():
    with pytest.raises(ValueError, match="must be declared"):
        _parse_call(_undeclared_send(), _canonical_world(), _call())
    # Declaring either member of the first_response group satisfies it; the base-rate mass check still applies.
    _parse_call(send_distribution(), _canonical_world(), _call())
    warm = send_distribution(0.35)
    warm["base_rates"][0]["key"] = "warm_reply"
    for item in warm["outcomes"]:
        item["base_rate_results"] = {"warm_reply": item["base_rate_results"]["cold_reply"]}
    warm["outcomes"][0]["state_patch"][0]["value"]["base_rate_key"] = "warm_reply"
    _parse_call(warm, _canonical_world(), _call())


def test_reads_and_unmatched_calls_are_not_forced_to_declare_send_rates():
    state = _canonical_world()
    for action in (
        _call("spawn_browser_agent", "browser", goal="Read the Gmail inbox for replies", type="browser"),
        _call("spawn_explore_agent", "explore", goal="Find warm investor contacts", type="explore"),
        _call("notify_sms_event", "message", event_type="progress", payload={}),
        _call("message_transport_send", "message", channel="email", to_email="  "),
    ):
        _parse_call(_undeclared_send(), state, action)
    # An inbox check delivers a due reply instead (already enforced by v4).
    due = dict(reply_event(at=START), **{"from": "Dana Lee <dana@example.vc>"})
    inbox = _call("spawn_browser_agent", "browser", goal="Check Gmail", type="browser")
    delivered = {"schema": OUTCOME_V4_SCHEMA, "base_rates": [],
                 "outcomes": [outcome("inbox", 1.0, delivered=["evt-reply-1"], content="1 new email from Dana Lee")]}
    _parse_call(delivered, _canonical_world([due]), inbox)


def test_given_conditioned_rate_is_required_only_when_its_state_precondition_holds():
    replied = dict(reply_event("evt-old", at=START - HOUR), **{"from": "Dana Lee <Dana@Example.vc>",
                                                             "delivered_at_ms": START - HOUR + 5})
    undelivered = dict(replied)
    undelivered.pop("delivered_at_ms")

    def meeting_distribution():
        proposal = dict(reply_event("evt-meeting"), kind="meeting_proposal", base_rate_key="meeting_accepted")
        return {
            "schema": OUTCOME_V4_SCHEMA,
            "base_rates": [{"key": "meeting_accepted", "given": None, "deviation_reason": None}],
            "outcomes": [
                outcome("accepts", 0.45, results={"meeting_accepted": True},
                        patch=[{"op": "add", "path": "/structured/scheduled_events/-", "value": proposal}]),
                outcome("no_meeting", 0.55, results={"meeting_accepted": False}),
            ],
        }

    # Dana already replied (delivered): a follow-up send must declare meeting acceptance, not a first reply.
    with pytest.raises(ValueError, match="must be declared"):
        _parse_call(send_distribution(), _canonical_world([replied]), _call())
    _parse_call(meeting_distribution(), _canonical_world([replied]), _call())
    # Without a delivered reply from this counterparty the precondition does not hold.
    with pytest.raises(ValueError, match="must be declared"):
        _parse_call(meeting_distribution(), _canonical_world([undelivered]), _call())
    other = _call(channel="email", to_email="sam@other.vc", message="Hi Sam")
    with pytest.raises(ValueError, match="must be declared"):
        _parse_call(meeting_distribution(), _canonical_world([replied]), other)
    _parse_call(send_distribution(), _canonical_world([replied]), other)


def test_provider_boundary_rejects_an_undeclared_send_for_protocol_repair():
    from benchmarks.wmh_rose_provider import _require_wmh_prediction

    state = _canonical_world()
    evidence = {"candidate_response": {"tool_calls": [{"call_id": "call-1", "arguments": dict(_call(), timestamp_ms=START)}]},
                "environment_state": state}
    request = {"messages": [{"role": "user", "content": json.dumps(evidence)}]}
    kwargs = dict(protocol=OUTCOME_V4_PROTOCOL, expected_call_ids=("call-1",), base_state=state, request=request)
    with pytest.raises(Exception, match="must be declared"):
        _require_wmh_prediction(json.dumps(_undeclared_send()), {}, "m", **kwargs)
    _require_wmh_prediction(json.dumps(send_distribution()), {}, "m", **kwargs)


def test_canonical_fixture_applicability_is_structured_and_validated():
    from benchmarks.wmh_context_insertion import load_canonical_base_rates, validated_base_rates

    rates = {rate["key"]: rate for rate in load_canonical_base_rates()}
    send = [{"category": "message", "tool": "message_transport_send", "argument": "to_email"}]
    assert {k for k, r in rates.items() if "applies_to" in r} == {"cold_reply", "warm_reply", "meeting_accepted"}
    assert all(rates[k]["applies_to"] == send for k in ("cold_reply", "warm_reply", "meeting_accepted"))
    assert rates["cold_reply"]["group"] == rates["warm_reply"]["group"] == "first_response"
    assert rates["meeting_accepted"]["precondition"]["present"] is True
    assert rates["cold_reply"]["applies_to_outreach"] == {"warm": False}
    assert rates["warm_reply"]["applies_to_outreach"] == {"warm": True}
    bad = deepcopy(list(rates.values()))
    bad[0]["precondition"]["delivered_base_rate_keys"] = ["unlisted"]
    with pytest.raises(ValueError, match="unlisted"):
        validated_base_rates(bad)
    bad = deepcopy(list(rates.values()))
    bad[0].pop("applies_to")
    bad[0].pop("applies_to_outreach")
    with pytest.raises(ValueError, match="precondition"):
        validated_base_rates(bad)


# --- Effect rule: recorded outreach (browser sends/forms included) declares its rate ----------


def _record(warm=False, counterparty="craftventures.com", record_id="out-1", kind="form_submission"):
    return {"id": record_id, "counterparty": counterparty, "channel": "form", "kind": kind, "warm": warm}


def _browser_form(declare=None, probability=0.07, *, warm=False, counterparty="craftventures.com"):
    add = [{"op": "add", "path": "/structured/outreach", "value": [_record(warm, counterparty)]}]
    reply = dict(reply_event(), **{"from": f"Partner <partner@{counterparty}>", "base_rate_key": declare})
    if declare is None:
        return {"schema": OUTCOME_V4_SCHEMA, "base_rates": [],
                "outcomes": [outcome("submitted", 1.0, patch=add, content="Form submitted: Thank you")]}
    return {
        "schema": OUTCOME_V4_SCHEMA,
        "base_rates": [{"key": declare, "given": None, "deviation_reason": None}],
        "outcomes": [
            outcome("submitted_reply", probability, results={declare: True}, content="Form submitted: Thank you",
                    patch=add + [{"op": "add", "path": "/structured/scheduled_events/-", "value": reply}]),
            outcome("submitted_silent", round(1 - probability, 10), results={declare: False}, patch=add,
                    content="Form submitted: Thank you"),
        ],
    }


BROWSER = _call("spawn_browser_agent", "browser", goal="Submit the Craft Ventures contact form", type="browser")


def test_browser_outcome_recording_a_submission_without_a_declaration_is_rejected():
    with pytest.raises(ValueError, match="first-response base rate"):
        _parse_call(_browser_form(), _canonical_world(), BROWSER)
    # Warmth is structural: a warm record needs warm_reply, not cold_reply.
    with pytest.raises(ValueError, match="first-response base rate"):
        _parse_call(_browser_form("cold_reply", warm=True), _canonical_world(), BROWSER)


def test_browser_outcome_recording_a_submission_with_both_branches_passes():
    parsed = _parse_call(_browser_form("cold_reply"), _canonical_world(), BROWSER)
    assert [o["probability"] for o in parsed["outcomes"]] == [0.07, 0.93]
    assert parsed["outcomes"][1]["transition"]["state"]["structured"]["outreach"] == [_record()]
    _parse_call(_browser_form("warm_reply", 0.35, warm=True), _canonical_world(), BROWSER)
    # Both branches remain mandatory: certainty is still rejected.
    certain = _browser_form("cold_reply")
    certain["outcomes"] = [dict(certain["outcomes"][1], probability=1.0)]
    with pytest.raises(ValueError, match="both outcomes"):
        _parse_call(certain, _canonical_world(), BROWSER)


def test_outcomes_without_outreach_effects_or_after_a_delivered_reply_are_not_forced():
    read = {"schema": OUTCOME_V4_SCHEMA, "base_rates": [],
            "outcomes": [outcome("read", 1.0, content="Contact page lists a form")]}
    _parse_call(read, _canonical_world(), BROWSER)
    replied = dict(reply_event("evt-old", at=START - HOUR), **{"from": "Partner <partner@craftventures.com>",
                                                             "delivered_at_ms": START - HOUR + 5})
    _parse_call(_browser_form(), _canonical_world([replied]), BROWSER)


@pytest.mark.parametrize(
    "record",
    [
        {"id": "out-1", "counterparty": "craftventures.com", "channel": "form", "kind": "form_submission"},
        dict(_record(), kind="visit"),
        dict(_record(), warm="no"),
        dict(_record(), counterparty=" "),
        dict(_record(), note="extra"),
    ],
)
def test_outreach_records_need_the_exact_structured_fields(record):
    payload = _browser_form("cold_reply")
    for item in payload["outcomes"]:
        item["state_patch"][0]["value"] = [record]
    with pytest.raises(ValueError, match="outreach|Outreach"):
        _parse_call(payload, _canonical_world(), BROWSER)


def test_outreach_ledger_is_append_only():
    state = _canonical_world()
    state["structured"]["outreach"] = [_record(record_id="out-0", counterparty="old.vc")]
    rewrite = {"schema": OUTCOME_V4_SCHEMA, "base_rates": [], "outcomes": [
        outcome("rewrite", 1.0, patch=[{"op": "replace", "path": "/structured/outreach/0/warm", "value": True}])]}
    with pytest.raises(ValueError, match="append-only"):
        _parse_call(rewrite, state, BROWSER)
    duplicate = _browser_form("cold_reply")
    for item in duplicate["outcomes"]:
        item["state_patch"][0] = {"op": "add", "path": "/structured/outreach/-", "value": _record(record_id="out-0")}
    with pytest.raises(ValueError, match="unique"):
        _parse_call(duplicate, state, BROWSER)
