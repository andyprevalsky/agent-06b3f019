#!/usr/bin/env python3
"""Report the explore-agent demo-cache trajectory for a prod agent_id.

For each explore goalHash (namespace) the agent touched, prints the positions
seen, whether each was a cache replay (hit) / miss / stored, the terminal
position, and whether the terminal call HIT or STALLED (miss -> live).

Usage: python benchmarks/explore_trajectory.py <agent_id> [--since-min N]
"""

import json
import os
import subprocess
import sys
from collections import defaultdict


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: explore_trajectory.py <agent_id>")
        sys.exit(1)
    agent_id = sys.argv[1]

    endpoint = os.environ["CLICKHOUSE_ENDPOINT"]
    user = os.environ["CLICKHOUSE_USER"]
    pw = os.environ["CLICKHOUSE_PASSWORD"]
    query = (
        "SELECT raw FROM observability.fly_logs "
        f"WHERE raw LIKE '%{agent_id}%' AND raw LIKE '%explore_agent:p:%' "
        "ORDER BY ingested_at ASC LIMIT 600 FORMAT JSONEachRow"
    )
    out = subprocess.run(
        [
            "curl",
            "-sS",
            "-u",
            f"{user}:{pw}",
            "--get",
            endpoint,
            "--data-urlencode",
            f"query={query}",
        ],
        capture_output=True,
        text=True,
    ).stdout

    # namespace -> position -> set(event kinds), and ordered event log
    ns: dict[str, dict[int, set[str]]] = defaultdict(lambda: defaultdict(set))
    events: list[tuple[str, str, str, int]] = []  # (ts, goalHash, kind, pos)
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(json.loads(line).get("raw", "{}")).get("message", "{}")
            j = json.loads(msg)
        except Exception:
            continue
        ev = j.get("event") or ""
        key = j.get("key", "")
        if ":p:" not in key or "explore_agent" not in key:
            continue
        try:
            pos = int(key.split(":p:")[1].split(":")[0])
            gh = key.split(":llm:")[1].split(":")[0]
        except Exception:
            continue
        kind = (
            "replay"
            if "replay" in ev
            else "miss"
            if "miss" in ev
            else "stored"
            if "stored" in ev
            else "dropped"
            if "dropped" in ev
            else ev
        )
        ns[gh][pos].add(kind)
        events.append((j.get("timestamp", "")[11:19], gh, kind, pos))

    if not ns:
        print(f"No explore trajectory events yet for {agent_id}")
        return

    for gh, positions in ns.items():
        maxpos = max(positions)
        seen = sorted(positions)
        terminal_kinds = positions[maxpos]
        stalled = "miss" in terminal_kinds and "replay" not in terminal_kinds
        hit = "replay" in terminal_kinds
        status = "STALL (terminal miss)" if stalled else ("HIT" if hit else "?")
        misses = sorted(p for p, k in positions.items() if "miss" in k and "replay" not in k)
        print(f"namespace {gh}: positions 1..{maxpos} ({len(seen)} seen)  terminal p:{maxpos} -> {status}")
        if misses:
            print(f"   MISS positions: {misses}")


if __name__ == "__main__":
    main()
