"""Append-only WMH wire stream: lossless folding, stable prefixes and fresh-stream boundaries.

Run by the WMH blackbox gate. The canonical native evidence stays the source of
truth; every rendering must fold back to it exactly (2026-10-12 caching design).
"""

import asyncio
import json
import random
from copy import deepcopy

import pytest

from benchmarks.wmh_outcomes import apply_state_patch
from benchmarks.wmh_wire_stream import StreamBook, diff_state, fold_stream


def same(a, b):
    """Strict JSON equality: True, 1 and 1.0 are different values."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def batch(*call_ids, note=""):
    return [{"role": "assistant", "assistant_action": {"tool_calls": [
        {"call_id": call_id, "name": "browser", "arguments": {"goal": note or call_id}} for call_id in call_ids
    ]}}, *[{"role": "tool", "tool_call_id": call_id, "content": f"result {call_id}"} for call_id in call_ids]]


def evidence(history, *, state=None, examples=("t1",), contexts=("c1",), call="next", tools=("browser",)):
    return {
        "task": {"initial_context": {"company": "Rose Labs"}, "instruction": "Raise", "task_id": "root",
                 "tools": [{"name": name} for name in tools]},
        "grounding_schema_version": "v1",
        "grounding_contexts": {cid: {"context": f"context {cid}"} for cid in contexts},
        "grounded_examples": [{"transition_id": tid, "context_ref": "c1",
                               "action": f"act {tid}", "observation": f"obs {tid}"} for tid in examples],
        "visible_conversation": history,
        "environment_state": state if state is not None else {"structured": {"funds": [], "cash": 0}, "scratchpad": "s"},
        "candidate_response": {"tool_calls": [{"call_id": call, "name": "browser", "arguments": {"agent_id": "a"}}]},
    }


def render(book, key, ev):
    rendered = asyncio.run(book.render(key, ev))
    assert rendered is not None
    units, final = rendered
    assert same(fold_stream(units, final), ev)
    return units, final


# -- state diffs -------------------------------------------------------------


def _random_value(rng, depth):
    kind = rng.randrange(7 if depth < 3 else 4)
    if kind == 0:
        return rng.choice([True, False, None])
    if kind == 1:
        return rng.choice([0, 1, -3, 7])
    if kind == 2:
        return rng.choice([1.0, 0.5, 2.25])
    if kind == 3:
        return rng.choice(["", "a", "a/b", "~x", "~1", "π"])
    if kind in (4, 5):
        return {rng.choice(["k", "a/b", "~", "x~1", "n", "m"]) + str(i): _random_value(rng, depth + 1)
                for i in range(rng.randrange(4))}
    return [_random_value(rng, depth + 1) for _ in range(rng.randrange(4))]


def _mutate(rng, value, depth=0):
    if isinstance(value, dict) and value and rng.random() < 0.8:
        value = dict(value)
        key = rng.choice(list(value))
        action = rng.randrange(4)
        if action == 0:
            del value[key]
        elif action == 1:
            value[key + "_new"] = _random_value(rng, depth + 1)
        else:
            value[key] = _mutate(rng, value[key], depth + 1)
        return value
    if isinstance(value, list) and rng.random() < 0.8:
        value = list(value)
        action = rng.randrange(4)
        if action == 0:
            value.append(_random_value(rng, depth + 1))
        elif action == 1 and value:
            value.pop(rng.randrange(len(value)))
        elif value:
            index = rng.randrange(len(value))
            value[index] = _mutate(rng, value[index], depth + 1)
        return value
    # Scalar type swaps (bool vs number vs float) must survive the diff.
    return rng.choice([True, 1, 1.0, "1", None, [], {}])


def test_state_diff_is_lossless_and_type_exact_on_random_documents():
    rng = random.Random(20261012)
    for _ in range(600):
        old = {"structured": _random_value(rng, 0), "scratchpad": rng.choice(["", "s", "notes"])}
        new = deepcopy(old)
        for _ in range(rng.randrange(1, 5)):
            new = _mutate(rng, new)
        if not isinstance(new, dict):
            new = {"root": new}
        ops = diff_state(old, new)
        assert same(apply_state_patch(old, ops), new)
        assert diff_state(new, new) == []


def test_state_diff_turns_list_growth_into_appends():
    old = {"funds": [{"name": "a"}], "count": 1}
    new = {"funds": [{"name": "a"}, {"name": "b"}], "count": 2}
    assert diff_state(old, new) == [
        {"op": "add", "path": "/funds/-", "value": {"name": "b"}},
        {"op": "replace", "path": "/count", "value": 2},
    ]


# -- rendering ---------------------------------------------------------------


def test_each_call_repeats_the_previous_stream_and_appends_only_what_is_new():
    book = StreamBook()
    first = evidence([{"role": "user", "content": "Raise the round"}])
    history = first["visible_conversation"] + batch("a", "b")
    second = evidence(history, state={"structured": {"funds": [{"name": "Pear"}], "cash": 0}, "scratchpad": "s"},
                      examples=("t1", "t2"), contexts=("c1", "c2"), call="n2", tools=("explore",))
    third = evidence(history + batch("c"), state={"structured": {"funds": [{"name": "Pear"}, {"name": "Amplify"}],
                                                                 "cash": 0}, "scratchpad": "s"},
                     examples=("t2", "t3"), contexts=("c2",), call="n3")
    units1, final1 = render(book, "s:a", first)
    units2, final2 = render(book, "s:a", second)
    units3, final3 = render(book, "s:a", third)
    assert units2[: len(units1)] == units1 and units3[: len(units2)] == units2
    tags = [next(iter(json.loads(unit))) for unit in units3]
    assert tags == [
        "task", "environment_state_baseline", "reference_material",
        "visible_conversation", "environment_state_changes", "reference_material",
        "visible_conversation", "environment_state_changes", "reference_material",
    ]
    # The baseline is sent once; later calls carry only the change.
    assert json.loads(units3[7])["environment_state_changes"] == [
        {"op": "add", "path": "/structured/funds/-", "value": {"name": "Amplify"}}
    ]
    # An example is sent once; the current call names the ones that apply.
    assert json.loads(units3[8])["reference_material"] == {"grounded_examples": [third["grounded_examples"][1]]}
    assert json.loads(final3)["current_call"]["grounded_example_ids"] == ["t2", "t3"]
    # Per-call evidence (tools, candidate) never enters the stream.
    assert all('"candidate_response"' not in unit and '"tools"' not in unit for unit in units3)


def test_an_unfinished_tool_batch_stays_in_the_current_call_until_complete():
    book = StreamBook()
    head = [{"role": "user", "content": "go"}]
    partial = head + batch("a", "b")[:-1]
    units, final = render(book, "s:a", evidence(partial))
    assert not any(json.loads(unit).get("visible_conversation") for unit in units)
    assert json.loads(final)["current_call"]["visible_conversation_tail"] == partial
    units2, final2 = render(book, "s:a", evidence(head + batch("a", "b")))
    assert json.loads(units2[-1])["visible_conversation"] == head + batch("a", "b")
    assert json.loads(final2)["current_call"]["visible_conversation_tail"] == []


def test_fold_preserves_absent_and_future_fields():
    book = StreamBook()
    ev = evidence([])
    del ev["grounding_contexts"]
    ev["future_field"] = {"nested": ["keep", 1, True]}
    render(book, "s:a", ev)
    ev2 = deepcopy(ev)
    del ev2["grounding_schema_version"]
    render(book, "s:a", ev2)


def test_parallel_calls_of_one_agent_render_the_same_prefix():
    async def scenario():
        book = StreamBook()
        base = evidence([{"role": "user", "content": "go"}] + batch("a"))
        calls = []
        for call in ("p1", "p2", "p3"):
            ev = deepcopy(base)
            ev["candidate_response"]["tool_calls"][0]["call_id"] = call
            calls.append(ev)
        return await asyncio.gather(*(book.render("s:a", ev) for ev in calls))

    results = asyncio.run(scenario())
    assert results[0][0] == results[1][0] == results[2][0]
    assert len({final for _, final in results}) == 3


def test_an_older_world_after_a_newer_one_is_still_exact():
    book = StreamBook()
    new = evidence([], state={"structured": {"funds": ["a", "b"]}, "scratchpad": ""})
    old = evidence([], state={"structured": {"funds": ["a"]}, "scratchpad": ""}, call="late")
    render(book, "s:a", new)
    render(book, "s:a", old)


@pytest.mark.parametrize("reason", ["task_changed", "changes_exceed_baseline"])
def test_a_new_task_or_outgrown_baseline_starts_a_fresh_world_stream(reason):
    book = StreamBook(max_change_ratio=0.5, min_change_chars=0)
    history = [{"role": "user", "content": "go"}] + batch("a")
    units, _ = render(book, "w", evidence(history))
    nxt = evidence(history + batch("b"))
    if reason == "task_changed":
        nxt["task"]["instruction"] = "Raise more"
    else:
        nxt["environment_state"]["structured"]["notes"] = "x" * 5_000
    fresh, _ = render(book, "w", nxt)
    assert fresh[: len(units)] != units
    assert [next(iter(json.loads(unit))) for unit in fresh[:2]] == ["task", "environment_state_baseline"]
    assert book.resets[-1] == reason


def test_a_new_agent_reuses_everything_other_agents_already_sent():
    """Run 7 (2026-10-12): every child's first call carried the world's shared history,
    re-sent uncached by per-agent streams (first calls read 11-40%)."""
    book = StreamBook()
    history = [{"role": "user", "content": "go"}] + batch("a") + batch("b")
    root, _ = render(book, "w", evidence(history, call="root-next"))
    child = evidence(history, call="child-first")
    child["candidate_response"]["tool_calls"][0]["arguments"]["agent_id"] = "child"
    units, final = render(book, "w", child)
    assert units == root and json.loads(final)["current_call"]["candidate_response"]["tool_calls"][0]["call_id"] == "child-first"
    assert book.branches == 0


def test_an_older_request_branches_without_moving_the_world_stream():
    book = StreamBook()
    head = [{"role": "user", "content": "go"}] + batch("a")
    newer, _ = render(book, "w", evidence(head + batch("b"), state={"structured": {"funds": ["a", "b"]}, "scratchpad": ""}))
    older, _ = render(book, "w", evidence(head + batch("c"), state={"structured": {"funds": ["a"]}, "scratchpad": ""},
                                          call="older"))
    # It reuses the shared prefix up to its last common batch, then branches.
    shared = next(i for i, (x, y) in enumerate(zip(newer, older)) if x != y)
    assert json.loads(newer[shared - 1]) == {"visible_conversation": head}
    assert book.branches == 1
    # The world stream still belongs to the newest request.
    latest, _ = render(book, "w", evidence(head + batch("b") + batch("d"),
                                           state={"structured": {"funds": ["a", "b"]}, "scratchpad": ""}))
    assert latest[: len(newer)] == newer


def test_a_redefined_reference_is_sent_again_and_the_later_one_applies():
    book = StreamBook()
    first = evidence([{"role": "user", "content": "go"}], examples=("t1",))
    units, _ = render(book, "w", first)
    changed = evidence([{"role": "user", "content": "go"}], examples=("t1",), call="later")
    changed["grounded_examples"][0]["observation"] = "different text, same id"
    later, _ = render(book, "w", changed)
    assert later[: len(units)] == units and not book.resets
    assert json.loads(later[-1])["reference_material"]["grounded_examples"] == changed["grounded_examples"]


def test_unrecognized_evidence_is_not_streamed():
    book = StreamBook()
    for broken in (
        {k: v for k, v in evidence([]).items() if k != "environment_state"},
        {**evidence([]), "visible_conversation": "opaque"},
        {**evidence([]), "grounded_examples": [{"no_id": True}]},
        {**evidence([]), "grounded_examples": [{"transition_id": "t"}, {"transition_id": "t"}]},
    ):
        assert asyncio.run(book.render("s:a", broken)) is None


def test_units_are_byte_identical_for_identical_evidence_in_any_key_order():
    ev = evidence([{"role": "user", "content": "go"}] + batch("a"))
    reordered = json.loads(json.dumps(ev, sort_keys=True))
    reordered = {key: reordered[key] for key in reversed(list(reordered))}
    a = asyncio.run(StreamBook().render("s:a", ev))
    b = asyncio.run(StreamBook().render("s:b", reordered))
    assert a == b


def _change_stream(changes, unit_patch=None):
    units = [json.dumps({"task": {"instruction": "Raise"}}),
             json.dumps({"environment_state_baseline": {"structured": {"log": [], "funds": ["y" * 200] * 50}}})]
    for n in range(changes):
        patch = unit_patch(n) if unit_patch else [{"op": "add", "path": "/structured/log/-", "value": {"n": n}}]
        units.append(json.dumps({"environment_state_changes": patch}))
    return units, json.dumps({"current_call": {"visible_conversation_tail": []}})


def _reference_state(units):
    state = None
    for text in units:
        (tag, value), = json.loads(text).items()
        if tag == "environment_state_baseline":
            state = deepcopy(value)
        elif tag == "environment_state_changes":
            state = apply_state_patch(state, value)
    return state


def test_fold_encodes_the_whole_state_once_not_once_per_change(monkeypatch):
    """SIM run 7: a fold re-copied and re-encoded the whole world state per change unit (quadratic)."""
    import benchmarks.wmh_wire_stream as wire

    units, final = _change_stream(300)
    full = []
    real = wire.apply_state_patch

    def counted(state, patch):
        full.append(1)
        return real(state, patch)

    monkeypatch.setattr(wire, "apply_state_patch", counted)
    folded = fold_stream(units, final)
    assert len(full) == 1, f"{len(full)} whole-state copies for 300 changes"
    assert same(folded["environment_state"], _reference_state(units))
    assert [entry["n"] for entry in folded["environment_state"]["structured"]["log"]] == list(range(300))


def test_linear_fold_keeps_per_unit_finite_json_and_error_semantics():
    nan = float("nan")
    # A non-finite value written and removed within one unit is finite at that unit's end.
    transient, final = _change_stream(3, lambda n: [{"op": "add", "path": "/structured/tmp", "value": nan},
                                                    {"op": "remove", "path": "/structured/tmp"}])
    assert same(fold_stream(transient, final)["environment_state"], _reference_state(transient))
    # A non-finite value that survives a later unit fails exactly like the per-unit reference.
    kept, final = _change_stream(
        3, lambda n: [{"op": "add", "path": f"/structured/v{n}", "value": nan if n == 2 else n}]
    )
    with pytest.raises(ValueError):
        _reference_state(kept)
    with pytest.raises(ValueError):
        fold_stream(kept, final)
    # A missing target still fails the fold.
    broken, final = _change_stream(2, lambda n: [{"op": "replace", "path": "/structured/absent", "value": n}])
    with pytest.raises(ValueError):
        fold_stream(broken, final)
