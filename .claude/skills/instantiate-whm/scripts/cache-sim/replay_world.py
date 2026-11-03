"""Replay recorded WMH runs through the committed world StreamBook and the measured cache rule."""
import asyncio, glob, json, sys
from benchmarks.wmh_rose_provider import STREAM_GUIDE
from benchmarks.wmh_wire_stream import StreamBook
from providers.rose.gpt_auth import build_codex_responses_body
from providers.rose.pools import get_pool
from cache_sim import Cache

def wire(system, units, final):
    m = [{"role": "system", "content": system + STREAM_GUIDE}]
    m += [{"role": "user", "content": [{"type": "text", "text": u, "cache_control": {"type": "ephemeral"}}]} for u in units]
    return m + [{"role": "user", "content": final}]

root = "/home/boxes/rose-wmh-resume/.context/world-model-native-resume/native-predictions/"
for run, session in (("run 7", "b9d571309e454ff490717324498ff6de"), ("run 8", "64488c11833b4e2bac7a7d097b25240b"),
                     ("run 10", "69a52110968f4b8fab26f35823a09c90")):
    preds = sorted((json.load(open(f)) for f in glob.glob(root + session + "/*.json")), key=lambda r: r.get("started_at_ms", 0))
    preds = [p for p in preds if p.get("schema") == "rose.wmh_native_prediction.v1" and "request" in p]
    book, cache, pending, seen, firsts = StreamBook(), Cache(), [], set(), []
    tot = {"total": 0, "read": 0, "written": 0, "plain": 0}
    streamed = 0
    for p in preds:
        start = p["started_at_ms"]
        for when, key in [x for x in pending if x[0] <= start]:
            cache.store.add(key)
        pending = [x for x in pending if x[0] > start]
        system, user = p["request"]["messages"][0]["content"], p["request"]["messages"][1]["content"]
        ev = json.loads(user)
        rendered = asyncio.run(book.render("w", ev))
        if rendered is None:
            continue
        streamed += 1
        body = build_codex_responses_body(pool_spec=get_pool("rose-wmh-gpt61"), model_override="gpt-6.1-sol",
                                          messages=wire(system, *rendered), request_id="r", cache_breakpoints=True)
        marks = {i for i, it in enumerate(body["input"]) if any("prompt_cache_breakpoint" in x for x in it.get("content", []) if isinstance(x, dict))}
        before = set(cache.store)
        r = cache.request(body["instructions"], body["input"], marks)
        new = cache.store - before
        cache.store -= new
        pending += [(start + 10_000, k) for k in new]
        for k in tot:
            tot[k] += r[k]
        agent = ev["candidate_response"]["tool_calls"][0].get("arguments", {}).get("agent_id")
        if agent not in seen:
            seen.add(agent)
            if len(seen) > 1:
                firsts.append(r["read"] / r["total"])
    cost = (0.05 * tot["read"] + 1.25 * tot["written"] + tot["plain"]) / tot["total"]
    print(f"{run}: {streamed}/{len(preds)} folded exactly, fallbacks {len(book.fallbacks)}, resets {len(book.resets)}, "
          f"branches {book.branches} | cost {cost:.2f}x, read {tot['read']/tot['total']:.1%}, "
          f"new agents' first call read {sum(firsts)/len(firsts):.0%} (n={len(firsts)})" if firsts else "")
