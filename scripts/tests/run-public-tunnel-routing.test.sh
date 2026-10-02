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
# PASS (it proves Cloudflare routed to us). A 530 from a trycloudflare hostname
# means Cloudflare has no live tunnel route and must be rejected just like no
# HTTP response at all (curl writes 000).
#
#   case 1 — edge returns 200            → routing
#   case 2 — edge returns 502 (no origin) → routing (must NOT be treated as dead)
#   case 3 — edge returns 404             → routing
#   case 4 — edge always 530              → NOT routing, bounded by the timeout
#   case 5 — edge always 000              → NOT routing, bounded by the timeout
#   case 6 — edge 000 then 502            → routing (recovers within the window)
#   case 7 — run.sh actually recycles a dead tunnel and backs off
#   case 8 — prefers IPv4 (curl -4) + localtunnel fallback + NXDOMAIN skip
#   case 9 — run-scoped ngrok fallback domains are bound, never reserved
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_SH="${PUBLIC_TUNNEL_RUN_SH:-$ROOT_DIR/scripts/run.sh}"
[ -f "$RUN_SH" ] || { echo "FATAL: missing $RUN_SH" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# Extract the real helpers from run.sh so this test exercises shipped code
# rather than a copy that could drift. Include supervised_edge_probe: the IPv4
# preference is passed as curl args through that helper (`-4`), not inlined as
# `curl -4` inside cloudflare_tunnel_edge_is_routing.
awk '/^supervised_edge_probe\(\) \{$/,/^\}$/' "$RUN_SH" > "$TMP/fn.sh"
awk '/^public_tunnel_hostname_resolves\(\) \{$/,/^\}$/' "$RUN_SH" >> "$TMP/fn.sh"
awk '/^cloudflare_tunnel_edge_is_routing\(\) \{$/,/^\}$/' "$RUN_SH" >> "$TMP/fn.sh"
grep -q 'supervised_edge_probe' "$TMP/fn.sh" \
  || fail "could not extract supervised_edge_probe from run.sh"
grep -q 'cloudflare_tunnel_edge_is_routing' "$TMP/fn.sh" \
  || fail "could not extract cloudflare_tunnel_edge_is_routing from run.sh"
grep -q 'public_tunnel_hostname_resolves' "$TMP/fn.sh" \
  || fail "could not extract public_tunnel_hostname_resolves from run.sh"
grep -q '000' "$TMP/fn.sh" \
  || fail "extracted routing check no longer distinguishes the 000 no-response case"
grep -qE 'supervised_edge_probe "\$url" -4' "$TMP/fn.sh" \
  || fail "extracted routing check no longer prefers IPv4 (supervised_edge_probe … -4) for trycloudflare probes"
grep -qE 'curl "\$@"' "$TMP/fn.sh" \
  || fail "supervised_edge_probe must forward curl args (including -4) via curl \"\$@\""

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

# --- case 4: Cloudflare's no-live-route response is rejected ----------------
started=$SECONDS
if CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS=0 \
  run_routing_check 2 530 530 530 530 530 530 530 530; then
  fail "case 4: HTTP 530 from a trycloudflare hostname must NOT count as routing"
fi
elapsed=$(( SECONDS - started ))
[ "$elapsed" -le 10 ] || fail "case 4: routing check ran ${elapsed}s, expected to stop near its 2s budget"
echo "PASS: persistent HTTP 530 is reported as an unrouted tunnel (${elapsed}s)"

# --- case 5: a permanently dead hostname is rejected, and is bounded --------
started=$SECONDS
if run_routing_check 6 000 000 000 000 000 000 000 000 000 000; then
  fail "case 5: a hostname that never responds must NOT count as routing"
fi
elapsed=$(( SECONDS - started ))
[ "$elapsed" -le 20 ] || fail "case 5: routing check ran ${elapsed}s, expected to stop near its 6s budget"
echo "PASS: persistent 000 is reported as dead, bounded by the timeout (${elapsed}s)"

# --- case 6: a slow-but-alive edge is accepted ------------------------------
# Remove the production backoff so host scheduling cannot consume this focused
# fixture's entire wall-clock budget before its deterministic third response.
CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS=0 \
  run_routing_check 20 000 000 502 || fail "case 6: edge that starts routing within the window must pass"
echo "PASS: edge that becomes reachable within the window counts as routing"

# --- case 7: run.sh recycles dead tunnels instead of dying ------------------
# Structural pins on the shipped retry loop: the old code had neither.
grep -q 'CLOUDFLARE_TUNNEL_MAX_ATTEMPTS' "$RUN_SH" \
  || fail "case 7: run.sh no longer bounds quick-tunnel attempts"
grep -q 'recycling the quick tunnel' "$RUN_SH" \
  || fail "case 7: run.sh no longer recycles a non-routing quick tunnel"
grep -q 'CLOUDFLARE_TUNNEL_RETRY_BACKOFF_SECONDS' "$RUN_SH" \
  || fail "case 7: run.sh no longer backs off between quick-tunnel attempts"
grep -q 'CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS' "$RUN_SH" \
  || fail "case 7: tunnel routing probes no longer expose deterministic retry cadence"
# A recycled tunnel must be removed from the service arrays, otherwise cleanup
# reports a dead pid as a live service.
awk '/^start_cloudflare_quick_tunnel\(\) \{$/,/^\}$/' "$RUN_SH" > "$TMP/start.sh"
grep -q "unset 'PIDS\[" "$TMP/start.sh" \
  || fail "case 7: recycled tunnel is not removed from PIDS"
grep -q 'cloudflare_tunnel_edge_is_routing' "$TMP/start.sh" \
  || fail "case 7: tunnel startup no longer verifies the edge routes"
echo "PASS: run.sh bounds, backs off, recycles, and de-registers dead quick tunnels"

# --- case 8: NXDOMAIN skip + localtunnel last-resort fallback --------------
grep -q 'skipping remaining quick-tunnel attempts' "$RUN_SH" \
  || fail "case 8: run.sh no longer skips remaining quick tunnels on NXDOMAIN"
grep -q 'start_localtunnel_public_tunnel' "$RUN_SH" \
  || fail "case 8: run.sh no longer defines localtunnel fallback"
awk '/^start_public_tunnel\(\) \{$/,/^}$/' "$RUN_SH" > "$TMP/start_public.sh"
grep -q 'start_localtunnel_public_tunnel && return 0' "$TMP/start_public.sh" \
  || fail "case 8: start_public_tunnel no longer calls localtunnel before hard-fail"
grep -q 'ngrok has no authtoken; trying localtunnel' "$TMP/start_public.sh" \
  || fail "case 8: start_public_tunnel no longer short-circuits to localtunnel when ngrok is unconfigured"
grep -q 'loca\.lt' "$RUN_SH" \
  || fail "case 8: localtunnel URL parser no longer accepts loca.lt"
# Bare `exit 1` on missing authtoken must not remain — it skipped localtunnel.
awk '/^start_ngrok_public_tunnel\(\) \{$/,/^}$/' "$RUN_SH" > "$TMP/start_ngrok.sh"
grep -q 'ngrok_public_tunnel_fail.*missing an authtoken' "$TMP/start_ngrok.sh" \
  || fail "case 8: start_ngrok_public_tunnel must use ngrok_public_tunnel_fail for missing authtoken"
if grep -nE '^\s*exit 1\s*$' "$TMP/start_ngrok.sh" | grep -vq 'ngrok_public_tunnel_fail'; then
  # Allow only exits inside ngrok_public_tunnel_fail itself (not in this fn).
  :
fi
! grep -nE 'echo .*missing an authtoken' -A1 "$TMP/start_ngrok.sh" | grep -q 'exit 1' \
  || fail "case 8: start_ngrok_public_tunnel still bare-exits on missing authtoken"
echo "PASS: NXDOMAIN skip + localtunnel fallback are wired into start_public_tunnel"

# --- case 9: run-scoped ngrok fallback domains are bound, never reserved -----
# Every isolated benchmark run has a unique "<worktree>-bench-<run id>" name.
# Reserving its fallback domain left one permanent reservation per run until the
# account's reserved-domain cap was full.
awk '/^dns_label_from_workspace\(\) \{$/,/^\}$/' "$RUN_SH" > "$TMP/ngrok_fallback.sh"
awk '/^ensure_ngrok_domain_reserved\(\) \{$/,/^\}$/' "$RUN_SH" >> "$TMP/ngrok_fallback.sh"
awk '/^start_ngrok_ephemeral_tunnel\(\) \{$/,/^\}$/' "$RUN_SH" >> "$TMP/ngrok_fallback.sh"
for fn in dns_label_from_workspace ensure_ngrok_domain_reserved start_ngrok_ephemeral_tunnel; do
  grep -q "^$fn() {" "$TMP/ngrok_fallback.sh" || fail "case 9: could not extract $fn from run.sh"
done
mkdir -p "$TMP/fake-ngrok-bin"
cat > "$TMP/fake-ngrok-bin/ngrok" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NGROK_CALLS"
case "$1" in
  config) exit 0 ;;
  api)
    case "$3" in
      list) printf '%s\n' '{"next_page_uri": null, "reserved_domains": []}' ;;
      create) printf '%s\n' '{"id": "rd_created"}' ;;
    esac
    exit 0
    ;;
  http)
    domain=""
    while [ "$#" -gt 0 ]; do
      [ "$1" = "--domain" ] && domain="$2"
      shift
    done
    printf '{"url":"https://%s"}\n' "${domain:-free.ngrok-free.dev}"
    exec sleep 30
    ;;
esac
STUB
chmod +x "$TMP/fake-ngrok-bin/ngrok"
run_ngrok_fallback() { # run_ngrok_fallback <CONDUCTOR_WORKSPACE_NAME>
  : > "$TMP/ngrok-calls"
  NGROK_CALLS="$TMP/ngrok-calls" PATH="$TMP/fake-ngrok-bin:$PATH" \
    CONDUCTOR_WORKSPACE_NAME="$1" NGROK_API_KEY=test-api-key NGROK_AUTHTOKEN=test-token \
    RUN_CONTEXT_DIR="$TMP/ngrok-run" FRONTEND_PORT=3002 \
    bash -c "
      PIDS=(); NAMES=()
      public_tunnel_publish_environment() { PUBLIC_BASE_URL=\"\$1\"; }
      cloudflare_tunnel_edge_is_routing() { return 0; }
      source '$TMP/ngrok_fallback.sh'
      start_ngrok_ephemeral_tunnel
      rc=\$?
      kill \"\$NGROK_PID\" 2>/dev/null
      exit \$rc
    " > "$TMP/ngrok-fallback.out" 2>&1
}

run_ngrok_fallback krakow-bench-1790879218-96570-58551 \
  || { cat "$TMP/ngrok-fallback.out" >&2; fail "case 9: run-scoped ngrok fallback did not publish a tunnel"; }
grep -qx 'http 3002 --domain rose-krakow-bench-1790879218-96570-58551-bench.ngrok.app --log stdout --log-format json --log-level info' "$TMP/ngrok-calls" \
  || { cat "$TMP/ngrok-calls" >&2; fail "case 9: run-scoped fallback must still bind its own named domain"; }
if grep -q '^api reserved-domains' "$TMP/ngrok-calls"; then
  cat "$TMP/ngrok-calls" >&2
  fail "case 9: a run-scoped fallback domain must never be listed or reserved"
fi
echo "PASS: a run-scoped ngrok fallback binds its own domain without reserving it"

run_ngrok_fallback krakow \
  || { cat "$TMP/ngrok-fallback.out" >&2; fail "case 9: per-worktree ngrok fallback did not publish a tunnel"; }
grep -qx 'api reserved-domains create --domain rose-krakow-bench.ngrok.app --description Conductor workspace krakow public frontend' "$TMP/ngrok-calls" \
  || { cat "$TMP/ngrok-calls" >&2; fail "case 9: the per-worktree fallback domain must still be reserved"; }
grep -qx 'http 3002 --domain rose-krakow-bench.ngrok.app --log stdout --log-format json --log-level info' "$TMP/ngrok-calls" \
  || { cat "$TMP/ngrok-calls" >&2; fail "case 9: per-worktree fallback must bind its reserved domain"; }
echo "PASS: the per-worktree ngrok fallback domain is still reserved and bound"

echo "ALL PASS — public quick-tunnel routing verification and recycling"
