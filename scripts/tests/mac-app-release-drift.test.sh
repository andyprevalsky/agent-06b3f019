#!/usr/bin/env bash
set -euo pipefail

# Regression gate for the shipped-Mac-app drift bug.
#
# The packaged Mac app compiles the shared front-end at build time, but a
# release only exists once a `v*` tag is pushed. When tagging depended solely
# on a human attaching MAC-APP-RELEASE, front-end-only PRs shipped to the web
# and never reached the desktop app (PR #973's rose "Connected" integrations
# treatment was live on roselabs.ai while the installed v1.1.132 build still
# rendered the old emerald chips).
#
# These checks pin the two invariants that make that impossible:
#   1. Any merge touching the shipped surface tags a release, label or not.
#   2. Non-shipping changes (tests, docs) never burn a signed release.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/auto-tag-mac-app.yml"
RELEASE_WORKFLOW="$ROOT_DIR/.github/workflows/release-mac-app.yml"
DECISION="$ROOT_DIR/scripts/mac-app-release-decision"
MAC_VITE_CONFIG="$ROOT_DIR/mac-app/vite.config.ts"
MAC_ROUTES="$ROOT_DIR/mac-app/ui/features/electron-app/components/AppRoutes.tsx"
FRONTEND_PACKAGE="$ROOT_DIR/front-end/package.json"
MAC_PACKAGE="$ROOT_DIR/mac-app/package.json"
TEST_RUNNER="$ROOT_DIR/scripts/test.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local file="$1" text="$2" description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

# The premise of the whole gate: the Mac app really does bundle front-end
# source. If either link is ever severed, this test must be revisited rather
# than silently guarding nothing.
require_text "$MAC_VITE_CONFIG" "path.resolve(__dirname, '../front-end/src')" \
  "mac-app must still alias @ to front-end/src (the shipped-surface premise)"
require_text "$MAC_ROUTES" "@/pages/Terminal" \
  "mac-app must still render the shared front-end Terminal (which hosts Integrations)"

[ -x "$DECISION" ] || fail "mac-app release decision script must be executable"

# --- behavioral: the decision script itself -------------------------------

assert_decision() {
  local description="$1" label="$2" expected_ship="$3" expected_reason="$4"
  shift 4
  local out
  out="$(printf '%s\n' "$@" | MAC_APP_RELEASE_LABEL="$label" "$DECISION")"
  grep -Fqx "ship=$expected_ship" <<< "$out" || fail "$description (expected ship=$expected_ship, got: $out)"
  grep -Fqx "reason=$expected_reason" <<< "$out" || fail "$description (expected reason=$expected_reason, got: $out)"
}

# The exact regression: PR #973 changed only front-end integrations components
# and carried no label. It MUST ship.
assert_decision "front-end-only integrations change must ship the Mac app" \
  false true shipped-surface \
  'front-end/src/features/integrations/components/SectionToggleButton.tsx' \
  'front-end/src/features/integrations/components/DropdownIconFrame.tsx' \
  'front-end/src/tests/blackbox/integrations.blackbox.tsx'

assert_decision "mac-app source changes must ship" \
  false true shipped-surface 'mac-app/ui/features/onboarding/components/OnboardingData.tsx'

assert_decision "front-end dependency changes must ship" \
  false true shipped-surface 'front-end/package.json'

assert_decision "the explicit label must still force a release" \
  true true label 'back-end/src/server.ts'

# Cost guards: these must NOT trigger a signed + notarized build.
assert_decision "backend-only changes must not ship the Mac app" \
  false false no-shipped-change 'back-end/src/server.ts' 'agents/worker.py'

assert_decision "front-end test-only changes must not ship" \
  false false no-shipped-change \
  'front-end/src/tests/blackbox/integrations.blackbox.tsx' \
  'front-end/src/tests/structural/structural-deps.test.ts'

assert_decision "mac-app test-only changes must not ship" \
  false false no-shipped-change 'mac-app/tests/renderer.test.ts' 'mac-app/tests-e2e/launch.spec.ts'

assert_decision "docs-only changes must not ship" \
  false false no-shipped-change 'front-end/README.md' 'docs/testing.md'

# A colocated test (not under a tests/ directory) is classified purely by its
# suffix. Any suffix missing from is_ignored_path silently burns a signed +
# notarized release on a test-only change, so pin every suffix the repo uses.
for colocated_test in \
  'front-end/src/Example.spec.tsx' \
  'front-end/src/Example.spec.ts' \
  'front-end/src/Example.spec.js' \
  'front-end/src/Example.spec.jsx' \
  'front-end/src/Example.test.tsx' \
  'front-end/src/Example.test.js' \
  'mac-app/ui/Example.spec.ts' \
  'mac-app/ui/Example.blackbox.ts' \
  'front-end/tests-e2e/login.spec.ts'; do
  assert_decision "colocated test file $colocated_test must not ship" \
    false false no-shipped-change "$colocated_test"
done

# ...but a colocated test must not mask a real shipped change beside it.
assert_decision "a real change alongside a colocated test still ships" \
  false true shipped-surface \
  'front-end/src/Example.spec.tsx' \
  'front-end/src/features/integrations/components/SyncItemButton.tsx'

assert_decision "an empty diff must not ship" false false no-shipped-change ''

# --- structural: the workflow must use that decision ----------------------

require_text "$WORKFLOW" 'scripts/mac-app-release-decision' \
  "auto-tag workflow must delegate to the shared release decision"
require_text "$WORKFLOW" 'BASE="${MERGE_SHA}^1"' \
  "release decision must inspect exactly what the PR added to main"
require_text "$WORKFLOW" 'git diff --name-only "$BASE" "${MERGE_SHA}"' \
  "release decision must diff the merge/push base against the shipped commit"
require_text "$WORKFLOW" 'BASE="$BEFORE_SHA"' \
  "a direct push must diff every commit it added to main"
require_text "$WORKFLOW" 'branches: [main]' \
  "direct /push merges to main must also cut a Mac release"
require_text "$RELEASE_WORKFLOW" 'group: release-mac-app' \
  "Mac builds must queue so the newest pending tag builds next"
require_text "$RELEASE_WORKFLOW" 'cancel-in-progress: false' \
  "a newer tag must never cancel a running Mac build"
require_text "$WORKFLOW" "steps.decide.outputs.ship == 'true'" \
  "tag creation must be gated on the shared decision"
require_text "$WORKFLOW" 'git tag --points-at "$MERGE_SHA"' \
  "a workflow rerun must not cut a second release for an already-tagged commit"
require_text "$WORKFLOW" 'group: auto-tag-mac-app' \
  "concurrent merges must serialize so two PRs cannot compute the same next tag"
require_text "$WORKFLOW" "github.event.pull_request.base.ref == 'main'" \
  "only merges into main may cut a release"

# The regression that started this: gating the whole job on the label meant a
# labelless front-end merge never even evaluated the shipped surface.
job_condition="$(sed -n '/^  auto-tag:/,/runs-on:/p' "$WORKFLOW")"
if grep -Fq "contains(github.event.pull_request.labels.*.name, 'MAC-APP-RELEASE')" <<< "$job_condition"; then
  fail "the job must not be gated on MAC-APP-RELEASE — that is how front-end merges silently skipped the Mac app"
fi
require_text "$WORKFLOW" "contains(github.event.pull_request.labels.*.name, 'MAC-APP-RELEASE')" \
  "the label must still be readable as an explicit override"
require_text "$RELEASE_WORKFLOW" "npm ci --ignore-scripts --workspaces=false" \
  "Mac release must install the locked shared frontend graph without resolving the root workspace"

# Shared renderer modules resolve from mac-app/ui during the desktop build, so
# every runtime package they import must also be a direct Mac dependency. Pin
# the shader dependency to the same range on both surfaces; otherwise a clean
# release runner can install the frontend package successfully and still fail
# when Vite resolves the Mac renderer graph.
node - "$FRONTEND_PACKAGE" "$MAC_PACKAGE" <<'NODE' || fail "Mac app must directly declare the shared shader dependency at the frontend version"
const fs = require('node:fs');
const [frontendPath, macPath] = process.argv.slice(2);
const frontend = JSON.parse(fs.readFileSync(frontendPath, 'utf8'));
const mac = JSON.parse(fs.readFileSync(macPath, 'utf8'));
const frontendRange = frontend.dependencies?.['@paper-design/shaders'];
const macRange = mac.dependencies?.['@paper-design/shaders'];
if (!frontendRange || macRange !== frontendRange) process.exit(1);
NODE

if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
  python3 -c 'import sys, yaml; [yaml.safe_load(open(path)) for path in sys.argv[1:]]' \
    "$WORKFLOW" "$RELEASE_WORKFLOW" || fail "workflow YAML must parse"
elif command -v ruby >/dev/null 2>&1; then
  ruby -e 'require "yaml"; ARGV.each { |path| YAML.parse_file(path) }' \
    "$WORKFLOW" "$RELEASE_WORKFLOW" || fail "workflow YAML must parse"
else
  fail "workflow YAML must parse (need python3+PyYAML or ruby)"
fi
if command -v actionlint >/dev/null 2>&1; then
  actionlint "$WORKFLOW" || fail "actionlint rejected the auto-tag workflow"
fi

# Cemented in the consistently-run gate.
python3 "$ROOT_DIR/scripts/tests/mac-app-autotag.test.py"

require_text "$TEST_RUNNER" 'mac-app-release-drift.test.sh' \
  "full test gate must run the Mac app release drift contract"

echo "All Mac app release drift checks passed."
