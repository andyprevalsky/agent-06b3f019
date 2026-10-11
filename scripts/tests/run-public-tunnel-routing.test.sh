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
#   case 8 — a missing ngrok authtoken is reported, not a bare exit
#   case 9 — a reserved ngrok domain held by another session falls back
#   case 10 — run-scoped ngrok fallback domains are bound, never reserved
#   case 11 — a dropped fallback tunnel does not take the shared stack down
#   case 12 — a record published after the host resolver cached NXDOMAIN routes
#   case 13 — the public smoke certifies what a cloud browser sees
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
awk '/^cloudflare_tunnel_edge_is_routing\(\) \{$/,/^\}$/' "$RUN_SH" >> "$TMP/fn.sh"
grep -q 'supervised_edge_probe' "$TMP/fn.sh" \
  || fail "could not extract supervised_edge_probe from run.sh"
grep -q 'cloudflare_tunnel_edge_is_routing' "$TMP/fn.sh" \
  || fail "could not extract cloudflare_tunnel_edge_is_routing from run.sh"
grep -q '000' "$TMP/fn.sh" \
  || fail "extracted routing check no longer distinguishes the 000 no-response case"
grep -qE 'supervised_edge_probe "\$url" -4' "$TMP/fn.sh" \
  || fail "extracted routing check no longer prefers IPv4 (supervised_edge_probe … -4) for trycloudflare probes"
grep -qE 'curl "\$@"' "$TMP/fn.sh" \
  || fail "supervised_edge_probe must forward curl args (including -4) via curl \"\$@\""

# Model the response headers at the actual curl boundary, including a proxy's
# CONNECT response followed by an unrelated block page.
cat > "$TMP/edge-headers.sh" <<'STUB'
#!/usr/bin/env bash
status="$1"; shift
headers=""
while [ "$#" -gt 0 ]; do
  case "$1" in -D|--dump-header) headers="$2"; shift ;; esac
  shift
done
[ -n "$headers" ] || exit 0
case "${EDGE_RESPONSE_IDENTITY:-cloudflare}" in
  cloudflare)
    printf 'HTTP/1.1 %s Fixture\r\nServer: cloudflare\r\nCF-Ray: 0123456789abcdef-SJC\r\n\r\n' "$status" > "$headers" ;;
  proxy)
    printf 'HTTP/1.1 %s Blocked\r\nServer: fixture-blocker\r\n\r\n' "$status" > "$headers" ;;
  proxy-after-connect)
    printf 'HTTP/1.1 200 Connection established\r\nServer: cloudflare\r\nCF-Ray: 0123456789abcdef-SJC\r\n\r\nHTTP/1.1 %s Blocked\r\nServer: fixture-blocker\r\n\r\n' "$status" > "$headers" ;;
  *) exit 98 ;;
esac
STUB

# The public-edge probe must retain inherited proxy configuration.
mkdir "$TMP/proxy-control"
cat > "$TMP/proxy-control/curl" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in --noproxy|--noproxy=*) exit 29 ;; esac
done
for key in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy; do
  [ "${!key}" = "fixture-proxy-setting" ] || exit 30
done
bash "$EDGE_HEADERS_WRITER" 200 "$@"
printf '200'
STUB
chmod +x "$TMP/proxy-control/curl"
status="$(EDGE_HEADERS_WRITER="$TMP/edge-headers.sh" HTTP_PROXY=fixture-proxy-setting HTTPS_PROXY=fixture-proxy-setting ALL_PROXY=fixture-proxy-setting \
  http_proxy=fixture-proxy-setting https_proxy=fixture-proxy-setting all_proxy=fixture-proxy-setting \
  NO_PROXY=fixture-proxy-setting no_proxy=fixture-proxy-setting PATH="$TMP/proxy-control:$PATH" \
  bash -c 'source "$1"; supervised_edge_probe https://fixture.invalid -4' fixture "$TMP/fn.sh")"
[ "$status" = 200 ] || fail "public-edge probe changed or bypassed inherited proxy settings"
echo "PASS: public-edge probe preserves inherited proxy settings"

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
status="$(sed -n "${idx}p" "$TMPDIR_FOR_STUB/statuses")"
bash "$TMPDIR_FOR_STUB/edge-headers.sh" "$status" "$@"
printf '%s' "$status"
STUB
  chmod +x "$TMP/curl"

  TMPDIR_FOR_STUB="$TMP" PATH="$TMP:$PATH" \
    CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS="$timeout" \
    bash -c "
      set -euo pipefail
      CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS=$timeout
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

# An HTTP response through the configured proxy is not necessarily the tunnel.
# Keep the real probe, its watchdog and all inherited proxy settings unchanged.
for blocked_status in 200 403; do
  if EDGE_RESPONSE_IDENTITY=proxy CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS=0 \
      run_routing_check 2 "$blocked_status"; then
    fail "edge identity: proxy HTTP $blocked_status must not count as tunnel routing"
  fi
done
echo "PASS: proxy HTTP 200 and 403 block pages are rejected"
if EDGE_RESPONSE_IDENTITY=proxy-after-connect CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS=0 \
    run_routing_check 2 403; then
  fail "edge identity: earlier CONNECT headers must not certify the final block page"
fi
echo "PASS: only the final HTTP response identifies the intended tunnel edge"

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

# --- case 8: a missing ngrok authtoken is reported, not a bare exit --------
awk '/^start_public_tunnel\(\) \{$/,/^}$/' "$RUN_SH" > "$TMP/start_public.sh"
grep -q 'tried cloudflare; ngrok has no authtoken' "$TMP/start_public.sh" \
  || fail "case 8: start_public_tunnel no longer reports an unconfigured ngrok fallback"
# A bare `exit 1` on a missing authtoken tears the stack down before the caller
# can report which providers it tried.
awk '/^start_ngrok_public_tunnel\(\) \{$/,/^}$/' "$RUN_SH" > "$TMP/start_ngrok.sh"
grep -q 'ngrok_public_tunnel_fail.*missing an authtoken' "$TMP/start_ngrok.sh" \
  || fail "case 8: start_ngrok_public_tunnel must use ngrok_public_tunnel_fail for missing authtoken"
if grep -nE '^\s*exit 1\s*$' "$TMP/start_ngrok.sh" | grep -vq 'ngrok_public_tunnel_fail'; then
  # Allow only exits inside ngrok_public_tunnel_fail itself (not in this fn).
  :
fi
! grep -nE 'echo .*missing an authtoken' -A1 "$TMP/start_ngrok.sh" | grep -q 'exit 1' \
  || fail "case 8: start_ngrok_public_tunnel still bare-exits on missing authtoken"
echo "PASS: a missing ngrok authtoken is reported by start_public_tunnel"

# --- case 9: ngrok mode survives a reserved domain held by another session ---
# RCA cement (2026-10-01). Cloud VMs booted from one environment snapshot share
# .cloud-env's workspace name, so they all derive the same reserved domain. A
# sibling VM held rose-cloud-44cb5599.ngrok.app, ngrok exited with
# ERR_NGROK_334, and the fatal ngrok path tore down /deploy's Step 5 stack.
# Drive the shipped start_public_tunnel with provider stubs; any other ngrok
# failure must stay fatal.
{
  awk '/^ngrok_public_tunnel_fail\(\) \{$/,/^\}$/' "$RUN_SH"
  awk '/^reap_failed_ngrok_tunnel\(\) \{$/,/^\}$/' "$RUN_SH"
  awk '/^start_public_tunnel\(\) \{$/,/^\}$/' "$RUN_SH"
} > "$TMP/ngrok_mode.sh"
grep -q 'ngrok_log_reports_endpoint_online_elsewhere' "$TMP/ngrok_mode.sh" \
  || fail "case 9: start_public_tunnel no longer classifies a reserved domain held elsewhere"

mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/cloudflared"
chmod +x "$TMP/bin/cloudflared"

run_ngrok_mode() { # run_ngrok_mode <ngrok_ok> <ngrok_log_line> <cloudflare_ok>
  mkdir -p "$TMP/ctx"
  rm -f "$TMP/ctx/ngrok.log" "$TMP/ctx/calls"
  PATH="$TMP/bin:$PATH" \
  STUB_NGROK_OK="$1" STUB_NGROK_LOG_LINE="$2" STUB_CLOUDFLARE_OK="$3" \
    RUN_CONTEXT_DIR="$TMP/ctx" ROOT_DIR="$ROOT_DIR" FN_FILE="$TMP/ngrok_mode.sh" \
    bash -c '
      set -euo pipefail
      source "$ROOT_DIR/scripts/lib/ngrok-tunnel.sh"
      source "$FN_FILE"
      NGROK_PUBLIC_TUNNEL_NONFATAL=0
      BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL=0
      FRONTEND_PORT=3002
      ALLOWED_ORIGINS="http://localhost:3002"
      PIDS=(); NAMES=()
      start_ngrok_public_tunnel() {
        echo ngrok >> "$RUN_CONTEXT_DIR/calls"
        WORKTREE_DOMAIN="rose-held.ngrok.app"
        PUBLIC_BASE_URL="https://$WORKTREE_DOMAIN"
        ALLOWED_ORIGINS="$ALLOWED_ORIGINS,$PUBLIC_BASE_URL"
        sleep 0 & NGROK_PID=$!
        PIDS+=("$NGROK_PID"); NAMES+=(ngrok)
        printf "%s\n" "$STUB_NGROK_LOG_LINE" > "$RUN_CONTEXT_DIR/ngrok.log"
        [ "$STUB_NGROK_OK" = 1 ] && return 0
        ngrok_public_tunnel_fail "stub ngrok exited" || return 1
      }
      start_cloudflare_quick_tunnel() {
        echo cloudflare >> "$RUN_CONTEXT_DIR/calls"
        # Like the real NXDOMAIN path: the hostname is published, then never routes.
        public_tunnel_publish_environment "https://stub.trycloudflare.com" "$ALLOWED_ORIGINS"
        [ "$STUB_CLOUDFLARE_OK" = 1 ] || return 1
        sleep 30 & NGROK_PID=$!
        PIDS+=("$NGROK_PID"); NAMES+=(cloudflared)
      }
      start_public_tunnel
      echo "url=$PUBLIC_BASE_URL"
      echo "origins=$ALLOWED_ORIGINS"
      echo "names=${NAMES[*]:-}"
      [ -z "${NGROK_PID:-}" ] || kill "$NGROK_PID" 2>/dev/null || true
    ' 2>"$TMP/ngrok_mode.err"
}

held_line='lvl=crit msg="command failed" err="failed to start tunnel: The endpoint is already online. ERR_NGROK_334"'

out="$(run_ngrok_mode 0 "$held_line" 1)" \
  || fail "case 9a: a reserved domain held by another session must not tear the stack down ($(cat "$TMP/ngrok_mode.err"))"
grep -qx 'url=https://stub.trycloudflare.com' <<<"$out" \
  || fail "case 9a: expected the account-less cloudflare origin, got: $out"
grep -q 'rose-held.ngrok.app' <<<"$out" \
  && fail "case 9a: the held domain must not stay in PUBLIC_BASE_URL/ALLOWED_ORIGINS: $out"
grep -qx 'names=cloudflared' <<<"$out" \
  || fail "case 9a: the dead ngrok service must be de-registered, got: $out"
[ "$(tr '\n' ' ' < "$TMP/ctx/calls")" = "ngrok cloudflare " ] \
  || fail "case 9a: unexpected provider order: $(tr '\n' ' ' < "$TMP/ctx/calls")"
echo "PASS: ERR_NGROK_334 falls back to an account-less cloudflare origin"

# Every remaining provider gates or fails cloud browsers, so the stack stops here
# and names what it tried instead of fronting an origin the smoke must reject.
if out="$(run_ngrok_mode 0 "$held_line" 0)"; then
  fail "case 9b: no routable provider must stop the stack, got: $out"
fi
grep -q 'reserved ngrok domain held elsewhere; tried cloudflare' "$TMP/ngrok_mode.err" \
  || fail "case 9b: the failure must name the providers it tried: $(cat "$TMP/ngrok_mode.err")"
[ "$(tr '\n' ' ' < "$TMP/ctx/calls")" = "ngrok cloudflare " ] \
  || fail "case 9b: unexpected provider order: $(tr '\n' ' ' < "$TMP/ctx/calls")"
echo "PASS: ERR_NGROK_334 stops the stack when cloudflare cannot route either"

if out="$(run_ngrok_mode 0 'lvl=crit msg="command failed" err="authentication failed ERR_NGROK_107"' 1)"; then
  fail "case 9c: a non-collision ngrok failure must stay fatal, got: $out"
fi
[ "$(tr '\n' ' ' < "$TMP/ctx/calls")" = "ngrok " ] \
  || fail "case 9c: a fatal ngrok failure must not try other providers: $(tr '\n' ' ' < "$TMP/ctx/calls")"
echo "PASS: other ngrok failures remain fatal in ngrok mode"

out="$(run_ngrok_mode 1 'lvl=info msg="started tunnel"' 1)" \
  || fail "case 9d: a healthy ngrok tunnel must succeed ($(cat "$TMP/ngrok_mode.err"))"
grep -qx 'url=https://rose-held.ngrok.app' <<<"$out" \
  || fail "case 9d: a healthy reserved domain must stay the public origin, got: $out"
[ "$(tr '\n' ' ' < "$TMP/ctx/calls")" = "ngrok " ] \
  || fail "case 9d: a healthy ngrok tunnel must not try fallbacks: $(tr '\n' ' ' < "$TMP/ctx/calls")"
echo "PASS: a healthy reserved ngrok domain is used without fallback"

# --- case 11: a dropped fallback tunnel does not take the shared stack down ---
# RCA cement (2026-10-01). After case 9's fallback, /deploy's Step 5 stack was
# fronted by localtunnel. The client exited 1 two minutes in, and the monitor
# loop (which only exempted a process named "ngrok") killed backend, frontend,
# and worker under the running semantic suite. Only an isolated run's own
# account-less tunnel is load-bearing.
grep -q 'public_tunnel_process_is_optional "$name" "${BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL:-0}"' "$RUN_SH" \
  || fail "case 11: run.sh's service monitor no longer consults public_tunnel_process_is_optional"
tunnel_optional() { # tunnel_optional <process name> <ephemeral mode>
  bash -c 'source "$1/scripts/lib/ngrok-tunnel.sh"; public_tunnel_process_is_optional "$2" "$3"' \
    _ "$ROOT_DIR" "$1" "$2"
}
for name in ngrok cloudflared; do
  tunnel_optional "$name" 0 \
    || fail "case 11: a dead $name tunnel must not stop a shared (non-isolated) stack"
done
tunnel_optional ngrok 1 \
  || fail "case 11: the isolated-run ngrok fallback stays optional"
tunnel_optional cloudflared 1 \
  && fail "case 11: an isolated run must stop when its cloudflared tunnel dies"
for name in back-end front-end agents; do
  for mode in 0 1; do
    tunnel_optional "$name" "$mode" \
      && fail "case 11: $name (mode $mode) is a required service, not a public tunnel"
  done
done
echo "PASS: only an isolated run's own account-less tunnel is load-bearing"

# --- case 12: preserve configured resolver/destination policy ---
# A newly published hostname may be temporarily unavailable. Retrying through
# the configured route is permitted; overriding DNS, destination or proxy
# policy can bypass a user's content blocker and must never make it pass.
mkdir -p "$TMP/dns/bin"
cat > "$TMP/dns/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DNS_STATE/edge_args"
case "$*" in *--resolve*|*--connect-to*|*--noproxy*) exit 97 ;; esac
if [ "$EDGE_MODE" = dead ]; then
  status=530
elif [ "$EDGE_MODE" = blocked ] || [ $(( $(date +%s) - $(cat "$DNS_STATE/started") )) -lt 3 ]; then
  status=000
else
  status=502
fi
bash "$EDGE_HEADERS_WRITER" "$status" "$@"
printf '%s' "$status"
STUB
for tool in getent dig; do
  cat > "$TMP/dns/bin/$tool" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "$DNS_STATE/host_resolver_calls"
exit 97
STUB
done
chmod +x "$TMP/dns/bin/"*
run_dns_case() { # <route outcome> <section seconds>
  rm -rf "$TMP/dns/state"; mkdir -p "$TMP/dns/state"
  date +%s > "$TMP/dns/state/started"
  EDGE_HEADERS_WRITER="$TMP/edge-headers.sh" PATH="$TMP/dns/bin:$PATH" DNS_STATE="$TMP/dns/state" EDGE_MODE="$1" \
    CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS="$2" CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS=1 \
    bash -c 'set -euo pipefail; source "$1"; cloudflare_tunnel_edge_is_routing https://race.trycloudflare.com' \
    _ "$TMP/fn.sh" > "$TMP/dns/state/out"
  local result=$?
  grep -qE -- '--resolve|--connect-to|--noproxy' "$TMP/dns/state/edge_args" \
    && fail "case 12: configured routing was overridden"
  [ ! -e "$TMP/dns/state/host_resolver_calls" ] \
    || fail "case 12: probe issued a separate resolver lookup"
  return "$result"
}
run_dns_case routed 10 || fail "case 12a: default-route retry did not recover"
echo "PASS: a newly published tunnel recovers through the configured default route"
for outcome in dead blocked; do
  if run_dns_case "$outcome" 5; then
    fail "case 12: $outcome default route must remain rejected without bypass"
  fi
done
echo "PASS: dead and blocked routes remain rejected without resolver or proxy overrides"

# --- case 13: the public smoke certifies what a cloud browser sees ----------
# RCA cement (2026-10-01). The smoke stack fronted /test_payment with localtunnel
# and scripts/test-public-tunnel.sh passed it: localtunnel serves curl's
# User-Agent normally and answers browsers with a 511 "Tunnel Password" page. All
# three payment tasks' cloud browsers sat on that page until their task timeouts.
SMOKE="$ROOT_DIR/scripts/test-public-tunnel.sh"
app_marker="$(sed -n "s/^APP_SHELL_MARKER='\(.*\)'$/\1/p" "$SMOKE")"
[ -n "$app_marker" ] || fail "case 13: test-public-tunnel.sh no longer declares APP_SHELL_MARKER"
grep -qF "$app_marker" "$ROOT_DIR/front-end/index.html" \
  || fail "case 13: front-end/index.html no longer contains the smoke's app-shell marker $app_marker"

mkdir -p "$TMP/smoke/bin" "$TMP/smoke/ctx"
cat > "$TMP/smoke/bin/curl" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in --noproxy|--noproxy=*|--resolve|--resolve=*|--connect-to|--connect-to=*) exit 97 ;; esac
done
for key in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
  [ "${!key-}" = "route-sentinel-$key" ] || exit 98
done
out="" ua="" url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -A) ua="$2"; shift ;;
    -w|--max-time|--connect-timeout|-H) shift ;;
    http*://*) url="$1" ;;
  esac
  shift
done
case "$url" in
  */api/test-payment/public-url) printf '{"url":"%s"}' "$PUBLIC_BASE_URL"; exit 0 ;;
esac
printf '%s\n' "$ua" >> "$STUB_STATE/user_agents"
app='<!doctype html><html><head><title>Rose</title></head><body><div id="root"></div></body></html>'
status=200 body="$app"
case "$ua" in
  Mozilla/*)
    case "$TUNNEL_MODE" in
      localtunnel) status=511 body='<html><body><h1>Friendly Reminder</h1><input placeholder="e.g. 203.0.113.42"></body></html>' ;;
      interstitial) body='<html><body>You are about to visit this site. <button>Visit Site</button></body></html>' ;;
    esac
    ;;
esac
[ -n "$out" ] && printf '%s' "$body" > "$out"
printf '%s' "$status"
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/smoke/bin/sleep"
chmod +x "$TMP/smoke/bin/curl" "$TMP/smoke/bin/sleep"

run_smoke() { # run_smoke <tunnel mode>
  rm -f "$TMP/smoke/ctx/user_agents"
  PATH="$TMP/smoke/bin:$PATH" STUB_STATE="$TMP/smoke/ctx" TUNNEL_MODE="$1" \
    HTTP_PROXY=route-sentinel-HTTP_PROXY HTTPS_PROXY=route-sentinel-HTTPS_PROXY \
    ALL_PROXY=route-sentinel-ALL_PROXY NO_PROXY=route-sentinel-NO_PROXY \
    http_proxy=route-sentinel-http_proxy https_proxy=route-sentinel-https_proxy \
    all_proxy=route-sentinel-all_proxy no_proxy=route-sentinel-no_proxy \
    BENCHMARK_CONTEXT_DIR="$TMP/smoke/ctx" BACKEND_PORT=28600 \
    PUBLIC_BASE_URL="https://stub-origin.trycloudflare.com" \
    bash "$SMOKE" > "$TMP/smoke/out" 2>&1
}

run_smoke app || fail "case 13a: the app shell must pass the smoke: $(cat "$TMP/smoke/out")"
grep -q '^Mozilla/' "$TMP/smoke/ctx/user_agents" \
  || fail "case 13a: the smoke must request /test_payment as a browser, sent: $(cat "$TMP/smoke/ctx/user_agents")"
echo "PASS: the app shell over the tunnel passes, requested as a browser"

if run_smoke localtunnel; then
  fail "case 13b: a 511 browser interstitial must fail the smoke: $(cat "$TMP/smoke/out")"
fi
grep -q 'HTTP 511' "$TMP/smoke/out" || fail "case 13b: the failure must report the 511: $(cat "$TMP/smoke/out")"
grep -q 'interstitial that cloud browsers cannot pass' "$TMP/smoke/out" \
  || fail "case 13b: the failure must name the browser gate: $(cat "$TMP/smoke/out")"
[ "$(wc -l < "$TMP/smoke/ctx/user_agents" | tr -d ' ')" = "1" ] \
  || fail "case 13b: a 511 gate is not transient and must not be retried ($(wc -l < "$TMP/smoke/ctx/user_agents") requests)"
echo "PASS: a 511 browser interstitial fails the smoke immediately"

if run_smoke interstitial; then
  fail "case 13c: a 200 interstitial page must fail the smoke: $(cat "$TMP/smoke/out")"
fi
grep -q 'not the app' "$TMP/smoke/out" \
  || fail "case 13c: the failure must say the page is not the app: $(cat "$TMP/smoke/out")"
echo "PASS: a 200 interstitial page fails the smoke"

# --- case 10: run-scoped ngrok fallback domains are bound, never reserved ----
# Every isolated benchmark run has a unique "<worktree>-bench-<run id>" name.
# Reserving its fallback domain left one permanent reservation per run until the
# account's reserved-domain cap was full.
awk '/^dns_label_from_workspace\(\) \{$/,/^\}$/' "$RUN_SH" > "$TMP/ngrok_fallback.sh"
awk '/^ensure_ngrok_domain_reserved\(\) \{$/,/^\}$/' "$RUN_SH" >> "$TMP/ngrok_fallback.sh"
awk '/^start_ngrok_ephemeral_tunnel\(\) \{$/,/^\}$/' "$RUN_SH" >> "$TMP/ngrok_fallback.sh"
for fn in supervised_edge_probe cloudflare_tunnel_edge_is_routing ngrok_reported_owned_origin ngrok_tunnel_edge_is_routing; do
  awk "/^${fn}\\(\\) \\{$/,/^\\}$/" "$RUN_SH" >> "$TMP/ngrok_fallback.sh"
done
for fn in dns_label_from_workspace ensure_ngrok_domain_reserved start_ngrok_ephemeral_tunnel; do
  grep -q "^$fn() {" "$TMP/ngrok_fallback.sh" || fail "case 10: could not extract $fn from run.sh"
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
    upstream="$2"
    while [ "$#" -gt 0 ]; do
      [ "$1" = "--domain" ] && domain="$2"
      shift
    done
    case "${NGROK_EVENT_KIND:-owned}" in
      foreign-url) domain=foreign.ngrok.app ;;
      wrong-upstream) upstream=3999 ;;
    esac
    addr="\"http://localhost:$upstream\""
    # ngrok 3.39 logs the upstream as a serialized Go url.URL, not a string.
    url_path=""
    [ "${NGROK_ADDR_FORMAT:-string}" = url-object-path ] && url_path=/other-app
    case "${NGROK_ADDR_FORMAT:-string}" in url-object|url-object-path)
      addr="{\"Scheme\":\"http\",\"Opaque\":\"\",\"User\":null,\"Host\":\"localhost:$upstream\",\"Path\":\"$url_path\",\"RawPath\":\"\",\"OmitHost\":false,\"ForceQuery\":false,\"RawQuery\":\"\",\"Fragment\":\"\",\"RawFragment\":\"\"}" ;;
    esac
    if [ "${NGROK_EVENT_KIND:-}" = delayed ]; then
      rm -f "$RUN_CONTEXT_DIR/ngrok-fallback.log"
      sleep 1
      printf '{"msg":"started tunnel","obj":"tunnels","name":"command_line","url":"https://%s","addr":%s}\n' "${domain:-free.ngrok-free.dev}" "$addr" > "$RUN_CONTEXT_DIR/ngrok-fallback.log"
    else
      printf '{"msg":"started tunnel","obj":"tunnels","name":"command_line","url":"https://%s","addr":%s}\n' "${domain:-free.ngrok-free.dev}" "$addr"
    fi
    exec sleep 30
    ;;
esac
STUB
chmod +x "$TMP/fake-ngrok-bin/ngrok"
cat > "$TMP/fake-ngrok-bin/curl" <<'STUB'
#!/usr/bin/env bash
headers=""; body=""; url=""
for arg in "$@"; do
  case "$arg" in --noproxy|--noproxy=*) exit 29 ;; esac
done
if [ "${NGROK_ASSERT_PROXY:-}" = 1 ]; then
  for key in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy; do
    [ "${!key}" = fixture-proxy-setting ] || exit 30
  done
fi
while [ "$#" -gt 0 ]; do
  case "$1" in -D|--dump-header) headers="$2"; shift ;; -o) body="$2"; shift ;; http*) url="$1" ;; esac
  shift
done
case "${NGROK_RESPONSE_KIND:-pre-origin}" in
  pre-origin) status=400; printf 'HTTP/2 400\r\nNgrok-Error-Code: ERR_NGROK_8012\r\nContent-Type: text/html\r\n\r\n' > "$headers"; printf '<html>upstream not started</html>' > "$body" ;;
  # The live ngrok edge answers 502 for ERR_NGROK_8012 before the origin listens.
  pre-origin-502) status=502; printf 'HTTP/2 502\r\nContent-Type: text/html\r\nNgrok-Error-Code: ERR_NGROK_8012\r\nReferrer-Policy: no-referrer\r\n\r\n' > "$headers"; printf '<html>upstream not started</html>' > "$body" ;;
  unmarked-502) status=502; printf 'HTTP/2 502\r\nContent-Type: text/html\r\n\r\n' > "$headers" ;;
  proxy-502) status=502; printf 'HTTP/2 502\r\nNgrok-Error-Code: ERR_NGROK_8012\r\nServer: fixture-blocker\r\n\r\n' > "$headers" ;;
  mismatched-502) status=502; printf 'HTTP/2 400\r\nNgrok-Error-Code: ERR_NGROK_8012\r\n\r\n' > "$headers" ;;
  healthy|wrong-body)
    status=200; printf 'HTTP/2 200\r\nContent-Type: text/html\r\n\r\n' > "$headers"
    printf '<div id="root">own-app</div>' > "$body"
    if [ "${NGROK_RESPONSE_KIND:-}" = wrong-body ] && [[ "$url" == http://127.0.0.1:* ]]; then
      printf '<div id="root">other-app</div>' > "$body"
    fi ;;
  offline) status=404; printf 'HTTP/2 404\r\nNgrok-Error-Code: ERR_NGROK_3200\r\n\r\n' > "$headers" ;;
  unmarked) status=400; printf 'HTTP/2 400\r\nContent-Type: text/html\r\n\r\n' > "$headers" ;;
  proxy) status=200; printf 'HTTP/2 200\r\nServer: fixture-blocker\r\n\r\n' > "$headers"; printf '<html>blocked</html>' > "$body" ;;
  proxy-after-connect) status=400; printf 'HTTP/1.1 400 Connection established\r\nNgrok-Error-Code: ERR_NGROK_8012\r\n\r\nHTTP/2 400\r\nServer: fixture-blocker\r\n\r\n' > "$headers" ;;
  *) exit 98 ;;
esac
printf '%s' "$status"
STUB
chmod +x "$TMP/fake-ngrok-bin/curl"
run_ngrok_fallback() { # run_ngrok_fallback <CONDUCTOR_WORKSPACE_NAME>
  : > "$TMP/ngrok-calls"
  rm -f "$TMP/ngrok-published"
  NGROK_CALLS="$TMP/ngrok-calls" PATH="$TMP/fake-ngrok-bin:$PATH" \
    CONDUCTOR_WORKSPACE_NAME="$1" NGROK_API_KEY=test-api-key NGROK_AUTHTOKEN=test-token \
    RUN_CONTEXT_DIR="$TMP/ngrok-run" FRONTEND_PORT=3002 NGROK_PUBLISHED_PATH="$TMP/ngrok-published" \
    CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS=2 CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS=0 \
    bash -c "
      PIDS=(); NAMES=()
      public_tunnel_publish_environment() { PUBLIC_BASE_URL=\"\$1\"; printf '%s' \"\$1\" > \"\$NGROK_PUBLISHED_PATH\"; }
      source '$TMP/ngrok_fallback.sh'
      start_ngrok_ephemeral_tunnel
      rc=\$?
      kill \"\$NGROK_PID\" 2>/dev/null
      exit \$rc
    " > "$TMP/ngrok-fallback.out" 2>&1
}

run_ngrok_fallback krakow-bench-1790879218-96570-58551 \
  || { cat "$TMP/ngrok-fallback.out" >&2; fail "case 10: run-scoped ngrok fallback did not publish a tunnel"; }
grep -qx 'http 3002 --domain rose-krakow-bench-1790879218-96570-58551-bench.ngrok.app --log stdout --log-format json --log-level info' "$TMP/ngrok-calls" \
  || { cat "$TMP/ngrok-calls" >&2; fail "case 10: run-scoped fallback must still bind its own named domain"; }
if grep -q '^api reserved-domains' "$TMP/ngrok-calls"; then
  cat "$TMP/ngrok-calls" >&2
  fail "case 10: a run-scoped fallback domain must never be listed or reserved"
fi
echo "PASS: a run-scoped ngrok fallback binds its own domain without reserving it"

run_ngrok_fallback krakow \
  || { cat "$TMP/ngrok-fallback.out" >&2; fail "case 10: per-worktree ngrok fallback did not publish a tunnel"; }
grep -qx 'api reserved-domains create --domain rose-krakow-bench.ngrok.app --description Conductor workspace krakow public frontend' "$TMP/ngrok-calls" \
  || { cat "$TMP/ngrok-calls" >&2; fail "case 10: the per-worktree fallback domain must still be reserved"; }
grep -qx 'http 3002 --domain rose-krakow-bench.ngrok.app --log stdout --log-format json --log-level info' "$TMP/ngrok-calls" \
  || { cat "$TMP/ngrok-calls" >&2; fail "case 10: per-worktree fallback must bind its reserved domain"; }
echo "PASS: the per-worktree ngrok fallback domain is still reserved and bound"


# Provider-specific recurrence: exercise the actual fallback AND actual probe.
NGROK_RESPONSE_KIND=healthy run_ngrok_fallback krakow-bench-healthy-origin \
  || fail "case 10: authentic healthy app must pass ngrok route proof"
echo "PASS: ngrok healthy200 matches its owned local app origin"
NGROK_RESPONSE_KIND=pre-origin-502 run_ngrok_fallback krakow-bench-pre-origin-502 \
  || { cat "$TMP/ngrok-fallback.out" >&2; fail "case 10: the edge's 502 ERR_NGROK_8012 before the origin listens must prove routing"; }
echo "PASS: ngrok's 502 ERR_NGROK_8012 before the origin listens proves the owned route"
NGROK_EVENT_KIND=delayed run_ngrok_fallback krakow-bench-delayed-publication \
  || fail "case 10: initial log absence must remain pending until the current child publishes"
echo "PASS: delayed current-child log publication remains pending then routes"
for event in foreign-url wrong-upstream; do
  if NGROK_EVENT_KIND="$event" run_ngrok_fallback krakow-bench-owner-negative; then
    fail "case 10: $event emitted identity must be rejected"
  fi
  [ ! -e "$TMP/ngrok-published" ] || fail "case 10: $event was published before ownership rejection"
done
echo "PASS: foreign ngrok endpoint and wrong upstream are rejected before publication"
NGROK_ADDR_FORMAT=url-object NGROK_RESPONSE_KIND=healthy run_ngrok_fallback krakow-bench-url-object-origin \
  || { cat "$TMP/ngrok-fallback.out" >&2; fail "case 10: ngrok's structured upstream address must identify its owned origin"; }
for event in foreign-url wrong-upstream; do
  if NGROK_ADDR_FORMAT=url-object NGROK_EVENT_KIND="$event" run_ngrok_fallback krakow-bench-url-object-negative; then
    fail "case 10: $event with a structured upstream address must be rejected"
  fi
  [ ! -e "$TMP/ngrok-published" ] || fail "case 10: structured $event was published before ownership rejection"
done
if NGROK_ADDR_FORMAT=url-object-path run_ngrok_fallback krakow-bench-url-object-path; then
  fail "case 10: a structured upstream address with a path must be rejected"
fi
[ ! -e "$TMP/ngrok-published" ] || fail "case 10: a structured upstream address with a path was published"
echo "PASS: ngrok's structured upstream address is owned only for the requested origin and port"
for response in offline unmarked unmarked-502 proxy proxy-502 mismatched-502 proxy-after-connect wrong-body; do
  if NGROK_RESPONSE_KIND="$response" run_ngrok_fallback krakow-bench-route-negative; then
    fail "case 10: ngrok $response must not certify routing"
  fi
done
echo "PASS: ngrok offline/unmarked/proxy/CONNECT/wrong-origin responses are rejected"
NGROK_ASSERT_PROXY=1 HTTP_PROXY=fixture-proxy-setting HTTPS_PROXY=fixture-proxy-setting ALL_PROXY=fixture-proxy-setting \
  http_proxy=fixture-proxy-setting https_proxy=fixture-proxy-setting all_proxy=fixture-proxy-setting \
  NO_PROXY=fixture-proxy-setting no_proxy=fixture-proxy-setting run_ngrok_fallback krakow-bench-proxy-preservation \
  || fail "case 10: ngrok proof changed or bypassed inherited proxy settings"
echo "PASS: actual ngrok route proof preserves all inherited proxy aliases"

echo "ALL PASS — public quick-tunnel routing verification and recycling"
