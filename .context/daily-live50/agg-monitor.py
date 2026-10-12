import json,sys,re,collections,subprocess,time,concurrent.futures as cf
c=sys.argv[1]; start=float(sys.argv[2])
s=json.load(open(f"{c}/summary.json"))
runs={}
for j in s["jobs"]:
    txt=open(j.get("log") or f"{c}/{j['job_id']}.log",errors="replace").read()
    m=re.findall(r"scripts/run-bench monitor (\S+)",txt)
    runs[j["job_id"]]=(j["task"],m[-1] if m else None,j)
def mon(item):
    jid,(task,rd,j)=item
    if not rd: return jid,task,None
    try:
        out=subprocess.run(["scripts/run-bench","monitor",rd],capture_output=True,text=True,timeout=45).stdout
        return jid,task,json.loads(out.strip().splitlines()[-1])
    except Exception as e:
        return jid,task,{"err":str(e)[:80]}
with cf.ThreadPoolExecutor(12) as ex: res=list(ex.map(mon,runs.items()))
occ=collections.Counter(); outc=collections.Counter(); clean=collections.Counter(); warn=[]; errs=0; ctl=0; exits=collections.Counter()
detail=[]
for jid,task,r in res:
    if r is None or "err" in r: errs+=1; continue
    for k,v in r["occupancy"].items():
        if v: occ[k]+=v
    for k,v in r["task_outcomes"].items(): outc[k]+=v
    clean[r["cleanup_status"]]+=1
    if r["controller_terminal"]: ctl+=1; exits[str(r["controller_exit_code"])]+=1
    if r.get("task_controller_warnings") or r.get("observation_warning"): warn.append(f"{jid}:{task}")
    for k in r["task_outcomes"]:
        if k not in ("starting","running","queued"): detail.append(f"{task}={k}")
sj=json.load(open(f"{c}/summary.json"))
print(f"t+{int(time.time()-start)}s occ={dict(occ)} outcomes={dict(outc)} cleanup={dict(clean)} ctl_exit={ctl} {dict(exits)} obs_err={errs} warn={len(warn)} campaign={sj['status']} e2e_exc={sj.get('e2e_timeout_exceeded')}")
if warn: print("  warnings:", " ".join(warn[:8]))
json.dump(sorted(detail),open(f"{c}/../.agg-detail-{sj['campaign_id']}.json","w"))
