#!/usr/bin/env bash
# Merged-code fundraiser: external WMH in a bounded scope, exact owner-PID WMH stop.
# usage: run-fundraiser.sh <timeout seconds> [wmh initial state file]
set -uo pipefail
timeout_seconds="$1"
state_file="${2:-}"
ctx=/home/boxes/rose-wmh-resume/.context/wmh-resume-20261009
out="$ctx/fundraiser"
unit=wmh-serve-fundraiser
commit=$(git -C /home/boxes/rose-wmh-merge rev-parse HEAD)
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$out/orchestrator.log"; }
# A transient scope has no main PID: TERM the exact owner (the scope's first
# process, recorded at registration). The owner stops its native child first.
stop_owner() {
    local owner
    owner=$(cat "$out/wmh-owner.pid" 2>/dev/null)
    if [ -n "$owner" ] && grep -qx "$owner" "/sys/fs/cgroup/system.slice/$unit.scope/cgroup.procs" 2>/dev/null; then
        log "TERM exact WMH owner $owner"; sudo kill -TERM "$owner"
    else
        log "recorded WMH owner absent from $unit.scope"
    fi
}
log "merged commit $commit"
for port in 28690 28600 28601 28602 28603 28604 28605 28606 28609; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then log "port $port busy"; exit 2; fi
done
date -u +%s > "$out/wmh-start.epoch"
sudo systemd-run --scope --quiet --unit="$unit" -p MemoryHigh=11G -p MemorySwapMax=infinity \
    --uid=boxes --gid=boxes -- "$ctx/wmh-serve-merged.sh" > "$out/wmh-serve.log" 2>&1 &
for _ in $(seq 60); do systemctl is-active --quiet "$unit.scope" && break; sleep 1; done
head -1 "/sys/fs/cgroup/system.slice/$unit.scope/cgroup.procs" > "$out/wmh-owner.pid"
log "WMH owner $(cat "$out/wmh-owner.pid") cmd: $(tr '\0' ' ' < /proc/$(cat "$out/wmh-owner.pid")/cmdline | cut -c1-160)"
ready=""
for _ in $(seq 1800); do
    if curl -fsS --max-time 3 http://127.0.0.1:28690/healthz > "$out/wmh-healthz.json" 2>/dev/null; then
        ready=$(( $(date -u +%s) - $(cat "$out/wmh-start.epoch") )); break
    fi
    systemctl is-active --quiet "$unit.scope" || { log "WMH scope exited before health"; exit 3; }
    sleep 2
done
[ -n "$ready" ] || { log "WMH not healthy within 3600s"; stop_owner; exit 3; }
log "WMH healthy after ${ready}s"
sudo systemctl set-property --runtime "$unit.scope" MemoryHigh=8G
"$ctx/launch-fundraiser-merged.sh" "$commit" "$timeout_seconds" "$state_file"
rc=$?
log "fundraiser launcher exited rc=$rc run_id=$(cat "$out/latest" 2>/dev/null)"
git -C /home/boxes/rose-wmh-merge diff -- agents/benchmarks/history > "$out/history.patch"
git -C /home/boxes/rose-wmh-merge checkout -- agents/benchmarks/history
# Owner-only TERM: the owner stops its exact native child first, which retires open sessions.
stop_owner
for _ in $(seq 120); do systemctl is-active --quiet "$unit.scope" || break; sleep 1; done
systemctl is-active --quiet "$unit.scope" && log "WMH scope still active after owner TERM" || log "WMH scope retired"
log "done"
exit "$rc"
