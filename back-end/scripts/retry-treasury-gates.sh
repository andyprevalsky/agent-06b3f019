#!/usr/bin/env bash
# Retry treasury-rails + test-payment until both pass or deadline elapses.
set -euo pipefail

DEADLINE_EPOCH="${1:-$(( $(date +%s) + 7200 ))}"
LOG_DIR="${LOG_DIR:-/workspace/.context/treasury-retry-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$LOG_DIR"

cd /workspace/back-end
set -a
# shellcheck disable=SC1091
source .env
set +a

attempt=0
delay=8
max_delay=300

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_DIR/runner.log"
}

run_treasury() {
  local out="$LOG_DIR/treasury-attempt-${attempt}.log"
  if npx tsx src/tests/blackbox/treasury-rails.blackbox.ts >"$out" 2>&1; then
    log "treasury-rails PASS (attempt $attempt)"
    return 0
  fi
  tail -5 "$out" | while read -r line; do log "treasury tail: $line"; done
  return 1
}

run_test_payment() {
  local out="$LOG_DIR/test-payment-attempt-${attempt}.log"
  if npm run test:blackbox -- test-payment >"$out" 2>&1; then
    if grep -qE 'FAIL  test-payment|failed, [1-9]' "$out"; then
      tail -8 "$out" | while read -r line; do log "test-payment tail: $line"; done
      return 1
    fi
    log "test-payment PASS (attempt $attempt)"
    return 0
  fi
  tail -8 "$out" | while read -r line; do log "test-payment tail: $line"; done
  return 1
}

log "Starting treasury gate retry loop; deadline epoch=$DEADLINE_EPOCH log_dir=$LOG_DIR"

while [[ $(date +%s) -lt $DEADLINE_EPOCH ]]; do
  attempt=$((attempt + 1))
  remaining=$((DEADLINE_EPOCH - $(date +%s)))
  log "=== attempt $attempt (${remaining}s remaining) sleep=${delay}s ==="

  treasury_ok=0
  payment_ok=0

  if run_treasury; then treasury_ok=1; fi
  if run_test_payment; then payment_ok=1; fi

  if [[ $treasury_ok -eq 1 && $payment_ok -eq 1 ]]; then
    log "ALL GATES GREEN after $attempt attempt(s)"
    echo "$LOG_DIR" > "$LOG_DIR/SUCCESS"
    exit 0
  fi

  if [[ $(date +%s) -ge $DEADLINE_EPOCH ]]; then
    break
  fi

  # Exponential backoff with jitter, cap at 5 minutes.
  jitter=$((RANDOM % 5))
  sleep_for=$((delay + jitter))
  if [[ $sleep_for -gt $remaining ]]; then
    sleep_for=$remaining
  fi
  log "sleeping ${sleep_for}s before next attempt"
  sleep "$sleep_for"
  delay=$((delay * 2))
  if [[ $delay -gt $max_delay ]]; then delay=$max_delay; fi
done

log "DEADLINE REACHED without both gates passing (attempts=$attempt)"
exit 1
