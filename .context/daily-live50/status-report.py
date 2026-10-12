import json, os, re, sys, time, glob
c, t0 = sys.argv[1], float(sys.argv[2])
now = time.time()
s = json.load(open(f"{c}/summary.json"))
def mt(p):
    try: return os.stat(p).st_mtime
    except OSError: return None
def birth(p):
    try:
        st = os.stat(p); b = getattr(st, "st_birthtime", None)
        return b or st.st_ctime
    except OSError: return None
def num(p):
    try: return float(open(p).read().split()[0])
    except Exception: return None
def f(x): return "-" if x is None else f"{int(x)}s"
rows = []
for j in s["jobs"]:
    log = j.get("log")
    txt = open(log, errors="replace").read() if log and os.path.exists(log) else ""
    m = re.findall(r"scripts/run-bench monitor (\S+)", txt)
    rd = m[-1] if m else None
    stage, status, dur = "pending", None, None
    td = None
    if rd:
        try:
            pt = json.load(open(f"{rd}/_batch/report-card.json"))["per_task"][0]
            stage, status, dur = pt.get("lifecycle_stage") or "?", pt.get("status"), pt.get("duration_s")
        except Exception: pass
        dirs = [d for d in glob.glob(f"{rd}/*/") if not d.rstrip("/").endswith("_batch")]
        td = dirs[0] if dirs else None
    st = num(f"{td}/bench-e2e.started-epoch") if td else None
    alloc = mt(f"{td}/primary.ids") if td else None
    ready = mt(f"{td}/barrier.ready.observed") if td else None
    ex = ev = None
    if rd:
        try:
            for line in open(f"{rd}/_batch/hub-live-publication.events.jsonl"):
                e = json.loads(line); tc = e.get("task_counts") or {}
                if ex is None and ("running" in tc or "passed" in tc or "failed" in tc): ex = e["epoch"]
                if ev is None and ("passed" in tc or "failed" in tc): ev = e["epoch"]
        except Exception: pass
    fin = num(f"{td}/bench-e2e.finished-epoch") if td else None
    if j["status"] in ("passed", "failed", "cancelled") or stage in ("finished", "released"): bucket = "COMPLETED"
    elif ex or stage in ("running", "evaluated", "evaluation/evidence", "teardown"): bucket = "IN_PROGRESS"
    else: bucket = "QUEUED"
    rows.append(dict(job=j["job_id"], task=j["task"], att=j.get("attempt", 1), bucket=bucket, stage=stage, status=status,
        q=(alloc - st) if alloc and st else None, boot=(ready - alloc) if ready and alloc else None,
        wait=(ex - ready) if ex and ready and ex >= ready else None,
        exe=((ev - ex) if ev and ex else ((now - ex) if ex else None)),
        tear=(((fin or now) - ev) if ev else None),
        e2e=((fin or now) - st) if st else None, jstatus=j["status"],
        prior=[a.get("task_status") for a in j.get("attempts", [])]))
order = {"COMPLETED": 0, "IN_PROGRESS": 1, "QUEUED": 2}
print(f"campaign {s['campaign_id']} status={s['status']} t+{int(now-t0)}s e2e_exceeded={s.get('e2e_timeout_exceeded')}")
for b in ("COMPLETED", "IN_PROGRESS", "QUEUED"):
    rs = [r for r in rows if r["bucket"] == b]
    print(f"\n## {b} ({len(rs)})")
    print("job | task | att | stage/result | queue→alloc | boot→ready | ready→exec | exec | evidence+teardown | e2e")
    for r in sorted(rs, key=lambda r: r["job"]):
        res = r["status"] if b == "COMPLETED" and r["status"] else r["stage"]
        if r["jstatus"] in ("failed","cancelled"): res = f"{r['jstatus']} ({','.join(str(p) for p in r['prior'] if p)})"
        print(f"{r['job']} | {r['task']} | {r['att']} | {res} | {f(r['q'])} | {f(r['boot'])} | {f(r['wait'])} | {f(r['exe'])} | {f(r['tear'])} | {f(r['e2e'])}")
