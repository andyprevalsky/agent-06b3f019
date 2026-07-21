#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/auto-rca.yml"
SHIPPED_WORKFLOW="$ROOT_DIR/.github/workflows/auto-rca-shipped.yml"
RCA_TOOL="$ROOT_DIR/scripts/auto-rca-tool"
LITERAL_DOLLAR='$'

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

require_absent() {
  local file="$1"
  local text="$2"
  local description="$3"
  if grep -Fq -- "$text" "$file"; then
    fail "$description"
  fi
}

require_text "$WORKFLOW" 'agent_id must be a UUID' "auto-RCA must reject non-UUID agent IDs"
require_text "$WORKFLOW" 'FAILURE_SOURCE: agent_workflow' "auto-RCA prompt source must be trusted"
require_text "$WORKFLOW" 'FAILURE_TITLE: Production agent failure' "auto-RCA prompt title must be trusted"
require_absent "$WORKFLOW" 'github.event.client_payload.source' "dispatch source must not reach the privileged prompt"
require_absent "$WORKFLOW" 'github.event.client_payload.title' "dispatch title must not reach the privileged prompt"
require_absent "$WORKFLOW" "Failure source: ${LITERAL_DOLLAR}{{ env.FAILURE_SOURCE }}" "failure source must not be interpolated into the privileged prompt"
require_absent "$WORKFLOW" "Failure title: ${LITERAL_DOLLAR}{{ env.FAILURE_TITLE }}" "failure title must not be interpolated into the privileged prompt"
require_text "$WORKFLOW" 'slack_ts must be a Slack message timestamp' "dispatch Slack timestamp must be validated"
require_text "$WORKFLOW" 'slack_channel must be a Slack channel ID' "dispatch Slack channel must be validated"
require_text "$WORKFLOW" "SLACK_OUTPUT_TS: ${LITERAL_DOLLAR}{{ steps.slack.outputs.ts }}" "step output must enter shell through the environment"
require_absent "$WORKFLOW" "ts=\"${LITERAL_DOLLAR}{{ steps.slack.outputs.ts }}\"" "step output must not be interpolated directly into shell source"
require_text "$WORKFLOW" "printf 'SLACK_TS=%s\\n' \"${LITERAL_DOLLAR}{ts:-}\" >> \"${LITERAL_DOLLAR}GITHUB_ENV\"" "resolved manual-dispatch Slack timestamp must reach the RCA broker"
require_text "$WORKFLOW" "printf 'SLACK_CHANNEL=%s\\n' \"${LITERAL_DOLLAR}{channel:-}\" >> \"${LITERAL_DOLLAR}GITHUB_ENV\"" "resolved manual-dispatch Slack channel must reach the RCA broker"
require_text "$WORKFLOW" 'persist-credentials: false' "checkout credentials must not persist into RCA tools"
require_text "$SHIPPED_WORKFLOW" "github.event.pull_request.base.ref == 'main'" "shipped notice must require a merge into main"
require_text "$WORKFLOW" 'sudo install -o root -g root -m 0555 scripts/auto-rca-tool /usr/local/bin/rose-auto-rca-tool' "auto-RCA must install an immutable broker outside the agent workspace"
require_text "$WORKFLOW" "sudo install -d -o root -g root -m 0700 \"${LITERAL_DOLLAR}AUTO_RCA_GATE_STATE_DIR\"" "auto-RCA must create root-owned gate state outside the agent workspace"
require_text "$WORKFLOW" '--allowedTools "Bash(/usr/local/bin/rose-auto-rca-tool evidence),Bash(/usr/local/bin/rose-auto-rca-tool benchmark),Bash(/usr/local/bin/rose-auto-rca-tool offline-gates),Bash(/usr/local/bin/rose-auto-rca-tool smoke-gates),Bash(/usr/local/bin/rose-auto-rca-tool publish-draft),Bash(/usr/local/bin/rose-auto-rca-tool mark-ready)"' "auto-RCA must grant only the immutable command broker"
require_absent "$WORKFLOW" 'Bash(*)' "auto-RCA must never grant arbitrary shell execution"
require_absent "$WORKFLOW" 'Bash(curl' "auto-RCA must not expose raw curl to production evidence"
require_absent "$WORKFLOW" 'Bash(gh' "auto-RCA must not expose raw GitHub CLI access"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool evidence' "auto-RCA prompt must gather evidence through the immutable command broker"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool publish-draft' "auto-RCA prompt must publish through the immutable command broker"
require_text "$WORKFLOW" 'name: Ensure preliminary RCA draft' "auto-RCA must create a preliminary draft when Claude does not publish one"
require_text "$WORKFLOW" '/usr/local/bin/rose-auto-rca-tool ensure-draft' "the trusted workflow must enforce the preliminary draft fallback"
require_absent "$WORKFLOW" 'Bash(/usr/local/bin/rose-auto-rca-tool ensure-draft)' "Claude must not be allowed to invoke the trusted draft fallback"
require_text "$WORKFLOW" 'name: Require RCA pull request' "auto-RCA must reject a successful Claude step that produced no PR"
require_text "$WORKFLOW" 'No RCA pull request was created' "missing PR must be a visible workflow failure"
require_text "$RCA_TOOL" "sudo tee \"${LITERAL_DOLLAR}GATE_STATE_DIR/${LITERAL_DOLLAR}{gate}.sha\"" "gate attestations must be written through the root-owned broker state"
require_text "$RCA_TOOL" "sudo cat \"${LITERAL_DOLLAR}marker\"" "gate attestations must be read from the root-owned broker state"
require_absent "$RCA_TOOL" "\"${LITERAL_DOLLAR}CONTEXT_DIR/${LITERAL_DOLLAR}{gate}.sha\"" "gate attestations must not live in the agent-writable context directory"
require_text "$RCA_TOOL" "GIT_ASKPASS=\"${LITERAL_DOLLAR}askpass\" GIT_TERMINAL_PROMPT=0" "the broker must authenticate pushes through an ephemeral askpass helper"
require_text "$RCA_TOOL" "git_push_branch \"${LITERAL_DOLLAR}branch\"" "all RCA pushes must use the authenticated broker path"
require_text "$RCA_TOOL" "git -C \"${LITERAL_DOLLAR}ROOT_DIR\" remote set-url origin \"https://github.com/${LITERAL_DOLLAR}GITHUB_REPOSITORY.git\"" "the broker must replace action-mutated origin credentials with the validated repository URL"
require_absent "$RCA_TOOL" 'remote get-url origin' "the broker must not trust the origin URL left by the Claude action"
require_absent "$RCA_TOOL" 'gh auth setup-git' "the broker must not rely on gh auth setup-git for ephemeral GITHUB_TOKEN authentication"
require_absent "$RCA_TOOL" "${LITERAL_DOLLAR}{GH_TOKEN}@github.com" "the broker must not place the GitHub token in a remote URL"
require_absent "$RCA_TOOL" 'extraheader' "the broker must not persist a derived credential in repository config"

ensure_line="$(grep -nF 'name: Ensure preliminary RCA draft' "$WORKFLOW" | cut -d: -f1)"
require_line="$(grep -nF 'name: Require RCA pull request' "$WORKFLOW" | cut -d: -f1)"
[ -n "$ensure_line" ] && [ -n "$require_line" ] && [ "$ensure_line" -lt "$require_line" ] || \
  fail "the preliminary draft fallback must run before the PR postcondition"

[ -x "$RCA_TOOL" ] || fail "auto-RCA command broker must exist and be executable"
if "$RCA_TOOL" >/dev/null 2>&1; then
  fail "auto-RCA command broker must reject a missing subcommand"
fi
if AGENT_ID=not-a-uuid "$RCA_TOOL" evidence >/dev/null 2>&1; then
  fail "auto-RCA command broker must reject an invalid agent ID before network access"
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/auto-rca-tool-test.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT
printf 'not-a-catalog-task\n' > "$TEMP_ROOT/benchmark-task"
if AUTO_RCA_CONTEXT_DIR="$TEMP_ROOT" "$RCA_TOOL" benchmark >/dev/null 2>&1; then
  fail "auto-RCA command broker must reject an unknown benchmark task"
fi
if AGENT_ID=550e8400-e29b-41d4-a716-446655440000 RCA_BRANCH=main \
  AUTO_RCA_CONTEXT_DIR="$TEMP_ROOT" "$RCA_TOOL" publish-draft >/dev/null 2>&1; then
  fail "auto-RCA command broker must reject a non-auto-RCA branch"
fi
if AGENT_ID=550e8400-e29b-41d4-a716-446655440000 RCA_BRANCH=auto-rca/test \
  AUTO_RCA_CONTEXT_DIR="$TEMP_ROOT" "$RCA_TOOL" mark-ready >/dev/null 2>&1; then
  fail "auto-RCA command broker must not mark a PR ready before both gates pass"
fi

while IFS= read -r action_ref; do
  if ! [[ "$action_ref" =~ @[0-9a-f]{40}$ ]]; then
    fail "auto-RCA action is not pinned to a full commit SHA: $action_ref"
  fi
done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+([^ #]+).*/\1/p' "$WORKFLOW")

echo "All auto-RCA workflow checks passed."
