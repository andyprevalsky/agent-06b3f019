"""Why do new agents' first WMH calls cache so little, and which stream design fixes it?"""

import asyncio
import glob
import json
import sys
from copy import deepcopy

from wmh.providers.base import Message

from benchmarks.wmh_outcomes import TIMED_DISTRIBUTION_PROTOCOL
from benchmarks.wmh_rose_provider import STREAM_GUIDE, RoseUsageAccumulator, RoseWMHProvider
from benchmarks.wmh_wire_stream import StreamBook, _Stream, diff_state, encode, fold_stream, streamable
from providers.rose.gpt_auth import build_codex_responses_body
from providers.rose.pools import get_pool
from cache_sim import Cache, tokens
from world_stream import WorldStreamBook


class SharedBaselineBook(StreamBook):
    """New streams start from a session-shared world snapshot plus one change list."""

    def __init__(self, advance_ratio=None, **kwargs):
        super().__init__(**kwargs)
        self.checkpoints = {}
        self.advance_ratio = advance_ratio  # None = never advance (design B)

    async def render(self, key, evidence):
        if not streamable(evidence):
            return None
        session = key.rsplit(":", 1)[0]
        stream = self._streams.get(key)
        changes = diff_state(stream.world, evidence["environment_state"]) if stream else []
        reason = stream and stream.break_reason(evidence, changes, max_change_ratio=self._max_change_ratio,
                                                min_change_chars=self._min_change_chars,
                                                max_stream_chars=self._max_stream_chars)
        if stream is None or reason:
            base = self.checkpoints.get(session)
            current = evidence["environment_state"]
            if base is None or (self.advance_ratio is not None and
                                len(encode(diff_state(base, current))) > self.advance_ratio * len(encode(base))):
                base = deepcopy(current)
                self.checkpoints[session] = base
            stream = _Stream.start({**evidence, "environment_state": base})
            changes = diff_state(base, current)
        stream.extend(evidence, changes)
        final = stream.final(evidence)
        units = list(stream.units)
        assert json.dumps(fold_stream(units, final), sort_keys=True) == json.dumps(evidence, sort_keys=True)
        self._streams[key] = stream
        return units, final


def wire(system, units, final):
    messages = [{"role": "system", "content": system + STREAM_GUIDE}]
    messages += [{"role": "user", "content": [{"type": "text", "text": u, "cache_control": {"type": "ephemeral"}}]}
                 for u in units]
    messages.append({"role": "user", "content": final})
    return messages


def simulate(session_dir, book, visible_after_s):
    preds = sorted((json.load(open(f)) for f in glob.glob(session_dir + "/*.json")),
                   key=lambda r: r.get("started_at_ms", 0))
    preds = [p for p in preds if p.get("schema") == "rose.wmh_native_prediction.v1" and "request" in p]
    cache, pending = Cache(), []
    seen, total, first_calls = set(), {"total": 0, "read": 0, "written": 0, "plain": 0}, []
    for p in preds:
        start = p["started_at_ms"]
        # Writes become readable only after their request's prefill.
        for when, key in [x for x in pending if x[0] <= start]:
            cache.store.add(key)
        pending = [x for x in pending if x[0] > start]
        system, user = p["request"]["messages"][0]["content"], p["request"]["messages"][1]["content"]
        evidence = json.loads(user)
        agent = evidence["candidate_response"]["tool_calls"][0].get("arguments", {}).get("agent_id") or "-"
        units, final = asyncio.run(book.render(f"s:{agent}", evidence))
        body = build_codex_responses_body(pool_spec=get_pool("rose-wmh-gpt61"), model_override="gpt-6.1-sol",
                                          messages=wire(system, units, final), request_id="r", cache_breakpoints=True)
        marks = {i for i, item in enumerate(body["input"])
                 if any("prompt_cache_breakpoint" in part for part in item.get("content", []) if isinstance(part, dict))}
        before = set(cache.store)
        result = cache.request(body["instructions"], body["input"], marks)
        new = cache.store - before
        if visible_after_s:
            cache.store -= new
            pending += [(start + visible_after_s * 1000, key) for key in new]
        for k in total:
            total[k] += result[k]
        if agent not in seen:
            seen.add(agent)
            if len(seen) > 1:
                first_calls.append(result["read"] / result["total"])
    cost = (0.05 * total["read"] + 1.25 * total["written"] + total["plain"]) / total["total"]
    child = sum(first_calls) / len(first_calls) if first_calls else None
    return cost, total["read"] / total["total"], child, len(first_calls)


if __name__ == "__main__":
    root = "/home/boxes/rose-wmh-resume/.context/world-model-native-resume/native-predictions/"
    for run, session in (("run 7", "b9d571309e454ff490717324498ff6de"), ("run 8", "64488c11833b4e2bac7a7d097b25240b"),
                         ("run 10", "69a52110968f4b8fab26f35823a09c90")):
        for timing, delay in (("realistic", 10),):
            for name, book in (("A per-agent (today)", StreamBook()), ("S world, reset 1x", WorldStreamBook()),
                               ("S world, reset 3x/60k", WorldStreamBook(max_change_ratio=3.0, min_change_chars=60_000)),
                               ("S world, never reset", WorldStreamBook(max_change_ratio=1e9, min_change_chars=10**12))):
                cost, rate, child, n = simulate(root + session, book, delay)
                extra = f" resets {len(book.resets)} branches {getattr(book, 'branches', '-')}"
                print(extra, end=" ")
                print(f"{run:6s} {timing:10s} {name:20s} cost {cost:.2f}x  read {rate:5.1%}  new agents' first call read {child if child is None else f'{child:5.1%}'} (n={n})", flush=True)
