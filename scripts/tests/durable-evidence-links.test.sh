#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

require_text() {
  local file="$1" text="$2" description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

HUB="$ROOT_DIR/agents/benchmarks/hub_upload.py"
RESULTS="$ROOT_DIR/agents/benchmarks/results.py"
PUBLISH="$ROOT_DIR/scripts/publish_evidence_links.py"
AGENTS_MD="$ROOT_DIR/AGENTS.md"

[ -f "$HUB" ] || fail "hub_upload.py missing"
[ -f "$PUBLISH" ] || fail "publish_evidence_links.py missing"

require_text "$HUB" "mirror_run_bundle_to_durable_hub" \
  "ephemeral Hub runs must dual-write to the durable Hub"
require_text "$HUB" "durable_open_agent_url" \
  "hub_upload must expose durable open-agent URLs"
require_text "$HUB" "CURSOR_AGENT" \
  "Cloud Agents must fail closed when durable Hub mirror fails"
require_text "$RESULTS" "mirror_run_bundle_to_durable_hub" \
  "BenchmarkRun.save must mirror terminal bundles to the durable Hub"
require_text "$RESULTS" "print_durable_agent_links" \
  "BenchmarkRun.save must print durable FE links"
require_text "$PUBLISH" "/opt/cursor/artifacts/rca_evidence" \
  "publish_evidence_links must write Cursor artifacts"
require_text "$PUBLISH" "www.roselabs.ai" \
  "publish_evidence_links must target the durable www.roselabs.ai origin"
require_text "$PUBLISH" "/?agent-id=" \
  "publish_evidence_links must use Terminal /?agent-id= deep links"
require_text "$HUB" "/?agent-id=" \
  "durable_open_agent_url must use Terminal /?agent-id= (not a missing /open-agent path alone)"
require_text "$AGENTS_MD" "publish_evidence_links.py" \
  "AGENTS.md must instruct Cloud Agents to publish durable evidence"

cd "$ROOT_DIR/agents"
# shellcheck disable=SC1091
source venv/bin/activate
PYTHONPATH=. python -m pytest benchmarks/hub_upload_test.py -q

echo "All durable evidence-link checks passed."
