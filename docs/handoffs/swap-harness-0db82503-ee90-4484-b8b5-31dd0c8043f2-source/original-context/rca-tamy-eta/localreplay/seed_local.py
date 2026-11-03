"""Seed / clean the fill-form benchmark's prod state into this box's LOCAL victoria DB (never prod)."""
import json, subprocess, sys
sys.path.insert(0, "/home/boxes/rose/agents")
from benchmarks import sms_runner as s
from benchmarks.benchmark_tasks import get_task_by_name

URL = "postgresql://postgres:postgres@localhost:5432/victoria"
STATE = "/home/boxes/rose/.context/rca-tamy-eta/localreplay/seeded.json"
USER = "1f85ff25-6e29-4c1b-8739-f917bd101a30"

def run_sql(q):
    r = subprocess.run(["psql", URL, "-t", "-A", "-F", "\t", "-c", q], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout

deps = s.SmsRunnerDeps(run_sql=run_sql, sql_literal=lambda v: "'" + str(v).replace("'", "''") + "'",
                       is_local_base_url=lambda u: True, benchmark_user_id=lambda: USER)
if sys.argv[1] == "seed":
    script = s.parse_sms_script(get_task_by_name("sms-supervisor-fill-form-searches-then-delegates"))
    pre = sorted(s._live_agent_ids(deps, USER))
    s._reset_session(deps, USER)
    s._seed_transcript(deps, USER, script["seed_messages"])
    agents, docs, reqs = [], [], []
    s._seed_agents(deps, USER, script["seed_agents"], agents)
    for d in script["seed_documents"]:
        docs += s._seed_documents(deps, USER, [d])
    for r in script["seed_attention_requests"]:
        reqs += s._seed_attention_requests(deps, USER, [r])
    json.dump({"pre": pre, "agents": agents, "docs": docs, "reqs": reqs}, open(STATE, "w"))
    print(f"seeded agents={len(agents)} docs={len(docs)} reqs={len(reqs)} history={len(script['seed_messages'])}")
else:
    st = json.load(open(STATE))
    s._cleanup(deps, USER, st["agents"], set(st["pre"]), st["docs"], st["reqs"])
    print("cleaned")
