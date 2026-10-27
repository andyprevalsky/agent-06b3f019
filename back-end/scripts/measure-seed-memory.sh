#!/usr/bin/env bash
# Measure the seed's peak RSS over N runs against a throwaway Postgres.
#
# WHY THIS IS A SCRIPT AND NOT A ONE-OFF
# The seed was SIGKILLed (rc=137) on a 4GB fleet primary on 2026-07-29 and the
# box was dropped from the batch as an infra loss. Nothing measured its
# footprint, so the ratchet in src/providers/seedMemoryBudget.ts had to be set
# from a guess. This produces the real number, repeatably, so the budget is
# evidence and the next regression is caught rather than diagnosed.
#
# Each run gets a FRESH database, so every run performs the same full cold sync
# (a warm DB would short-circuit on the USER_EXISTS check and measure nothing).
#
# Cloud / ROSE_USE_SYSTEM_PG=true: Docker overlay mounts fail on some VMs, so
# this script provisions isolated databases on system Postgres (localhost:5432)
# instead of throwaway containers. Assertions and the RSS ratchet are unchanged.
#
# Usage: bash scripts/measure-seed-memory.sh [runs] [port] [source_port] [--enforce-budget]
set -uo pipefail

RUNS="${1:-5}"
PORT_REQUESTED="${2:-0}"
CONTAINER="victoria-db-seedmem-$$"
SRC_CONTAINER="victoria-db-seedsrc-$$"
SRC_PORT_REQUESTED="${3:-0}"
ENFORCE_BUDGET="${4:-}"
DEV_USER_ID="1f85ff25-6e29-4c1b-8739-f917bd101a30"
USE_SYSTEM_PG=false
if [ "${ROSE_USE_SYSTEM_PG:-false}" = "true" ]; then
    USE_SYSTEM_PG=true
fi
# Cloud VMs often have a Docker daemon that cannot overlay-mount images.
# Fall back to the same system Postgres path setup-db.sh / run.sh already use.
if ! $USE_SYSTEM_PG; then
    if ! docker run --rm --entrypoint true pgvector/pgvector:pg16 >/dev/null 2>&1; then
        echo "⚠️  Docker Postgres unavailable — falling back to system Postgres (set ROSE_USE_SYSTEM_PG=true to skip Docker)."
        USE_SYSTEM_PG=true
    fi
fi
SRC_DB="victoria_seedmem_src_$$"
TARGET_DB="victoria_seedmem_tgt_$$"
# Newest cached prod dump. Restored into a LOCAL source db so the measurement
# does not depend on outbound reachability to prod (all .env hosts were
# TCP-closed on 2026-07-29 and every run died in ~4s).
DUMP="$(ls -t ../.context/benchmarks/seed-cache/*.dump 2>/dev/null | head -1)"
# Default to a PID-scoped directory so two concurrent /deploy worktrees (or a
# controller + worker both hitting Step 4r) cannot append into one shared
# summary.txt and poison `len(peaks) != requested_runs` (observed: interleaved
# run lines → "got 9" after five real cold seeds).
OUT_DIR="${SEED_MEM_OUT_DIR:-../.context/seed-mem-$$}"
mkdir -p "$OUT_DIR"
# Per-PID summary so concurrent /deploy (or overlapping measure runs) cannot
# interleave "run N: ok ..." lines into one file and fail the exact-count gate.
SUMMARY="$OUT_DIR/summary-$$.txt"
: > "$SUMMARY"

if [ -n "$ENFORCE_BUDGET" ] && [ "$ENFORCE_BUDGET" != "--enforce-budget" ]; then
    echo "❌ unknown fourth argument: $ENFORCE_BUDGET"
    exit 2
fi
if [ "$ENFORCE_BUDGET" = "--enforce-budget" ] && [ "$RUNS" != 5 ]; then
    echo "❌ budget enforcement requires exactly five cold runs"
    exit 2
fi
BUDGET_MB="$(sed -nE 's/^export const SEED_PEAK_RSS_BUDGET_MB = ([0-9]+);$/\1/p' \
    src/providers/seedMemoryBudget.ts)"
[ -n "$BUDGET_MB" ] || { echo "❌ could not read SEED_PEAK_RSS_BUDGET_MB"; exit 2; }

cleanup() {
    if $USE_SYSTEM_PG; then
        PGPASSWORD=postgres dropdb -h localhost -p 5432 -U postgres --if-exists "$TARGET_DB" >/dev/null 2>&1 || true
    else
        # postgres declares /var/lib/postgresql/data as a VOLUME, so every
        # throwaway container gets an anonymous volume. Remove it with the
        # container or repeated cold runs leak gigabytes onto the deploy host.
        docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
    fi
}
cleanup_all() {
    # A failed pipeline expansion can inherit EXIT; only the creating shell owns
    # these databases. $$ and BASH_SUBSHELL can still name the parent in that trap.
    /bin/sh -c '[ "$PPID" = "$1" ]' cleanup-owner "$$" || return 0
    cleanup
    if $USE_SYSTEM_PG; then
        PGPASSWORD=postgres dropdb -h localhost -p 5432 -U postgres --if-exists "$SRC_DB" >/dev/null 2>&1 || true
    else
        docker rm -fv "$SRC_CONTAINER" >/dev/null 2>&1 || true
    fi
}
trap cleanup_all EXIT INT TERM

# Preserve inherited proxy settings, including Freedom's blocking configuration.

# A deploy box that has not run a benchmark yet has no cached dump. Measure the
# same reviewed canonical base an isolated benchmark restores. System Postgres
# can only restore archives written by its own pg_dump major; the Docker path
# picks its image from the archive header, so the pinned pg16 publication works.
if [ -z "$DUMP" ]; then
    CANONICAL_PG_MAJOR=16
    if $USE_SYSTEM_PG; then
        CANONICAL_PG_MAJOR="$(pg_dump --version 2>/dev/null | sed -E 's/^[^0-9]*([0-9]+)\..*/\1/')"
    fi
    echo "   no cached dump; pulling the canonical base fixture (pg${CANONICAL_PG_MAJOR})…" | tee -a "$SUMMARY"
    DUMP="$(bash "../scripts/benchmark-seed-cache" pull-canonical prisma/schema.prisma \
        ../.context/benchmarks/seed-cache "$CANONICAL_PG_MAJOR")" || DUMP=""
fi
[ -n "$DUMP" ] || { echo "❌ no cached prod dump in .context/benchmarks/seed-cache" | tee -a "$SUMMARY"; exit 1; }
echo "🧪 seed memory measurement: $RUNS run(s), target :$PORT_REQUESTED, source :$SRC_PORT_REQUESTED" | tee -a "$SUMMARY"
echo "   source dump: $(basename "$DUMP")" | tee -a "$SUMMARY"
if $USE_SYSTEM_PG; then
    echo "   backend: system Postgres (ROSE_USE_SYSTEM_PG=true)" | tee -a "$SUMMARY"
fi

psql_admin() {
    PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d postgres "$@"
}

psql_db() {
    local database="$1"
    shift
    PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d "$database" "$@"
}

wait_for_seed_memory_host_postgres() {
    local port="$1" database="$2" diagnostic="$3" attempt
    for attempt in $(seq 1 30); do
        if PGCONNECT_TIMEOUT=2 PGPASSWORD=postgres psql -h localhost -p "$port" -U postgres -d "$database" \
            -tAc 'SELECT 1' >"$diagnostic" 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# ── Source db: restored ONCE and reused across runs (it is read-only here) ──
if $USE_SYSTEM_PG; then
    if ! pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null; then
        sudo service postgresql start >/dev/null 2>&1 || true
    fi
    if ! pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null; then
        echo "❌ System Postgres is not ready on localhost:5432 (ROSE_USE_SYSTEM_PG=true)." | tee -a "$SUMMARY"
        exit 1
    fi
    PGPASSWORD=postgres dropdb -h localhost -p 5432 -U postgres --if-exists "$SRC_DB" >/dev/null 2>&1 || true
    PGPASSWORD=postgres createdb -h localhost -p 5432 -U postgres "$SRC_DB" || {
        echo "❌ could not create system source database $SRC_DB" | tee -a "$SUMMARY"; exit 1; }
    printf '   restoring source into %s…\n' "$SRC_DB" | tee -a "$SUMMARY"
    PGPASSWORD=postgres pg_restore -h localhost -p 5432 -U postgres -d "$SRC_DB" \
        --no-owner --no-acl "$DUMP" >/dev/null 2>&1 || true
    SRC_ROWS="$(psql_db "$SRC_DB" -tAc \
        "SELECT COUNT(*) FROM \"Cookie\" WHERE \"userId\" = '$DEV_USER_ID'" 2>/dev/null | tr -d " ")"
    echo "   source Cookie rows (userId=$DEV_USER_ID): ${SRC_ROWS:-0}" | tee -a "$SUMMARY"
    [ "${SRC_ROWS:-0}" -gt 0 ] || { echo "❌ source restore produced no Cookie rows for seed user — measurement would be meaningless" | tee -a "$SUMMARY"; exit 1; }
    export SEED_REMOTE_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$SRC_DB"
else
    docker rm -fv "$SRC_CONTAINER" >/dev/null 2>&1 || true
    if [ "$SRC_PORT_REQUESTED" = 0 ]; then
        SRC_PORT_MAPPING="127.0.0.1::5432"
    else
        SRC_PORT_MAPPING="$SRC_PORT_REQUESTED:5432"
    fi
    # The dump's archive-format version pins which pg_restore can read it: a
    # PG18 publisher emits format 1.16, which postgres:16's pg_restore rejects
    # outright ("unsupported version (1.16) in file header"). Restoring with an
    # older image silently produced an EMPTY source db, and the gate then failed
    # with the misleading "no Cookie rows" message instead of naming the cause.
    # Pick the image from the dump header so a newer publisher just works.
    # pgvector images: prod dumps carry CREATE EXTENSION vector (planner memory).
    SRC_PG_IMAGE=pgvector/pgvector:pg16
    DUMP_FORMAT_VERSION="$(
        head -c 8 "$DUMP" | od -An -tu1 -j5 -N2 | awk 'NF{printf "%d.%d", $1, $2; exit}'
    )"
    case "$DUMP_FORMAT_VERSION" in
        1.1[6-9]|1.[2-9][0-9]) SRC_PG_IMAGE=pgvector/pgvector:pg18 ;;
    esac
    echo "   dump archive format $DUMP_FORMAT_VERSION -> $SRC_PG_IMAGE" | tee -a "$SUMMARY"
    docker run -d --name "$SRC_CONTAINER" \
        -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
        -p "$SRC_PORT_MAPPING" "$SRC_PG_IMAGE" >/dev/null || {
            echo "❌ could not start source postgres ($SRC_PG_IMAGE)" | tee -a "$SUMMARY"; exit 1; }
    SRC_PORT="$(docker port "$SRC_CONTAINER" 5432/tcp | tail -1 | sed 's/.*://')"
    [ -n "$SRC_PORT" ] || { echo "❌ could not resolve source postgres port" | tee -a "$SUMMARY"; exit 1; }
    SRC_READY=0
    for _ in $(seq 1 60); do
        # The image's temporary init server accepts Unix sockets before it
        # stops for the final launch. TCP is ready only for the final server.
        docker exec "$SRC_CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && { SRC_READY=1; break; }
        sleep 1
    done
    # Falling through the timeout used to continue into pg_restore against a
    # server that never accepted connections, which produced an empty source db
    # and the misleading "no Cookie rows" error further down.
    if [ "$SRC_READY" != 1 ]; then
        echo "❌ source postgres ($SRC_PG_IMAGE) never became ready in 60s" | tee -a "$SUMMARY"
        docker logs --tail 20 "$SRC_CONTAINER" 2>&1 | tee -a "$SUMMARY"
        exit 1
    fi
    echo "   restoring source…" | tee -a "$SUMMARY"
    SRC_RESTORE_ERR="$OUT_DIR/source-restore.err"
    set +e
    docker exec -i "$SRC_CONTAINER" pg_restore -U postgres -d postgres --no-owner --no-acl \
        < "$DUMP" >/dev/null 2>"$SRC_RESTORE_ERR"
    SRC_RESTORE_STATUS=$?
    set -e
    if [ "$SRC_RESTORE_STATUS" -ne 0 ]; then
        # pg_restore exits non-zero for genuinely benign noise: the dump names
        # roles/extensions/owners that do not exist in a throwaway container.
        # Strip exactly those, and treat ANY remaining diagnostic as fatal — a
        # header refusal, a truncated archive, or a restore-time SQL error all
        # leave an incomplete source db, which silently invalidates the whole
        # measurement. Previously every failure was discarded by `|| true`.
        SRC_RESTORE_UNEXPECTED="$(grep -vE \
            'warning:|WARNING:|role "[^"]*" does not exist|extension "[^"]*" already exists|schema "[^"]*" already exists|must be owner of|no privileges (could be revoked|were granted)|^[[:space:]]*$|^pg_restore: while PROCESSING|^pg_restore: from TOC entry|^[[:space:]]*Command was:' \
            "$SRC_RESTORE_ERR" 2>/dev/null || true)"
        # A non-zero exit with NO diagnostic at all cannot be classified as
        # benign — there is nothing to recognize, so the source db state is
        # simply unknown (killed container, OOM, docker exec failure). Only a
        # failure that actually explained itself as role/extension noise may
        # continue; silence is fatal.
        # NOTE: `grep -c` PRINTS 0 and EXITS 1 when nothing matches, so
        # `$(grep -c ... || echo 0)` yields "0\n0" — a non-integer that makes
        # the comparison below error out and silently take the tolerant branch,
        # recreating exactly the hole this check closes. Assign, then correct.
        SRC_RESTORE_DIAGNOSTIC_LINES=$(grep -cvE '^[[:space:]]*$' "$SRC_RESTORE_ERR" 2>/dev/null) ||
            SRC_RESTORE_DIAGNOSTIC_LINES=0
        case "$SRC_RESTORE_DIAGNOSTIC_LINES" in
            ''|*[!0-9]*) SRC_RESTORE_DIAGNOSTIC_LINES=0 ;;
        esac
        if [ -n "$SRC_RESTORE_UNEXPECTED" ] || [ "$SRC_RESTORE_DIAGNOSTIC_LINES" -eq 0 ]; then
            echo "❌ pg_restore failed on $DUMP (exit $SRC_RESTORE_STATUS):" | tee -a "$SUMMARY"
            if [ "$SRC_RESTORE_DIAGNOSTIC_LINES" -eq 0 ]; then
                echo "   (pg_restore produced no diagnostic output — source state unknown)" | tee -a "$SUMMARY"
            else
                printf '%s\n' "$SRC_RESTORE_UNEXPECTED" | head -5 | tee -a "$SUMMARY"
            fi
            echo "   Full log: $SRC_RESTORE_ERR" | tee -a "$SUMMARY"
            echo "   A version refusal means the dump was published by a newer" | tee -a "$SUMMARY"
            echo "   pg_dump than this reader — republish it, or extend the image map above." | tee -a "$SUMMARY"
            exit 1
        fi
        echo "   pg_restore reported only role/extension noise (exit $SRC_RESTORE_STATUS)" | tee -a "$SUMMARY"
    fi
    # The script intentionally started without errexit so each measured seed's
    # status can be captured and reported below. The restore probe enables it
    # only around its classifier; restore that original mode before measuring.
    set +e
    # Cookie is the fidelity-critical table the gate fingerprints below. Canonical
    # base dumps can have empty MessageRecord (messages still live in Message), so
    # Cookie (for the seeded DEV user) is the durable "dump is non-empty" probe.
    SRC_ROWS="$(docker exec "$SRC_CONTAINER" psql -U postgres -tAc \
        "SELECT COUNT(*) FROM \"Cookie\" WHERE \"userId\" = '$DEV_USER_ID'" 2>/dev/null | tr -d " ")"
    echo "   source Cookie rows (userId=$DEV_USER_ID): ${SRC_ROWS:-0}" | tee -a "$SUMMARY"
    [ "${SRC_ROWS:-0}" -gt 0 ] || { echo "❌ source restore produced no Cookie rows for seed user — measurement would be meaningless" | tee -a "$SUMMARY"; exit 1; }
    export SEED_REMOTE_DATABASE_URL="postgresql://postgres:postgres@localhost:$SRC_PORT/postgres"
fi

origin_fingerprint() {
    local database="$1"
    local table="$2"
    local payload="$3"
    local sql="
        SELECT COUNT(*)::text || ':' ||
               COALESCE(
                 md5(string_agg(
                   \"origin\" || E'\\x1f' || \"hash\" || E'\\x1f' ||
                   pg_column_size(\"$payload\")::text,
                   E'\\x1e' ORDER BY \"origin\"
                 )),
                 md5('')
               )
        FROM \"$table\"
        WHERE \"userId\" = '$DEV_USER_ID'
    "
    if $USE_SYSTEM_PG; then
        psql_db "$database" -tAc "$sql" 2>/dev/null | tr -d '[:space:]'
    else
        local container="$4"
        docker exec "$container" psql -U postgres -d "$database" -tAc "$sql" 2>/dev/null | tr -d '[:space:]'
    fi
}

cookie_fingerprint() {
    local database="$1"
    local sql="
        SELECT COUNT(*)::text || ':' ||
               COALESCE(
                 md5(string_agg(
                   md5((to_jsonb(c) - 'id')::text),
                   '' ORDER BY
                     \"domain\", \"name\", \"path\", \"topFrameSiteKey\",
                     \"browserSource\", \"browserProfile\"
                 )),
                 md5('')
               )
        FROM \"Cookie\" AS c
        WHERE \"userId\" = '$DEV_USER_ID'
    "
    if $USE_SYSTEM_PG; then
        psql_db "$database" -tAc "$sql" 2>/dev/null | tr -d '[:space:]'
    else
        local container="$2"
        docker exec "$container" psql -U postgres -d "$database" -tAc "$sql" 2>/dev/null | tr -d '[:space:]'
    fi
}

verify_seed_fidelity() {
    local source_fingerprint target_fingerprint
    for spec in \
        "LocalStorageOrigin entries" \
        "IndexedDBOrigin databases" \
        "CacheStorageOrigin caches"
    do
        set -- $spec
        if $USE_SYSTEM_PG; then
            source_fingerprint="$(origin_fingerprint "$SRC_DB" "$1" "$2")"
            target_fingerprint="$(origin_fingerprint "$TARGET_DB" "$1" "$2")"
        else
            source_fingerprint="$(origin_fingerprint postgres "$1" "$2" "$SRC_CONTAINER")"
            target_fingerprint="$(origin_fingerprint victoria "$1" "$2" "$CONTAINER")"
        fi
        if [ -z "$source_fingerprint" ] || [ "$source_fingerprint" != "$target_fingerprint" ]; then
            echo "fidelity mismatch: $1 source=$source_fingerprint target=$target_fingerprint"
            return 1
        fi
    done

    if $USE_SYSTEM_PG; then
        source_fingerprint="$(cookie_fingerprint "$SRC_DB")"
        target_fingerprint="$(cookie_fingerprint "$TARGET_DB")"
    else
        source_fingerprint="$(cookie_fingerprint postgres "$SRC_CONTAINER")"
        target_fingerprint="$(cookie_fingerprint victoria "$CONTAINER")"
    fi
    if [ -z "$source_fingerprint" ] || [ "$source_fingerprint" != "$target_fingerprint" ]; then
        echo "fidelity mismatch: Cookie source=$source_fingerprint target=$target_fingerprint"
        return 1
    fi
    return 0
}

for i in $(seq 1 "$RUNS"); do
    cleanup
    if $USE_SYSTEM_PG; then
        PGPASSWORD=postgres createdb -h localhost -p 5432 -U postgres "$TARGET_DB" || {
            echo "❌ run $i: could not create system target database $TARGET_DB" | tee -a "$SUMMARY"; continue; }
        export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$TARGET_DB"
        export DIRECT_URL="$DATABASE_URL"
    else
        if [ "$PORT_REQUESTED" = 0 ]; then
            PORT_MAPPING="127.0.0.1::5432"
        else
            PORT_MAPPING="$PORT_REQUESTED:5432"
        fi
        docker run -d --name "$CONTAINER" \
            -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=victoria \
            -p "$PORT_MAPPING" pgvector/pgvector:pg16 >/dev/null || {
                echo "❌ could not start throwaway postgres" | tee -a "$SUMMARY"; exit 1; }
        PORT="$(docker port "$CONTAINER" 5432/tcp | tail -1 | sed 's/.*://')"
        [ -n "$PORT" ] || {
            echo "❌ run $i: could not resolve throwaway postgres port" | tee -a "$SUMMARY"; continue; }

        # Wait for readiness rather than sleeping a guess.
        for _ in $(seq 1 60); do
            docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
            sleep 1
        done

        HOST_PROBE_LOG="$OUT_DIR/host-postgres-$i.log"
        if ! wait_for_seed_memory_host_postgres "$PORT" victoria "$HOST_PROBE_LOG"; then
            echo "❌ run $i: host Postgres probe failed on port $PORT (diagnostic: $HOST_PROBE_LOG)" | tee -a "$SUMMARY"
            tail -n 12 "$HOST_PROBE_LOG" | tee -a "$SUMMARY"
            continue
        fi

        export DATABASE_URL="postgresql://postgres:postgres@localhost:$PORT/victoria"
        export DIRECT_URL="$DATABASE_URL"
    fi
    SCHEMA_PUSH_LOG="$OUT_DIR/schema-push-$i.log"
    if ! PRISMA_CLI_DATABASE_URL="$DIRECT_URL" npx prisma db push --accept-data-loss --skip-generate >"$SCHEMA_PUSH_LOG" 2>&1; then
        echo "❌ run $i: schema push failed (diagnostic: $SCHEMA_PUSH_LOG)" | tee -a "$SUMMARY"
        tail -n 12 "$SCHEMA_PUSH_LOG" | tee -a "$SUMMARY"
        continue
    fi

    report="$OUT_DIR/run-$i.json"
    log="$OUT_DIR/run-$i.log"
    # OS-level peak RSS (not Node self-reporting). BSD `time -l` prints bytes;
    # GNU `time -v` prints kilobytes. Both land in $log stderr-merged.
    # Prefer the real binary — bash's `time` builtin cannot emit RSS.
    TIME_BIN=""
    if [ -x /usr/bin/time ]; then
        TIME_BIN=/usr/bin/time
    elif command -v gtime >/dev/null 2>&1; then
        TIME_BIN="$(command -v gtime)"
    fi
    if [ -z "$TIME_BIN" ]; then
        echo "❌ run $i: GNU/BSD time binary missing (install package 'time' or gtime)" | tee -a "$SUMMARY"
        printf 'time binary missing\n' > "$log"
        continue
    fi
    if [ "$(uname -s)" = "Darwin" ]; then
        SEED_PEAK_RSS_REPORT="$report" \
            NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=96" \
            "$TIME_BIN" -l npx tsx scripts/seed-local.ts > "$log" 2>&1
        rc=$?
        os_peak_bytes="$(grep -oE '[0-9]+ +maximum resident set size' "$log" | grep -oE '^[0-9]+' | tail -1)"
    else
        SEED_PEAK_RSS_REPORT="$report" \
            NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=96" \
            "$TIME_BIN" -v npx tsx scripts/seed-local.ts > "$log" 2>&1
        rc=$?
        os_peak_kb="$(grep -oE 'Maximum resident set size \(kbytes\):[[:space:]]*[0-9]+' "$log" | grep -oE '[0-9]+$' | tail -1)"
        if [ -n "${os_peak_kb:-}" ]; then
            os_peak_bytes=$(( os_peak_kb * 1024 ))
        else
            os_peak_bytes=""
        fi
    fi
    # A successful seed with no parseable OS RSS is a measurement defect, not a
    # 0MB win — fail the run instead of defaulting missing output to zero.
    if [ "$rc" = 0 ] && { [ -z "${os_peak_bytes:-}" ] || [ "$os_peak_bytes" = 0 ]; }; then
        echo "❌ run $i: could not parse OS peak RSS from time output" | tee -a "$SUMMARY"
        printf 'could not parse OS peak RSS from time output\n' >> "$log"
        rc=87
    fi
    fidelity="not-run"
    if [ "$rc" = 0 ]; then
        fidelity_output="$(verify_seed_fidelity)"
        if [ "$?" = 0 ]; then
            fidelity="verified"
        else
            fidelity="FAILED"
            rc=86
            printf '%s\n' "$fidelity_output" >> "$log"
        fi
    fi

    os_peak_mb=$(( ${os_peak_bytes:-0} / 1024 / 1024 ))
    node_peak_mb="$(python3 -c "
import json,sys
try: print(json.load(open('$report'))['peakRssMb'])
except Exception: print(0)
" 2>/dev/null)"
    worst="$(python3 -c "
import json
try:
    t=json.load(open('$report'))['tables']
    print(f\"{t[0]['name']}@{t[0]['peakRssMb']}MB\" if t else '-')
except Exception: print('-')
" 2>/dev/null)"

    status="ok"
    [ "$rc" = 0 ] || status="FAILED(rc=$rc)"
    echo "run $i: $status os_peak=${os_peak_mb}MB node_peak=${node_peak_mb}MB worst=$worst fidelity=$fidelity" | tee -a "$SUMMARY"
done

cleanup
echo "── summary ──" | tee -a "$SUMMARY"
python3 - "$SUMMARY" "$RUNS" "$BUDGET_MB" "$ENFORCE_BUDGET" <<'PY' | tee -a "$SUMMARY"
import math, re, sys
text = open(sys.argv[1]).read()
requested_runs = int(sys.argv[2])
budget_mb = int(sys.argv[3])
enforce = sys.argv[4] == "--enforce-budget"
# ONLY successful runs count. A failed seed's footprint is the footprint of
# failing, and averaging it in produces a confidently wrong budget.
peaks = [int(m) for m in re.findall(r"run \d+: ok os_peak=(\d+)MB", text) if int(m) > 0]
failed = len(re.findall(r"FAILED", text))
if failed:
    print(f"⚠️  {failed} run(s) FAILED — excluded from the measurement")
if not peaks:
    print("no successful runs"); raise SystemExit(1)
peaks.sort()
print(f"runs={len(peaks)} min={peaks[0]}MB max={peaks[-1]}MB median={peaks[len(peaks)//2]}MB")
print(f"STABLE_PEAK_MB={peaks[-1]}")
print(f"SUGGESTED_BUDGET_MB={math.ceil(peaks[-1] * 1.2)}  # measured max + 20% headroom")
if enforce:
    if failed or len(peaks) != requested_runs:
        print(
            f"❌ seed memory ratchet requires {requested_runs} successful, fidelity-verified runs; "
            f"got {len(peaks)}"
        )
        raise SystemExit(1)
    if peaks[-1] > budget_mb:
        print(f"❌ seed memory ratchet FAILED: {peaks[-1]}MB > {budget_mb}MB budget")
        raise SystemExit(1)
    print(f"✅ seed memory ratchet: max {peaks[-1]}MB <= {budget_mb}MB budget")
PY
