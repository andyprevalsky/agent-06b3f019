#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/claude-code-review-fallback.yml"
DEPLOY_COMMAND="$ROOT_DIR/.claude/commands/deploy.md"

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
require_text "$WORKFLOW" "claude-review-fallback" "fallback label is not configured"
require_text "$WORKFLOW" "contains(github.event.pull_request.labels.*.name, 'claude-review-fallback')" "synchronize events must remain gated by the fallback label"
# The literal GitHub expression must not be expanded by this test shell.
# shellcheck disable=SC2016
require_text "$WORKFLOW" 'claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' "OAuth token must come from GitHub Secrets"
require_text "$WORKFLOW" "uses: anthropics/claude-code-action@v1" "official Claude Code Action v1 is required"
require_text "$WORKFLOW" "code-review@claude-code-plugins" "official code-review plugin is required"
require_text "$WORKFLOW" "--comment" "Claude review must publish its findings to the PR"

if grep -Eq 'types:.*(opened|ready_for_review|reopened)' "$WORKFLOW"; then
  fail "fallback must not run automatically on healthy CodeRabbit PRs"
fi

if grep -Fq -- "-X POST -f 'labels[]=claude-review-fallback'" "$DEPLOY_COMMAND"; then
  fail "/deploy must not trigger the disabled Claude fallback"
fi
require_text "$DEPLOY_COMMAND" "Claude fallback review is DISABLED" "/deploy must state the Claude fallback is disabled"
require_text "$DEPLOY_COMMAND" "Review limit reached" "/deploy does not recognize CodeRabbit quota failures"
require_text "$DEPLOY_COMMAND" "usage spending cap" "/deploy does not recognize CodeRabbit spending-cap failures"

echo "All Claude review fallback checks passed (fallback disabled in /deploy)."
