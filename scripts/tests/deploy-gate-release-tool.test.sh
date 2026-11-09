#!/usr/bin/env bash
# scripts/ci/release-tool.sh: a GitHub Releases outage must not fail a deploy gate VM whose
# dependency disk already holds the tool (2026-11-08: every Blacksmith gate failed in Prepare
# runner on flyctl/cloudflared 504s). Exercises the real helper with fake installers.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }

run_case() {  # run_case <name> <failures before success, or "always"> <seed cache: yes|no>
  local name=$1 failures=$2 seed=$3 dir="$tmp/$1"
  mkdir -p "$dir/home" "$dir/cache"
  [ "$seed" = yes ] && { printf '#!/bin/sh\necho cached\n' > "$dir/cache/tool"; chmod 0755 "$dir/cache/tool"; }
  (
    export HOME="$dir/home" RELEASE_TOOL_CACHE="$dir/cache" RELEASE_TOOL_RETRY_SECONDS=0
    # shellcheck source=../ci/release-tool.sh
    . "$ROOT/scripts/ci/release-tool.sh"
    installer() {
      local n
      n=$(( $(cat "$dir/attempts" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$dir/attempts"
      if [ "$failures" = always ] || [ "$n" -le "$failures" ]; then
        echo "curl: (22) The requested URL returned error: 504" >&2
        return 22
      fi
      mkdir -p "$HOME/bin" && printf '#!/bin/sh\necho fresh\n' > "$HOME/bin/tool" && chmod 0755 "$HOME/bin/tool"
    }
    release_tool tool "$HOME/bin/tool" installer
  ) > "$dir/out" 2>&1 && echo 0 > "$dir/status" || echo $? > "$dir/status"
}

# Outage, disk never had the tool: bounded retries, then an explicit failure.
run_case cold-outage always no
[ "$(cat "$tmp/cold-outage/status")" != 0 ] || fail "cold outage succeeded"
[ "$(cat "$tmp/cold-outage/attempts")" = 6 ] || fail "cold outage made $(cat "$tmp/cold-outage/attempts") attempts, want 6"
grep -q 'dependency disk has no copy' "$tmp/cold-outage/out" || fail "cold outage lacks its reason"
pass=$((pass + 1))

# An explicit attempt budget bounds the retries.
RELEASE_TOOL_ATTEMPTS=2 run_case budget always no
[ "$(cat "$tmp/budget/attempts")" = 2 ] || fail "attempt budget ignored: $(cat "$tmp/budget/attempts") attempts"
grep -q 'failed 2 times' "$tmp/budget/out" || fail "budget failure lacks its count"
pass=$((pass + 1))

# Outage, disk holds a last good copy: installed after the first failure, no waiting.
run_case warm-outage always yes
[ "$(cat "$tmp/warm-outage/status")" = 0 ] || fail "warm outage failed: $(cat "$tmp/warm-outage/out")"
[ "$(cat "$tmp/warm-outage/attempts")" = 1 ] || fail "warm outage retried before using the cached copy"
[ "$("$tmp/warm-outage/home/bin/tool")" = cached ] || fail "warm outage did not install the cached copy"
pass=$((pass + 1))

# Transient 504s: retried, and the fresh install refreshes the disk copy.
run_case transient 2 no
[ "$(cat "$tmp/transient/status")" = 0 ] || fail "transient failure not retried: $(cat "$tmp/transient/out")"
[ "$(cat "$tmp/transient/attempts")" = 3 ] || fail "transient case made $(cat "$tmp/transient/attempts") attempts, want 3"
[ "$("$tmp/transient/cache/tool")" = fresh ] || fail "fresh install did not refresh the disk copy"
pass=$((pass + 1))

# Healthy Releases with a stale disk copy: the live install wins and replaces it.
run_case healthy 0 yes
[ "$(cat "$tmp/healthy/status")" = 0 ] || fail "healthy install failed"
[ "$("$tmp/healthy/home/bin/tool")" = fresh ] || fail "healthy install used the cached copy"
[ "$("$tmp/healthy/cache/tool")" = fresh ] || fail "healthy install left a stale disk copy"
pass=$((pass + 1))

# The gate setup routes both GitHub Releases tools through the helper.
setup="$ROOT/scripts/ci/deploy-gate-setup.sh"
# flyctl and ngrok are optional too: an outage costs two attempts, not the default six.
grep -q 'RELEASE_TOOL_ATTEMPTS=2 release_tool flyctl "\$HOME/.fly/bin/flyctl" install_flyctl' "$setup" \
  || fail "setup bypasses release_tool or the two-attempt budget for flyctl"
grep -q 'RELEASE_TOOL_ATTEMPTS=2 release_tool ngrok /usr/local/bin/ngrok install_ngrok' "$setup" \
  || fail "setup bypasses release_tool or the two-attempt budget for ngrok"
grep -q 'RELEASE_TOOL_ATTEMPTS=2 release_tool cloudflared /usr/local/bin/cloudflared install_cloudflared' "$setup" \
  || fail "setup bypasses release_tool for cloudflared"
grep -q 'cloudflared is required for isolated benchmark public tunnels' "$ROOT/scripts/run.sh" \
  || fail "run.sh no longer refuses a missing cloudflared, so the setup may not treat it as optional"
pass=$((pass + 1))

# setup-uv is the other GitHub Releases download: a failure there falls back to PyPI.
workflow="$ROOT/.github/workflows/deploy-gates.yml"
python3 - "$workflow" <<'PY' || fail "deploy-gates.yml lacks the setup-uv PyPI fallback"
import re, sys
text = open(sys.argv[1]).read()
step = re.search(r"- uses: astral-sh/setup-uv@v\d+\n((?:        .*\n)+)", text)
assert step and "id: setup-uv" in step.group(1) and "continue-on-error: true" in step.group(1), "setup-uv is fatal"
fallback = text[step.end():].split("\n      - ", 2)[1]
assert "if: steps.setup-uv.outcome == 'failure'" in fallback, "no fallback condition"
assert "pip install" in fallback and " uv" in fallback and "GITHUB_PATH" in fallback, "fallback does not install uv"
PY
pass=$((pass + 1))

# Every optional tool in Prepare runner is non-fatal: a cold-disk outage of its host must not fail
# gates that never call it (hunt round 9: fly.io/install.sh 504s failed 10 of 11 gates).
setup="$ROOT/scripts/ci/deploy-gate-setup.sh"
for tool in flyctl ngrok cloudflared; do
  grep -A3 "release_tool $tool " "$setup" | grep -q "|| echo \"⚠️ $tool unavailable" \
    || fail "$tool install is fatal in deploy-gate-setup.sh"
done
bash -n "$setup" || fail "deploy-gate-setup.sh does not parse"
pass=$((pass + 1))
echo "RESULTS: $pass passed, 0 failed"
