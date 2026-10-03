#!/usr/bin/env bash
# Pins that backend blackbox runs always use a local trace archive.
#
# Cursor Cloud injects TRACE_ARCHIVE_BACKEND=r2 as a secret. Both runners used
# `${TRACE_ARCHIVE_BACKEND:-local}`, so the injected value won: the backend
# under test read the shared production bucket while agent-trajectories wrote
# local archive files (0 hits instead of 2), and every finalized test agent was
# uploaded to that bucket.
#
#   case 1: run-blackbox-tests.sh hands its children local over an inherited r2.
#   case 2: run-blackbox-tests.sh keeps an explicit fake-r2 backend and dir.
#   case 3: run-coverage.sh's backend guard turns an inherited r2 into local.
#   case 4: run-coverage.sh applies that guard before booting its backend.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BLACKBOX="$ROOT_DIR/back-end/scripts/run-blackbox-tests.sh"
COVERAGE="$ROOT_DIR/back-end/scripts/run-coverage.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# --list execs the runner's node child right after environment setup; a fake
# node reports the archive environment that every domain process inherits.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/node" <<'NODE'
#!/usr/bin/env bash
printf 'archive=%s|%s\n' "$TRACE_ARCHIVE_BACKEND" "$TRACE_ARCHIVE_LOCAL_DIR"
NODE
chmod +x "$TMP/bin/node"

out="$(env -u TRACE_ARCHIVE_LOCAL_DIR TRACE_ARCHIVE_BACKEND=r2 PATH="$TMP/bin:$PATH" \
  BLACKBOX_TEST_ARTIFACT_ROOT="$TMP/runs" bash "$BLACKBOX" --list 2>/dev/null)"
grep -qx "archive=local|$ROOT_DIR/.context" <<< "$out" \
  || fail "case 1: run-blackbox-tests.sh children saw: $out"
echo "PASS: case 1 run-blackbox-tests.sh children get local over inherited r2"

out="$(env TRACE_ARCHIVE_BACKEND=fake-r2 TRACE_ARCHIVE_LOCAL_DIR=/archives PATH="$TMP/bin:$PATH" \
  BLACKBOX_TEST_ARTIFACT_ROOT="$TMP/runs" bash "$BLACKBOX" --list 2>/dev/null)"
grep -qx "archive=fake-r2|/archives" <<< "$out" \
  || fail "case 2: run-blackbox-tests.sh children saw: $out"
echo "PASS: case 2 run-blackbox-tests.sh keeps an explicit fake-r2 backend and dir"

guard_start="$(grep -n -m1 '^case "\${TRACE_ARCHIVE_BACKEND:-}" in$' "$COVERAGE" | cut -d: -f1 || true)"
[ -n "$guard_start" ] || fail "case 3: run-coverage.sh has no TRACE_ARCHIVE_BACKEND guard"
guard_end="$(awk -v start="$guard_start" 'NR > start && /^esac$/ { print NR; exit }' "$COVERAGE")"
[ -n "$guard_end" ] || fail "case 3: run-coverage.sh guard has no closing esac"
got="$(TRACE_ARCHIVE_BACKEND=r2 bash -c "set -euo pipefail; $(sed -n "${guard_start},${guard_end}p" "$COVERAGE") >/dev/null
printf '%s' \"\$TRACE_ARCHIVE_BACKEND\"")"
[ "$got" = "local" ] || fail "case 3: run-coverage.sh guard left TRACE_ARCHIVE_BACKEND='$got'"
echo "PASS: case 3 run-coverage.sh guard turns inherited r2 into local"

boot_line="$(grep -n -m1 'node --import tsx src/bootstrap.ts' "$COVERAGE" | cut -d: -f1 || true)"
[ -n "$boot_line" ] || fail "case 4: run-coverage.sh backend boot line not found"
[ "$guard_end" -lt "$boot_line" ] \
  || fail "case 4: guard (ends line $guard_end) runs after backend boot (line $boot_line)"
echo "PASS: case 4 run-coverage.sh guards before booting its backend"

echo "blackbox-archive-env: all cases passed"
