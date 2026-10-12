"""One append-only stream per world session: every agent's call reuses the deepest matching prefix."""

import asyncio
import json
from copy import deepcopy

from benchmarks.wmh_wire_stream import (
    STABLE_TASK_KEYS, _Stream, completed_batch_ends, diff_state, encode, fold_stream, streamable,
)


class WorldStreamBook:
    def __init__(self, max_change_ratio=1.0, min_change_chars=20_000, max_stream_chars=1_200_000):
        self.mains = {}
        self.ratio, self.min_change, self.max_chars = max_change_ratio, min_change_chars, max_stream_chars
        self.resets, self.branches = [], 0

    def _start(self, evidence):
        main = {"task": encode({k: evidence["task"][k] for k in STABLE_TASK_KEYS}), "units": [],
                "hist": [0], "world": [], "refs": [], "baseline_chars": 0, "change_chars": 0}
        task_unit = encode({"task": {k: evidence["task"][k] for k in STABLE_TASK_KEYS}})
        base_unit = encode({"environment_state_baseline": evidence["environment_state"]})
        main["units"] = [task_unit, base_unit]
        world = deepcopy(evidence["environment_state"])
        main["hist"] = [0, 0, 0]          # history length after units[:k]
        main["world"] = [None, None, world]  # world after units[:k]
        main["refs"] = [frozenset(), frozenset(), frozenset()]
        main["baseline_chars"] = len(base_unit)
        return main

    async def render(self, key, evidence):
        if not streamable(evidence):
            return None
        session = key.rsplit(":", 1)[0]
        main = self.mains.get(session)
        task = encode({k: evidence["task"][k] for k in STABLE_TASK_KEYS})
        history = evidence["visible_conversation"]
        if main is None or main["task"] != task:
            main = self.mains[session] = self._start(evidence)
        # Deepest prefix of the world stream consistent with this request's history.
        k, hist_len = 2, 0
        for i in range(2, len(main["units"])):
            unit = json.loads(main["units"][i])
            if "visible_conversation" in unit:
                entries = unit["visible_conversation"]
                if encode(history[hist_len:hist_len + len(entries)]) != encode(entries):
                    break
                hist_len += len(entries)
            k = i + 1
        k = max(k, 2)
        while main["world"][k] is None:
            k -= 1
        units = list(main["units"][:k])
        world, refs_seen, hist_len = main["world"][k], set(main["refs"][k]), main["hist"][k]
        changes = diff_state(world, evidence["environment_state"])
        if main["change_chars"] + len(encode(changes)) > max(self.ratio * main["baseline_chars"], self.min_change) \
                or sum(map(len, units)) > self.max_chars:
            self.resets.append("world_stream_reset")
            main = self.mains[session] = self._start(evidence)
            units, world, refs_seen, hist_len, changes = list(main["units"]), main["world"][2], set(), 0, []
            k = 2
        new, states = [], []
        start = hist_len
        for end in sorted(completed_batch_ends(history)):
            if end >= start:
                new.append(encode({"visible_conversation": history[start:end + 1]}))
                start = end + 1
                states.append((start, world, frozenset(refs_seen)))
        if changes:
            new.append(encode({"environment_state_changes": changes}))
            world = deepcopy(evidence["environment_state"])
            states.append((start, world, frozenset(refs_seen)))
        material = {}
        contexts = {c: v for c, v in evidence.get("grounding_contexts", {}).items() if c not in refs_seen}
        examples = [e for e in evidence.get("grounded_examples", []) if e["transition_id"] not in refs_seen]
        if contexts:
            material["grounding_contexts"] = contexts
        if examples:
            material["grounded_examples"] = examples
        if material:
            new.append(encode({"reference_material": material}))
            refs_seen |= set(contexts) | {e["transition_id"] for e in examples}
            states.append((start, world, frozenset(refs_seen)))
        units += new
        if k == len(main["units"]):  # newest request: the world stream advances
            main["units"] += new
            for h, w, r in states:
                main["hist"].append(h)
                main["world"].append(w)
                main["refs"].append(r)
            main["change_chars"] += len(encode(changes)) if changes else 0
        else:
            self.branches += 1
        stream = _Stream(task=task)
        stream.history_len = start
        final = stream.final(evidence)
        assert encode(fold_stream(units, final)) == encode(evidence), "world stream lost evidence"
        return units, final
