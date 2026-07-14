#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER_SRC="$ROOT_DIR/scripts/lib/cloudbench-env.sh"
NGROK_HELPER_SRC="$ROOT_DIR/scripts/lib/ngrok-tunnel.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_text() {
  local file="$1" text="$2" description="$3"
  grep -Fq -- "$text" "$file" || fail "$description"
}

[ -f "$HELPER_SRC" ] || fail "cloud benchmark env helper is missing"
[ -f "$NGROK_HELPER_SRC" ] || fail "ngrok tunnel helper is missing"
# shellcheck source=../lib/cloudbench-env.sh
source "$HELPER_SRC"
# shellcheck source=../lib/ngrok-tunnel.sh
source "$NGROK_HELPER_SRC"

[ "$(public_tunnel_provider_for_mode 1)" = "cloudflare" ] || \
  fail "ephemeral benchmark mode must dispatch to the per-process Quick Tunnel provider"
[ "$(public_tunnel_provider_for_mode 0)" = "ngrok" ] || \
  fail "stable local mode must retain the ngrok provider"
if public_tunnel_provider_for_mode invalid >/dev/null 2>&1; then
  fail "invalid public tunnel modes must fail closed"
fi
public_tunnel_process_is_required cloudflared 1 || \
  fail "the ephemeral cloudflared process must be a required stack dependency"
if public_tunnel_process_is_required ngrok 0; then
  fail "the stable local ngrok process must retain its nonfatal development policy"
fi
if public_tunnel_process_is_required cloudflared 0; then
  fail "cloudflared must never be selected as a stable local tunnel"
fi

ngrok_configure_endpoint_mode 1 ""
[ "$NGROK_RESERVE_DOMAIN" = "0" ] && [ "${#NGROK_ENDPOINT_ARGS[@]}" -eq 0 ] || \
  fail "ephemeral ngrok mode must not reserve or pass a domain"
ngrok_configure_endpoint_mode 0 rose-stable.ngrok.app
[ "$NGROK_RESERVE_DOMAIN" = "1" ] && [ "${NGROK_ENDPOINT_ARGS[*]}" = "--domain rose-stable.ngrok.app" ] || \
  fail "stable ngrok mode must retain its explicit domain contract"

ngrok_response="$TMP_ROOT/ngrok-response.json"
printf '%s\n' '{"tunnels":[{"proto":"http","public_url":"http://ignored.example"},{"proto":"https","public_url":"https://ephemeral-123.ngrok-free.app"}]}' > "$ngrok_response"
ngrok_publish_reported_environment "$ngrok_response" "http://localhost:3001"
[ "$PUBLIC_BASE_URL" = "https://ephemeral-123.ngrok-free.app" ] || fail "ngrok response must publish its exact HTTPS origin"
old_ngrok_url_one="$PUBLIC_BASE_URL"
ngrok_publish_reported_environment "$ngrok_response" "http://localhost:3001"
old_ngrok_url_two="$PUBLIC_BASE_URL"
[ "$old_ngrok_url_one" = "$old_ngrok_url_two" ] || \
  fail "RCA fixture must reproduce the account-assigned ngrok URL collision"
[ "$WORKTREE_DOMAIN" = "ephemeral-123.ngrok-free.app" ] || fail "ngrok response must publish its exact host"
[ "$VITE_ALLOWED_HOSTS" = "$WORKTREE_DOMAIN" ] || fail "Vite must allow the reported ngrok host"
[ "$ALLOWED_ORIGINS" = "http://localhost:3001,https://ephemeral-123.ngrok-free.app" ] || \
  fail "the reported ngrok origin must be added exactly once"
ngrok_manifest="$TMP_ROOT/ngrok-services.json"
printf '%s\n' '{"urls":{"backend":"http://localhost:3000"}}' > "$ngrok_manifest"
ngrok_publish_public_url_manifest "$ngrok_manifest"
[ "$(jq -r '.urls.public' "$ngrok_manifest")" = "$PUBLIC_BASE_URL" ] || \
  fail "services.json must publish the provider-reported ngrok URL"

cloudflare_log="$TMP_ROOT/cloudflared.log"
printf '%s\n' \
  '2026-07-13T07:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...' \
  '2026-07-13T07:00:01Z INF | https://unit-test-random.trycloudflare.com |' \
  > "$cloudflare_log"
cloudflare_publish_reported_environment "$cloudflare_log" "http://localhost:3001"
[ "$PUBLIC_BASE_URL" = "https://unit-test-random.trycloudflare.com" ] || \
  fail "Cloudflare Quick Tunnel logs must publish their exact random HTTPS origin"
quick_url_one="$PUBLIC_BASE_URL"
[ "$WORKTREE_DOMAIN" = "unit-test-random.trycloudflare.com" ] || \
  fail "Cloudflare Quick Tunnel publication must expose the reported host"
[ "$ALLOWED_ORIGINS" = "http://localhost:3001,https://unit-test-random.trycloudflare.com" ] || \
  fail "Cloudflare Quick Tunnel publication must add its origin exactly once"
printf '%s\n' '2026-07-13T07:00:02Z INF | https://second-random.trycloudflare.com |' > "$cloudflare_log"
cloudflare_publish_reported_environment "$cloudflare_log" "http://localhost:3001"
quick_url_two="$PUBLIC_BASE_URL"
[ "$quick_url_one" != "$quick_url_two" ] || \
  fail "separate Quick Tunnel process fixtures must publish isolated URLs"
printf '%s\n' 'https://attacker.example.test' > "$cloudflare_log"
if cloudflare_publish_reported_environment "$cloudflare_log" "http://localhost:3001" >/dev/null 2>&1; then
  fail "Cloudflare publication must reject URLs outside trycloudflare.com"
fi
printf '%s\n' 'https://bad.trycloudflare.com/path' > "$cloudflare_log"
if cloudflare_publish_reported_environment "$cloudflare_log" "http://localhost:3001" >/dev/null 2>&1; then
  fail "Cloudflare publication must reject non-origin URLs"
fi
printf '%s\n' 'https://attacker@unit-test.trycloudflare.com' > "$cloudflare_log"
if cloudflare_publish_reported_environment "$cloudflare_log" "http://localhost:3001" >/dev/null 2>&1; then
  fail "Cloudflare publication must reject URL credentials"
fi
printf '%s\n' 'https://unit-test.trycloudflare.com:8443' > "$cloudflare_log"
if cloudflare_publish_reported_environment "$cloudflare_log" "http://localhost:3001" >/dev/null 2>&1; then
  fail "Cloudflare publication must reject explicit ports"
fi

printf '%s\n' '{malformed' > "$ngrok_response"
if ngrok_publish_reported_environment "$ngrok_response" "http://localhost:3001" >/dev/null 2>&1; then
  fail "malformed ngrok responses must fail closed"
fi
printf '%s\n' '{"tunnels":[{"proto":"http","public_url":"http://only-http.example"}]}' > "$ngrok_response"
if ngrok_publish_reported_environment "$ngrok_response" "http://localhost:3001" >/dev/null 2>&1; then
  fail "ngrok responses without an HTTPS tunnel must fail closed"
fi

cloudbench_is_controller_shell || fail "the top-level controller shell must own cleanup"
if (cloudbench_is_controller_shell); then
  fail "a benchmark subshell must never own destructive controller cleanup"
fi

cleanup_calls="$TMP_ROOT/cleanup-calls"
: > "$cleanup_calls"
FLY() {
  printf 'FLY %s\n' "$*" >> "$cleanup_calls"
}
mock_controller_lock_release() {
  printf 'LOCK_RELEASE %s\n' "$1" >> "$cleanup_calls"
}
mock_fleet_cleanup() {
  local pool_file="$1" app="$2" lock="$3" id
  while IFS= read -r id; do
    [ -n "$id" ] && FLY machine stop "$id" -a "$app"
  done < "$pool_file"
  mock_controller_lock_release "$lock"
}
mock_pool="$TMP_ROOT/mock-pool.ids"
printf 'machine-a\nmachine-b\n' > "$mock_pool"
cloudbench_dispatch_controller_cleanup 0 mock_fleet_cleanup "$mock_pool" bench-app mock-lock
require_text "$cleanup_calls" \
  'FLY machine stop machine-a -a bench-app' \
  "top-level cleanup must stop its first authoritative pool machine"
require_text "$cleanup_calls" \
  'FLY machine stop machine-b -a bench-app' \
  "top-level cleanup must stop its second authoritative pool machine"
require_text "$cleanup_calls" \
  'LOCK_RELEASE mock-lock' \
  "top-level cleanup must release its controller lock"
: > "$cleanup_calls"
(cloudbench_dispatch_controller_cleanup 0 mock_fleet_cleanup "$mock_pool" bench-app mock-lock)
[ ! -s "$cleanup_calls" ] || fail "non-owner cleanup must perform zero destructive calls"
set +e
cloudbench_dispatch_controller_cleanup 23 mock_fleet_cleanup /dev/null bench-app mock-lock
cleanup_status=$?
set -e
[ "$cleanup_status" -eq 23 ] || fail "cleanup dispatch must preserve the triggering exit status"

agents_env="$TMP_ROOT/agents.env"
backend_env="$TMP_ROOT/backend.env"
printf 'BROWSER_PROVIDER=browserbase\nSECRET=value-one\n' > "$agents_env"
printf 'BROWSER_PROVIDER=browserbase\nSECRET=value-two\n' > "$backend_env"

if cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" kernel kernel >/dev/null 2>&1; then
  fail "stale browserbase config must not pass a production kernel contract"
fi

sed -i.bak 's/browserbase/kernel/' "$agents_env" "$backend_env"
rm -f "$agents_env.bak" "$backend_env.bak"
cloudbench_validate_browser_provider_contract "$agents_env" "$backend_env" kernel kernel >/dev/null

agents_digest="$(cloudbench_env_sha256 "$agents_env")"
backend_digest="$(cloudbench_env_sha256 "$backend_env")"
[ "${#agents_digest}" -eq 64 ] || fail "agents env digest must be sha256"
[ "${#backend_digest}" -eq 64 ] || fail "backend env digest must be sha256"
cloudbench_verify_env_file "$agents_env" "$agents_digest" agents >/dev/null
if cloudbench_verify_env_file "$agents_env" "$backend_digest" agents >/dev/null 2>&1; then
  fail "a mismatched injected env digest must fail closed"
fi

retry_attempts=0
fail_twice_then_succeed() {
  retry_attempts=$((retry_attempts + 1))
  [ "$retry_attempts" -ge 3 ]
}
cloudbench_retry_command 3 0 fail_twice_then_succeed >/dev/null 2>&1 ||
  fail "a transient command must succeed within its retry budget"
[ "$retry_attempts" -eq 3 ] || fail "a transient command must be retried exactly to success"

retry_attempts=0
always_fail() {
  retry_attempts=$((retry_attempts + 1))
  return 9
}
if cloudbench_retry_command 3 0 always_fail >/dev/null 2>&1; then
  fail "a permanently failing command must fail closed"
fi
[ "$retry_attempts" -eq 3 ] || fail "a permanent failure must exhaust its retry budget"

machine_states="$TMP_ROOT/machine-states"
printf 'created\ncreated\nstopped\n' > "$machine_states"
read_machine_state() {
  local state
  state="$(head -1 "$machine_states")"
  tail -n +2 "$machine_states" > "$machine_states.next"
  mv "$machine_states.next" "$machine_states"
  printf '%s\n' "$state"
}
cloudbench_wait_machine_startable read_machine_state machine-1 3 0 ||
  fail "a provisioning clone must wait until it becomes stopped/startable"
[ ! -s "$machine_states" ] || fail "the startable-state wait must consume the transition sequence"

printf 'created\ndestroyed\n' > "$machine_states"
if cloudbench_wait_machine_startable read_machine_state machine-2 3 0 >/dev/null 2>&1; then
  fail "a destroyed provisioning clone must fail closed"
fi

cloudbench_validate_fresh_clone_id clone-2 warm-1 clone-1 ||
  fail "a unique non-source clone id must be accepted"
if cloudbench_validate_fresh_clone_id warm-1 warm-1 clone-1; then
  fail "the warm source id must never be accepted as a fresh clone"
fi
if cloudbench_validate_fresh_clone_id clone-1 warm-1 clone-1; then
  fail "a duplicate clone id must never be accepted"
fi

activation_ids="$(printf '%s\n' '[{"id":"warm-1","name":"cloudbench-warm","state":"stopped"},{"id":"lock-1","name":"cloudbench-controller-lock","state":"stopped"},{"id":"clone-1","name":"fleet-1","state":"stopped"},{"id":"provisioning-1","name":"other-controller-clone","state":"created"},{"id":"running-1","name":"other-controller-run","state":"started"}]' | cloudbench_env_activation_machine_ids)"
[ "$activation_ids" = $'warm-1\nclone-1' ] ||
  fail "environment activation must target only stopped non-lock benchmark machines"

node_a="$TMP_ROOT/node-a"
node_b="$TMP_ROOT/node-b"
mkdir -p "$node_a/back-end" "$node_a/front-end" "$node_b/back-end" "$node_b/front-end"
printf '{"lockfileVersion":3,"packages":{"generated":"old"}}\n' > "$node_a/package-lock.json"
printf '{"lockfileVersion":3,"packages":{"generated":"new"}}\n' > "$node_b/package-lock.json"
printf '{"lockfileVersion":3,"packages":{}}\n' > "$node_a/back-end/package-lock.json"
cp "$node_a/back-end/package-lock.json" "$node_b/back-end/package-lock.json"
printf '{"scripts":{"test":"old"},"dependencies":{"tsx":"1.0.0"}}\n' > "$node_a/package.json"
printf '{"scripts":{"test":"new"},"dependencies":{"tsx":"1.0.0"}}\n' > "$node_b/package.json"
for relative in back-end/package.json front-end/package.json; do
  printf '{"scripts":{"test":"old"}}\n' > "$node_a/$relative"
  printf '{"scripts":{"test":"new"}}\n' > "$node_b/$relative"
done
node_a_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_a")"
node_b_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_b")"
[ "$node_a_fingerprint" = "$node_b_fingerprint" ] ||
  fail "scripts and the generated root lock must not invalidate baked dependencies"
printf '{"scripts":{"test":"new"},"dependencies":{"tsx":"2.0.0"}}\n' > "$node_b/package.json"
node_b_fingerprint="$(cloudbench_node_dependency_fingerprint "$node_b")"
[ "$node_a_fingerprint" != "$node_b_fingerprint" ] ||
  fail "dependency field changes must invalidate baked dependencies"

lock_file="$TMP_ROOT/controller.lock"
cloudbench_controller_lock_acquire "$lock_file"
cloudbench_controller_parent_valid "$lock_file" || fail "the lock owner token must validate"
owner_token="$CLOUDBENCH_CONTROLLER_TOKEN"
CLOUDBENCH_CONTROLLER_TOKEN=forged
if cloudbench_controller_parent_valid "$lock_file"; then
  fail "a forged parent-lock flag without the owner token must be rejected"
fi
CLOUDBENCH_CONTROLLER_TOKEN="$owner_token"
if bash -c 'source "$1"; cloudbench_controller_lock_acquire "$2"' _ "$HELPER_SRC" "$lock_file"; then
  fail "a second controller must not acquire an owned lock"
fi
cloudbench_controller_lock_release "$lock_file"
[ ! -e "$lock_file" ] || fail "controller lock must be removed by its owner"

shared_repo="$TMP_ROOT/shared-repo"
shared_worktree="$TMP_ROOT/shared-worktree"
git init -q "$shared_repo"
git -C "$shared_repo" config user.email benchmark@example.invalid
git -C "$shared_repo" config user.name "Benchmark Test"
printf 'fixture\n' > "$shared_repo/fixture.txt"
git -C "$shared_repo" add fixture.txt
git -C "$shared_repo" commit -qm fixture
git -C "$shared_repo" worktree add -qb benchmark-worktree "$shared_worktree"
primary_lock="$(cloudbench_controller_lock_path "$shared_repo" bench-app)"
worktree_lock="$(cloudbench_controller_lock_path "$shared_worktree" bench-app)"
[ "$primary_lock" = "$worktree_lock" ] || fail "all git worktrees must coordinate through one cloud resource lock"
cloudbench_controller_lock_acquire "$primary_lock"
if bash -c 'source "$1"; path="$(cloudbench_controller_lock_path "$2" bench-app)"; cloudbench_controller_lock_acquire "$path"' _ "$HELPER_SRC" "$shared_worktree"; then
  fail "a controller in another worktree must not acquire the shared cloud resource lock"
fi
cloudbench_controller_lock_release "$primary_lock"

patch_repo="$TMP_ROOT/patch-repo"
patch_file="$TMP_ROOT/added-file.patch"
git init -q "$patch_repo"
git -C "$patch_repo" config user.email benchmark@example.invalid
git -C "$patch_repo" config user.name "Benchmark Test"
printf 'base\n' > "$patch_repo/base.txt"
git -C "$patch_repo" add base.txt
git -C "$patch_repo" commit -qm base
mkdir -p "$patch_repo/scripts/lib"
printf 'new helper\n' > "$patch_repo/scripts/lib/new-helper.sh"
git -C "$patch_repo" add -N scripts/lib/new-helper.sh
git -C "$patch_repo" diff --binary > "$patch_file"
git -C "$patch_repo" reset -q -- scripts/lib/new-helper.sh
printf 'keep me\n' > "$patch_repo/unrelated-cache.txt"
bash "$ROOT_DIR/scripts/cloudbench-prepare-patch.sh" "$patch_repo" "$patch_file"
[ ! -e "$patch_repo/scripts/lib/new-helper.sh" ] || \
  fail "patch preparation must remove the stale untracked create-path collision"
[ -f "$patch_repo/unrelated-cache.txt" ] || \
  fail "patch preparation must preserve unrelated untracked cache files"
git -C "$patch_repo" apply "$patch_file"
[ "$(cat "$patch_repo/scripts/lib/new-helper.sh")" = "new helper" ] || \
  fail "prepared dirty patch must create its intended new file"

api_calls="$TMP_ROOT/machines-api-calls"
api_lease_state="$TMP_ROOT/machines-api-lease-state"
api_primary_stop_fail="$TMP_ROOT/machines-api-primary-stop-fail"
api_primary_activation_attempts="$TMP_ROOT/machines-api-primary-activation-attempts"
api_bad_activation_attempts="$TMP_ROOT/machines-api-bad-activation-attempts"
api_primary_start_attempts="$TMP_ROOT/machines-api-primary-start-attempts"
api_bad_start_attempts="$TMP_ROOT/machines-api-bad-start-attempts"
api_fresh_lease_attempts="$TMP_ROOT/machines-api-fresh-lease-attempts"
api_bad_lease_attempts="$TMP_ROOT/machines-api-bad-lease-attempts"
cloud_lease_get_failure="$TMP_ROOT/cloud-lease-get-failure"
printf '0\n' > "$api_primary_activation_attempts"
printf '0\n' > "$api_bad_activation_attempts"
printf '0\n' > "$api_primary_start_attempts"
printf '0\n' > "$api_bad_start_attempts"
printf '0\n' > "$api_fresh_lease_attempts"
printf '0\n' > "$api_bad_lease_attempts"
CLOUDBENCH_MACHINES_API_TOKEN=test-token
: > "$api_calls"
cloudbench_machines_api_request() {
  local method="$1" path="$2" body="${3:-}" nonce="${4:-}"
  printf '%s|%s|%s|%s\n' "$method" "$path" "$body" "$nonce" >> "$api_calls"
  case "$method|$path" in
    'GET|/v1/apps/bench-app/machines')
      if [ -e "$cloud_lease_get_failure" ]; then
        CLOUDBENCH_API_STATUS=503
        CLOUDBENCH_API_BODY='{"error":"unavailable"}'
        return 1
      fi
      CLOUDBENCH_API_STATUS=200
      CLOUDBENCH_API_BODY='[{"id":"lock-machine","name":"cloudbench-controller-lock"}]'
      ;;
    'POST|/v1/apps/bench-app/machines/lock-machine/lease')
      if [ -e "$api_lease_state" ]; then
        CLOUDBENCH_API_STATUS=409
        CLOUDBENCH_API_BODY='{"error":"lease already held"}'
      else
        : > "$api_lease_state"
        CLOUDBENCH_API_STATUS=201
        CLOUDBENCH_API_BODY='{"status":"success","data":{"nonce":"lease-nonce","owner":"runner"}}'
      fi
      ;;
    'DELETE|/v1/apps/bench-app/machines/lock-machine/lease')
      rm -f "$api_lease_state"
      CLOUDBENCH_API_STATUS=200
      CLOUDBENCH_API_BODY='{"ok":true}'
      ;;
    'POST|/v1/apps/bench-app/machines/primary-machine/lease')
      CLOUDBENCH_API_STATUS=201
      CLOUDBENCH_API_BODY='{"status":"success","data":{"nonce":"primary-nonce","owner":"runner"}}'
      ;;
    'GET|/v1/apps/bench-app/machines/primary-machine')
      activation_attempt="$(cat "$api_primary_activation_attempts")"
      CLOUDBENCH_API_STATUS=200
      CLOUDBENCH_API_BODY="{\"id\":\"primary-machine\",\"name\":\"primary\",\"region\":\"ord\",\"version\":\"v$((activation_attempt + 1))\",\"config\":{\"image\":\"example/image:latest\"}}"
      ;;
    'POST|/v1/apps/bench-app/machines/primary-machine')
      [ "$nonce" = "primary-nonce" ] || fail "primary environment activation omitted its Fly lease nonce"
      activation_attempt="$(cat "$api_primary_activation_attempts")"
      [ "$(printf '%s' "$body" | jq -r '.current_version')" = "v$((activation_attempt + 1))" ] || \
        fail "Machine activation retry must use the version returned by its latest GET"
      activation_attempt=$((activation_attempt + 1))
      printf '%s\n' "$activation_attempt" > "$api_primary_activation_attempts"
      if [ "$activation_attempt" -eq 1 ]; then
        CLOUDBENCH_API_STATUS=408
        CLOUDBENCH_API_BODY=''
      else
        CLOUDBENCH_API_STATUS=200
        CLOUDBENCH_API_BODY='{"id":"primary-machine","state":"stopped"}'
      fi
      ;;
    'GET|/v1/apps/bench-app/machines/bad-activation-machine')
      CLOUDBENCH_API_STATUS=200
      CLOUDBENCH_API_BODY='{"id":"bad-activation-machine","name":"bad","region":"ord","version":"bad-v1","config":{"image":"example/image:latest"}}'
      ;;
    'POST|/v1/apps/bench-app/machines/bad-activation-machine')
      bad_activation_attempt="$(cat "$api_bad_activation_attempts")"
      printf '%s\n' "$((bad_activation_attempt + 1))" > "$api_bad_activation_attempts"
      CLOUDBENCH_API_STATUS=500
      CLOUDBENCH_API_BODY='{"error":"permanent activation error"}'
      ;;
    'POST|/v1/apps/bench-app/machines/primary-machine/start')
      [ "$nonce" = "primary-nonce" ] || fail "primary lifecycle mutation omitted its Fly lease nonce"
      start_attempt="$(cat "$api_primary_start_attempts")"
      start_attempt=$((start_attempt + 1))
      printf '%s\n' "$start_attempt" > "$api_primary_start_attempts"
      if [ "$start_attempt" -eq 1 ]; then
        CLOUDBENCH_API_STATUS=412
        CLOUDBENCH_API_BODY='{"error":"failed_precondition: machine getting replaced, refusing to start"}'
      else
        CLOUDBENCH_API_STATUS=200
        CLOUDBENCH_API_BODY='{"ok":true}'
      fi
      ;;
    'POST|/v1/apps/bench-app/machines/primary-machine/stop')
      [ "$nonce" = "primary-nonce" ] || fail "primary lifecycle mutation omitted its Fly lease nonce"
      if [ -e "$api_primary_stop_fail" ]; then
        CLOUDBENCH_API_STATUS=500
        CLOUDBENCH_API_BODY='{"error":"stop failed"}'
      else
        CLOUDBENCH_API_STATUS=200
        CLOUDBENCH_API_BODY='{"ok":true}'
      fi
      ;;
    'POST|/v1/apps/bench-app/machines/bad-start-machine/start')
      bad_start_attempt="$(cat "$api_bad_start_attempts")"
      printf '%s\n' "$((bad_start_attempt + 1))" > "$api_bad_start_attempts"
      CLOUDBENCH_API_STATUS=412
      CLOUDBENCH_API_BODY='{"error":"failed_precondition: unrelated permanent state"}'
      ;;
    'DELETE|/v1/apps/bench-app/machines/primary-machine/lease')
      [ "$nonce" = "primary-nonce" ] || fail "primary lease release omitted its Fly lease nonce"
      CLOUDBENCH_API_STATUS=200
      CLOUDBENCH_API_BODY='{"ok":true}'
      ;;
    'DELETE|/v1/apps/bench-app/machines/primary-machine?force=true')
      [ "$nonce" = "primary-nonce" ] || fail "primary destroy omitted its Fly lease nonce"
      CLOUDBENCH_API_STATUS=200
      CLOUDBENCH_API_BODY='{"ok":true}'
      ;;
    'POST|/v1/apps/bench-app/machines/fresh-machine/lease')
      [ "$(printf '%s' "$body" | jq -r '.description' | wc -m | tr -d ' ')" -le 65 ] || \
        fail "Machine lease descriptions must respect Fly's 64-rune limit"
      fresh_attempt="$(cat "$api_fresh_lease_attempts")"
      fresh_attempt=$((fresh_attempt + 1))
      printf '%s\n' "$fresh_attempt" > "$api_fresh_lease_attempts"
      if [ "$fresh_attempt" -lt 3 ]; then
        CLOUDBENCH_API_STATUS=409
        CLOUDBENCH_API_BODY='{"error":"bootstrap lease held"}'
      else
        CLOUDBENCH_API_STATUS=201
        CLOUDBENCH_API_BODY='{"data":{"nonce":"fresh-nonce"}}'
      fi
      ;;
    'POST|/v1/apps/bench-app/machines/bad-machine/lease')
      bad_attempt="$(cat "$api_bad_lease_attempts")"
      printf '%s\n' "$((bad_attempt + 1))" > "$api_bad_lease_attempts"
      CLOUDBENCH_API_STATUS=400
      CLOUDBENCH_API_BODY='{"status":"error","message":"invalid request"}'
      ;;
    *)
      fail "unexpected Machines API request: $method $path"
      ;;
  esac
}
cloudbench_cloud_lock_acquire bench-app
[ "$CLOUDBENCH_CLOUD_LOCK_MACHINE_ID" = "lock-machine" ] || fail "cloud lock must bind the sentinel machine"
[ "$CLOUDBENCH_CLOUD_LOCK_NONCE" = "lease-nonce" ] || fail "cloud lock must retain the lease nonce"
[ -n "$CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID" ] && kill -0 "$CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID" 2>/dev/null || \
  fail "cloud lock must arm a watchdog before its server-side lease can expire"
if (cloudbench_cloud_lock_acquire bench-app >/dev/null 2>&1); then
  fail "a second host must be rejected while the Fly sentinel lease is held"
fi
cloudbench_cloud_lock_release bench-app
require_text "$api_calls" \
  'DELETE|/v1/apps/bench-app/machines/lock-machine/lease||lease-nonce' \
  "cloud lock release must authenticate with the acquired lease nonce"

primary_nonce="$(cloudbench_machine_lease_acquire bench-app primary-machine test-primary)"
[ "$primary_nonce" = "primary-nonce" ] || fail "primary Machine lease must retain its nonce"
CLOUDBENCH_MACHINE_ACTIVATION_RETRY_DELAY=0 \
  cloudbench_activate_machine_environment_with_lease bench-app primary-machine "$primary_nonce"
[ "$(cat "$api_primary_activation_attempts")" -eq 2 ] || \
  fail "fresh Machine environment activation must retry Fly's observed HTTP 408"
[ "$(grep -c 'GET|/v1/apps/bench-app/machines/primary-machine|' "$api_calls")" -eq 2 ] || \
  fail "ambiguous Machine activation retries must refresh config and version"
activation_versions="$(awk -F'|' '$1 == "POST" && $2 == "/v1/apps/bench-app/machines/primary-machine" { print $3 }' \
  "$api_calls" | while IFS= read -r update_body; do printf '%s' "$update_body" | jq -r '.current_version'; done | paste -sd, -)"
[ "$activation_versions" = "v1,v2" ] || \
  fail "Machine activation retries must advance current_version after a 408"
if CLOUDBENCH_MACHINE_ACTIVATION_RETRY_DELAY=0 \
  cloudbench_activate_machine_environment_with_lease \
    bench-app bad-activation-machine bad-activation-nonce >/dev/null 2>&1; then
  fail "non-408 Machine activation failures must fail closed"
fi
[ "$(cat "$api_bad_activation_attempts")" -eq 1 ] || \
  fail "non-408 Machine activation failures must not be retried"
CLOUDBENCH_MACHINE_START_RETRY_DELAY=0 \
  cloudbench_machine_start_with_lease bench-app primary-machine "$primary_nonce"
[ "$(cat "$api_primary_start_attempts")" -eq 2 ] || \
  fail "leased Machine start must retry Fly's asynchronous replacement transition"
if CLOUDBENCH_MACHINE_START_RETRY_DELAY=0 \
  cloudbench_machine_start_with_lease bench-app bad-start-machine bad-start-nonce >/dev/null 2>&1; then
  fail "unrelated Machine start preconditions must fail closed"
fi
[ "$(cat "$api_bad_start_attempts")" -eq 1 ] || \
  fail "only Fly's exact replacement transition may be retried"
cloudbench_machine_stop_and_release_lease bench-app primary-machine "$primary_nonce"
require_text "$api_calls" \
  'POST|/v1/apps/bench-app/machines/primary-machine/stop|{}|primary-nonce' \
  "primary cleanup must stop through the Machines API before releasing its lease"
release_count_before="$(grep -c 'DELETE|/v1/apps/bench-app/machines/primary-machine/lease' "$api_calls")"
: > "$api_primary_stop_fail"
if cloudbench_machine_stop_and_release_lease bench-app primary-machine primary-nonce; then
  fail "a failed primary stop must fail closed"
fi
release_count_after="$(grep -c 'DELETE|/v1/apps/bench-app/machines/primary-machine/lease' "$api_calls")"
[ "$release_count_after" -eq "$release_count_before" ] || \
  fail "a failed primary stop must retain its live lease for cleanup retry"
rm -f "$api_primary_stop_fail"
cloudbench_machine_destroy_with_lease bench-app primary-machine "$primary_nonce"
require_text "$api_calls" \
  'DELETE|/v1/apps/bench-app/machines/primary-machine?force=true||primary-nonce' \
  "stale pool retirement must destroy through the Machines API under its lease"

long_description="cloudbench-primary-run-with-a-description-that-exceeds-the-provider-limit-by-design-1234567890"
fresh_nonce="$(cloudbench_machine_lease_acquire_retry bench-app fresh-machine "$long_description" 3 0)"
[ "$fresh_nonce" = "fresh-nonce" ] || fail "fresh-clone lease handoff must return its eventual nonce"
[ "$(cat "$api_fresh_lease_attempts")" -eq 3 ] || fail "fresh-clone lease retry must be bounded and retry conflicts"
if cloudbench_machine_lease_acquire_retry bench-app bad-machine bad-primary 3 0 >/dev/null 2>&1; then
  fail "permanent Machine lease errors must fail closed"
fi
[ "$(cat "$api_bad_lease_attempts")" -eq 1 ] || fail "permanent Machine lease errors must not be retried"

# Failure typing must come from the current acquisition stage, never a stale
# API status left by an earlier 409. Otherwise a real outage loops as "busy".
stale_status_lock="$TMP_ROOT/stale-status-controller.lock"
: > "$api_lease_state"
CLOUDBENCH_MACHINES_API_TOKEN="test-token"
if cloudbench_controller_acquire "$stale_status_lock" bench-app >/dev/null 2>&1; then
  fail "an occupied cloud lease must not be acquired"
fi
[ "$CLOUDBENCH_CONTROLLER_ACQUIRE_REASON" = "cloud_busy" ] ||
  fail "an occupied cloud lease must be typed as cloud_busy"
rm -f "$api_lease_state"
: > "$cloud_lease_get_failure"
if cloudbench_controller_acquire "$stale_status_lock" bench-app >/dev/null 2>&1; then
  fail "a sentinel API outage must not acquire the controller"
fi
[ "$CLOUDBENCH_CONTROLLER_ACQUIRE_REASON" = "cloud_api_error" ] ||
  fail "a sentinel API outage was misclassified using stale 409 state"
[ ! -e "$stale_status_lock" ] || fail "API failure leaked the local controller lock"
rm -f "$cloud_lease_get_failure"

# A local lock setup error is not contention and must fail immediately.
if cloudbench_controller_wait_acquire /dev/null/controller.lock bench-app >/dev/null 2>&1; then
  fail "a local lock filesystem error must not enter the contention queue"
fi
[ "$CLOUDBENCH_CONTROLLER_ACQUIRE_REASON" = "local_error" ] ||
  fail "a local lock filesystem error must be typed as local_error"

# A legitimate sibling controller holds the app-wide lease while another
# workspace queues its fleet. The queued controller must wait for handoff
# instead of turning the Hub request into seven placeholder failures.
wait_lock_file="$TMP_ROOT/waiting-controller.lock"
: > "$api_lease_state"
CLOUDBENCH_MACHINES_API_TOKEN="test-token"
( sleep 0.05; rm -f "$api_lease_state" ) & lease_releaser_pid=$!
CLOUDBENCH_CONTROLLER_RETRY_INTERVAL=0.01 \
  cloudbench_controller_wait_acquire "$wait_lock_file" bench-app >/dev/null
wait "$lease_releaser_pid"
[ -e "$api_lease_state" ] || fail "waiting controller never acquired the released cloud lease"
cloudbench_controller_release "$wait_lock_file" bench-app
[ ! -e "$wait_lock_file" ] || fail "waiting controller did not release its local lock"

# Signals in the startup window (after lease acquisition but before the fleet's
# full cleanup trap) must release both the provider lease and local lock.
signal_lock_file="$TMP_ROOT/signal-controller.lock"
signal_ready_file="$TMP_ROOT/signal-controller.ready"
CLOUDBENCH_MACHINES_API_TOKEN="test-token"
(
  cloudbench_controller_install_release_guard "$signal_lock_file" bench-app
  cloudbench_controller_wait_acquire "$signal_lock_file" bench-app >/dev/null
  : > "$signal_ready_file"
  while :; do sleep 1; done
) & signal_controller_pid=$!
for _ in $(seq 1 100); do
  [ -e "$signal_ready_file" ] && break
  sleep 0.01
done
[ -e "$signal_ready_file" ] || fail "signal-guard controller never acquired its lease"
kill -TERM "$signal_controller_pid"
signal_status=0
wait "$signal_controller_pid" || signal_status=$?
[ "$signal_status" -eq 143 ] || fail "signal-guard controller returned $signal_status instead of 143"
[ ! -e "$api_lease_state" ] || fail "signal guard leaked the provider lease"
[ ! -e "$signal_lock_file" ] || fail "signal guard leaked the local controller lock"
unset CLOUDBENCH_MACHINES_API_TOKEN

require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'bash scripts/run-bench-cloud --refresh-secrets' \
  "fleet controller must refresh the environment once before cloning"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_PARENT_LOCK_HELD=1' \
  "fleet environment refresh must declare the controller lock it already owns"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_SKIP_MACHINE_ACTIVATION=1' \
  "fleet environment refresh must not update Machines owned by other isolated runs"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_ENV_REFRESHED=1' \
  "fleet children must receive proof that the controller refreshed the environment"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_wait_acquire "$LOCK_DIR" "$APP"' \
  "fleet controllers must acquire the cross-host Fly sentinel lease"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_install_release_guard "$LOCK_DIR" "$APP"' \
  "fleet startup must guard controller leases before full cleanup is installed"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_controller_release "$LOCK_DIR" "$APP"' \
  "fleet cleanup must release the cross-host Fly sentinel lease"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_dispatch_controller_cleanup "$ec" cleanup_impl "$ec"' \
  "fleet cleanup must dispatch through controller ownership"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_machine_start_with_lease "$APP" "$cid" "$primary_nonce"' \
  "fleet primaries must start under their own platform lease"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'Verifying parent-started leased machine $mid' \
  "fleet children must treat Machine start as a parent-owned lifecycle action"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'if [ -z "$FLEET_MACHINE_ID" ] \' \
  "fleet child readiness polling must not issue unleased start retries"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_machine_stop_and_release_lease "$APP" "$id" "$nonce"' \
  "fleet cleanup must stop primaries before releasing their platform leases"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLAIMED_POOL_FILE="$FLEET_DIR/claimed-pool.ids"' \
  "pool claims must persist across command-substitution shells"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'grep -Fxq "$id" "$CLAIMED_POOL_FILE"' \
  "pool claim selection must skip IDs already claimed by this run"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'candidate primary $cid is currently leased; trying next pool machine' \
  "a leased pool candidate must not prevent the task from trying another primary"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'if [ "$primary_lease_rc" -ne 75 ]; then' \
  "pool selection must distinguish a lease conflict from permanent control-plane errors"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'exit "$primary_lease_rc"' \
  "permanent pool lease errors must abort instead of trying another candidate or clone"
pool_acquire_line="$(grep -n 'if primary_nonce="$(cloudbench_machine_lease_acquire' "$ROOT_DIR/scripts/run-bench-fleet" | cut -d: -f1)"
pool_fail_closed_line="$(grep -n 'if \[ "$primary_lease_rc" -ne 75 \]; then' "$ROOT_DIR/scripts/run-bench-fleet" | cut -d: -f1)"
pool_conflict_skip_line="$(grep -n 'candidate primary $cid is currently leased; trying next pool machine' "$ROOT_DIR/scripts/run-bench-fleet" | cut -d: -f1)"
fresh_clone_line="$(grep -n 'pool empty → cloning fresh isolated machine' "$ROOT_DIR/scripts/run-bench-fleet" | cut -d: -f1)"
[ -n "$pool_acquire_line" ] && [ "$pool_acquire_line" -lt "$pool_fail_closed_line" ] && \
  [ "$pool_fail_closed_line" -lt "$pool_conflict_skip_line" ] && \
  [ "$pool_conflict_skip_line" -lt "$fresh_clone_line" ] || \
  fail "pool lease failures must fail closed before conflict skipping or fresh cloning"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_machine_lease_acquire_retry "$APP" "$cid"' \
  "fresh clones must wait for Fly's bootstrap lease handoff"
lease_record_line="$(grep -n 'LEASED_PRIMARY_IDS+=("$cid")' "$ROOT_DIR/scripts/run-bench-fleet" | cut -d: -f1)"
leased_start_line="$(grep -n 'cloudbench_machine_start_with_lease "$APP" "$cid" "$primary_nonce"' "$ROOT_DIR/scripts/run-bench-fleet" | cut -d: -f1)"
[ -n "$lease_record_line" ] && [ "$lease_record_line" -lt "$leased_start_line" ] || \
  fail "fleet must record leased ownership before attempting to start a primary"
target_activation_line="$(grep -n 'cloudbench_activate_machine_environment_with_lease "$APP" "$cid" "$primary_nonce"' "$ROOT_DIR/scripts/run-bench-fleet" | cut -d: -f1)"
primary_lease_line="$(grep -n 'primary_nonce="$(cloudbench_machine_lease_acquire' "$ROOT_DIR/scripts/run-bench-fleet" | head -1 | cut -d: -f1)"
[ -n "$target_activation_line" ] && [ "$primary_lease_line" -lt "$target_activation_line" ] && \
  [ "$target_activation_line" -lt "$leased_start_line" ] || \
  fail "fleet must activate its claimed primary inside the lease before start"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_machine_stop_and_release_lease "$APP" "$cid" "$primary_nonce"' \
  "an ambiguous leased-start failure must stop before releasing ownership"
if grep -Fq 'reconciling authoritative pool machine' "$ROOT_DIR/scripts/run-bench-fleet"; then
  fail "fleet cleanup must not stop unowned shared pool Machines"
fi
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench_controller_acquire "$LOCK_DIR" "$APP"' \
  "single-machine controllers must use the shared cloud resource lock"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench_controller_parent_valid "$LOCK_DIR"' \
  "fleet child lock bypass must validate its controller owner token"
normal_acquire_line="$(grep -n 'cloudbench_controller_acquire "$LOCK_DIR" "$APP"' "$ROOT_DIR/scripts/run-bench-cloud" | tail -1 | cut -d: -f1)"
normal_ensure_line="$(grep -n '^ensure_app$' "$ROOT_DIR/scripts/run-bench-cloud" | tail -1 | cut -d: -f1)"
[ -n "$normal_acquire_line" ] && [ -n "$normal_ensure_line" ] && [ "$normal_acquire_line" -lt "$normal_ensure_line" ] || \
  fail "direct runs must acquire the cloud lease before ensure_app mutates the app"
cleanup_stop_line="$(grep -n 'stop_machine "$mid"' "$ROOT_DIR/scripts/run-bench-cloud" | tail -1 | cut -d: -f1)"
cleanup_release_line="$(grep -n 'cloudbench_controller_release "$LOCK_DIR" "$APP"' "$ROOT_DIR/scripts/run-bench-cloud" | tail -1 | cut -d: -f1)"
[ "$cleanup_stop_line" -lt "$cleanup_release_line" ] || \
  fail "direct cleanup must stop its machine before releasing the cloud lifecycle lease"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'required_lock_ttl=$((RUN_TIMEOUT + 3600))' \
  "direct-run lease TTL must include the configured run timeout and lifecycle margin"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'if [ "${CLOUDBENCH_PARENT_LOCK_HELD:-0}" = "1" ]; then' \
  "authenticated fleet helpers must preserve their parent lease ceiling"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench-prepare-patch.sh" /data/cloudbench-prepare-patch.sh' \
  "fleet children must receive patch preparation independently of the patch itself"
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'if [ "$BENCH_SIMULATE" != "1" ]; then' \
  "real cloud stacks must provision their external webhook tunnel dependency"
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  '"BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL=1"' \
  "real cloud stacks must use run-scoped random tunnel URLs"
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  '"BENCHMARK_SKIP_PUBLIC_TUNNEL=1"' \
  "simulated cloud stacks may explicitly skip the public tunnel"
skip_tunnel_line="$(grep -n '"BENCHMARK_SKIP_PUBLIC_TUNNEL=1"' "$ROOT_DIR/scripts/cloudbench-run.sh" | cut -d: -f1)"
simulate_branch_line="$(grep -n 'if \[ "$BENCH_SIMULATE" = "1" \]; then' "$ROOT_DIR/scripts/cloudbench-run.sh" | \
  cut -d: -f1 | awk -v skip="$skip_tunnel_line" '$1 < skip { line=$1 } END { print line }')"
[ -n "$simulate_branch_line" ] && [ "$simulate_branch_line" -lt "$skip_tunnel_line" ] || \
  fail "only the simulated cloud stack branch may skip its public tunnel"
require_text "$ROOT_DIR/scripts/run.sh" \
  'cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$FRONTEND_PORT"' \
  "ephemeral cloud tunnels must request independent random Quick Tunnel URLs"
require_text "$ROOT_DIR/scripts/run.sh" \
  'cloudflare_publish_reported_environment "$tunnel_log" "$ALLOWED_ORIGINS"' \
  "ephemeral tunnels must publish the provider-assigned URL to the services manifest"
require_text "$ROOT_DIR/scripts/run.sh" \
  'public_tunnel_provider_for_mode "${BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL:-0}"' \
  "run.sh must dispatch through the executable provider policy"
require_text "$ROOT_DIR/scripts/run.sh" \
  'public_tunnel_process_is_required "$name" "${BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL:-0}"' \
  "run.sh must enforce the executable required-process policy after startup"
require_text "$ROOT_DIR/scripts/run.sh" \
  'public_tunnel_publish_url_manifest "$services_manifest"' \
  "run.sh must persist the reported ephemeral URL into services.json"
require_text "$ROOT_DIR/Dockerfile.cloudbench-warm" \
  'cloudflared-linux-$(dpkg --print-architecture).deb' \
  "new warm images must bake the real-mode webhook tunnel agent"
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb' \
  "existing warm images must install the official architecture-specific tunnel package"
require_text "$HELPER_SRC" \
  'kill -TERM "$owner_pid"' \
  "a live controller must fail closed before its server-side lease can expire"

fake_bin="$TMP_ROOT/fake-bin"
fake_fly_calls="$TMP_ROOT/forged-bypass-fly-calls"
mkdir -p "$fake_bin"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$*" >> "$FAKE_FLY_CALLS"' 'printf "[]\\n"' > "$fake_bin/flyctl"
chmod +x "$fake_bin/flyctl"
: > "$fake_fly_calls"
if PATH="$fake_bin:$PATH" FLY_BENCH_API_TOKEN=test-token FAKE_FLY_CALLS="$fake_fly_calls" \
  CLOUDBENCH_CONTROLLER_TOKEN=forged \
  bash "$ROOT_DIR/scripts/run-bench-cloud" forged-task --no-lock --no-dashboard \
    > "$TMP_ROOT/forged-bypass.log" 2>&1; then
  fail "a forged --no-lock invocation must fail closed"
fi
require_text "$TMP_ROOT/forged-bypass.log" \
  '--no-lock requires a valid, live fleet controller owner token' \
  "the actual runner must reject forged lock bypass before app access"
[ ! -s "$fake_fly_calls" ] || fail "forged lock bypass must be rejected before any Fly mutation or read"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'FLY secrets set --stage -a "$APP"' \
  "Machines API apps must stage the app-level environment before machine updates"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'transient Fly update failure; retrying machine $machine_id' \
  "machine environment activation must retry transient Fly API failures"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'FLY machine update "$machine_id" -a "$APP" --skip-start --yes' \
  "every owned benchmark machine must activate staged secrets without starting"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'activation_targets="$(environment_activation_targets)"' \
  "environment activation must be scoped to the owned warm source and pool"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'activate_machine_environment "$machine_id" "$role"' \
  "environment activation must preserve role-specific concurrency checks"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_wait_machine_startable fleet_machine_state "$cid"' \
  "fleet children must not launch while a fresh clone is still in created state"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'wait_seconds="${CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS:-1800}"' \
  "fleet environment refreshes must allow legitimate long-running setup owners"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'wait_seconds="${CLOUDBENCH_APP_ENV_LOCK_WAIT_SECONDS:-1800}"' \
  "direct environment refreshes must allow legitimate long-running setup owners"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'Timed out after ${wait_seconds}s waiting for shared benchmark app environment lock.' \
  "fleet environment lock waits must remain bounded and observable"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'Timed out after ${wait_seconds}s waiting for shared benchmark app environment lock.' \
  "direct environment lock waits must remain bounded and observable"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'st="$(fleet_machine_state "$id")"' \
  "pool readiness must use the exact JSON machine state reader"
if grep -Fq 'machine status "$id" -a "$APP" 2>/dev/null | grep -qiE' "$ROOT_DIR/scripts/run-bench-fleet"; then
  fail "pool readiness must not use a grep -q pipeline that fails under pipefail/SIGPIPE"
fi
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'touch "$POOL_IDS_FILE"' \
  "pool provisioning must preserve and reconcile its ownership ledger"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'retiring orphaned volume bindings for missing pool machine $id' \
  "pool reconciliation must retire exact bound volumes when a tracked Machine disappears"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'fleet_orphan_volume_safe_for_missing_machine "$volume_id"' \
  "missing-Machine cleanup must reject recorded volumes still attached elsewhere"
require_text "$ROOT_DIR/scripts/test.sh" \
  'agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py' \
  "the normal repository test gate must execute behavioral cloud lifecycle regressions"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'provenance belongs to a stale warm image/snapshot generation' \
  "preserved pool capacity must fail closed across warm snapshot generations"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'validate_tracked_pool_provenance || exit 1' \
  "normal fleet startup must validate provenance before consuming pool capacity"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'pool_machine_provenance_valid "$id" || return 2' \
  "every pool claim must fail closed if provenance changes after startup validation"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'live image does not match its recorded immutable image' \
  "preserved pool capacity must verify its live immutable image"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  '"$id" "$WARM_ID" "$SNAP_ID" "$WARM_IMAGE_IDENTITY" "$volume_csv"' \
  "new pool machines must persist exact creation and volume provenance before ownership promotion"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  '"cloudbench-pool-provision run=$RUN_ID"' \
  "pool provisioning must acquire a task-scoped platform Machine lease"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'cloudbench_machine_stop_and_release_lease "$APP" "$id" "$nonce"' \
  "pool provisioning must stop non-idle machines before releasing their leases"
if sed -n '/^provision_pool()/,/^}/p' "$ROOT_DIR/scripts/run-bench-fleet" \
  | grep -Fq 'FLY machine stop "$id" -a "$APP"'; then
  fail "pool provisioning must not stop a tracked machine outside its platform lease"
fi
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'pool target unmet: need $n ready machines, verified $ready_count' \
  "pool provisioning must fail closed unless its requested ready capacity is verified"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'exit "$provision_status"' \
  "the pool provisioning mode must propagate readiness failures to its caller"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  '--name "$target_name"' \
  "fresh fleet clones must use an exact unique name for id resolution"
if grep -Fq -- 'FLY secrets deploy' "$ROOT_DIR/scripts/run-bench-cloud"; then
  fail "Machines API apps must not use Fly Launch secrets deploy"
fi
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'cloudbench_verify_env_file' \
  "primary benchmark machines must verify decoded env digests"
require_text "$ROOT_DIR/scripts/run.sh" \
  'BLACKBOX_TEST_REPLAY_OUTBOUND="${BLACKBOX_TEST_REPLAY_OUTBOUND:-0}"' \
  "real benchmark backends must capture mutable provider calls without replaying them"
require_text "$ROOT_DIR/back-end/scripts/run-blackbox-tests.sh" \
  'BLACKBOX_TEST_REPLAY_OUTBOUND=1' \
  "isolated blackbox runs must opt into outbound fixture replay explicitly"
require_text "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  'cloudbench_verify_env_file' \
  "autoscaled benchmark workers must refresh and verify their env files"
require_text "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  'umask 077' \
  "decoded benchmark secrets must be owner-only from file creation"
require_text "$ROOT_DIR/scripts/cloudbench-sync-deps.sh" \
  'cloudbench_node_dependency_fingerprint' \
  "cloud dependency sync must ignore package scripts while binding dependency fields"
if grep -Fq -- 'eval "exec ${CLOUDBENCH_CONTROLLER_LOCK_FD}' "$HELPER_SRC"; then
  fail "controller lock fd cleanup must not use eval"
fi
require_text "$HELPER_SRC" \
  'exec {CLOUDBENCH_CONTROLLER_LOCK_FD}<> "$path"' \
  "flock fallback must open without truncating the current owner"

attempt_file="$TMP_ROOT/machine-update-attempts"
argv_file="$TMP_ROOT/machine-update-argv"
printf '0\n' > "$attempt_file"
: > "$argv_file"
FLY() {
  local count
  printf '%s\n' "$*" >> "$argv_file"
  count="$(cat "$attempt_file")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$attempt_file"
  if [ "$count" -lt 3 ]; then
    echo "Error: request returned non-2xx status: 408"
    return 1
  fi
  echo "machine updated"
}
CLOUDBENCH_MACHINE_UPDATE_ATTEMPTS=3 \
  CLOUDBENCH_MACHINE_UPDATE_RETRY_DELAY=0 \
  cloudbench_activate_machine_environment machine-1 bench-app >/dev/null
[ "$(cat "$attempt_file")" -eq 3 ] || fail "transient machine updates must be retried"
expected_argv='machine update machine-1 -a bench-app --skip-start --yes'
[ "$(wc -l < "$argv_file" | tr -d ' ')" -eq 3 ] || fail "every retry must execute flyctl"
while IFS= read -r argv; do
  [ "$argv" = "$expected_argv" ] || fail "machine update must preserve its safety-critical argv"
done < "$argv_file"

printf '0\n' > "$attempt_file"
FLY() {
  local count
  count="$(cat "$attempt_file")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$attempt_file"
  echo "permanent update failure"
  return 1
}
if (set +o pipefail
  CLOUDBENCH_MACHINE_UPDATE_ATTEMPTS=3 \
    CLOUDBENCH_MACHINE_UPDATE_RETRY_DELAY=0 \
    cloudbench_activate_machine_environment machine-1 bench-app >/dev/null 2>&1
); then
  fail "exhausted machine updates must fail closed"
fi
[ "$(cat "$attempt_file")" -eq 3 ] || fail "machine update retries must be bounded"

echo "All cloud benchmark environment checks passed."
