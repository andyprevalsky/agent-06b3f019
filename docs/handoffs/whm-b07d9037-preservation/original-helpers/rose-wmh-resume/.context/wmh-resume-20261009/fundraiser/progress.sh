#!/usr/bin/env bash
# One progress line for the running fundraiser: agents, messages, native predictions/commits, memory, liveness.
run_id=$(cat /home/boxes/rose-wmh-resume/.context/wmh-resume-20261009/fundraiser/latest)
db="victoria_bench_$(printf '%s' "$run_id" | tr -c '[:alnum:]' '_')"
np=/home/boxes/rose-wmh-resume/.context/world-model-native-resume/native-predictions
sess=$(ls -td "$np"/*/ 2>/dev/null | head -1)
q() { PGPASSWORD=postgres psql -h localhost -U postgres -d $db -Atc "$1" 2>/dev/null; }
agents=$(q "select string_agg(status||':'||n, ' ') from (select status, count(*) n from \"Agent\" group by status) s")
msgs=$(q "select count(*) from \"Message\"")
read preds errs sel rev maxretry < <(python3 - "$sess" <<'PY'
import json, sys
from pathlib import Path
preds = errs = sel = rev = retry = 0
for f in Path(sys.argv[1]).glob("*.json"):
    try:
        d = json.loads(f.read_text())
    except Exception:
        continue
    if d.get("schema") == "rose.wmh_native_prediction.v1":
        preds += 1; errs += "error" in d; rev = max(rev, d.get("snapshot_revision") or 0); retry = max(retry, d.get("state_retries") or 0)
    elif d.get("schema") == "rose.wmh_outcome_selection.v1":
        sel += 1
print(preds, errs, sel, rev, retry)
PY
)
live=$(pgrep -f "benchmarks/local.py raise-5m-rose-labs-brex" >/dev/null && echo L || echo -)$(systemctl is-active --quiet wmh-serve-fundraiser.scope && echo W || echo -)
avail=$(awk '/MemAvailable/{printf "%.1fG", $2/1048576}' /proc/meminfo)
echo "$(date -u +%T) live=$live agents[$agents] msgs=$msgs preds=$preds selections=$sel pred_errors=$errs max_rev=$rev max_retries=$maxretry sess=$(basename "$sess") avail=$avail"
