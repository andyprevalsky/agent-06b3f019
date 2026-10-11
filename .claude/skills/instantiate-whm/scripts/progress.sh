#!/usr/bin/env bash
# One progress line for a running trajectory started by run-trajectory.sh.
# usage: progress.sh <out dir>
set -uo pipefail
out=$1
run_id=$(sed -n 's/^run_id=//p' "$out/run.env" 2>/dev/null)
wmh_root=$(sed -n 's/^wmh_root=//p' "$out/run.env" 2>/dev/null)
wmh_port=$(sed -n 's/^wmh_port=//p' "$out/run.env" 2>/dev/null)
[ -n "$run_id" ] || { echo "$(date -u +%T) waiting for WMH health (no run.env yet)"; exit 0; }
db="victoria_bench_$(printf '%s' "$run_id" | tr -c '[:alnum:]' '_')"
q() { PGPASSWORD=postgres psql -h localhost -U postgres -d "$db" -Atc "$1" 2>/dev/null; }
agents=$(q "select string_agg(status||':'||n, ' ') from (select status, count(*) n from \"Agent\" group by status) s")
msgs=$(q "select count(*) from \"Message\"")
root=$(q "select id from \"Agent\" where \"parentAgentId\" is null order by \"createdAt\" limit 1")
sess=$(ls -td "$wmh_root"/native-predictions/*/ 2>/dev/null | head -1)
activity=$(curl -s --max-time 3 "http://127.0.0.1:$wmh_port/world_models/rose-archive/sessions/$(basename "$sess")/activity")
world=$( [ -n "$root" ] && curl -s --max-time 3 "http://127.0.0.1:$wmh_port/world_models/rose-archive/scopes/$root/clock" | python3 -c "
import json, sys, datetime
try:
    d = json.load(sys.stdin)
    t = d.get('shared_time_ms') or d['start_ms']
    print(datetime.datetime.fromtimestamp(t / 1000, datetime.timezone.utc).strftime('%Y-%m-%d %H:%M'), 'day', round((t - d['start_ms']) / 86400000, 1))
except Exception:
    print('-')" )
avail=$(awk '/MemAvailable/{printf "%.1fG", $2/1048576}' /proc/meminfo)
echo "$(date -u +%T) root=${root:-?} agents[${agents}] msgs=${msgs:-?} wmh=${activity:-?} world="${world:--}" session=$(basename "$sess") avail=$avail"
