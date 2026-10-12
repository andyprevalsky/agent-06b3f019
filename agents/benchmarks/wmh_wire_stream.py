"""Append-only wire stream for native WMH evidence: one stream per world session and acting agent.

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

from benchmarks.wmh_outcomes import apply_state_patch

STREAM_GUIDE = (
    "\n\nWORLD EVIDENCE STREAM: this step's evidence object arrives as the following user messages, oldest "
    'first, each a JSON object with one key. "task" holds the task\'s fixed fields. '
    '"environment_state_baseline" is the environment_state when this stream began; each later '
    '"environment_state_changes" is a JSON Patch list, applied in order, so the supplied environment_state '
    "(the state your state_patch applies to) is the baseline with every change applied. "
    '"visible_conversation" messages are the acting agent\'s history, in order. "reference_material" adds '
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
            state = deepcopy(value)
        elif tag == "environment_state_changes":
            state = apply_state_patch(state, value)
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


@dataclass
class _Stream:
    task: str
    units: list[str] = field(default_factory=list)
    world: dict = field(default_factory=dict)
    history_len: int = 0
    history_digest: str = _digest("")
    contexts: dict = field(default_factory=dict)
    examples: dict = field(default_factory=dict)
    baseline_chars: int = 0
    change_chars: int = 0
    chars: int = 0

    @classmethod
    def start(cls, evidence: dict) -> "_Stream":
        task = encode({key: evidence["task"][key] for key in STABLE_TASK_KEYS})
        stream = cls(task=task)
        stream._append(encode({"task": json.loads(task)}))
        baseline = encode({"environment_state_baseline": evidence["environment_state"]})
        stream._append(baseline)
        stream.world = deepcopy(evidence["environment_state"])
        stream.baseline_chars = len(baseline)
        return stream

    def _append(self, unit: str) -> None:
        self.units.append(unit)
        self.chars += len(unit)

    def break_reason(self, evidence: dict, changes: list, *, max_change_ratio: float, min_change_chars: int,
                     max_stream_chars: int) -> str | None:
        if encode({key: evidence["task"][key] for key in STABLE_TASK_KEYS}) != self.task:
            return "task_changed"
        history = evidence["visible_conversation"]
        if len(history) < self.history_len or _digest(encode(history[: self.history_len])) != self.history_digest:
            return "history_rewritten"
        for cid, context in evidence.get("grounding_contexts", {}).items():
            if cid in self.contexts and self.contexts[cid] != _digest(encode(context)):
                return "context_redefined"
        for example in evidence.get("grounded_examples", []):
            tid = example["transition_id"]
            if tid in self.examples and self.examples[tid] != _digest(encode(example)):
                return "example_redefined"
        change_chars = self.change_chars + (len(encode(changes)) if changes else 0)
        if change_chars > max(max_change_ratio * self.baseline_chars, min_change_chars):
            return "changes_exceed_baseline"
        if self.chars > max_stream_chars:
            return "stream_too_long"
        return None

    def extend(self, evidence: dict, changes: list) -> None:
        history = evidence["visible_conversation"]
        start = self.history_len
        for end in sorted(completed_batch_ends(history)):
            if end >= start:
                self._append(encode({"visible_conversation": history[start : end + 1]}))
                start = end + 1
        self.history_len = start
        self.history_digest = _digest(encode(history[:start]))
        if changes:
            unit = encode({"environment_state_changes": changes})
            self._append(unit)
            self.change_chars += len(unit)
            self.world = deepcopy(evidence["environment_state"])
        material: dict = {}
        contexts = {cid: c for cid, c in evidence.get("grounding_contexts", {}).items() if cid not in self.contexts}
        examples = [e for e in evidence.get("grounded_examples", []) if e["transition_id"] not in self.examples]
        if contexts:
            material["grounding_contexts"] = contexts
        if examples:
            material["grounded_examples"] = examples
        if material:
            self._append(encode({"reference_material": material}))
            self.contexts.update({cid: _digest(encode(c)) for cid, c in contexts.items()})
            self.examples.update({e["transition_id"]: _digest(encode(e)) for e in examples})

    def final(self, evidence: dict) -> str:
        call: dict = {}
        if "grounding_contexts" in evidence:
            call["grounding_context_ids"] = list(evidence["grounding_contexts"])
        if "grounded_examples" in evidence:
            call["grounded_example_ids"] = [e["transition_id"] for e in evidence["grounded_examples"]]
        call["visible_conversation_tail"] = evidence["visible_conversation"][self.history_len :]
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


class StreamBook:
    """Per (world session, agent) streams for one provider process.

    Calls of one agent render under that agent's lock, so parallel calls see the
    same prefix and only their final messages differ. After a process restart an
    agent simply starts a fresh stream.
    """

    def __init__(self, *, max_change_ratio: float = 1.0, min_change_chars: int = 20_000,
                 max_stream_chars: int = 1_200_000, max_streams: int = 512):
        self._streams: OrderedDict[str, _Stream] = OrderedDict()
        self._locks: dict[str, asyncio.Lock] = {}
        self._max_change_ratio = max_change_ratio
        self._min_change_chars = min_change_chars
        self._max_stream_chars = max_stream_chars
        self._max_streams = max_streams
        self.resets: list[str] = []
        self.fallbacks: list[str] = []

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
            changes = diff_state(stream.world, evidence["environment_state"]) if stream else []
            reason = None
            if stream is not None:
                reason = stream.break_reason(
                    evidence, changes, max_change_ratio=self._max_change_ratio,
                    min_change_chars=self._min_change_chars, max_stream_chars=self._max_stream_chars,
                )
            if stream is None or reason:
                if reason:
                    self.resets = [*self.resets[-99:], reason]
                stream = _Stream.start(evidence)
                changes = []
            stream.extend(evidence, changes)
            final = stream.final(evidence)
            units = list(stream.units)
            try:
                exact = _same(fold_stream(units, final), evidence)
            except (KeyError, TypeError, ValueError):
                exact = False
            if not exact:
                # Never send a rendering that loses or alters evidence.
                self._streams.pop(key, None)
                self.fallbacks = [*self.fallbacks[-99:], "fold_mismatch"]
                return None
            self._streams[key] = stream
            self._streams.move_to_end(key)
            while len(self._streams) > self._max_streams:
                evicted, _ = self._streams.popitem(last=False)
                self._locks.pop(evicted, None)
            return units, final
