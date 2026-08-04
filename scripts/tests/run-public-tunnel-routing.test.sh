#!/usr/bin/env bash
# Focused test for the quick-tunnel routing verification + recycling in
# scripts/run.sh (start_cloudflare_quick_tunnel / cloudflare_tunnel_edge_is_routing).
#
# RCA cement. `start_cloudflare_quick_tunnel` treated "cloudflared printed a
# hostname" as readiness. Account-less trycloudflare.com tunnels publish a
# hostname within ~2s, but a meaningful fraction never route at all: DNS answers
# with Cloudflare IPs while every request fails to connect indefinitely. The dead
# tunnel was only discovered ~60s later by scripts/test-public-tunnel.sh, which
# is fatal — run.sh tore down the whole isolated benchmark stack with no retry,
# failing the entire Pre-Deploy smoke gate. That happened three times in one
# deploy on 2026-07-27.
#
# The fix verifies the edge at creation time. The critical subtlety pinned here:
# the origin frontend is NOT up yet when the tunnel starts, so a 502/404 is a
# PASS (it proves Cloudflare routed to us). Only "no HTTP response at all"
# (curl writes 000) means the hostname is dead.
#
#   case 1 — edge returns 200            → routing
#   case 2 — edge returns 502 (no origin) → routing (must NOT be treated as dead)
#   case 3 — edge returns 404             → routing
#   case 4 — edge always 000              → NOT routing, bounded by the timeout
#   case 5 — edge 000 then 502            → routing (recovers within the window)
#   case 6 — run.sh actually recycles a dead tunnel and backs off
#   case 7 — prefers IPv4 (curl -4) + localtunnel fallback + NXDOMAIN skip
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_SH="${PUBLIC_TUNNEL_RUN_SH:-$ROOT_DIR/scripts/run.sh}"
[ -f "$RUN_SH" ] || { echo "FATAL: missing $RUN_SH" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# Extract the real helpers from run.sh so this test exercises shipped code
# rather than a copy that could drift.
awk '/^public_tunnel_hostname_resolves\(\) \{$/,/^\}$/' "$RUN_SH" > "$TMP/fn.sh"
awk '/^cloudflare_tunnel_edge_is_routing\(\) \{$/,/^\}$/' "$RUN_SH" >> "$TMP/fn.sh"
grep -q 'cloudflare_tunnel_edge_is_routing' "$TMP/fn.sh" \
  || fail "could not extract cloudflare_tunnel_edge_is_routing from run.sh"
grep -q 'public_tunnel_hostname_resolves' "$TMP/fn.sh" \
  || fail "could not extract public_tunnel_hostname_resolves from run.sh"
grep -q '000' "$TMP/fn.sh" \
  || fail "extracted routing check no longer distinguishes the 000 no-response case"
grep -qE 'curl -4 ' "$TMP/fn.sh" \
  || fail "extracted routing check no longer prefers IPv4 (curl -4) for trycloudflare probes"

# Drive the extracted function with a stub curl whose status sequence we control.
# STATUS_FILE holds one status per line; the stub pops one per invocation and
# repeats the last line once exhausted.
run_routing_check() { # run_routing_check <timeout_seconds> <statuses...>
  local timeout="$1"; shift
  printf '%s\n' "$@" > "$TMP/statuses"
  printf '0\n' > "$TMP/calls"

  cat > "$TMP/curl" <<'STUB'
#!/usr/bin/env bash
# Stub curl: ignore all flags, emit the next scripted status code.
n=$(( $(cat "$TMPDIR_FOR_STUB/calls") + 1 ))
printf '%s\n' "$n" > "$TMPDIR_FOR_STUB/calls"
total=$(wc -l < "$TMPDIR_FOR_STUB/statuses" | tr -d ' ')
idx=$n
[ "$idx" -gt "$total" ] && idx=$total
sed -n "${idx}p" "$TMPDIR_FOR_STUB/statuses"
STUB
  chmod +x "$TMP/curl"

  TMPDIR_FOR_STUB="$TMP" PATH="$TMP:$PATH" \
    CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS="$timeout" \
    CLOUDFLARE_TUNNEL_SKIP_DNS_CHECK=1 \
    bash -c "
      set -euo pipefail
      CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS=$timeout
      CLOUDFLARE_TUNNEL_SKIP_DNS_CHECK=1
      source '$TMP/fn.sh'
      cloudflare_tunnel_edge_is_routing https://stub.trycloudflare.com
    "
}

# --- case 1: a healthy edge is accepted -------------------------------------
run_routing_check 10 200 || fail "case 1: HTTP 200 must count as routing"
echo "PASS: HTTP 200 counts as a routing edge"

# --- case 2: 502 is routing (origin not up yet) -----------------------------
# This is the case that makes the fix safe to run before the frontend starts.
run_routing_check 10 502 || fail "case 2: HTTP 502 must count as routing (origin not up yet)"
echo "PASS: HTTP 502 counts as routing (origin not started is not a dead tunnel)"

# --- case 3: 404 is routing -------------------------------------------------
run_routing_check 10 404 || fail "case 3: HTTP 404 must count as routing"
echo "PASS: HTTP 404 counts as routing"

# --- case 4: a permanently dead hostname is rejected, and is bounded --------
started=$SECONDS
if run_routing_check 6 000 000 000 000 000 000 000 000 000 000; then
  fail "case 4: a hostname that never responds must NOT count as routing"
fi
elapsed=$(( SECONDS - started ))
[ "$elapsed" -le 20 ] || fail "case 4: routing check ran ${elapsed}s, expected to stop near its 6s budget"
echo "PASS: persistent 000 is reported as dead, bounded by the timeout (${elapsed}s)"

# --- case 5: a slow-but-alive edge is accepted ------------------------------
# Remove the production backoff so host scheduling cannot consume this focused
# fixture's entire wall-clock budget before its deterministic third response.
CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS=0 \
  run_routing_check 20 000 000 502 || fail "case 5: edge that starts routing within the window must pass"
echo "PASS: edge that becomes reachable within the window counts as routing"

# --- case 6: run.sh recycles dead tunnels instead of dying ------------------
# Structural pins on the shipped retry loop: the old code had neither.
grep -q 'CLOUDFLARE_TUNNEL_MAX_ATTEMPTS' "$RUN_SH" \
  || fail "case 6: run.sh no longer bounds quick-tunnel attempts"
grep -q 'recycling the quick tunnel' "$RUN_SH" \
  || fail "case 6: run.sh no longer recycles a non-routing quick tunnel"
grep -q 'CLOUDFLARE_TUNNEL_RETRY_BACKOFF_SECONDS' "$RUN_SH" \
  || fail "case 6: run.sh no longer backs off between quick-tunnel attempts"
grep -q 'CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS' "$RUN_SH" \
  || fail "case 6: tunnel routing probes no longer expose deterministic retry cadence"
# A recycled tunnel must be removed from the service arrays, otherwise cleanup
# reports a dead pid as a live service.
awk '/^start_cloudflare_quick_tunnel\(\) \{$/,/^\}$/' "$RUN_SH" > "$TMP/start.sh"
grep -q "unset 'PIDS\[" "$TMP/start.sh" \
  || fail "case 6: recycled tunnel is not removed from PIDS"
grep -q 'cloudflare_tunnel_edge_is_routing' "$TMP/start.sh" \
  || fail "case 6: tunnel startup no longer verifies the edge routes"
echo "PASS: run.sh bounds, backs off, recycles, and de-registers dead quick tunnels"

# --- case 7: NXDOMAIN skip + localtunnel last-resort fallback --------------
grep -q 'skipping remaining quick-tunnel attempts' "$RUN_SH" \
  || fail "case 7: run.sh no longer skips remaining quick tunnels on NXDOMAIN"
grep -q 'start_localtunnel_public_tunnel' "$RUN_SH" \
  || fail "case 7: run.sh no longer defines localtunnel fallback"
awk '/^start_public_tunnel\(\) \{$/,/^}$/' "$RUN_SH" > "$TMP/start_public.sh"
grep -q 'start_localtunnel_public_tunnel && return 0' "$TMP/start_public.sh" \
  || fail "case 7: start_public_tunnel no longer calls localtunnel before hard-fail"
grep -q 'loca\.lt' "$RUN_SH" \
  || fail "case 7: localtunnel URL parser no longer accepts loca.lt"
echo "PASS: NXDOMAIN skip + localtunnel fallback are wired into start_public_tunnel"

echo "ALL PASS — public quick-tunnel routing verification and recycling"
