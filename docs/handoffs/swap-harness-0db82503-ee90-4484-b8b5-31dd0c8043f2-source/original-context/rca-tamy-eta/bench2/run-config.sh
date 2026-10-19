#!/usr/bin/env bash
# usage: run-config.sh <label> <n> [MODEL ROUTE]
# Retries a run whose preflight failed (prod EMAXCONN during compute-token refresh), after
# stopping exactly that run's retained stack through local.stop_services.
set -u
label=$1; n=$2; model=${3:-}; route=${4:-}; token_type=${5:-}
cd /home/boxes/rose
export ROSE_USE_SYSTEM_PG=true; source .cloud-env
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 TRACE_ARCHIVE_ENABLED=1
if [ -n "$model" ]; then export BENCHMARK_SMS_SUPERVISOR_MODEL=$model BENCHMARK_SMS_SUPERVISOR_ROUTE=$route; fi
[ -n "$token_type" ] && export BENCHMARK_SMS_SUPERVISOR_TOKEN_TYPE=$token_type
B=.context/rca-tamy-eta/bench2
for i in $(seq 1 "$n"); do
  for attempt in 1 2 3 4; do
    log=$B/$label-$i.attempt$attempt.log
    scripts/run-bench --local sms-supervisor-fill-form-searches-then-delegates > "$log" 2>&1
    code=$?
    if grep -qa "could not refresh local compute tokens" "$log"; then
      run_dir=$(grep -aoE '\.context/benchmarks/[0-9]+-[0-9]+-[0-9]+' "$log" | head -1)
      echo "$label-$i attempt$attempt preflight-failed; stopping $run_dir" >> $B/status.txt
      [ -n "$run_dir" ] && agents/venv/bin/python $B/stop_retained.py "$run_dir" >> $B/status.txt 2>&1
      sleep 20
      continue
    fi
    cp "$log" $B/$label-$i.log
    echo "$label-$i exit=$code" >> $B/status.txt
    break
  done
done
echo "$label DONE" >> $B/status.txt
