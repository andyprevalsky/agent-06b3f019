"""Eligible DAILY pool: catalog timeout vs history-derived execution timeout."""
import json, sys, os
from pathlib import Path
ROOT = Path.cwd()
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "agents")]
from cloudbench_catalog import resolve_task_selection, load_unified_catalog
from fleet_infra_sample import eligible_pool, catalog_path
from benchmarks.benchmark_tasks import get_smoke_cap, get_timeout_floor
from benchmarks import timeout_history as th
cat = catalog_path(ROOT)
daily = resolve_task_selection(cat, ["daily"])
pool = set(eligible_pool(ROOT, None, require_cloud_root=True, minimum_successful_llm=3))
eligible = [n for n in daily if n in pool]
by = {t["name"]: t for t in load_unified_catalog(cat)}
rows = []
for n in eligible:
    t = by[n]; cat_to = t.get("timeout_seconds")
    try:
        hist = th.get_timeout(n, max_seconds=get_smoke_cap(n)); src = "history"
        floor = get_timeout_floor(n)
        if floor: hist = max(hist, floor)
    except Exception as e:
        hist = None; src = type(e).__name__
    rows.append((n, cat_to, hist, src))
print("daily:", len(daily), "eligible:", len(eligible))
over_cat = [r for r in rows if isinstance(r[1], int) and r[1] > 1200]
over_hist = [r for r in rows if isinstance(r[2], (int, float)) and r[2] > 1200]
print("catalog timeout > 1200:", len(over_cat)); [print("  ", r) for r in sorted(over_cat, key=lambda r: -r[1])]
print("history timeout > 1200:", len(over_hist)); [print("  ", r) for r in sorted(over_hist, key=lambda r: -r[2])[:15]]
mx = max((r[1] or 0) for r in rows); print("max catalog timeout:", mx)
print("missing catalog timeout:", sum(1 for r in rows if r[1] is None))
json.dump(rows, open(".context/daily_timeouts.json","w"))
