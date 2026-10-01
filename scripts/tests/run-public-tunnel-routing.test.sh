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
        [ "$STUB_CLOUDFLARE_OK" = 1 ] || return 1
        public_tunnel_publish_environment "https://stub.trycloudflare.com" "$ALLOWED_ORIGINS"
        sleep 30 & NGROK_PID=$!
        PIDS+=("$NGROK_PID"); NAMES+=(cloudflared)
      }
      start_localtunnel_public_tunnel() {
        echo localtunnel >> "$RUN_CONTEXT_DIR/calls"
        public_tunnel_publish_environment "https://stub.loca.lt" "$ALLOWED_ORIGINS"
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

out="$(run_ngrok_mode 0 "$held_line" 0)" \
  || fail "case 9b: localtunnel must serve when cloudflare also fails ($(cat "$TMP/ngrok_mode.err"))"
printf '%s\n' "$out" | grep -qx 'url=https://stub.loca.lt' \
  || fail "case 9b: expected the localtunnel origin, got: $out"
[ "$(tr '\n' ' ' < "$TMP/ctx/calls")" = "ngrok cloudflare localtunnel " ] \
  || fail "case 9b: unexpected provider order: $(tr '\n' ' ' < "$TMP/ctx/calls")"
echo "PASS: ERR_NGROK_334 reaches localtunnel when cloudflare cannot route"

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

# --- case 10: the ngrok fallback reserves one domain per worktree, not per run ---
# RCA cement (2026-10-01). Isolated benchmark runs rename the workspace to
# "<worktree>-bench-<run id>", and the fallback derived its reserved domain from
# that name: 85 one-off rose-<worktree>-bench-<run id>-bench domains filled the
# ngrok account roster (101 domains; nothing new reservable since 2026-09-01).
{
  awk '/^dns_label_from_workspace\(\) \{$/,/^\}$/' "$RUN_SH"
  awk '/^start_ngrok_ephemeral_tunnel\(\) \{$/,/^\}$/' "$RUN_SH"
} > "$TMP/ngrok_fallback.sh"
cat > "$TMP/bin/ngrok" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_NGROK_ARGS"
domain=""
while [ "$#" -gt 0 ]; do
  [ "$1" = "--domain" ] && domain="$2"
  shift
done
sleep 1
printf '{"url":"https://%s"}\n' "${domain:-stub.ngrok-free.dev}"
exec sleep 30
STUB
chmod +x "$TMP/bin/ngrok"

fallback_domain_for() { # fallback_domain_for <workspace name>
  rm -f "$TMP/ctx/ngrok-args" "$TMP/ctx/reserved"
  PATH="$TMP/bin:$PATH" STUB_NGROK_ARGS="$TMP/ctx/ngrok-args" \
    CONDUCTOR_WORKSPACE_NAME="$1" NGROK_AUTHTOKEN=stub NGROK_API_KEY=stub_key \
    RUN_CONTEXT_DIR="$TMP/ctx" ROOT_DIR="$ROOT_DIR" FN_FILE="$TMP/ngrok_fallback.sh" \
    bash -c '
      set -euo pipefail
      source "$ROOT_DIR/scripts/lib/ngrok-tunnel.sh"
      source "$FN_FILE"
      FRONTEND_PORT=3002
      ALLOWED_ORIGINS="http://localhost:3002"
      PIDS=(); NAMES=()
      ensure_ngrok_domain_reserved() { printf "%s\n" "$1" >> "$RUN_CONTEXT_DIR/reserved"; }
      cloudflare_tunnel_edge_is_routing() { return 0; }
      # run.sh only calls this in a conditional, which suspends errexit for
      # its URL poll; an unconditional call dies on the first empty poll.
      start_ngrok_ephemeral_tunnel >&2 || exit 1
      kill "$NGROK_PID" 2>/dev/null || true
      echo "$PUBLIC_BASE_URL"
    ' 2>"$TMP/ngrok_fallback.err"
}

out="$(fallback_domain_for cloud-44cb5599-bench-1788291482-530832-87704)" \
  || fail "case 10: fallback tunnel failed to start ($(cat "$TMP/ngrok_fallback.err"); log: $(cat "$TMP/ctx/ngrok-fallback.log" 2>/dev/null))"
[ "$out" = "https://rose-cloud-44cb5599-bench.ngrok.app" ] \
  || fail "case 10: isolated run must bind the worktree fallback domain, got $out"
[ "$(cat "$TMP/ctx/reserved")" = "rose-cloud-44cb5599-bench.ngrok.app" ] \
  || fail "case 10: isolated run reserved a per-run domain: $(cat "$TMP/ctx/reserved")"
grep -q -- '--domain rose-cloud-44cb5599-bench.ngrok.app' "$TMP/ctx/ngrok-args" \
  || fail "case 10: ngrok was not bound to the worktree fallback domain: $(cat "$TMP/ctx/ngrok-args")"
out="$(fallback_domain_for managua-v1)" \
  || fail "case 10: plain worktree fallback failed ($(cat "$TMP/ngrok_fallback.err"))"
[ "$out" = "https://rose-managua-v1-bench.ngrok.app" ] \
  || fail "case 10: plain worktree fallback domain changed, got $out"
echo "PASS: the ngrok fallback reuses one per-worktree domain across isolated runs"

echo "ALL PASS — public quick-tunnel routing verification and recycling"
