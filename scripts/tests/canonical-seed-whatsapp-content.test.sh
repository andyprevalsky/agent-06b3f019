#!/usr/bin/env bash
# Owning-boundary tests for scripts/validate-canonical-seed-dump.sh.
#
# Size cannot distinguish a good whatsapp-v2 -Fc archive from a poisoned
# cold-sync (~30MiB both). This suite locks the row-content gate that does.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VALIDATE="$ROOT_DIR/scripts/validate-canonical-seed-dump.sh"
PASS=0
FAIL=0

assert_exit() {
  local label="$1" expected="$2"
  shift 2
  set +e
  "$@" >/tmp/validate-canonical-seed-test.out 2>/tmp/validate-canonical-seed-test.err
  local got=$?
  set -e
  if [ "$got" -eq "$expected" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $label"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $label (expected exit $expected, got $got)"
    echo "     stdout: $(cat /tmp/validate-canonical-seed-test.out)"
    echo "     stderr: $(cat /tmp/validate-canonical-seed-test.err)"
  fi
}

if [ ! -x "$VALIDATE" ]; then
  echo "FAIL: validate script missing or not executable: $VALIDATE"
  exit 1
fi

# Usage / missing DB name
assert_exit "usage fails closed without database name" 2 bash "$VALIDATE"

# Live probes created during the whatsapp-history-recall RCA (optional — skip
# when this VM has not restored them). When present they are the exact RED/GREEN
# pair: poisoned R2 restore vs republished fixture.
export PGPASSWORD="${PGPASSWORD:-postgres}"
if psql -h localhost -U postgres -d victoria_rca_probe -c 'SELECT 1' >/dev/null 2>&1; then
  assert_exit "poisoned restore (0 WHATSAPP rows) fails" 1 \
    bash "$VALIDATE" victoria_rca_probe
else
  echo "  ⏭ skip poisoned-probe live check (victoria_rca_probe absent)"
fi

if psql -h localhost -U postgres -d victoria_fixed_probe -c 'SELECT 1' >/dev/null 2>&1; then
  assert_exit "fixed restore (3825 WHATSAPP rows + CONNECTED) passes" 0 \
    bash "$VALIDATE" victoria_fixed_probe
else
  echo "  ⏭ skip fixed-probe live check (victoria_fixed_probe absent)"
fi

# run.sh must call the validator after restore and before publish
if grep -q 'validate-canonical-seed-dump.sh' "$ROOT_DIR/scripts/run.sh" \
  && grep -q 'lacked reviewed WhatsApp history' "$ROOT_DIR/scripts/run.sh" \
  && grep -q 'refusing to publish: DB failed canonical WhatsApp content check' "$ROOT_DIR/scripts/run.sh"; then
  PASS=$((PASS + 1))
  echo "  ✅ run.sh gates restore + publish on canonical WhatsApp content"
else
  FAIL=$((FAIL + 1))
  echo "  ❌ run.sh missing canonical WhatsApp content gates"
fi

echo
if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: $FAIL canonical-seed-content check(s) failed ($PASS passed)"
  exit 1
fi
echo "PASS: canonical seed WhatsApp content gate ($PASS checks)"
