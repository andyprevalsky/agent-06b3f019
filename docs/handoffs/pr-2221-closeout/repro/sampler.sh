#!/usr/bin/env bash
# sampler.sh <port> <out>: per-second server-wide client count until killed
while :; do
  n=$(psql "postgresql://postgres:postgres@localhost:$1/postgres" -tAc "select count(*) from pg_stat_activity where backend_type='client backend'" 2>/dev/null || echo ERR)
  echo "$(date +%s) $n" >> "$2"; sleep 0.5
done
