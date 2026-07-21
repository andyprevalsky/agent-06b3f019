#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/auto-rca.yml"
SHIPPED_WORKFLOW="$ROOT_DIR/.github/workflows/auto-rca-shipped.yml"

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
require_absent "$WORKFLOW" 'Failure source: ${{ env.FAILURE_SOURCE }}' "failure source must not be interpolated into the privileged prompt"
require_absent "$WORKFLOW" 'Failure title: ${{ env.FAILURE_TITLE }}' "failure title must not be interpolated into the privileged prompt"
require_text "$WORKFLOW" 'slack_ts must be a Slack message timestamp' "dispatch Slack timestamp must be validated"
require_text "$WORKFLOW" 'slack_channel must be a Slack channel ID' "dispatch Slack channel must be validated"
require_text "$WORKFLOW" 'SLACK_OUTPUT_TS: ${{ steps.slack.outputs.ts }}' "step output must enter shell through the environment"
require_absent "$WORKFLOW" 'ts="${{ steps.slack.outputs.ts }}"' "step output must not be interpolated directly into shell source"
require_text "$WORKFLOW" 'persist-credentials: false' "checkout credentials must not persist into RCA tools"
require_text "$SHIPPED_WORKFLOW" "github.event.pull_request.base.ref == 'main'" "shipped notice must require a merge into main"

while IFS= read -r action_ref; do
  if ! [[ "$action_ref" =~ @[0-9a-f]{40}$ ]]; then
    fail "auto-RCA action is not pinned to a full commit SHA: $action_ref"
  fi
done < <(sed -nE 's/^[[:space:]]*uses:[[:space:]]+([^ #]+).*/\1/p' "$WORKFLOW")

echo "All auto-RCA workflow checks passed."
