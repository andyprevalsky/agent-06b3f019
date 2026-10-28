#!/usr/bin/env bash
# Pins that backend blackbox runs always use a local trace archive.
#
# Cursor Cloud injects TRACE_ARCHIVE_BACKEND=r2 as a secret. Both runners used
# `${TRACE_ARCHIVE_BACKEND:-local}`, so the injected value won: the backend
# under test read the shared production bucket while agent-trajectories wrote
# local archive files (0 hits instead of 2), and every finalized test agent was
# uploaded to that bucket.
#
#   case 1: run-blackbox-tests.sh hands its children local over an inherited r2.
#   case 2: run-blackbox-tests.sh keeps an explicit fake-r2 backend and dir.
#   case 3: run-coverage.sh's backend guard turns an inherited r2 into local.
#   case 4: run-coverage.sh applies that guard before booting its backend.
#   case 5: both runners' seed preflight accepts the funded Azure Codex deployment
#           (an https AZURE_FOUNDRY_* region on the Codex host, with its key) as
#           the Codex fallback, and never GPT_API_KEY, which no Codex sandbox gets.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BLACKBOX="$ROOT_DIR/back-end/scripts/run-blackbox-tests.sh"
COVERAGE="$ROOT_DIR/back-end/scripts/run-coverage.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# --list execs the runner's node child right after environment setup; a fake
# node reports the archive environment that every domain process inherits.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/node" <<'NODE'
#!/usr/bin/env bash
printf 'archive=%s|%s\n' "$TRACE_ARCHIVE_BACKEND" "$TRACE_ARCHIVE_LOCAL_DIR"
NODE
chmod +x "$TMP/bin/node"

out="$(env -u TRACE_ARCHIVE_LOCAL_DIR TRACE_ARCHIVE_BACKEND=r2 PATH="$TMP/bin:$PATH" \
  BLACKBOX_TEST_ARTIFACT_ROOT="$TMP/runs" bash "$BLACKBOX" --list 2>/dev/null)"
grep -qx "archive=local|$ROOT_DIR/.context" <<< "$out" \
  || fail "case 1: run-blackbox-tests.sh children saw: $out"
echo "PASS: case 1 run-blackbox-tests.sh children get local over inherited r2"

out="$(env TRACE_ARCHIVE_BACKEND=fake-r2 TRACE_ARCHIVE_LOCAL_DIR=/archives PATH="$TMP/bin:$PATH" \
  BLACKBOX_TEST_ARTIFACT_ROOT="$TMP/runs" bash "$BLACKBOX" --list 2>/dev/null)"
grep -qx "archive=fake-r2|/archives" <<< "$out" \
  || fail "case 2: run-blackbox-tests.sh children saw: $out"
echo "PASS: case 2 run-blackbox-tests.sh keeps an explicit fake-r2 backend and dir"

guard_start="$(grep -n -m1 '^case "\${TRACE_ARCHIVE_BACKEND:-}" in$' "$COVERAGE" | cut -d: -f1 || true)"
[ -n "$guard_start" ] || fail "case 3: run-coverage.sh has no TRACE_ARCHIVE_BACKEND guard"
guard_end="$(awk -v start="$guard_start" 'NR > start && /^esac$/ { print NR; exit }' "$COVERAGE")"
[ -n "$guard_end" ] || fail "case 3: run-coverage.sh guard has no closing esac"
got="$(TRACE_ARCHIVE_BACKEND=r2 bash -c "set -euo pipefail; $(sed -n "${guard_start},${guard_end}p" "$COVERAGE") >/dev/null
printf '%s' \"\$TRACE_ARCHIVE_BACKEND\"")"
[ "$got" = "local" ] || fail "case 3: run-coverage.sh guard left TRACE_ARCHIVE_BACKEND='$got'"
echo "PASS: case 3 run-coverage.sh guard turns inherited r2 into local"

boot_line="$(grep -n -m1 'node --import tsx src/bootstrap.ts' "$COVERAGE" | cut -d: -f1 || true)"
[ -n "$boot_line" ] || fail "case 4: run-coverage.sh backend boot line not found"
[ "$guard_end" -lt "$boot_line" ] \
  || fail "case 4: guard (ends line $guard_end) runs after backend boot (line $boot_line)"
echo "PASS: case 4 run-coverage.sh guards before booting its backend"

# Run a runner's real preflight functions against a fixture back-end/.env and a
# clean environment (only the listed exports), printing 0 (fallback) or 1.
codex_fallback() {
  local runner="$1" dotenv="$2"; shift 2
  local fixture="$TMP/backend-$RANDOM"
  mkdir -p "$fixture"
  printf '%s\n' "$dotenv" > "$fixture/.env"
  local functions
  functions="$(awk '/^backend_env_value\(\) \{$/ { on = 1 } on { print } on && /^codex_funded_fallback_configured\(\) \{$/ { last = 1 } last && /^}$/ { exit }' "$runner")"
  [ -n "$functions" ] || fail "case 5: $runner has no Codex fallback preflight"
  env -i PATH="$PATH" BACKEND_DIR="$fixture" "$@" bash -c "set -euo pipefail; $functions
if codex_funded_fallback_configured; then printf 0; else printf 1; fi"
}

WESTUS="https://rose-foundry-westus.openai.azure.com"
SOUTH="https://rose-foundry-southcentralus.openai.azure.com"
# The shell default deployment is the codexAzure column of codeAgentModels.ts.
TABLE_AZURE="$(sed -n "s/.*codexAzure: '\([^']*\)'.*/\1/p" "$ROOT_DIR/back-end/src/providers/codeAgentModels.ts" | sort -u)"
[ "$TABLE_AZURE" = "gpt-6.1-sol" ] || fail "case 5: codeAgentModels.ts codexAzure is '$TABLE_AZURE', the runners default to gpt-6.1-sol"
for runner in "$BLACKBOX" "$COVERAGE"; do
  name="$(basename "$runner")"
  expect() {
    local want="$1" why="$2"; shift 2
    local got
    got="$(codex_fallback "$runner" "$@")"
    [ "$got" = "$want" ] || fail "case 5: $name: $why (got $got, want $want)"
  }
  expect 0 "a later slot lists gpt-6.1-sol, trailing slash" \
    "$(printf 'AZURE_FOUNDRY_ENDPOINT=https://other.openai.azure.com\nAZURE_FOUNDRY_API_KEY=k1\nAZURE_FOUNDRY_DEPLOYMENTS=gpt-6-sol\nAZURE_FOUNDRY_ENDPOINT_2=%s/\nAZURE_FOUNDRY_API_KEY_2="k2"\nAZURE_FOUNDRY_DEPLOYMENTS_2="gpt-6-sol, gpt-6.1-sol"' "$SOUTH")"
  expect 1 "GPT_API_KEY alone is not a Codex fallback" 'GPT_API_KEY=sk-openai'
  expect 1 "a region whose deployments omit gpt-6.1-sol" \
    "$(printf 'AZURE_FOUNDRY_ENDPOINT=%s\nAZURE_FOUNDRY_API_KEY=k1\nAZURE_FOUNDRY_DEPLOYMENTS=gpt-6-sol' "$WESTUS")"
  expect 0 "CODEX_AZURE_DEPLOYMENT selects a listed deployment" \
    "$(printf 'CODEX_AZURE_DEPLOYMENT=gpt-6-sol\nAZURE_FOUNDRY_ENDPOINT=%s\nAZURE_FOUNDRY_API_KEY=k1\nAZURE_FOUNDRY_DEPLOYMENTS=gpt-6-sol' "$WESTUS")"
  expect 0 "CODEX_AZURE_FOUNDRY_HOST selects another host" \
    "$(printf 'CODEX_AZURE_FOUNDRY_HOST=other.openai.azure.com\nAZURE_FOUNDRY_ENDPOINT=https://other.openai.azure.com\nAZURE_FOUNDRY_API_KEY=k1')"
  expect 1 "an http endpoint is not usable" \
    "$(printf 'AZURE_FOUNDRY_ENDPOINT=http://rose-foundry-southcentralus.openai.azure.com\nAZURE_FOUNDRY_API_KEY=k1\nAZURE_FOUNDRY_DEPLOYMENTS=gpt-6.1-sol')"
  expect 1 "a region without its key" "$(printf 'AZURE_FOUNDRY_ENDPOINT=%s\nAZURE_FOUNDRY_DEPLOYMENTS=gpt-6.1-sol' "$SOUTH")"
  expect 1 "the last assignment wins (dotenv) and a comment-only key is empty" \
    "$(printf 'AZURE_FOUNDRY_ENDPOINT=%s\nAZURE_FOUNDRY_API_KEY=k1\nAZURE_FOUNDRY_DEPLOYMENTS=gpt-6.1-sol\nAZURE_FOUNDRY_API_KEY= # unset' "$SOUTH")"
  expect 0 "an exported shell value wins over back-end/.env" 'GPT_API_KEY=sk-openai' \
    AZURE_FOUNDRY_ENDPOINT_2="$SOUTH" AZURE_FOUNDRY_API_KEY_2=k2 AZURE_FOUNDRY_DEPLOYMENTS_2=gpt-6.1-sol
done
echo "PASS: case 5 both runners accept the Azure Codex deployment, never GPT_API_KEY, as the Codex fallback"

echo "blackbox-archive-env: all cases passed"
