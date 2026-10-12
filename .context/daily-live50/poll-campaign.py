import json,sys,collections,re,glob,os,subprocess,time
c=sys.argv[1]; start=float(sys.argv[2])
s=json.load(open(f"{c}/summary.json"))
jobs=s.get("jobs",[])
st=collections.Counter(j.get("status") for j in jobs)
ready=sum(1 for j in jobs if j.get("startup_ready_at"))
exits=collections.Counter(str(j.get("controller_exit_code")) for j in jobs if j.get("controller_exit_code") is not None)
# outcomes from run dirs
outc=collections.Counter(); stages=collections.Counter()
for j in jobs:
    log=j.get("log") or f"{c}/{j['job_id']}.log"
    try: txt=open(log,errors="replace").read()
    except Exception: txt=""
    m=re.findall(r"scripts/run-bench monitor (\S+)",txt)
    rd=m[-1] if m else None
    if rd:
        for f in glob.glob(f"{rd}/*/result*.json")+glob.glob(f"{rd}/summary.json"):
            pass
    for kw,lab in (("PASSED","PASS"),("FAILED","FAIL"),("INFRA_ERROR","INFRA")):
        if re.search(rf"\b{kw}\b",txt[-4000:]): outc[lab]+=1; break
now=time.time()
print(f"t+{int(now-start)}s status={dict(st)} ready={ready}/{len(jobs)} exits={dict(exits)} tail-outcomes={dict(outc)} campaign={s.get('status')} e2e_exceeded={s.get('e2e_timeout_exceeded')}")
