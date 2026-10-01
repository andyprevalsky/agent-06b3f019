#!/usr/bin/env bash
# Reproduce the /deploy topology: Step 5, smoke, and AgentCard stacks share one
# system Postgres (default max_connections=100), unlike Docker's per-stack DBs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_SH="$ROOT/scripts/run.sh"

source <(awk '/^configure_local_db_url\(\) \{/{copy=1} copy{print} copy && /^\}/{exit}' "$RUN_SH")
grep -q '^configure_local_db_url$' "$RUN_SH" || {
    echo "FAIL: run.sh does not apply the local DB pool configuration" >&2
    exit 1
}

LOCAL_DB_URL='postgresql://postgres:postgres@localhost:5432/victoria_bench_test'
USE_SYSTEM_PG=true
IS_CLOUD=false
BENCHMARK_MODE=true
configure_local_db_url
system_limit="${DATABASE_URL#*connection_limit=}"
system_limit="${system_limit%%&*}"
[[ "$system_limit" =~ ^[0-9]+$ ]] || exit 1
(( 3 * system_limit + 40 <= 100 )) || {
    echo "FAIL: three isolated stacks plus 40 reserved connections exceed system Postgres cap" >&2
    exit 1
}
[[ "$DIRECT_URL" == "$LOCAL_DB_URL" ]] || exit 1

unset LOCAL_DB_CONNECTION_LIMIT
IS_CLOUD=true
configure_local_db_url
[[ "$DATABASE_URL" == *'connection_limit=80&pool_timeout=30' ]] || {
    echo "FAIL: Cloud benchmark lost its 80-connection fan-out pool" >&2
    exit 1
}

unset LOCAL_DB_CONNECTION_LIMIT
IS_CLOUD=false
USE_SYSTEM_PG=false
configure_local_db_url
[[ "$DATABASE_URL" == *'connection_limit=80&pool_timeout=30' ]] || {
    echo "FAIL: dedicated Docker benchmark lost its 80-connection fan-out pool" >&2
    exit 1
}

unset LOCAL_DB_CONNECTION_LIMIT
BENCHMARK_MODE=false
configure_local_db_url
[[ "$DATABASE_URL" == *'connection_limit=50&pool_timeout=30' ]] || {
    echo "FAIL: non-benchmark Docker stack lost its 50-connection pool" >&2
    exit 1
}
echo 'run-system-pg-pool-budget: OK'
