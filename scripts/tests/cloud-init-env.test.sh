#!/usr/bin/env bash
# cloud-init.sh mirrors INJECTED browser-provider settings (Browser Use flag,
# Tilion key/tuning/kill switch) and an INJECTED BROWSER_AGENT_BROWSER_USE_ENABLED into
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
for tool in ruby rsync lsof python3.11 flyctl ngrok cloudflared shlock apt-get add-apt-repository; do
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
# The Docker daemon answers only while $DOCKER_UP exists.
DOCKER_UP="$TMP_ROOT/docker-up"
printf '#!/bin/sh\n[ -f "%s" ]\n' "$DOCKER_UP" >"$STUB_BIN/docker"
touch "$PG_UP"
chmod +x "$STUB_BIN"/*
ln -s "$PYTHON_BIN" "$STUB_BIN/python3"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# The scripts under test run with only the stubs and /usr/bin:/bin on PATH. GNU
# timeout is there on Linux but not on macOS, so resolve the 60s bound once
# from the caller's PATH (Homebrew ships it as timeout or gtimeout), and fall
# back to perl's alarm, which both systems have.
if TIMEOUT_BIN="$(command -v timeout || command -v gtimeout)"; then
  BOUNDED=("$TIMEOUT_BIN" 60)
  ln -s "$TIMEOUT_BIN" "$STUB_BIN/timeout"
else
  BOUNDED=(/usr/bin/perl -e 'alarm shift; exec @ARGV' 60)
  cat >"$STUB_BIN/timeout" <<'TIMEOUT'
#!/bin/sh
exec /usr/bin/perl -e 'alarm shift; exec @ARGV' "$@"
TIMEOUT
  chmod +x "$STUB_BIN/timeout"
fi

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

# Tilion is the default provider: injected credentials/tuning reach both .env
# files (never the log), an explicit tilion survives, and an unsupported value
# is forced to tilion only when a TILION_API_KEY exists, otherwise kernel.
TILION_FAKE_KEY='tl_fake_cloud_init_key_0123456789'
expect_env_line() {
  local name="$1" line="$2" envf
  for envf in agents/.env back-end/.env; do
    grep -qxF "$line" "$TMP_ROOT/$name/$envf" || fail "$name: $envf lacks '$line'"
  done
}
expect_no_secret_in_log() {
  if grep -qF "$TILION_FAKE_KEY" "$TMP_ROOT/$1/cloud-init.log"; then
    fail "$1: cloud-init.log printed TILION_API_KEY"
  fi
}

run_cloud_init tilion-injected-env-synced false BROWSER_PROVIDER=tilion \
  TILION_API_KEY="$TILION_FAKE_KEY" TILION_BASE_URL=https://back.tilion.dev \
  TILION_SESSION_TTL_SECONDS=7200 TILION_IDLE_TIMEOUT_SECONDS=600 TILION_CDP_OBSERVE=false \
  BROWSER_AGENT_TILION_ENABLED=false
expect_env_line tilion-injected-env-synced "TILION_API_KEY=$TILION_FAKE_KEY"
expect_env_line tilion-injected-env-synced 'TILION_BASE_URL=https://back.tilion.dev'
expect_env_line tilion-injected-env-synced 'TILION_SESSION_TTL_SECONDS=7200'
expect_env_line tilion-injected-env-synced 'TILION_IDLE_TIMEOUT_SECONDS=600'
expect_env_line tilion-injected-env-synced 'TILION_CDP_OBSERVE=false'
expect_env_line tilion-injected-env-synced 'BROWSER_AGENT_TILION_ENABLED=false'
expect_no_secret_in_log tilion-injected-env-synced
if grep -q '^BROWSER_PROVIDER=' "$TMP_ROOT/tilion-injected-env-synced/back-end/.env"; then
  fail "tilion-injected-env-synced: a supported tilion provider must not be rewritten"
fi
echo "PASS: tilion-injected-env-synced"

run_cloud_init unsupported-provider-with-tilion-key false BROWSER_PROVIDER=browserbase \
  TILION_API_KEY="$TILION_FAKE_KEY"
expect_env_line unsupported-provider-with-tilion-key 'BROWSER_PROVIDER="tilion"'
expect_no_secret_in_log unsupported-provider-with-tilion-key
echo "PASS: unsupported-provider-with-tilion-key"

run_cloud_init unsupported-provider-without-tilion-key false BROWSER_PROVIDER=browserbase
expect_env_line unsupported-provider-without-tilion-key 'BROWSER_PROVIDER="kernel"'
echo "PASS: unsupported-provider-without-tilion-key"

# Failed dependency setup + unseeded DB: npx without --no-install blocks on a
# hidden install prompt. The stub models that prompt as an indefinite wait.
NPX_STUB_BIN="$TMP_ROOT/npx-bin"
mkdir -p "$NPX_STUB_BIN"
printf '#!/bin/sh\necho\n' >"$NPX_STUB_BIN/psql"
cat >"$NPX_STUB_BIN/npx" <<'NPX'
#!/bin/sh
[ "$1" = "--no-install" ] && exit 1
exec sleep 600
NPX
chmod +x "$NPX_STUB_BIN"/*
seed_repo="$TMP_ROOT/unseeded-without-deps"
mkdir -p "$seed_repo/scripts" "$seed_repo/agents" "$seed_repo/back-end/scripts"
cp "$ROOT_DIR/scripts/cloud-init.sh" "$seed_repo/scripts/cloud-init.sh"
printf '#!/usr/bin/env bash\nexit 1\n' >"$seed_repo/scripts/cloud-build.sh"
printf '#!/usr/bin/env bash\nexit 1\n' >"$seed_repo/back-end/scripts/apply-local-workflow-ddl.sh"
: >"$seed_repo/agents/.env"
: >"$seed_repo/back-end/.env"
if ! env -i HOME="$TMP_ROOT/home" PATH="$NPX_STUB_BIN:$STUB_BIN:/usr/bin:/bin" BROWSER_PROVIDER=kernel \
  "${BOUNDED[@]}" "$BASH" "$seed_repo/scripts/cloud-init.sh" >"$seed_repo/cloud-init.log" 2>&1; then
  cat "$seed_repo/cloud-init.log" >&2
  fail "unseeded-without-deps: cloud-init.sh did not finish (npx install prompt?)"
fi
grep -q 'WARN: seed-local.ts failed' "$seed_repo/cloud-init.log" ||
  fail "unseeded-without-deps: missing seed failure warning"
grep -q 'cloud-init complete' "$seed_repo/cloud-init.log" ||
  fail "unseeded-without-deps: cloud-init.sh did not run to completion"
echo "PASS: unseeded-without-deps"

# cloud-build.sh from a scratch git checkout. Every package, service, and
# privilege tool is a stub that appends its argv to calls.log; PG_LS_MAJOR names
# a server major with no installed vector.control, so the refresh branch runs.
BUILD_STUB_BIN="$TMP_ROOT/build-bin"
mkdir -p "$BUILD_STUB_BIN"
for tool in apt-get apt-cache dpkg-query docker npm npx pg_isready pg_lsclusters pg_ctlcluster \
  service su systemctl usermod find ls uname; do
  cat >"$BUILD_STUB_BIN/$tool" <<'STUB'
#!/bin/sh
tool="$(basename "$0")"
printf '%s %s\n' "$tool" "$*" >>"$CALLS_LOG"
case "$tool $*" in
  "uname -m") echo x86_64 ;;
  uname*) echo Linux ;;
  "docker info") [ "$DOCKER_UP" = 1 ] && exit 0 || exit 1 ;;
  "ls /usr/lib/postgresql") echo "$PG_LS_MAJOR" ;;
  dpkg-query*) printf '%s' "$PG_INSTALLED_VERSION" ;;
  "apt-cache madison"*) echo " postgresql-server-dev-$PG_LS_MAJOR | $PG_ARCHIVE_VERSION | http://archive" ;;
  "apt-get install -y -qq --only-upgrade"*) exit "$PG_REFRESH_RC" ;;
  "npm install"*) mkdir -p node_modules/.bin && : >node_modules/.bin/tsx && chmod +x node_modules/.bin/tsx ;;
esac
exit 0
STUB
done
printf '#!/bin/sh\nexit 1\n' >"$BUILD_STUB_BIN/sudo"
chmod +x "$BUILD_STUB_BIN"/*

# run_cloud_build <case> <node_modules-layout> [VAR=value ...]
# Layouts: none | without-tsx | root-tsx | backend-tsx
run_cloud_build() {
  local name="$1" layout="$2"
  shift 2
  local repo="$TMP_ROOT/$name"
  mkdir -p "$repo/scripts/lib" "$repo/back-end" "$repo/agents/venv/bin"
  cp "$ROOT_DIR/scripts/cloud-build.sh" "$repo/scripts/cloud-build.sh"
  cp "$ROOT_DIR/scripts/lib/workspace-env.sh" "$repo/scripts/lib/workspace-env.sh"
  printf '#!/usr/bin/env bash\necho pgvector-installer >>"$CALLS_LOG"\n' \
    >"$repo/scripts/cloudbench-install-pgvector.sh"
  : >"$repo/agents/venv/bin/activate"
  printf '#!/bin/sh\nexit 0\n' >"$repo/agents/venv/bin/python"
  chmod +x "$repo/agents/venv/bin/python"
  echo '{}' >"$repo/package.json"
  case "$layout" in
    without-tsx) mkdir -p "$repo/node_modules/.bin" && : >"$repo/node_modules/.bin/prisma" ;;
    root-tsx)
      mkdir -p "$repo/node_modules/.bin"
      printf '#!/bin/sh\n' >"$repo/node_modules/.bin/tsx"
      chmod +x "$repo/node_modules/.bin/tsx"
      ;;
    backend-tsx)
      mkdir -p "$repo/node_modules" "$repo/back-end/node_modules/.bin"
      printf '#!/bin/sh\n' >"$repo/back-end/node_modules/.bin/tsx"
      chmod +x "$repo/back-end/node_modules/.bin/tsx"
      ;;
  esac
  git -C "$repo" init -q
  : >"$repo/calls.log"
  if ! env -i HOME="$TMP_ROOT/home" PATH="$BUILD_STUB_BIN:/usr/bin:/bin" CALLS_LOG="$repo/calls.log" \
    CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME="$name" DOCKER_UP=1 PG_LS_MAJOR=99 \
    PG_INSTALLED_VERSION=99.1-1 PG_ARCHIVE_VERSION=99.1-1 PG_REFRESH_RC=0 "$@" \
    "${BOUNDED[@]}" "$BASH" "$repo/scripts/cloud-build.sh" >"$repo/cloud-build.log" 2>&1; then
    cat "$repo/cloud-build.log" >&2
    fail "$name: cloud-build.sh exited non-zero"
  fi
  grep -q 'Cloud build complete' "$repo/cloud-build.log" || {
    cat "$repo/cloud-build.log" >&2
    fail "$name: cloud-build.sh did not run to completion"
  }
}

expect_npm_install() {
  local name="$1" expected="$2" calls
  calls="$(grep -c '^npm install' "$TMP_ROOT/$name/calls.log" || true)"
  [ "$calls" = "$expected" ] || fail "$name: expected $expected npm install call(s), saw $calls"
  if [ "$expected" != 0 ]; then
    grep -q '^npm install --include=dev ' "$TMP_ROOT/$name/calls.log" ||
      fail "$name: npm install omitted --include=dev"
  fi
  grep -q '^npx prisma generate' "$TMP_ROOT/$name/calls.log" || fail "$name: prisma generate skipped"
  echo "PASS: $name"
}

run_cloud_build build-fresh-tree-installs-dev-deps none
expect_npm_install build-fresh-tree-installs-dev-deps 1
run_cloud_build build-tree-without-tsx-reinstalls without-tsx
expect_npm_install build-tree-without-tsx-reinstalls 1
run_cloud_build build-root-tsx-skips-install root-tsx
expect_npm_install build-root-tsx-skips-install 0
run_cloud_build build-backend-tsx-skips-install backend-tsx
expect_npm_install build-backend-tsx-skips-install 0

# Snapshot server minor with no matching archive headers, and the refresh fails:
# the build must still reach the pgvector installer and the dependency steps.
run_cloud_build build-failed-pg-refresh-continues root-tsx DOCKER_UP=0 \
  PG_INSTALLED_VERSION=99.1-1 PG_ARCHIVE_VERSION=99.2-1 PG_REFRESH_RC=100
calls="$TMP_ROOT/build-failed-pg-refresh-continues/calls.log"
grep -q '^apt-get install -y -qq --only-upgrade postgresql-99 postgresql-client-99' "$calls" ||
  fail "build-failed-pg-refresh-continues: refresh was not attempted"
grep -q 'Could not refresh postgresql-99' "$TMP_ROOT/build-failed-pg-refresh-continues/cloud-build.log" ||
  fail "build-failed-pg-refresh-continues: missing refresh warning"
grep -q '^pgvector-installer' "$calls" ||
  fail "build-failed-pg-refresh-continues: pgvector installer skipped"
echo "PASS: build-failed-pg-refresh-continues"

# Matching archive headers: no refresh, installer still runs.
run_cloud_build build-matching-headers-skips-refresh root-tsx DOCKER_UP=0
calls="$TMP_ROOT/build-matching-headers-skips-refresh/calls.log"
if grep -q -- '--only-upgrade' "$calls"; then
  fail "build-matching-headers-skips-refresh: refreshed a server whose headers exist"
fi
grep -q '^pgvector-installer' "$calls" ||
  fail "build-matching-headers-skips-refresh: pgvector installer skipped"
echo "PASS: build-matching-headers-skips-refresh"

[ ! -e "$SERVICE_LOG" ] || fail "a reachable Postgres was restarted: $(cat "$SERVICE_LOG")"

# Without Docker, run.sh falls back to the system cluster, so a snapshot's
# stopped cluster must be started before the seed targets it.
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

# With Docker, run.sh's database is its workspace container: the stopped system
# cluster stays stopped and is neither checked nor seeded.
rm -f "$PG_UP" "$SERVICE_LOG" "$PG_START_FAILS"
touch "$DOCKER_UP"
run_cloud_init docker-path-leaves-system-postgres true
log="$TMP_ROOT/docker-path-leaves-system-postgres/cloud-init.log"
[ ! -e "$SERVICE_LOG" ] || fail "docker path: started system Postgres: $(cat "$SERVICE_LOG")"
grep -q 'Docker is available: run.sh creates and seeds its workspace database' "$log" ||
  fail "docker path: skip was not reported: $(cat "$log")"
! grep -qE 'seeding local DB|DB already seeded|no Postgres is reachable' "$log" ||
  fail "docker path: targeted the system cluster: $(cat "$log")"
echo "PASS: docker-path-leaves-system-postgres"

# ROSE_USE_SYSTEM_PG=true selects the system cluster even when Docker answers.
run_cloud_init forced-system-postgres-with-docker true ROSE_USE_SYSTEM_PG=true
[ "$(cat "$SERVICE_LOG")" = "postgresql start" ] ||
  fail "forced system Postgres: service calls '$(cat "$SERVICE_LOG" 2>/dev/null)'"
grep -q 'DB already seeded' "$TMP_ROOT/forced-system-postgres-with-docker/cloud-init.log" ||
  fail "forced system Postgres: seed check did not run against the started Postgres"
echo "PASS: forced-system-postgres-with-docker"

echo "All cloud-init env tests passed."
