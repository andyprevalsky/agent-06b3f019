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
printf '#!/bin/sh\necho 1\n' >"$STUB_BIN/psql"
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
  timeout 60 "$BASH" "$seed_repo/scripts/cloud-init.sh" >"$seed_repo/cloud-init.log" 2>&1; then
  cat "$seed_repo/cloud-init.log" >&2
  fail "unseeded-without-deps: cloud-init.sh did not finish (npx install prompt?)"
fi
grep -q 'WARN: seed-local.ts failed' "$seed_repo/cloud-init.log" ||
  fail "unseeded-without-deps: missing seed failure warning"
grep -q 'cloud-init complete' "$seed_repo/cloud-init.log" ||
  fail "unseeded-without-deps: cloud-init.sh did not run to completion"
echo "PASS: unseeded-without-deps"

echo "All cloud-init env tests passed."
