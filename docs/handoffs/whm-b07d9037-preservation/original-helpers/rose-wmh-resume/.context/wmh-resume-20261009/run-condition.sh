#!/usr/bin/env bash
# Run one cache condition end to end: exact checkout, external WMH in a bounded
# scope, the unchanged five-minute benchmark, exact WMH retirement, measurement.
# usage: run-condition.sh <iteration 0-3>
set -uo pipefail
iteration="$1"
case "$iteration" in
    0) provider=9186ce1777a1bc0b9980a1030949441a16b283b431e32e3264a67a87b565993e ;;
    1) provider=f4f37226b8a4bcb351e8a4a62d01a7269f8f43e76f173dfa588f12a6a44bcbe4 ;;
    2) provider=9cb7804354512c2224340f97e6247a4b7ce7e834c50188c66414148835660375 ;;
    3) provider=424415aafecb49a16ea4ca03bece17928f5dbc2b86df6e79bcbabe84613d8adc ;;
    *) echo "unknown iteration" >&2; exit 2 ;;
esac
repo=/home/boxes/rose-wmh-resume
ctx="$repo/.context/wmh-resume-20261009"
out="$ctx/conditions/i$iteration"
mkdir -p "$out"
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$out/orchestrator.log"; }
unit="wmh-serve-i$iteration"
cd "$repo"
# Runs append their attempt to the tracked history ledger by design. Keep each
# run's lines with its condition evidence; the ledger is committed afterwards.
if [ -n "$(git status --porcelain --untracked-files=no -- agents/benchmarks/history)" ]; then
    log "unexpected pending history ledger change before checkout"; exit 2
fi
git checkout -q --detach "wmh-cache-i$iteration-run" || { log "checkout failed"; exit 2; }
commit=$(git rev-parse HEAD)
log "checked out $commit"
for port in 28690 28600 28601 28602 28603 28604 28605 28606 28609; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then log "port $port busy"; exit 2; fi
done
date -u +%s > "$out/wmh-start.epoch"
sudo systemd-run --scope --quiet --unit="$unit" -p MemoryHigh=10G -p MemorySwapMax=infinity \
    --uid=boxes --gid=boxes -- "$ctx/wmh-serve.sh" > "$out/wmh-serve.log" 2>&1 &
# systemd registers the transient scope asynchronously; wait for it before
# treating an inactive unit as an early WMH exit.
for _ in $(seq 60); do systemctl is-active --quiet "$unit.scope" && break; sleep 1; done
ready=""
for _ in $(seq 1800); do
    if curl -fsS --max-time 3 http://127.0.0.1:28690/healthz > "$out/wmh-healthz.json" 2>/dev/null; then
        ready=$(( $(date -u +%s) - $(cat "$out/wmh-start.epoch") )); break
    fi
    systemctl is-active --quiet "$unit.scope" || { log "WMH scope exited before health"; exit 3; }
    sleep 2
done
[ -n "$ready" ] || { log "WMH not healthy within 3600s"; sudo systemctl stop "$unit.scope"; exit 3; }
log "WMH healthy after ${ready}s"
echo "$ready" > "$out/wmh-ready-seconds"
sudo systemctl set-property --runtime "$unit.scope" MemoryHigh=8G
"$ctx/launch.sh" "$iteration" "$commit" "$provider"
rc=$?
run_id=$(cat "$ctx/runs/latest")
log "benchmark launcher exited rc=$rc run_id=$run_id"
echo "$run_id" > "$out/run_id"
git diff -- agents/benchmarks/history > "$out/history.patch"
git checkout -- agents/benchmarks/history
# Retire exactly this condition's WMH (its native child joins on TERM).
sudo systemctl stop "$unit.scope"
for _ in $(seq 60); do systemctl is-active --quiet "$unit.scope" || break; sleep 1; done
systemctl is-active --quiet "$unit.scope" && log "WMH scope still active after stop" || log "WMH scope retired"
log "done"
exit "$rc"
