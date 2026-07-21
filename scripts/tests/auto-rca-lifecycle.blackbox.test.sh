#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RCA_TOOL="$ROOT_DIR/scripts/auto-rca-tool"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/auto-rca-lifecycle.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
ORIGINAL_PATH="$PATH"

FAKE_BIN="$TEST_ROOT/bin"
CHECKOUT="$TEST_ROOT/checkout"
CONTEXT="$CHECKOUT/.context/auto-rca"
CAPTURED_BODY="$TEST_ROOT/pr-body.txt"
UNEXPECTED_CALLS="$TEST_ROOT/unexpected-calls.txt"
FAKE_GATE_ROOT="$TEST_ROOT/gates"
mkdir -p "$FAKE_BIN" "$CONTEXT" "$FAKE_GATE_ROOT" "$CHECKOUT/scripts/tests"
: > "$UNEXPECTED_CALLS"

cat > "$FAKE_BIN/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
args=" $* "
case "$args" in
  *" branch --show-current "*) printf '%s\n' "$RCA_BRANCH" ;;
  *" status --porcelain --untracked-files=normal "*) ;;
  *" diff --name-only --diff-filter=U "*) ;;
  *" rev-list --count main..HEAD "*) printf '%s\n' "${FAKE_REV_COUNT:-1}" ;;
  *" rev-parse HEAD "*) printf '0123456789abcdef0123456789abcdef01234567\n' ;;
  *" remote set-url origin "*) ;;
  *" push --set-upstream origin "*) ;;
  *" add "*) ;;
  *" commit "*) ;;
  *) printf 'unexpected fake git invocation: %s\n' "$*" | tee -a "$UNEXPECTED_CALLS" >&2; exit 90 ;;
esac
SH

cat > "$FAKE_BIN/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ]; then
  printf '%s' "${FAKE_PR_JSON:-}"
  exit 0
fi
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "create" ]; then
  printf 'pr create %s\n' "$*" >> "$GH_CALLS"
  shift 2
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--body" ]; then
      printf '%s\n' "$2" > "$CAPTURED_BODY"
      shift 2
      continue
    fi
    shift
  done
  printf 'https://github.com/Rose-Ai-Labs/rose/pull/999\n'
  exit 0
fi
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "ready" ]; then
  printf 'pr ready %s\n' "$*" >> "$GH_CALLS"
  exit 0
fi
if [ "${1:-}" = "api" ]; then
  printf 'api %s\n' "$*" >> "$GH_CALLS"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--raw-field" ] && [[ "$2" = body=* ]]; then
      printf '%s\n' "${2#body=}" > "$CAPTURED_BODY"
      shift 2
      continue
    fi
    shift
  done
  exit 0
fi
printf 'unexpected fake gh invocation: %s\n' "$*" >&2
exit 91
SH

cat > "$FAKE_BIN/sudo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
map_path() {
  case "$1" in
    /var/lib/rose-auto-rca/*/*) printf '%s/%s' "$FAKE_GATE_ROOT" "${1##*/}" ;;
    *) printf '%s' "$1" ;;
  esac
}
case "${1:-}" in
  test)
    shift
    flag="$1"
    shift
    exec test "$flag" "$(map_path "$1")"
    ;;
  cat)
    exec cat "$(map_path "$2")"
    ;;
  tee)
    exec tee "$(map_path "$2")"
    ;;
  chmod)
    exit 0
    ;;
  install)
    source="${@: -2:1}"
    target="${@: -1}"
    exec cp "$source" "$(map_path "$target")"
    ;;
esac
exec "$@"
SH

cat > "$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CURL_CALLS"
if [[ "$*" == *"conversations.history"* ]] && [ -n "${FAKE_HISTORY_TS:-}" ]; then
  printf '{"ok":true,"messages":[{"ts":"%s","metadata":{"event_type":"rose_auto_rca","event_payload":{"agent_id":"d29e631e-b78a-40dd-8f0b-732d1143a854"}}}]}\n' "$FAKE_HISTORY_TS"
  exit 0
fi
if [ "${FAKE_SLACK_RATE_LIMIT_ONCE:-false}" = true ]; then
  count="$(cat "$FAKE_CURL_COUNT" 2>/dev/null || printf 0)"
  [ -n "$count" ] || count=0
  printf '%s\n' "$((count + 1))" > "$FAKE_CURL_COUNT"
  if [ "$count" -eq 0 ]; then
    printf '{"ok":false,"error":"ratelimited"}\n'
    exit 0
  fi
fi
if [ "${FAKE_SLACK_OK:-true}" = true ]; then
  printf '{"ok":true,"ts":"%s"}\n' "${FAKE_SLACK_TS:-1784617220.480779}"
else
  printf '{"ok":false,"error":"synthetic_failure"}\n'
fi
SH

chmod +x "$FAKE_BIN/git" "$FAKE_BIN/gh" "$FAKE_BIN/sudo" "$FAKE_BIN/curl"

assert_dispatch_plan() {
  local expected="$1" actual
  shift
  actual="$(env "$@" "$RCA_TOOL" dispatch-plan)"
  [ "$actual" = "$expected" ] || {
    echo "FAIL: dispatch plan expected '$expected', got '$actual'" >&2
    exit 1
  }
}

assert_dispatch_plan 'initial false' EVENT_NAME=repository_dispatch EXISTING_PR_FOUND=false
assert_dispatch_plan 'recovery false' EVENT_NAME=repository_dispatch EXISTING_PR_FOUND=true EXISTING_PR_IS_DRAFT=true
assert_dispatch_plan 'ready-reconcile true' EVENT_NAME=repository_dispatch EXISTING_PR_FOUND=true EXISTING_PR_IS_DRAFT=false
assert_dispatch_plan 'revision false' EVENT_NAME=issue_comment
if EVENT_NAME=repository_dispatch EXISTING_PR_FOUND=true EXISTING_PR_IS_DRAFT=unknown \
  "$RCA_TOOL" dispatch-plan >/dev/null 2>&1; then
  echo "FAIL: invalid duplicate PR state was accepted" >&2
  exit 1
fi

cat > "$CHECKOUT/scripts/tests/sample.test.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$CHECKOUT/scripts/tests/sample.test.sh"
printf 'sample.test.sh\n' > "$CHECKOUT/scripts/test.sh"
sample_hash="$(python3 - "$CHECKOUT/scripts/tests/sample.test.sh" <<'PY'
import hashlib
import pathlib
import sys
print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"
printf '%s\n' '0123456789abcdef0123456789abcdef01234567' > "$FAKE_GATE_ROOT/offline-gates.sha"
printf '%s\n' '0123456789abcdef0123456789abcdef01234567' > "$FAKE_GATE_ROOT/smoke-gates.sha"
printf '%s\n' 'd29e631e-b78a-40dd-8f0b-732d1143a854' > "$FAKE_GATE_ROOT/evidence.agent"
printf '%s\n' 'scripts/tests/sample.test.sh' > "$FAKE_GATE_ROOT/repro.path"
printf '%s\n' '0123456789abcdef0123456789abcdef01234567' > "$FAKE_GATE_ROOT/repro.head"
printf '%s\n' "$sample_hash" > "$FAKE_GATE_ROOT/repro.sha256"

cat > "$CONTEXT/pr-body-final.md" <<'REPORT'
# Complete RCA

Evidence: production trace captured.

Root cause: deterministic first-bad boundary.

Reproduction: failed before the fix and passed after the fix.

Verification: offline and smoke gates passed for this HEAD.

<!-- rca-slack ts=1784617220.480779 channel=C0BE1B87882 -->
REPORT

PATH="$FAKE_BIN:$PATH" \
CAPTURED_BODY="$CAPTURED_BODY" \
UNEXPECTED_CALLS="$UNEXPECTED_CALLS" \
FAKE_GATE_ROOT="$FAKE_GATE_ROOT" \
AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
RCA_BRANCH="auto-rca/d29e631eb78a-123" \
AUTO_RCA_ROOT_DIR="$CHECKOUT" \
AUTO_RCA_CONTEXT_DIR="$CONTEXT" \
AUTO_RCA_GATE_STATE_DIR="/var/lib/rose-auto-rca/123" \
GITHUB_RUN_ID="123" \
GITHUB_REPOSITORY="Rose-Ai-Labs/rose" \
GH_TOKEN="test-push-token" \
AUTO_RCA_PR_TOKEN="test-pr-token" \
SLACK_TS="1784617220.480779" \
SLACK_CHANNEL="C0BE1B87882" \
GH_CALLS="$TEST_ROOT/gh-calls.txt" \
"$RCA_TOOL" ensure-draft >/dev/null

if ! grep -Fq '# Complete RCA' "$CAPTURED_BODY"; then
  echo "FAIL: trusted finalizer discarded the investigator's completed RCA report" >&2
  echo "Captured PR body:" >&2
  sed -n '1,80p' "$CAPTURED_BODY" >&2
  exit 1
fi

if grep -Fq 'automated investigator completed without publishing' "$CAPTURED_BODY"; then
  echo "FAIL: completed RCA was mislabeled as a preliminary fallback" >&2
  exit 1
fi

if PATH="$FAKE_BIN:$PATH" \
  UNEXPECTED_CALLS="$UNEXPECTED_CALLS" \
  FAKE_GATE_ROOT="$FAKE_GATE_ROOT" \
  AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
  RCA_BRANCH="auto-rca/d29e631eb78a-123" \
  AUTO_RCA_ROOT_DIR="$CHECKOUT" \
  AUTO_RCA_CONTEXT_DIR="$CONTEXT" \
  AUTO_RCA_GATE_STATE_DIR="/var/lib/rose-auto-rca/123" \
  "$RCA_TOOL" require-complete >/dev/null 2>&1; then
  echo "FAIL: incomplete investigator outcome reproduced the old false-green workflow" >&2
  exit 1
fi

cat > "$CONTEXT/pr-body-final.md" <<'REPORT'
# Evidence

Production trace captured.

# Root cause

Deterministic first-bad boundary.

# Local reproduction

The unchanged blackbox command exercises the boundary.

# Pre-fix result

The assertion failed.

# Post-fix result

The same assertion passed.

# Verification

Offline and smoke gates passed for this HEAD.

<!-- rca-complete head=0123456789abcdef0123456789abcdef01234567 agent=d29e631e-b78a-40dd-8f0b-732d1143a854 -->
<!-- rca-slack ts=1784617220.480779 channel=C0BE1B87882 agent=d29e631e-b78a-40dd-8f0b-732d1143a854 run=123 -->
REPORT

: > "$TEST_ROOT/gh-calls.txt"
PATH="$FAKE_BIN:$PATH" \
CAPTURED_BODY="$CAPTURED_BODY" \
GH_CALLS="$TEST_ROOT/gh-calls.txt" \
UNEXPECTED_CALLS="$UNEXPECTED_CALLS" \
FAKE_GATE_ROOT="$FAKE_GATE_ROOT" \
FAKE_PR_JSON='{"number":999,"url":"https://github.com/Rose-Ai-Labs/rose/pull/999","isDraft":true}' \
AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
RCA_BRANCH="auto-rca/d29e631eb78a-123" \
AUTO_RCA_ROOT_DIR="$CHECKOUT" \
AUTO_RCA_CONTEXT_DIR="$CONTEXT" \
AUTO_RCA_GATE_STATE_DIR="/var/lib/rose-auto-rca/123" \
GITHUB_RUN_ID="123" \
GITHUB_REPOSITORY="Rose-Ai-Labs/rose" \
GH_TOKEN="test-push-token" \
AUTO_RCA_PR_TOKEN="test-pr-token" \
SLACK_TS="1784617220.480779" \
SLACK_CHANNEL="C0BE1B87882" \
"$RCA_TOOL" ensure-draft >/dev/null

grep -Fq 'pr ready pr ready --repo Rose-Ai-Labs/rose https://github.com/Rose-Ai-Labs/rose/pull/999' \
  "$TEST_ROOT/gh-calls.txt" || {
    echo "FAIL: complete HEAD-scoped RCA was not promoted to ready" >&2
    sed -n '1,120p' "$TEST_ROOT/gh-calls.txt" >&2
    exit 1
  }
if grep -Fq 'Status: RCA incomplete' "$CAPTURED_BODY"; then
  echo "FAIL: complete RCA retained an incomplete-state banner" >&2
  exit 1
fi

PATH="$FAKE_BIN:$PATH" \
UNEXPECTED_CALLS="$UNEXPECTED_CALLS" \
FAKE_GATE_ROOT="$FAKE_GATE_ROOT" \
AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
RCA_BRANCH="auto-rca/d29e631eb78a-123" \
AUTO_RCA_ROOT_DIR="$CHECKOUT" \
AUTO_RCA_CONTEXT_DIR="$CONTEXT" \
AUTO_RCA_GATE_STATE_DIR="/var/lib/rose-auto-rca/123" \
"$RCA_TOOL" require-complete >/dev/null

: > "$TEST_ROOT/gh-calls.txt"
PATH="$FAKE_BIN:$PATH" \
CAPTURED_BODY="$CAPTURED_BODY" \
GH_CALLS="$TEST_ROOT/gh-calls.txt" \
UNEXPECTED_CALLS="$UNEXPECTED_CALLS" \
FAKE_GATE_ROOT="$FAKE_GATE_ROOT" \
FAKE_PR_JSON='{"number":999,"url":"https://github.com/Rose-Ai-Labs/rose/pull/999","isDraft":false}' \
AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
RCA_BRANCH="auto-rca/d29e631eb78a-123" \
AUTO_RCA_ROOT_DIR="$CHECKOUT" \
AUTO_RCA_CONTEXT_DIR="$CONTEXT" \
AUTO_RCA_GATE_STATE_DIR="/var/lib/rose-auto-rca/123" \
GITHUB_RUN_ID="123" \
GITHUB_REPOSITORY="Rose-Ai-Labs/rose" \
GH_TOKEN="test-push-token" \
AUTO_RCA_PR_TOKEN="test-pr-token" \
"$RCA_TOOL" begin-draft >/dev/null

grep -Fq 'pr ready pr ready --undo --repo Rose-Ai-Labs/rose https://github.com/Rose-Ai-Labs/rose/pull/999' \
  "$TEST_ROOT/gh-calls.txt" || {
    echo "FAIL: reviewer feedback did not return the ready PR to draft" >&2
    sed -n '1,120p' "$TEST_ROOT/gh-calls.txt" >&2
    exit 1
  }

for state in running revising blocked draft ready shipped; do
  case "$state" in
    running) expected_label='🟡 RCA running' ;;
    revising) expected_label='🟡 Revising RCA from PR feedback' ;;
    blocked) expected_label='🔴 RCA blocked — draft needs attention' ;;
    draft) expected_label='🔵 Draft PR open (needs attention)' ;;
    ready) expected_label='🟢 Ready for review — approve to ship' ;;
    shipped) expected_label='✅ Shipped — merged to main' ;;
  esac
  message="$(
    AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
    AFFECTED_USER_NAME='Ada Lovelace' \
    RCA_STATE="$state" \
    RCA_FE_URL='https://roselabs.ai/?agent-id=d29e631e-b78a-40dd-8f0b-732d1143a854' \
    RCA_PR_URL='https://github.com/Rose-Ai-Labs/rose/pull/999' \
    RCA_RUN_URL='https://github.com/Rose-Ai-Labs/rose/actions/runs/123' \
    "$RCA_TOOL" slack-message
  )"
  grep -Fq "*Affected user:* Ada Lovelace" <<< "$message" || exit 1
  grep -Fq "*Current state:* $expected_label" <<< "$message" || exit 1
  grep -Fq '<https://roselabs.ai/?agent-id=d29e631e-b78a-40dd-8f0b-732d1143a854|FE View>' <<< "$message" || exit 1
  grep -Fq '<https://github.com/Rose-Ai-Labs/rose/pull/999|PR>' <<< "$message" || exit 1
  grep -Fq '<https://github.com/Rose-Ai-Labs/rose/actions/runs/123|GH Action RCA Run>' <<< "$message" || exit 1
  grep -Fq "*Agent ID:* \`d29e631e-b78a-40dd-8f0b-732d1143a854\`" <<< "$message" || exit 1
  if [ "$state" = shipped ]; then
    ! grep -Fq '*Feedback:*' <<< "$message" || exit 1
  else
    grep -Fq "*Feedback:* Add a top-level Conversation comment \`/rca <requested changes>\` on the PR." <<< "$message" || exit 1
  fi
done

if AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
  AFFECTED_USER_NAME='Ada Lovelace' \
  RCA_STATE='unknown' \
  RCA_FE_URL='https://roselabs.ai/?agent-id=d29e631e-b78a-40dd-8f0b-732d1143a854' \
  RCA_PR_URL='https://github.com/Rose-Ai-Labs/rose/pull/999' \
  RCA_RUN_URL='https://github.com/Rose-Ai-Labs/rose/actions/runs/123' \
  "$RCA_TOOL" slack-message >/dev/null 2>&1; then
  echo "FAIL: unknown Slack lifecycle state was accepted" >&2
  exit 1
fi

: > "$TEST_ROOT/curl-calls.txt"
: > "$TEST_ROOT/github-env.txt"
PATH="$FAKE_BIN:$PATH" \
CURL_CALLS="$TEST_ROOT/curl-calls.txt" \
GITHUB_ENV="$TEST_ROOT/github-env.txt" \
AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
AFFECTED_USER_NAME='Ada Lovelace' \
RCA_STATE=revising \
RCA_FE_URL='https://roselabs.ai/?agent-id=d29e631e-b78a-40dd-8f0b-732d1143a854' \
RCA_PR_URL='https://github.com/Rose-Ai-Labs/rose/pull/999' \
RCA_RUN_URL='https://github.com/Rose-Ai-Labs/rose/actions/runs/123' \
SLACK_BOT_TOKEN='test-slack-token' \
SLACK_CHANNEL='C0BE1B87882' \
SLACK_TS='1784617220.480779' \
"$RCA_TOOL" slack-update
grep -Fq 'https://slack.com/api/chat.update' "$TEST_ROOT/curl-calls.txt" || {
  echo "FAIL: existing lifecycle card was not updated in place" >&2
  exit 1
}
grep -Fq 'SLACK_TS=1784617220.480779' "$TEST_ROOT/github-env.txt" || exit 1

: > "$TEST_ROOT/curl-calls.txt"
: > "$TEST_ROOT/github-env.txt"
PATH="$FAKE_BIN:$PATH" \
CURL_CALLS="$TEST_ROOT/curl-calls.txt" \
GITHUB_ENV="$TEST_ROOT/github-env.txt" \
FAKE_SLACK_TS='1784617221.111111' \
AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
AFFECTED_USER_NAME='Ada Lovelace' \
RCA_STATE=running \
RCA_FE_URL='https://roselabs.ai/?agent-id=d29e631e-b78a-40dd-8f0b-732d1143a854' \
RCA_PR_URL='https://github.com/Rose-Ai-Labs/rose/pull/999' \
RCA_RUN_URL='https://github.com/Rose-Ai-Labs/rose/actions/runs/123' \
SLACK_BOT_TOKEN='test-slack-token' \
SLACK_CHANNEL='C0BE1B87882' \
"$RCA_TOOL" slack-update
grep -Fq 'https://slack.com/api/chat.postMessage' "$TEST_ROOT/curl-calls.txt" || {
  echo "FAIL: manual RCA without a Slack timestamp did not create a lifecycle card" >&2
  exit 1
}
grep -Fq 'SLACK_TS=1784617221.111111' "$TEST_ROOT/github-env.txt" || exit 1

: > "$TEST_ROOT/curl-calls.txt"
: > "$TEST_ROOT/github-env.txt"
PATH="$FAKE_BIN:$PATH" \
CURL_CALLS="$TEST_ROOT/curl-calls.txt" \
GITHUB_ENV="$TEST_ROOT/github-env.txt" \
FAKE_HISTORY_TS='1784617222.222222' \
AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
AFFECTED_USER_NAME='Ada Lovelace' \
RCA_STATE=running \
RCA_RECONCILE_SLACK=true \
RCA_FE_URL='https://roselabs.ai/?agent-id=d29e631e-b78a-40dd-8f0b-732d1143a854' \
RCA_PR_URL='https://github.com/Rose-Ai-Labs/rose/pull/999' \
RCA_RUN_URL='https://github.com/Rose-Ai-Labs/rose/actions/runs/123' \
SLACK_BOT_TOKEN='test-slack-token' \
SLACK_CHANNEL='C0BE1B87882' \
"$RCA_TOOL" slack-update
grep -Fq 'conversations.history' "$TEST_ROOT/curl-calls.txt" || exit 1
grep -Fq 'chat.update' "$TEST_ROOT/curl-calls.txt" || {
  echo "FAIL: recovered lifecycle did not update the metadata-matched Slack card" >&2
  exit 1
}
if grep -Fq 'chat.postMessage' "$TEST_ROOT/curl-calls.txt"; then
  echo "FAIL: recovered lifecycle duplicated an existing Slack card" >&2
  exit 1
fi

: > "$TEST_ROOT/curl-calls.txt"
: > "$TEST_ROOT/curl-count.txt"
PATH="$FAKE_BIN:$PATH" \
CURL_CALLS="$TEST_ROOT/curl-calls.txt" \
FAKE_CURL_COUNT="$TEST_ROOT/curl-count.txt" \
FAKE_SLACK_RATE_LIMIT_ONCE=true \
AUTO_RCA_SLACK_RETRY_SLEEP_SECONDS=0 \
AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
AFFECTED_USER_NAME='Ada Lovelace' \
RCA_STATE=blocked \
RCA_FE_URL='https://roselabs.ai/?agent-id=d29e631e-b78a-40dd-8f0b-732d1143a854' \
RCA_PR_URL='https://github.com/Rose-Ai-Labs/rose/pull/999' \
RCA_RUN_URL='https://github.com/Rose-Ai-Labs/rose/actions/runs/123' \
SLACK_BOT_TOKEN='test-slack-token' \
SLACK_CHANNEL='C0BE1B87882' \
SLACK_TS='1784617220.480779' \
"$RCA_TOOL" slack-update
[ "$(cat "$TEST_ROOT/curl-count.txt")" -eq 2 ] || {
  echo "FAIL: Slack rate limit did not retry to convergence" >&2
  exit 1
}

if PATH="$FAKE_BIN:$PATH" \
  CURL_CALLS="$TEST_ROOT/curl-calls.txt" \
  FAKE_SLACK_OK=false \
  AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
  AFFECTED_USER_NAME='Ada Lovelace' \
  RCA_STATE=blocked \
  RCA_FE_URL='https://roselabs.ai/?agent-id=d29e631e-b78a-40dd-8f0b-732d1143a854' \
  RCA_PR_URL='https://github.com/Rose-Ai-Labs/rose/pull/999' \
  RCA_RUN_URL='https://github.com/Rose-Ai-Labs/rose/actions/runs/123' \
  SLACK_BOT_TOKEN='test-slack-token' \
  SLACK_CHANNEL='C0BE1B87882' \
  SLACK_TS='1784617220.480779' \
  "$RCA_TOOL" slack-update >/dev/null 2>&1; then
  echo "FAIL: Slack API rejection was silently accepted" >&2
  exit 1
fi

# The trusted verifier must run one byte-identical test against clean baseline
# and current archives, observe the first fail, observe the second pass, and
# write root-owned attestations. This uses real git; only sudo is faked.
REAL_REPO="$TEST_ROOT/repro-repo"
SUDO_ONLY_BIN="$TEST_ROOT/sudo-only-bin"
REAL_CONTEXT="$REAL_REPO/.context/auto-rca"
REAL_GATES="$TEST_ROOT/real-gates"
mkdir -p "$REAL_REPO/scripts/tests" "$REAL_CONTEXT" "$SUDO_ONLY_BIN" "$REAL_GATES"
cp "$FAKE_BIN/sudo" "$SUDO_ONLY_BIN/sudo"
(
  cd "$REAL_REPO"
  git init -q -b main
  git config user.name test
  git config user.email test@example.com
  printf '.context/\n' > .gitignore
  printf 'broken\n' > behavior.txt
  cat > scripts/tests/unchanged-repro.test.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
grep -Fxq fixed behavior.txt
SH
  chmod +x scripts/tests/unchanged-repro.test.sh
  printf 'bash scripts/tests/unchanged-repro.test.sh\n' > scripts/test.sh
  git add .
  git commit -qm baseline
  baseline="$(git rev-parse HEAD)"
  git update-ref refs/remotes/origin/main "$baseline"
  printf 'fixed\n' > behavior.txt
  git add behavior.txt
  git commit -qm fix
)
printf '{"test_path":"scripts/tests/unchanged-repro.test.sh"}\n' > "$REAL_CONTEXT/repro.json"

PATH="$SUDO_ONLY_BIN:$ORIGINAL_PATH" \
FAKE_GATE_ROOT="$REAL_GATES" \
AGENT_ID="d29e631e-b78a-40dd-8f0b-732d1143a854" \
RCA_BRANCH=auto-rca/d29e631eb78a \
AUTO_RCA_ROOT_DIR="$REAL_REPO" \
AUTO_RCA_CONTEXT_DIR="$REAL_CONTEXT" \
AUTO_RCA_GATE_STATE_DIR="/var/lib/rose-auto-rca/456" \
"$RCA_TOOL" verify-repro >/dev/null

[ "$(cat "$REAL_GATES/repro.head")" = "$(git -C "$REAL_REPO" rev-parse HEAD)" ] || {
  echo "FAIL: repro attestation was not bound to current HEAD" >&2
  exit 1
}
grep -Fq 'Baseline exit: 1 (must be non-zero)' "$REAL_GATES/verification.txt" || {
  echo "FAIL: verifier did not record the pre-fix failure" >&2
  exit 1
}
grep -Fq 'Current exit: 0 (must be zero)' "$REAL_GATES/verification.txt" || {
  echo "FAIL: verifier did not record the post-fix pass" >&2
  exit 1
}

if [ -s "$UNEXPECTED_CALLS" ]; then
  echo "FAIL: lifecycle blackbox silently ignored fake calls:" >&2
  cat "$UNEXPECTED_CALLS" >&2
  exit 1
fi

echo "Auto-RCA lifecycle blackbox passed."
