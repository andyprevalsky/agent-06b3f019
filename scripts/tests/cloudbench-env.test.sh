#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER_SRC="$ROOT_DIR/scripts/lib/cloudbench-env.sh"
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
# shellcheck source=scripts/lib/cloudbench-env.sh
source "$HELPER_SRC"

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

lock_file="$TMP_ROOT/controller.lock"
cloudbench_controller_lock_acquire "$lock_file"
if bash -c 'source "$1"; cloudbench_controller_lock_acquire "$2"' _ "$HELPER_SRC" "$lock_file"; then
  fail "a second controller must not acquire an owned lock"
fi
cloudbench_controller_lock_release "$lock_file"
[ ! -e "$lock_file" ] || fail "controller lock must be removed by its owner"

activation_ids="$(printf '%s\n' '[{"id":"warm-1","name":"cloudbench-warm","state":"stopped"},{"id":"lock-1","name":"cloudbench-controller-lock","state":"stopped"},{"id":"clone-1","name":"fleet-1","state":"stopped"},{"id":"provisioning-1","name":"other-controller-clone","state":"created"},{"id":"running-1","name":"other-controller-run","state":"started"}]' | cloudbench_env_activation_machine_ids)"
[ "$activation_ids" = $'warm-1\nclone-1' ] ||
  fail "environment activation must target only stopped non-lock benchmark machines"

shared_lock="$(cloudbench_controller_lock_path "$ROOT_DIR" navi-whisper-lux-bench)"
git_common_dir="$(git -C "$ROOT_DIR" rev-parse --git-common-dir)"
case "$git_common_dir" in
  /*) ;;
  *) git_common_dir="$ROOT_DIR/$git_common_dir" ;;
esac
git_common_dir="$(cd "$git_common_dir" && pwd -P)"
[ "$shared_lock" = "$git_common_dir/cloudbench-controller-navi-whisper-lux-bench.lock" ] ||
  fail "controller lock must live in the repo-common git directory across worktrees"

for lifecycle_mode in setup refresh-wmh refresh-secrets destroy; do
  cloudbench_controller_mode_needs_lock "$lifecycle_mode" 0 ||
    fail "$lifecycle_mode must acquire the shared controller lock"
done
if cloudbench_controller_mode_needs_lock run 0; then
  fail "the normal run path must use its dedicated run-lock section"
fi
if cloudbench_controller_mode_needs_lock destroy 1; then
  fail "a fleet child must not reacquire its parent controller lock"
fi

no_lock_error="$TMP_ROOT/no-lock.error"
if bash "$ROOT_DIR/scripts/run-bench-cloud" test-task --no-lock > /dev/null 2> "$no_lock_error"; then
  fail "a direct top-level run must not bypass controller ownership with --no-lock"
fi
grep -Fq -- '--no-lock is valid only for a fleet child pinned with --machine' "$no_lock_error" ||
  fail "a rejected top-level --no-lock run must explain the fleet-child contract"

require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'bash scripts/run-bench-cloud --refresh-secrets' \
  "fleet controller must refresh the environment once before cloning"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_PARENT_LOCK_HELD=1' \
  "fleet environment refresh must declare the controller lock it already owns"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  'CLOUDBENCH_ENV_REFRESHED=1' \
  "fleet children must receive proof that the controller refreshed the environment"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  "FLY secrets set --stage -a \"\$APP\"" \
  "Machines API apps must stage the app-level environment before machine updates"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  "FLY machine update \"\$machine_id\" -a \"\$APP\" --skip-start --yes" \
  "eligible stopped benchmark machines must activate staged secrets without starting"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  'cloudbench_env_activation_machine_ids' \
  "secret activation must exclude machines owned by another controller"
require_text "$ROOT_DIR/scripts/run-bench-cloud" \
  "cloudbench_controller_lock_path \"\$ROOT_DIR\" \"\$APP\"" \
  "direct cloud runs must resolve the shared controller lock"
require_text "$ROOT_DIR/scripts/run-bench-fleet" \
  "cloudbench_controller_lock_path \"\$ROOT_DIR\" \"\$APP\"" \
  "fleet runs must use the shared controller lock"
if ! python3 - "$ROOT_DIR/scripts/run-bench-cloud" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
body = source.split("stop_on_exit() {", 1)[1].split("\n}", 1)[0]
raise SystemExit(0 if body.index('stop_machine "$mid"') < body.index("cleanup_controller_lock") else 1)
PY
then
  fail "default-run cleanup must stop its machine before releasing controller ownership"
fi
if ! python3 - "$ROOT_DIR/scripts/run-bench-cloud" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
body = source.split('if [ "$MODE" = "destroy" ]; then', 1)[1].split("\nfi", 1)[0]
raise SystemExit(0 if body.index('FLY volumes destroy "$vid"') < body.index("cloudbench_cloud_lock_machine_destroy") else 1)
PY
then
  fail "destroy mode must retain its leased sentinel until all shared resources are gone"
fi
if grep -Fq -- 'FLY secrets deploy' "$ROOT_DIR/scripts/run-bench-cloud"; then
  fail "Machines API apps must not use Fly Launch secrets deploy"
fi
require_text "$ROOT_DIR/scripts/cloudbench-run.sh" \
  'cloudbench_verify_env_file' \
  "primary benchmark machines must verify decoded env digests"
require_text "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  'cloudbench_verify_env_file' \
  "autoscaled benchmark workers must refresh and verify their env files"
require_text "$ROOT_DIR/scripts/cloudbench-worker.sh" \
  'umask 077' \
  "decoded benchmark secrets must be owner-only from file creation"
if grep -Fq -- "eval \"exec \${CLOUDBENCH_CONTROLLER_LOCK_FD}" "$HELPER_SRC"; then
  fail "controller lock fd cleanup must not use eval"
fi
require_text "$HELPER_SRC" \
  "exec {CLOUDBENCH_CONTROLLER_LOCK_FD}<> \"\$path\"" \
  "flock fallback must open without truncating the current owner"

cloudbench_cloud_lock_machine_ensure() {
  printf '%s\n' lock-machine-1
}
curl() {
  if [ "$MOCK_FLY_LEASE_STATUS" = "409" ]; then
    printf '%s\n%s' '{"error":"lease held by another controller"}' 409
  else
    printf '%s\n%s' "{\"status\":\"success\",\"data\":{\"nonce\":\"nonce-1\",\"expires_at\":$(( $(date +%s) + 300 ))}}" 201
  fi
}
FLY_API_TOKEN="test-token"
export FLY_API_TOKEN MOCK_FLY_LEASE_STATUS
distributed_lock="$TMP_ROOT/distributed-controller.lock"
MOCK_FLY_LEASE_STATUS="409"
if cloudbench_controller_acquire "$distributed_lock" test-app iad 300 >/dev/null 2>&1; then
  fail "a live remote controller lease must block before shared app mutation"
else
  lease_rc=$?
fi
[ "$lease_rc" -eq 75 ] || fail "a remote controller conflict must retain its distinct failure code"
[ ! -e "$distributed_lock" ] || fail "a rejected remote lease must release its local lock"

MOCK_FLY_LEASE_STATUS="201"
cloudbench_controller_acquire "$distributed_lock" test-app iad 300
[ "$CLOUDBENCH_CLOUD_LOCK_MACHINE_ID" = "lock-machine-1" ] ||
  fail "a successful remote lease must retain its sentinel identity"
[ "$CLOUDBENCH_CLOUD_LOCK_NONCE" = "nonce-1" ] ||
  fail "a successful remote lease must retain its release nonce"
cloudbench_controller_release "$distributed_lock" test-app
[ ! -e "$distributed_lock" ] || fail "controller release must clear its local lock"
unset -f curl cloudbench_cloud_lock_machine_ensure
unset FLY_API_TOKEN MOCK_FLY_LEASE_STATUS

echo "All cloud benchmark environment checks passed."
