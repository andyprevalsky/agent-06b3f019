#!/usr/bin/env bash
# cloud-init.sh mirrors an INJECTED BROWSER_AGENT_BROWSER_USE_ENABLED into
# agents/.env and back-end/.env so dotenv children agree with the parent shell.
# An injected-but-empty value is "disabled" to the parent; it must overwrite a
# stale `true` with `false` rather than being skipped (upsert_env_key ignores
# empty values, which left the stale `true` enabling Browser Use in children).
#
# Hermetic: cloud-init runs from a scratch copy with an empty environment, and
# every installer, provisioner, sudo, network, and database tool it can reach is
# a stub, so nothing outside the scratch directory is touched.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PYTHON_BIN="$(python3 -c 'import sys; print(sys.executable)')"
STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN" "$TMP_ROOT/home"
for tool in ruby rsync python3.11 flyctl ngrok cloudflared shlock apt-get add-apt-repository; do
  printf '#!/bin/sh\nexit 0\n' >"$STUB_BIN/$tool"
done
# Refuse network and privilege escalation; report the dev user as already seeded.
printf '#!/bin/sh\nexit 1\n' >"$STUB_BIN/curl"
printf '#!/bin/sh\nexit 1\n' >"$STUB_BIN/sudo"
# System Postgres is "up" while $PG_UP exists; `service postgresql start` brings
# it up unless $PG_START_FAILS exists. Every service call is logged.
PG_UP="$TMP_ROOT/pg-up"
PG_START_FAILS="$TMP_ROOT/pg-start-fails"
SERVICE_LOG="$TMP_ROOT/service.log"
printf '#!/bin/sh\n[ -f "%s" ] || exit 2\necho 1\n' "$PG_UP" >"$STUB_BIN/psql"
printf '#!/bin/sh\n[ -f "%s" ]\n' "$PG_UP" >"$STUB_BIN/pg_isready"
printf '#!/bin/sh\nexit 0\n' >"$STUB_BIN/pg_ctlcluster"
printf '#!/bin/sh\necho "$*" >>"%s"\n[ -f "%s" ] && exit 1\ntouch "%s"\n' \
  "$SERVICE_LOG" "$PG_START_FAILS" "$PG_UP" >"$STUB_BIN/service"
touch "$PG_UP"
chmod +x "$STUB_BIN"/*
ln -s "$PYTHON_BIN" "$STUB_BIN/python3"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# run_cloud_init <case> <stale-value> [VAR=value ...]
run_cloud_init() {
  local name="$1" stale="$2"
  shift 2
  local repo="$TMP_ROOT/$name"
  mkdir -p "$repo/scripts" "$repo/agents" "$repo/back-end"
  cp "$ROOT_DIR/scripts/cloud-init.sh" "$repo/scripts/cloud-init.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$repo/scripts/cloud-build.sh"
  for envf in agents/.env back-end/.env; do
    printf 'OTHER_KEY=keep\nBROWSER_AGENT_BROWSER_USE_ENABLED=%s\n' "$stale" >"$repo/$envf"
  done
  if ! env -i HOME="$TMP_ROOT/home" PATH="$STUB_BIN:/usr/bin:/bin" BROWSER_PROVIDER=kernel "$@" \
    "$BASH" "$repo/scripts/cloud-init.sh" >"$repo/cloud-init.log" 2>&1; then
    cat "$repo/cloud-init.log" >&2
    fail "$name: cloud-init.sh exited non-zero"
  fi
  grep -q 'cloud-init complete' "$repo/cloud-init.log" || {
    cat "$repo/cloud-init.log" >&2
    fail "$name: cloud-init.sh did not run to completion"
  }
}

expect_flag() {
  local name="$1" expected="$2" envf lines
  for envf in agents/.env back-end/.env; do
    lines="$(grep '^BROWSER_AGENT_BROWSER_USE_ENABLED=' "$TMP_ROOT/$name/$envf" || true)"
    [ "$lines" = "BROWSER_AGENT_BROWSER_USE_ENABLED=$expected" ] ||
      fail "$name: $envf has '${lines//$'\n'/ | }', expected BROWSER_AGENT_BROWSER_USE_ENABLED=$expected"
    grep -qx 'OTHER_KEY=keep' "$TMP_ROOT/$name/$envf" || fail "$name: $envf lost unrelated keys"
  done
  echo "PASS: $name"
}

run_cloud_init injected-empty-disables-stale-true true BROWSER_AGENT_BROWSER_USE_ENABLED=
expect_flag injected-empty-disables-stale-true false

run_cloud_init injected-false-overwrites-stale-true true BROWSER_AGENT_BROWSER_USE_ENABLED=false
expect_flag injected-false-overwrites-stale-true false

run_cloud_init injected-true-overwrites-stale-false false BROWSER_AGENT_BROWSER_USE_ENABLED=true
expect_flag injected-true-overwrites-stale-false true

[ ! -e "$SERVICE_LOG" ] || fail "a reachable Postgres was restarted: $(cat "$SERVICE_LOG")"

# Docker reachable leaves cloud-build.sh's system-Postgres fallback idle; the
# snapshot's stopped cluster must be started before the seed targets it.
rm -f "$PG_UP"
run_cloud_init stopped-system-postgres-starts true
[ "$(cat "$SERVICE_LOG")" = "postgresql start" ] || fail "stopped cluster: service calls '$(cat "$SERVICE_LOG")'"
grep -q 'DB already seeded' "$TMP_ROOT/stopped-system-postgres-starts/cloud-init.log" ||
  fail "stopped cluster: seed check did not run against the started Postgres"
echo "PASS: stopped-system-postgres-starts"

rm -f "$PG_UP" "$SERVICE_LOG"
touch "$PG_START_FAILS"
run_cloud_init unreachable-postgres-skips-seed true
log="$TMP_ROOT/unreachable-postgres-skips-seed/cloud-init.log"
grep -q 'WARN: no Postgres is reachable at localhost:5432' "$log" ||
  fail "unreachable Postgres was not reported: $(cat "$log")"
! grep -q 'seeding local DB' "$log" || fail "seed ran without a reachable Postgres"
echo "PASS: unreachable-postgres-skips-seed"

echo "All cloud-init env tests passed."
