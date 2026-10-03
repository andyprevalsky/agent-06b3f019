#!/usr/bin/env bash
# Pins that backend blackbox runs always use the local trace archive.
#
# Cursor Cloud injects TRACE_ARCHIVE_BACKEND=r2 as a secret. Both runners used
# `${TRACE_ARCHIVE_BACKEND:-local}`, so the injected value won: the backend
# under test read the shared production bucket while agent-trajectories wrote
# local archive files (0 hits instead of 2), and every finalized test agent was
# uploaded to that bucket.
#
#   case 1: the helper pins local over an inherited r2 and defaults the dir.
#   case 2: the helper keeps an explicit archive dir and enabled flag.
#   case 3: run-blackbox-tests.sh hands its child processes the local backend.
#   case 4: run-coverage.sh applies the same helper before booting its backend.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$ROOT_DIR/scripts/lib/blackbox-archive-env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

got="$(env -u TRACE_ARCHIVE_LOCAL_DIR -u TRACE_ARCHIVE_ENABLED TRACE_ARCHIVE_BACKEND=r2 bash -c '
  set -euo pipefail
  source "$1"
  pin_blackbox_trace_archive_env /repo
  printf "%s|%s|%s" "$TRACE_ARCHIVE_BACKEND" "$TRACE_ARCHIVE_LOCAL_DIR" "$TRACE_ARCHIVE_ENABLED"
' _ "$HELPER")"
[ "$got" = "local|/repo/.context|1" ] || fail "case 1: helper exported '$got'"
echo "PASS: case 1 helper pins local over inherited r2"

got="$(TRACE_ARCHIVE_BACKEND=r2 TRACE_ARCHIVE_LOCAL_DIR=/archives TRACE_ARCHIVE_ENABLED=0 bash -c '
  set -euo pipefail
  source "$1"
  pin_blackbox_trace_archive_env /repo
  printf "%s|%s|%s" "$TRACE_ARCHIVE_BACKEND" "$TRACE_ARCHIVE_LOCAL_DIR" "$TRACE_ARCHIVE_ENABLED"
' _ "$HELPER")"
[ "$got" = "local|/archives|0" ] || fail "case 2: helper exported '$got'"
echo "PASS: case 2 helper keeps explicit dir and enabled flag"

# --list execs the runner's node child right after environment setup; a fake
# node reports the archive environment that every domain process inherits.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/node" <<'NODE'
#!/usr/bin/env bash
printf 'archive=%s|%s\n' "$TRACE_ARCHIVE_BACKEND" "$TRACE_ARCHIVE_LOCAL_DIR"
NODE
chmod +x "$TMP/bin/node"
out="$(env -u TRACE_ARCHIVE_LOCAL_DIR TRACE_ARCHIVE_BACKEND=r2 PATH="$TMP/bin:$PATH" \
  BLACKBOX_TEST_ARTIFACT_ROOT="$TMP/runs" \
  bash "$ROOT_DIR/back-end/scripts/run-blackbox-tests.sh" --list)"
grep -qx "archive=local|$ROOT_DIR/.context" <<< "$out" \
  || fail "case 3: run-blackbox-tests.sh children saw: $out"
echo "PASS: case 3 run-blackbox-tests.sh children get the local archive"

coverage="$ROOT_DIR/back-end/scripts/run-coverage.sh"
pin_line="$(grep -n '^pin_blackbox_trace_archive_env "\$ROOT_DIR"$' "$coverage" | cut -d: -f1 || true)"
boot_line="$(grep -n 'node --import tsx src/bootstrap.ts' "$coverage" | head -1 | cut -d: -f1 || true)"
[ -n "$pin_line" ] || fail "case 4: run-coverage.sh does not call pin_blackbox_trace_archive_env"
[ -n "$boot_line" ] || fail "case 4: run-coverage.sh backend boot line not found"
[ "$pin_line" -lt "$boot_line" ] || fail "case 4: pin (line $pin_line) runs after backend boot (line $boot_line)"
if grep -nE '^[[:space:]]*export TRACE_ARCHIVE_BACKEND=' "$coverage" "$ROOT_DIR/back-end/scripts/run-blackbox-tests.sh"; then
  fail "case 4: a runner re-exports TRACE_ARCHIVE_BACKEND outside the helper"
fi
echo "PASS: case 4 run-coverage.sh pins before booting its backend"

echo "blackbox-archive-env: all cases passed"
