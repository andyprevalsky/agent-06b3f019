"""Which cache-marking pattern should Rose apply to GPT-5.6+ calls? Replay real agent request sequences."""

import collections
import glob
import json
import re

from providers.rose.gpt_auth import _build_instructions, _build_responses_input
from cache_sim import Cache

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-")


def requests(root):
    by_agent = collections.defaultdict(list)
    for path in glob.glob(root + "/*/*.json"):
        try:
            dump = json.load(open(path))
        except ValueError:
            continue
        agent = str(dump.get("agent_id") or "")
        if not UUID.match(agent) or not dump.get("messages") or dump.get("call_site", "").startswith(("test", "benchmark_")):
            continue
        by_agent[agent].append((int(path.split("/")[-1].split("-")[0]), dump))
    return by_agent


def marks_for(items, pattern, caller_marks):
    users = [i for i, item in enumerate(items) if item.get("role") == "user"]
    if pattern == "implicit only":
        return set()
    if pattern == "caller markers":
        return caller_marks
    if pattern == "auto: every user message before the last item":
        return {i for i in users if i < len(items) - 1}
    if pattern == "explicit: every user message before the last item":
        return {i for i in users if i < len(items) - 1}
    if pattern == "explicit: every user message incl. the last":
        return set(users)
    raise ValueError(pattern)


PATTERNS = ("implicit only", "auto: every user message before the last item",
            "explicit: every user message before the last item", "explicit: every user message incl. the last")

if __name__ == "__main__":
    import sys
    by_agent = requests(sys.argv[1])
    sequence = sorted(((ts, agent, dump) for agent, calls in by_agent.items() for ts, dump in calls), key=lambda x: x[0])
    print(f"{len(sequence)} real agent calls from {len(by_agent)} agents; call sites:",
          collections.Counter(d["call_site"] for _, _, d in sequence).most_common(8))
    for pattern in PATTERNS:
        cache, totals = Cache(), collections.defaultdict(lambda: collections.Counter())
        for _, _, dump in sequence:
            messages = dump["messages"]
            items = _build_responses_input(messages, cache_breakpoints=True)
            caller = {i for i, item in enumerate(items) if any("prompt_cache_breakpoint" in p for p in item.get("content", []) if isinstance(p, dict))}
            for item in items:
                for part in item.get("content", []) if isinstance(item.get("content"), list) else []:
                    if isinstance(part, dict):
                        part.pop("prompt_cache_breakpoint", None)
            result = cache.request(_build_instructions(messages) or "", items, marks_for(items, pattern, caller),
                                   explicit_mode=pattern.startswith("explicit"))
            for key in ("all", dump["call_site"]):
                totals[key].update(result)
        t = totals["all"]
        cost = (0.05 * t["read"] + 1.25 * t["written"] + t["plain"]) / t["total"]
        print(f"\n{pattern}: cost {cost:.2f}x of no cache, read {t['read'] / t['total']:.1%}, written {t['written'] / t['total']:.1%}")
        for site, c in sorted(totals.items(), key=lambda kv: -kv[1]["total"])[1:8]:
            site_cost = (0.05 * c["read"] + 1.25 * c["written"] + c["plain"]) / c["total"]
            print(f"   {site:32s} cost {site_cost:.2f}x read {c['read'] / c['total']:5.1%} ({c['total']:,} tokens)")
