"""Append-only wire stream for native WMH evidence: one stream per world session.

The native world model's evidence object (full world snapshot, retrieval,
history, candidate) stays the source of truth: replay keys, outcome checks and
prediction records all use it. On the wire, GPT-6.1 prompt caching reuses only
an exact prefix ending at a cache breakpoint (measured on Azure 2026-10-12), so
each agent's evidence is rendered as a stream it only ever appends to:

    instructions   policy + STREAM_GUIDE
    user ◆         {"task": fixed task fields}
    user ◆         {"environment_state_baseline": world state when the stream began}
    user ◆         {"visible_conversation": [one completed tool batch]}   (repeats)
    user ◆         {"environment_state_changes": [JSON Patch since the agent's last call]}
    user ◆         {"reference_material": {contexts and examples not sent before}}
    ...            (later calls append; earlier messages never change)
    user           {"current_call": example ids, history tail, tools, candidate}

    ◆ = cache breakpoint

A call repeats the previous call's stream byte for byte and appends only what
is new. Every rendering is folded back and must equal the canonical evidence
exactly; otherwise the caller falls back to the canonical layout. A break in
append-only evidence (history rewritten, task or a reference changed, changes
outgrowing the baseline, an oversized stream) starts a fresh stream.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from benchmarks.wmh_outcomes import apply_state_patch, apply_state_patch_in_place

STREAM_GUIDE = (
    "\n\nWORLD EVIDENCE STREAM: this step's evidence object arrives as the following user messages, oldest "
    'first, each a JSON object with one key. "task" holds the task\'s fixed fields. '
    '"environment_state_baseline" is the environment_state when this stream began; each later '
    '"environment_state_changes" is a JSON Patch list, applied in order, so the supplied environment_state '
    "(the state your state_patch applies to) is the baseline with every change applied. "
    '"visible_conversation" messages are the world\'s shared history, in order. "reference_material" adds '
    'grounding contexts and grounded examples, keyed by id. The final "current_call" message completes the '
    "object: grounding_context_ids and grounded_example_ids name the material that applies to this step, "
    "visible_conversation_tail ends the history, task adds the candidate's tools, and candidate_response is "
    "the action to predict."
)

STABLE_TASK_KEYS = ("initial_context", "instruction", "task_id")
UNIT_TAGS = (
    "task",
    "environment_state_baseline",
    "visible_conversation",
    "environment_state_changes",
    "reference_material",
)
_STREAMED_KEYS = {"task", "grounding_contexts", "grounded_examples", "visible_conversation", "environment_state"}
_CALL_KEYS = {"task", "visible_conversation_tail", "grounding_context_ids", "grounded_example_ids"}


def encode(value: Any) -> str:
    """Byte-stable JSON for stream units: identical values always render identically."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def _same(a: Any, b: Any) -> bool:
    # Strict JSON equality: True, 1 and 1.0 differ even though Python says they are equal.
    return encode(a) == encode(b)


def _escape(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def diff_state(old: dict, new: dict) -> list[dict]:
    """A JSON Patch that turns ``old`` into exactly ``new`` (list growth becomes appends)."""
    if not isinstance(old, dict) or not isinstance(new, dict):
        raise ValueError("World state diff requires two objects")
    operations: list[dict] = []
    _diff(old, new, "", operations)
    return operations


def _diff(old: Any, new: Any, path: str, operations: list[dict]) -> None:
    if _same(old, new):
        return
    if isinstance(old, dict) and isinstance(new, dict):
        for key in old:
            if key not in new:
                operations.append({"op": "remove", "path": f"{path}/{_escape(key)}"})
        for key, value in new.items():
            if key in old:
                _diff(old[key], value, f"{path}/{_escape(key)}", operations)
            else:
                operations.append({"op": "add", "path": f"{path}/{_escape(key)}", "value": deepcopy(value)})
        return
    if isinstance(old, list) and isinstance(new, list):
        if len(new) >= len(old) and all(_same(a, b) for a, b in zip(old, new)):
            operations.extend({"op": "add", "path": f"{path}/-", "value": deepcopy(v)} for v in new[len(old):])
            return
        if len(new) == len(old):
            for index, (a, b) in enumerate(zip(old, new)):
                _diff(a, b, f"{path}/{index}", operations)
            return
    operations.append({"op": "replace", "path": path, "value": deepcopy(new)})


def completed_batch_ends(history: list) -> set[int]:
    """Indices that end a complete assistant tool-call batch (every declared result present)."""
    ends = set()
    pending = None
    for index, entry in enumerate(history):
        if entry.get("role") == "assistant":
            action = entry.get("assistant_action")
            calls = action.get("tool_calls") if isinstance(action, dict) else None
            ids = [call.get("call_id") for call in calls] if isinstance(calls, list) and all(isinstance(call, dict) for call in calls) else []
            valid = ids and all(isinstance(value, str) and value for value in ids)
            pending = set(ids) if valid and len(set(ids)) == len(ids) else None
        elif entry.get("role") == "tool" and pending is not None:
            result_id = entry.get("tool_call_id")
            if not isinstance(result_id, str) or result_id not in pending:
                pending = None
            else:
                pending.remove(result_id)
                if not pending and (index + 1 == len(history) or history[index + 1].get("role") != "tool"):
                    ends.add(index)
                    pending = None
        else:
            pending = None
    return ends


def streamable(evidence: Any) -> bool:
    """Only well-formed native evidence is streamed; anything else keeps the canonical layout."""
    if not isinstance(evidence, dict) or (_CALL_KEYS - {"task"}) & set(evidence):
        return False
    task = evidence.get("task")
    if not isinstance(task, dict) or not all(key in task for key in STABLE_TASK_KEYS):
        return False
    history = evidence.get("visible_conversation")
    if not isinstance(history, list) or not all(isinstance(entry, dict) for entry in history):
        return False
    if not isinstance(evidence.get("environment_state"), dict):
        return False
    if "grounding_contexts" in evidence and not isinstance(evidence["grounding_contexts"], dict):
        return False
    if "grounded_examples" in evidence:
        examples = evidence["grounded_examples"]
        if not isinstance(examples, list) or not all(
            isinstance(e, dict) and isinstance(e.get("transition_id"), str) and e["transition_id"] for e in examples
        ):
            return False
        if len({e["transition_id"] for e in examples}) != len(examples):
            return False
    try:
        encode(evidence)
    except (TypeError, ValueError):
        return False
    return True


def fold_stream(units: list[str], final: str) -> dict:
    """Rebuild the exact evidence object a stream rendering encodes."""
    task = state = None
    # Every unit is freshly decoded, so nothing here aliases the caller's data.
    # Change units apply in place to one private copy of the baseline. The
    # result equals applying apply_state_patch per unit; re-encoding the whole
    # state after every unit made each fold quadratic in the world's history,
    # and the provider folds every request on its one event loop (SIM run 7).
    owned = False
    history: list = []
    contexts: dict = {}
    examples: dict = {}
    for text in units:
        unit = json.loads(text)
        if not isinstance(unit, dict) or len(unit) != 1:
            raise ValueError("A stream unit holds exactly one tagged value")
        (tag, value), = unit.items()
        if tag == "task":
            task = value
        elif tag == "environment_state_baseline":
            state, owned = value, False
        elif tag == "environment_state_changes":
            if not owned:
                state, owned = apply_state_patch(state, value), True
            elif not apply_state_patch_in_place(state, value):
                json.dumps(state, allow_nan=False)
        elif tag == "visible_conversation":
            history.extend(value)
        elif tag == "reference_material":
            contexts.update(value.get("grounding_contexts", {}))
            examples.update({example["transition_id"]: example for example in value.get("grounded_examples", [])})
        else:
            raise ValueError(f"Unknown stream unit {tag!r}")
    call = json.loads(final)
    if not isinstance(call, dict) or list(call) != ["current_call"] or not isinstance(task, dict) or state is None:
        raise ValueError("A stream needs its task, a baseline and a final current_call")
    call = call["current_call"]
    evidence = {"task": {**task, **call.get("task", {})}}
    evidence.update({key: value for key, value in call.items() if key not in _CALL_KEYS})
    evidence["visible_conversation"] = history + call["visible_conversation_tail"]
    evidence["environment_state"] = state
    if "grounding_context_ids" in call:
        evidence["grounding_contexts"] = {cid: contexts[cid] for cid in call["grounding_context_ids"]}
    if "grounded_example_ids" in call:
        evidence["grounded_examples"] = [examples[tid] for tid in call["grounded_example_ids"]]
    return evidence


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _final(evidence: dict, history_len: int) -> str:
    call: dict = {}
    if "grounding_contexts" in evidence:
        call["grounding_context_ids"] = list(evidence["grounding_contexts"])
    if "grounded_examples" in evidence:
        call["grounded_example_ids"] = [e["transition_id"] for e in evidence["grounded_examples"]]
    call["visible_conversation_tail"] = evidence["visible_conversation"][history_len:]
    remainder = {key: value for key, value in evidence["task"].items() if key not in STABLE_TASK_KEYS}
    if remainder:
        call["task"] = remainder
    for key, value in evidence.items():
        if key not in _STREAMED_KEYS and key != "candidate_response":
            call[key] = value
    if "candidate_response" in evidence:
        call["candidate_response"] = evidence["candidate_response"]
    # Fixed field order (candidate last), byte-stable values.
    fields = ",".join(f"{json.dumps(key, ensure_ascii=False)}:{encode(value)}" for key, value in call.items())
    return '{"current_call":{' + fields + "}}"


@dataclass
class _WorldStream:
    """A world's append-only stream and the evidence it encodes after each prefix.

    Index k of ``history``, ``worlds`` and ``refs`` describes ``units[:k]``.
    """

    task: str
    units: list[str] = field(default_factory=list)
    history: list[int] = field(default_factory=list)
    worlds: list = field(default_factory=list)
    refs: list[dict] = field(default_factory=list)
    baseline_chars: int = 0
    change_chars: int = 0
    chars: int = 0

    @classmethod
    def start(cls, evidence: dict) -> "_WorldStream":
        stable = {key: evidence["task"][key] for key in STABLE_TASK_KEYS}
        stream = cls(task=encode(stable), history=[0], worlds=[None], refs=[{}])
        stream.append(encode({"task": stable}), 0, None, {})
        baseline = encode({"environment_state_baseline": evidence["environment_state"]})
        stream.append(baseline, 0, deepcopy(evidence["environment_state"]), {})
        stream.baseline_chars = len(baseline)
        return stream

    def append(self, unit: str, history: int, world, refs: dict) -> None:
        self.units.append(unit)
        self.history.append(history)
        self.worlds.append(world)
        self.refs.append(refs)
        self.chars += len(unit)

    def deepest_prefix(self, history: list) -> int:
        """Longest prefix whose history units are this request's history, in order."""
        k, covered = 2, 0
        for index in range(2, len(self.units)):
            unit = self.units[index]
            if unit.startswith('{"visible_conversation":'):
                entries = json.loads(unit)["visible_conversation"]
                if encode(history[covered : covered + len(entries)]) != encode(entries):
                    break
                covered += len(entries)
            k = index + 1
        return k


def _delta(evidence: dict, history_len: int, world: dict, refs: dict) -> tuple[list[tuple], int, int]:
    """Units this request adds after a prefix, each as (unit, history_len, world, refs)."""
    units, changes_chars = [], 0
    history = evidence["visible_conversation"]
    for end in sorted(completed_batch_ends(history)):
        if end >= history_len:
            units.append((encode({"visible_conversation": history[history_len : end + 1]}), end + 1, world, refs))
            history_len = end + 1
    changes = diff_state(world, evidence["environment_state"])
    if changes:
        unit = encode({"environment_state_changes": changes})
        world = deepcopy(evidence["environment_state"])
        units.append((unit, history_len, world, refs))
        changes_chars = len(unit)
    material: dict = {}
    contexts = {cid: c for cid, c in evidence.get("grounding_contexts", {}).items()
                if refs.get(f"c:{cid}") != _digest(encode(c))}
    examples = [e for e in evidence.get("grounded_examples", [])
                if refs.get(f"e:{e['transition_id']}") != _digest(encode(e))]
    if contexts:
        material["grounding_contexts"] = contexts
    if examples:
        material["grounded_examples"] = examples
    if material:
        # A redefined id is sent again; the later definition wins when folding.
        refs = {**refs, **{f"c:{cid}": _digest(encode(c)) for cid, c in contexts.items()},
                **{f"e:{e['transition_id']}": _digest(encode(e)) for e in examples}}
        units.append((encode({"reference_material": material}), history_len, world, refs))
    return units, history_len, changes_chars


class StreamBook:
    """One append-only stream per world session for one provider process.

    The native world model shows every agent the world's shared history, so a
    new agent's first call repeats what other agents already sent. Each call
    reuses the deepest prefix of its world's stream that matches its evidence
    and appends only its own delta. The newest request advances the stream; a
    request from an older revision branches without moving it. Calls render
    under the world's lock. After a process restart a world starts afresh.
    """

    def __init__(self, *, max_change_ratio: float = 3.0, min_change_chars: int = 60_000,
                 max_stream_chars: int = 1_200_000, max_streams: int = 512):
        self._streams: OrderedDict[str, _WorldStream] = OrderedDict()
        self._locks: dict[str, asyncio.Lock] = {}
        self._max_change_ratio = max_change_ratio
        self._min_change_chars = min_change_chars
        self._max_stream_chars = max_stream_chars
        self._max_streams = max_streams
        self.resets: list[str] = []
        self.fallbacks: list[str] = []
        self.branches = 0

    def forget(self, prefix: str) -> None:
        for key in [key for key in self._streams if key.startswith(prefix)]:
            self._streams.pop(key, None)
            self._locks.pop(key, None)

    async def render(self, key: str, evidence: Any) -> tuple[list[str], str] | None:
        if not streamable(evidence):
            return None
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            stream = self._streams.get(key)
            task = encode({k: evidence["task"][k] for k in STABLE_TASK_KEYS})
            reason = None
            if stream is not None and stream.task != task:
                reason, stream = "task_changed", None
            if stream is None:
                stream = _WorldStream.start(evidence)
            k = stream.deepest_prefix(evidence["visible_conversation"])
            delta, history_len, change_chars = _delta(evidence, stream.history[k], stream.worlds[k], stream.refs[k])
            if reason is None and stream.change_chars + change_chars > max(
                self._max_change_ratio * stream.baseline_chars, self._min_change_chars
            ):
                reason = "changes_exceed_baseline"
            elif reason is None and stream.chars > self._max_stream_chars:
                reason = "stream_too_long"
            if reason in ("changes_exceed_baseline", "stream_too_long"):
                stream = _WorldStream.start(evidence)
                k = 2
                delta, history_len, change_chars = _delta(evidence, 0, stream.worlds[2], {})
            if reason:
                self.resets = [*self.resets[-99:], reason]
            units = stream.units[:k] + [unit for unit, *_ in delta]
            final = _final(evidence, history_len)
            try:
                exact = _same(fold_stream(units, final), evidence)
            except (KeyError, TypeError, ValueError):
                exact = False
            if not exact:
                # Never send a rendering that loses or alters evidence.
                self.fallbacks = [*self.fallbacks[-99:], "fold_mismatch"]
                return None
            if k == len(stream.units):
                for unit, history, world, refs in delta:
                    stream.append(unit, history, world, refs)
                stream.change_chars += change_chars
            else:
                self.branches += 1
            self._streams[key] = stream
            self._streams.move_to_end(key)
            while len(self._streams) > self._max_streams:
                evicted, _ = self._streams.popitem(last=False)
                self._locks.pop(evicted, None)
            return units, final
