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
awk '/^cloudflare_quick_tunnel_edge_ipv4s\(\) \{$/,/^\}$/' "$RUN_SH" >> "$TMP/fn.sh"
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
printf '%s\n' "$out" | grep -qx 'url=https://stub.trycloudflare.com' \
  || fail "case 9a: expected the account-less cloudflare origin, got: $out"
printf '%s\n' "$out" | grep -q 'rose-held.ngrok.app' \
  && fail "case 9a: the held domain must not stay in PUBLIC_BASE_URL/ALLOWED_ORIGINS: $out"
printf '%s\n' "$out" | grep -qx 'names=cloudflared' \
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
printf '%s\n' "$out" | grep -qx 'url=https://rose-held.ngrok.app' \
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

# --- case 12: a record published after the host resolver cached NXDOMAIN ---
# RCA cement (2026-10-01). cloudflared prints a quick-tunnel hostname a few seconds
# before Cloudflare publishes its record. The edge probe resolved it in that window,
# the VM's caching resolver kept serving NXDOMAIN for trycloudflare.com's 60s
# negative TTL, and the isolated run's 10s probe discarded a healthy tunnel (3 of 4
# isolated stacks that day). The smoke stack then lost the shared ngrok fallback to
# a concurrent lane and fronted /test_payment with localtunnel, whose password page
# held every payment task's cloud browser until the task timed out.
#
# Stubs model that cache: the record publishes PUBLISH_AFTER seconds into the case,
# and a host-resolver lookup of the new hostname made before then is cached as
# NXDOMAIN for the rest of the case. The edge answers by SNI at its anycast
# addresses regardless of DNS, exactly like Cloudflare's.
mkdir -p "$TMP/dns/bin"
cat > "$TMP/dns/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DNS_STATE/edge_args"
[ "$EDGE_MODE" = dead ] && { printf '530'; exit 0; }
case "$*" in
  *--resolve*) printf '502' ;;
  *) [ -f "$DNS_STATE/poisoned" ] && printf '000' || printf '502' ;;
esac
STUB
for tool in getent dig; do
  cat > "$TMP/dns/bin/$tool" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "$DNS_STATE/host_resolver_calls"
case "$*" in
  *api.trycloudflare.com*)
    [ "$EDGE_NAME" = unresolvable ] && exit 2
    [ "$(basename "$0")" = getent ] && printf '104.16.231.132 STREAM api.trycloudflare.com\n104.16.230.132 STREAM\n' \
      || printf '104.16.231.132\n104.16.230.132\n'
    exit 0
    ;;
esac
[ $(( $(date +%s) - $(cat "$DNS_STATE/started") )) -ge "$PUBLISH_AFTER" ] || : > "$DNS_STATE/poisoned"
[ -f "$DNS_STATE/poisoned" ] && exit 2
case "$(basename "$0")" in
  getent) printf '104.16.230.132 STREAM race.trycloudflare.com\n' ;;
  dig) printf '104.16.230.132\n' ;;
esac
STUB
done
chmod +x "$TMP/dns/bin/"*

run_dns_case() { # run_dns_case <edge mode> <edge name> <timeout seconds>
  rm -rf "$TMP/dns/state"; mkdir -p "$TMP/dns/state"
  date +%s > "$TMP/dns/state/started"
  PATH="$TMP/dns/bin:$PATH" DNS_STATE="$TMP/dns/state" \
    EDGE_MODE="$1" EDGE_NAME="$2" PUBLISH_AFTER=3 \
    CLOUDFLARE_TUNNEL_EDGE_TIMEOUT_SECONDS="$3" CLOUDFLARE_TUNNEL_EDGE_RETRY_SECONDS=1 \
    bash -c 'set -euo pipefail; source "$1"; cloudflare_tunnel_edge_is_routing https://race.trycloudflare.com' \
    _ "$TMP/fn.sh" > "$TMP/dns/state/out"
}
resolved_new_hostname() {
  grep -q 'race.trycloudflare.com' "$TMP/dns/state/host_resolver_calls" 2>/dev/null
}

run_dns_case routed resolvable 10 \
  || fail "case 12a: a routing tunnel probed before its record publishes must pass ($(cat "$TMP/dns/state/out"))"
resolved_new_hostname \
  && fail "case 12a: the probe resolved the new hostname and seeded the cache: $(cat "$TMP/dns/state/host_resolver_calls")"
grep -q -- '--resolve race.trycloudflare.com:443:104.16.230.132,104.16.231.132' "$TMP/dns/state/edge_args" \
  || fail "case 12a: the probe must reach the quick-tunnel edge directly: $(cat "$TMP/dns/state/edge_args" 2>/dev/null)"
grep -q 'edge 104.16.230.132,104.16.231.132: HTTP 502' "$TMP/dns/state/out" \
  || fail "case 12a: the probe must log each edge result: $(cat "$TMP/dns/state/out")"
echo "PASS: a tunnel probed before its record publishes routes without seeding the resolver cache"

started=$SECONDS
if run_dns_case dead resolvable 3; then
  fail "case 12b: a pinned edge answering 530 (no tunnel route) must NOT count as routing"
fi
elapsed=$(( SECONDS - started ))
[ "$elapsed" -le 9 ] || fail "case 12b: a dead tunnel must fail at the probe deadline, ran ${elapsed}s"
resolved_new_hostname \
  && fail "case 12b: the probe resolved a dead tunnel's hostname: $(cat "$TMP/dns/state/host_resolver_calls")"
echo "PASS: a dead tunnel at the pinned edge is still rejected (${elapsed}s)"

run_dns_case routed unresolvable 10 \
  || fail "case 12c: without edge addresses the plain probe must still run ($(cat "$TMP/dns/state/out"))"
grep -q -- '--resolve' "$TMP/dns/state/edge_args" \
  && fail "case 12c: no edge addresses means nothing to pin: $(cat "$TMP/dns/state/edge_args")"
grep -q 'No edge addresses for api.trycloudflare.com; probing race.trycloudflare.com through DNS' "$TMP/dns/state/out" \
  || fail "case 12c: the unpinned probe must say why it uses DNS: $(cat "$TMP/dns/state/out")"
echo "PASS: an unresolvable edge name falls back to the plain probe"

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
out="" ua="" url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -A) ua="$2"; shift ;;
    -w|--noproxy|--max-time|--connect-timeout|-H) shift ;;
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

echo "ALL PASS — public quick-tunnel routing verification and recycling"
