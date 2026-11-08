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
grep -q 'release_tool flyctl "\$HOME/.fly/bin/flyctl" install_flyctl' "$setup" || fail "setup bypasses release_tool for flyctl"
grep -q 'release_tool cloudflared /usr/local/bin/cloudflared install_cloudflared' "$setup" || fail "setup bypasses release_tool for cloudflared"
pass=$((pass + 1))

echo "RESULTS: $pass passed, 0 failed"
