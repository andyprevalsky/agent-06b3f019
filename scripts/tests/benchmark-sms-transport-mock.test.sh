#!/usr/bin/env bash
# Deploy structural gate: benchmark SMS/WhatsApp transport mocks must stay wired.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

require_text() {
  local label="$1"
  local file="$2"
  local needle="$3"
  if grep -qF "$needle" "$file"; then
    PASS=$((PASS + 1))
    echo "  ✅ $label"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $label (missing in $file)"
  fi
}

UNIT_DIR="$ROOT_DIR/back-end/src/tests/unit"
for test_file in \
  sms-transport-mock.test.ts \
  sms-queue-benchmark-mock.test.ts \
  whatsapp-queue-benchmark-mock.test.ts \
  benchmark-sms-guards.test.ts; do
  if [ -f "$UNIT_DIR/$test_file" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ unit test present: $test_file"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ missing unit test: $test_file"
  fi
done

require_text \
  "smsQueue consults benchmark mock gate" \
  "$ROOT_DIR/back-end/src/providers/smsQueue.ts" \
  "shouldMockBenchmarkSmsSend"

require_text \
  "whatsappCloud consults benchmark mock gate" \
  "$ROOT_DIR/back-end/src/providers/whatsappCloud.ts" \
  "shouldMockBenchmarkWhatsAppSend"

require_text \
  "run.sh fakes AgentPhone in benchmark mode" \
  "$ROOT_DIR/scripts/run.sh" \
  "BLACKBOX_TEST_FAKE_AGENTPHONE"

require_text \
  "run.sh fakes WhatsApp in benchmark mode" \
  "$ROOT_DIR/scripts/run.sh" \
  "BLACKBOX_TEST_FAKE_WHATSAPP"

require_text \
  "sms_runner_test pins transport mock contract" \
  "$ROOT_DIR/agents/benchmarks/sms_runner_test.py" \
  "BLACKBOX_TEST_FAKE_AGENTPHONE"

echo
if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: $FAIL benchmark SMS transport mock check(s) failed ($PASS passed)"
  exit 1
fi
echo "PASS: benchmark SMS transport mock gate ($PASS checks)"
