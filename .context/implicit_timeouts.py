import sys
from pathlib import Path
ROOT = Path.cwd(); sys.path[:0] = [str(ROOT/"scripts"), str(ROOT/"agents")]
from cloudbench_catalog import load_unified_catalog
from fleet_infra_sample import catalog_path
from benchmarks.benchmark_tasks import get_smoke_cap, get_timeout_floor
from benchmarks import timeout_history as th
rows=[]
for t in load_unified_catalog(catalog_path(ROOT)):
    if t.get("status","ready")!="ready": continue
    n=t["name"]; cat=t.get("timeout_seconds"); cap=get_smoke_cap(n)
    try:
        h=th.get_timeout(n, max_seconds=cap); fl=get_timeout_floor(n); h=max(h,fl) if fl else h; src="history"
    except Exception as e:
        h=None; src="default"
    rows.append((n,cat,h,cap,src))
lower=[r for r in rows if r[2] is not None and isinstance(r[1],(int,float)) and r[2]<r[1]]
capped=[r for r in rows if r[3] is not None and isinstance(r[1],(int,float)) and r[3]<r[1]]
print("ready tasks:",len(rows),"| history-derived timeout:",sum(r[4]=="history" for r in rows))
print("history timeout BELOW catalog timeout:",len(lower))
for r in sorted(lower,key=lambda r:r[2]/r[1])[:12]: print(f"   {r[0]:55} catalog={r[1]} history={r[2]}")
print("smoke cap BELOW catalog timeout:",len(capped)); [print("   ",r[0],"catalog",r[1],"cap",r[3]) for r in capped[:10]]
