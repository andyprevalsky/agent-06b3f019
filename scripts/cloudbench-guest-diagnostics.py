#!/usr/bin/env python3
"""Sample guest CPU, memory and Postgres connection pressure during a cloud run.

One JSON line per interval tells pool queueing, CPU saturation and Postgres
contention apart: the backend's client connections against its Prisma
``connection_limit`` (pool), /proc CPU and load (host), and pg_stat_activity
states, wait events and the longest active query (database). Each sample is a
single aggregate query and two /proc reads, so its cost is independent of the
number of agents. Samples and line size are capped; the file is exported with
the runtime evidence bundle as ``guest-diagnostics.jsonl``.

usage: cloudbench-guest-diagnostics.py <output> <database-url> <pool-limit>
                                       <interval-seconds> <max-samples>
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

MAX_LINE_BYTES = 4096

PG_SUMMARY_SQL = """
SELECT json_build_object(
  'connections', count(*),
  'max_connections', current_setting('max_connections')::int,
  'database_clients', count(*) FILTER (WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()),
  'by_state', COALESCE((SELECT json_object_agg(s, n) FROM (
      SELECT COALESCE(state, 'none') AS s, count(*) AS n FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() GROUP BY 1) states), '{}'::json),
  'by_wait', COALESCE((SELECT json_object_agg(w, n) FROM (
      SELECT wait_event_type || ':' || wait_event AS w, count(*) AS n FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND state = 'active' AND wait_event IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8) waits), '{}'::json),
  'longest_active_s', COALESCE(round(max(EXTRACT(EPOCH FROM now() - query_start))
      FILTER (WHERE state = 'active' AND pid <> pg_backend_pid())::numeric, 3), 0),
  'longest_idle_in_transaction_s', COALESCE(round(max(EXTRACT(EPOCH FROM now() - state_change))
      FILTER (WHERE state LIKE 'idle in transaction%')::numeric, 3), 0)
) FROM pg_stat_activity
"""


def cpu_times() -> tuple[int, int]:
    fields = [int(v) for v in Path("/proc/stat").read_text().splitlines()[0].split()[1:]]
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    return sum(fields), idle


def memory_available_kb() -> int | None:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1])
    return None


def pg_summary(database_url: str) -> dict:
    try:
        result = subprocess.run(
            ["psql", database_url, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", PG_SUMMARY_SQL],
            capture_output=True, text=True, timeout=5, check=False,
            env={**os.environ, "PGCONNECT_TIMEOUT": "3", "PGAPPNAME": "cloudbench-guest-diagnostics"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": type(error).__name__}
    if result.returncode != 0:
        return {"error": (result.stderr.strip().splitlines() or ["psql failed"])[-1][:200]}
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {"error": "unparseable psql output"}


def main() -> int:
    output, database_url, pool_limit, interval, max_samples = sys.argv[1:6]
    interval_s, limit = float(interval), int(max_samples)
    assert 0 < interval_s <= 3600 and 0 < limit <= 100000
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    previous = cpu_times()
    with open(output, "a", encoding="utf-8") as sink:
        for _ in range(limit):
            time.sleep(interval_s)
            current = cpu_times()
            total, idle = current[0] - previous[0], current[1] - previous[1]
            previous = current
            sample = {
                "ts": round(time.time(), 3),
                "load": [float(v) for v in Path("/proc/loadavg").read_text().split()[:3]],
                "cpu_busy_pct": round(100.0 * (total - idle) / total, 1) if total > 0 else None,
                "cpus": os.cpu_count(),
                "mem_available_kb": memory_available_kb(),
                "backend_pool_limit": int(pool_limit),
                "pg": pg_summary(database_url),
            }
            line = json.dumps(sample, sort_keys=True)
            if len(line) > MAX_LINE_BYTES:
                line = json.dumps({"ts": sample["ts"], "error": "sample exceeded line cap"})
            sink.write(line + "\n")
            sink.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
