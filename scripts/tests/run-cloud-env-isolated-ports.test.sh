#!/usr/bin/env bash
# Isolated benchmark runs must keep the CONDUCTOR_PORT / workspace that local.py
# assigned even when .cloud-env is sourced (cloud agents always have .cloud-env).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Help must be side-effect free even inside a configured cloud workspace.
mkdir -p "$TMP/help-workspace/scripts"
cp "${RUN_HELP_SOURCE:-$ROOT/scripts/run.sh}" "$TMP/help-workspace/scripts/run.sh"
cat > "$TMP/help-workspace/.cloud-env" <<'ENV'
printf 'unexpected workspace setup\n' > "$HELP_SIDE_EFFECT_MARKER"
export CONDUCTOR_PORT=3001
ENV
for help_args in '--help' '-h' '--benchmark --help'; do
  marker="$TMP/help-side-effect"
  read -r -a help_argv <<< "$help_args"
  if ! out=$(HELP_SIDE_EFFECT_MARKER="$marker" bash "$TMP/help-workspace/scripts/run.sh" "${help_argv[@]}" 2>&1); then
    echo "FAIL help must exit successfully before workspace setup: $help_args" >&2
    exit 1
  fi
  [ ! -e "$marker" ] || { echo 'FAIL help sourced workspace configuration' >&2; exit 1; }
  [[ "$out" == *'Usage:'* ]] || { echo 'FAIL help omitted usage' >&2; exit 1; }
done

# Assert run.sh still contains the preserve logic (structural).
grep -q '_cloud_env_isolated' "$ROOT/scripts/run.sh"
grep -q 'must not clobber those' "$ROOT/scripts/run.sh"

cat > "$TMP/.cloud-env" <<'ENV'
export CONDUCTOR_PORT=3001
export CONDUCTOR_WORKSPACE_NAME=shared-ws
ENV

cat > "$TMP/probe.sh" <<'PROBE'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Mirror scripts/run.sh cloud-env sourcing + isolated/strict preserve.
if [ -f "$SCRIPT_DIR/.cloud-env" ]; then
    _cloud_env_saved_port="${CONDUCTOR_PORT:-}"
    _cloud_env_saved_workspace="${CONDUCTOR_WORKSPACE_NAME:-}"
    _cloud_env_isolated="${BENCHMARK_ISOLATED_RUN:-false}"
    _cloud_env_strict="${RUN_SH_STRICT_CONDUCTOR_PORT:-0}"
    . "$SCRIPT_DIR/.cloud-env"
    if [ "$_cloud_env_isolated" = "true" ] || [ "$_cloud_env_strict" = "1" ]; then
        [ -n "$_cloud_env_saved_port" ] && CONDUCTOR_PORT="$_cloud_env_saved_port"
        [ -n "$_cloud_env_saved_workspace" ] && CONDUCTOR_WORKSPACE_NAME="$_cloud_env_saved_workspace"
    fi
    unset _cloud_env_saved_port _cloud_env_saved_workspace _cloud_env_isolated _cloud_env_strict
fi
printf 'port=%s ws=%s\n' "${CONDUCTOR_PORT:-}" "${CONDUCTOR_WORKSPACE_NAME:-}"
PROBE
chmod +x "$TMP/probe.sh"

out=$(cd "$TMP" && BENCHMARK_ISOLATED_RUN=true CONDUCTOR_PORT=3201 CONDUCTOR_WORKSPACE_NAME=bench-x bash probe.sh)
[ "$out" = "port=3201 ws=bench-x" ] || { echo "FAIL isolated preserve: $out" >&2; exit 1; }

out=$(cd "$TMP" && env -u BENCHMARK_ISOLATED_RUN RUN_SH_STRICT_CONDUCTOR_PORT=1 CONDUCTOR_PORT=56000 CONDUCTOR_WORKSPACE_NAME=deploy-ws bash probe.sh)
[ "$out" = "port=56000 ws=deploy-ws" ] || { echo "FAIL strict preserve: $out" >&2; exit 1; }

out=$(cd "$TMP" && env -u BENCHMARK_ISOLATED_RUN -u RUN_SH_STRICT_CONDUCTOR_PORT CONDUCTOR_PORT=3201 CONDUCTOR_WORKSPACE_NAME=bench-x bash probe.sh)
[ "$out" = "port=3001 ws=shared-ws" ] || { echo "FAIL shared cloud-env wins: $out" >&2; exit 1; }

# AgentCard lifecycle launches run.sh --benchmark and must export the isolated
# flag + CONDUCTOR_PORT so .cloud-env cannot collapse onto the shared port.
LIFECYCLE="$ROOT/scripts/run-agentcard-lifecycle-task.sh"
grep -qE '^export CONDUCTOR_PORT$' "$LIFECYCLE" \
  || { echo "FAIL: run-agentcard-lifecycle-task.sh must export CONDUCTOR_PORT" >&2; exit 1; }
grep -qE '^export BENCHMARK_ISOLATED_RUN=true$' "$LIFECYCLE" \
  || { echo "FAIL: run-agentcard-lifecycle-task.sh must export BENCHMARK_ISOLATED_RUN=true" >&2; exit 1; }

echo "run-cloud-env-isolated-ports: OK"
