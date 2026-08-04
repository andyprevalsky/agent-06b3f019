#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAVE="$ROOT_DIR/scripts/save-seed-dump.sh"
RUN_SH="$ROOT_DIR/scripts/run.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/out"

cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SEED_DUMP_TEST_LOG"
printf 'container-compatible-archive'
EOF
chmod +x "$TMP/bin/docker"

cat > "$TMP/bin/pg_dump" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SEED_DUMP_TEST_LOG"
printf 'system-compatible-archive'
EOF
chmod +x "$TMP/bin/pg_dump"

export PATH="$TMP/bin:$PATH"
export SEED_DUMP_TEST_LOG="$TMP/calls.log"

bash "$SAVE" "$TMP/out/container.dump" localhost 5432 postgres victoria postgres-16
grep -qx 'exec postgres-16 pg_dump -U postgres -Fc victoria' "$SEED_DUMP_TEST_LOG"
grep -qx 'container-compatible-archive' "$TMP/out/container.dump"
echo "PASS: Docker databases are dumped with their matching container pg_dump"

: > "$SEED_DUMP_TEST_LOG"
bash "$SAVE" "$TMP/out/system.dump" localhost 55432 postgres victoria
grep -qx -- '-h localhost -p 55432 -U postgres -Fc victoria' "$SEED_DUMP_TEST_LOG"
grep -qx 'system-compatible-archive' "$TMP/out/system.dump"
echo "PASS: system databases are dumped with the colocated host pg_dump"

cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'partial'
exit 17
EOF
chmod +x "$TMP/bin/docker"
printf 'known-good-archive' > "$TMP/out/failed.dump"
if bash "$SAVE" "$TMP/out/failed.dump" localhost 5432 postgres victoria postgres-16; then
    echo "FAIL: failed pg_dump unexpectedly succeeded" >&2
    exit 1
fi
grep -qx 'known-good-archive' "$TMP/out/failed.dump"
if find "$TMP/out" -name 'failed.dump.tmp.*' -print -quit | grep -q .; then
    echo "FAIL: failed pg_dump left a partial archive" >&2
    exit 1
fi
echo "PASS: failed dumps preserve a known-good archive and leave no partial"

grep -q '_SEED_DUMP_CONTAINER="$DB_CONTAINER"' "$RUN_SH"
SAVE_CALL="$(grep -A2 'bash scripts/save-seed-dump.sh' "$RUN_SH")"
echo "$SAVE_CALL" | grep -q '"$LOCAL_DB_NAME"'
echo "$SAVE_CALL" | grep -q '"$_SEED_DUMP_CONTAINER"'
echo "PASS: run.sh passes the exact database and Docker container to the helper"

RESTORE_FAILURE="$(grep -A7 'restore failed — falling back' "$RUN_SH")"
echo "$RESTORE_FAILURE" | grep -q 'rm -f "$_SEED_DUMP" "${_SEED_DUMP}.schemahash"'
echo "PASS: run.sh invalidates an archive already proven unrestorable"
# ngrok reserved-domains list page size must stay <= 100 (ERR_NGROK_233).
grep -qE -- '--limit 100\b' "$RUN_SH" || { echo "FAIL: run.sh must list reserved domains with --limit 100" >&2; exit 1; }
! grep -qE -- '--limit 1000\b' "$RUN_SH" || { echo "FAIL: run.sh still requests --limit 1000 from ngrok" >&2; exit 1; }
echo "PASS: run.sh respects ngrok reserved-domains page-size cap"

