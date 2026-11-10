#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/claude-code-review-fallback.yml"
DEPLOY_COMMAND="$ROOT_DIR/.claude/commands/deploy.md"
REVIEW_CYCLE="$ROOT_DIR/scripts/deploy_review_cycle.py"
REVIEW_WAITER="$ROOT_DIR/scripts/wait_for_code_review.py"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local file="$1"
  local text="$2"
  local description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

[ -f "$WORKFLOW" ] || fail "Claude review fallback workflow is missing"

require_text "$WORKFLOW" "types: [labeled, synchronize]" "fallback must support label activation and labeled-PR updates"
require_text "$WORKFLOW" "workflow_dispatch:" "fallback must support manual dispatch"
# Retired by user decision on 2026-10-28 (d7f06d576): the review job is inert
# even when the PR is labeled or the workflow is dispatched, and no label
# expression may re-enable it. The trigger surface stays label/manual only.
require_text "$WORKFLOW" "if: \${{ false }}" "the retired fallback job must stay inert (if: false) even when labeled or dispatched"
if grep -Fq -- "github.event.label.name == 'claude-review-fallback'" "$WORKFLOW"; then
  fail "the claude-review-fallback label must not re-enable the retired fallback"
fi
require_text "$WORKFLOW" "claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}" "OAuth token must come from GitHub Secrets"
require_text "$WORKFLOW" "uses: anthropics/claude-code-action@v1" "official Claude Code Action v1 is required"
require_text "$WORKFLOW" "code-review@claude-code-plugins" "official code-review plugin is required"
require_text "$WORKFLOW" "--comment" "Claude review must publish its findings to the PR"

if grep -Eq 'types:.*(opened|ready_for_review|reopened)' "$WORKFLOW"; then
  fail "fallback must not run automatically on healthy CodeRabbit PRs"
fi

if grep -Fq -- "-X POST -f 'labels[]=claude-review-fallback'" "$DEPLOY_COMMAND"; then
  fail "/deploy must not trigger the disabled Claude fallback"
fi
# The executing deploy CLI and review ledger must not trigger the disabled fallback either.
for source in "$ROOT_DIR/scripts/deploy_cli.py" "$ROOT_DIR/scripts/deploy_review_cycle.py" "$ROOT_DIR/scripts/wait_for_code_review.py"; do
  if grep -Fq -- "claude-review-fallback" "$source"; then
    fail "$(basename "$source") must not trigger the disabled Claude fallback"
  fi
done
require_text "$DEPLOY_COMMAND" "The Claude fallback review is disabled." "/deploy must state the Claude fallback is disabled"
# deploy.md names the CodeRabbit quota skip; the quota/spending-cap wording is
# recognized by the review-cycle ledger and the review waiter, not by the doc.
require_text "$DEPLOY_COMMAND" 'Confirmed quota or spending cap on the current HEAD: `deploy_review_cycle.py skip --reason usage-cap`' \
  "/deploy must route a confirmed CodeRabbit quota or spending cap to the review-cycle skip"
require_text "$REVIEW_CYCLE" 'USAGE_EXHAUSTED = re.compile(r"review limit reached|usage spending cap|spending cap", re.IGNORECASE)' \
  "the review cycle does not recognize CodeRabbit quota and spending-cap failures"
require_text "$REVIEW_WAITER" '"review limit reached" in description' \
  "the review waiter does not recognize CodeRabbit quota failures"
require_text "$REVIEW_WAITER" '"usage spending cap" in description' \
  "the review waiter does not recognize CodeRabbit spending-cap failures"

echo "All Claude review fallback checks passed (workflow inert; fallback disabled in /deploy)."
