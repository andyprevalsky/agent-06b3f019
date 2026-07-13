#!/usr/bin/env bash

# Shared fail-closed helpers for the cloud benchmark environment handoff.
# This file is sourced by both the macOS controller and Linux benchmark VMs.

cloudbench_env_value() {
  local path="$1" key="$2"
  python3 - "$path" "$key" <<'PY'
from pathlib import Path
import sys

path, wanted = sys.argv[1:3]
for raw in Path(path).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() != wanted:
        continue
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    print(value)
    break
PY
}

cloudbench_env_sha256() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

cloudbench_verify_env_file() {
  local path="$1" expected="$2" label="$3" actual
  [ -n "$expected" ] || {
    echo "FATAL: $label env digest is missing from the controller handoff" >&2
    return 1
  }
  actual="$(cloudbench_env_sha256 "$path")"
  if [ "$actual" != "$expected" ]; then
    echo "FATAL: $label env digest mismatch: expected=${expected:0:12} actual=${actual:0:12}" >&2
    return 1
  fi
  echo "$label env digest verified: ${actual:0:12}"
}

cloudbench_validate_browser_provider_contract() {
  local agents_env="$1" backend_env="$2" prod_backend="$3" prod_worker="$4"
  local agents_provider backend_provider
  agents_provider="$(cloudbench_env_value "$agents_env" BROWSER_PROVIDER)"
  backend_provider="$(cloudbench_env_value "$backend_env" BROWSER_PROVIDER)"

  case "$prod_backend" in kernel|steel) ;; *)
    echo "FATAL: production backend BROWSER_PROVIDER is invalid: ${prod_backend:-<unset>}" >&2
    return 1
  esac
  case "$prod_worker" in kernel|steel) ;; *)
    echo "FATAL: production worker BROWSER_PROVIDER is invalid: ${prod_worker:-<unset>}" >&2
    return 1
  esac
  if [ "$prod_backend" != "$prod_worker" ]; then
    echo "FATAL: production browser provider drift: backend=$prod_backend worker=$prod_worker" >&2
    return 1
  fi
  if [ "$backend_provider" != "$prod_backend" ]; then
    echo "FATAL: benchmark backend env does not match production: local=${backend_provider:-<unset>} prod=$prod_backend" >&2
    return 1
  fi
  if [ "$agents_provider" != "$prod_worker" ]; then
    echo "FATAL: benchmark worker env does not match production: local=${agents_provider:-<unset>} prod=$prod_worker" >&2
    return 1
  fi
  echo "browser provider contract verified: backend=$prod_backend worker=$prod_worker"
}

cloudbench_retry_command() {
  local max_attempts="$1" retry_delay_seconds="$2"
  shift 2

  local attempt=1 status
  while true; do
    if "$@"; then
      return 0
    else
      status=$?
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      return "$status"
    fi

    echo "Transient command failure (attempt $attempt/$max_attempts, exit=$status); retrying in ${retry_delay_seconds}s..." >&2
    sleep "$retry_delay_seconds"
    attempt=$((attempt + 1))
  done
}

cloudbench_wait_machine_startable() {
  local state_reader="$1" machine_id="$2" max_attempts="$3" retry_delay_seconds="$4"
  local attempt state

  for attempt in $(seq 1 "$max_attempts"); do
    state="$($state_reader "$machine_id" 2>/dev/null || true)"
    case "$state" in
      started|stopped) return 0 ;;
      destroyed|destroying)
        echo "Machine $machine_id became unavailable while provisioning (state=$state)" >&2
        return 1
        ;;
    esac
    [ "$attempt" -ge "$max_attempts" ] || sleep "$retry_delay_seconds"
  done

  echo "Machine $machine_id did not become startable (last_state=${state:-unknown})" >&2
  return 1
}

cloudbench_validate_fresh_clone_id() {
  local candidate="$1" source_id="$2"
  shift 2

  [ -n "$candidate" ] || return 1
  [ "$candidate" != "$source_id" ] || return 1
  local used_id
  for used_id in "$@"; do
    [ "$candidate" != "$used_id" ] || return 1
  done
}

cloudbench_env_activation_machine_ids() {
  local controller_lock_name="${1:-cloudbench-controller-lock}"
  CONTROLLER_LOCK_NAME="$controller_lock_name" python3 -c '
import json, os, sys
for machine in json.load(sys.stdin) or []:
    if machine.get("name") == os.environ["CONTROLLER_LOCK_NAME"]:
        continue
    if machine.get("state") != "stopped":
        continue
    if machine.get("id"):
        print(machine["id"])
'
}

cloudbench_node_dependency_fingerprint() {
  local root="$1"
  python3 - "$root" <<'PY'
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
digest = hashlib.sha256()
dependency_fields = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bundledDependencies",
    "bundleDependencies",
    "overrides",
    "workspaces",
)

# The workspace-root package-lock.json is intentionally gitignored and is
# regenerated by `npm install`, so it is not a stable input shared by the image
# build and a Git checkout on the persistent volume. The backend lockfile is
# tracked and therefore safe to bind exactly.
lock_path = root / "back-end/package-lock.json"
if not lock_path.is_file():
    raise SystemExit(f"missing dependency manifest: {lock_path}")
digest.update(b"back-end/package-lock.json\0")
digest.update(lock_path.read_bytes())
digest.update(b"\0")

for relative in ("package.json", "back-end/package.json", "front-end/package.json"):
    path = root / relative
    if not path.is_file():
        raise SystemExit(f"missing dependency manifest: {path}")
    package = json.loads(path.read_text())
    dependency_config = {
        field: package[field]
        for field in dependency_fields
        if field in package
    }
    digest.update(relative.encode())
    digest.update(b"\0")
    digest.update(json.dumps(dependency_config, sort_keys=True, separators=(",", ":")).encode())
    digest.update(b"\0")

print(digest.hexdigest())
PY
}

cloudbench_controller_lock_acquire() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  if command -v shlock >/dev/null 2>&1; then
    shlock -p "$$" -f "$path" || return 1
    CLOUDBENCH_CONTROLLER_LOCK_KIND="shlock"
  elif command -v flock >/dev/null 2>&1; then
    exec {CLOUDBENCH_CONTROLLER_LOCK_FD}<> "$path"
    if ! flock -n "$CLOUDBENCH_CONTROLLER_LOCK_FD"; then
      exec {CLOUDBENCH_CONTROLLER_LOCK_FD}>&-
      unset CLOUDBENCH_CONTROLLER_LOCK_FD
      return 1
    fi
    printf '%s\n' "$$" > "$path"
    CLOUDBENCH_CONTROLLER_LOCK_KIND="flock"
  else
    echo "FATAL: shlock or flock is required for the cloud benchmark controller lock" >&2
    return 1
  fi
  CLOUDBENCH_CONTROLLER_LOCK_PATH="$path"
}

cloudbench_controller_lock_release() {
  local path="${1:-${CLOUDBENCH_CONTROLLER_LOCK_PATH:-}}" owner
  [ -n "$path" ] || return 0
  owner="$(cat "$path" 2>/dev/null || true)"
  [ "$owner" = "$$" ] || return 0
  if [ "${CLOUDBENCH_CONTROLLER_LOCK_KIND:-}" = "flock" ] && \
     [ -n "${CLOUDBENCH_CONTROLLER_LOCK_FD:-}" ]; then
    flock -u "$CLOUDBENCH_CONTROLLER_LOCK_FD" 2>/dev/null || true
    exec {CLOUDBENCH_CONTROLLER_LOCK_FD}>&-
    unset CLOUDBENCH_CONTROLLER_LOCK_FD
  fi
  rm -f "$path"
  unset CLOUDBENCH_CONTROLLER_LOCK_KIND CLOUDBENCH_CONTROLLER_LOCK_PATH
}

cloudbench_random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

cloudbench_machines_api_request() {
  local method="$1" path="$2" body="${3:-}" nonce="${4:-}" response
  local api_host="${FLY_API_HOSTNAME:-https://api.machines.dev}"
  local api_token="${CLOUDBENCH_MACHINES_API_TOKEN:-${FLY_API_TOKEN:-}}"
  [ -n "$api_token" ] || { echo "FATAL: Machines API token is required" >&2; return 1; }
  local -a args=(
    -sS -X "$method"
    -H "Authorization: Bearer $api_token"
    -H "Content-Type: application/json"
  )
  [ -n "$nonce" ] && args+=(-H "fly-machine-lease-nonce: $nonce")
  [ -n "$body" ] && args+=(-d "$body")
  if ! response="$(curl "${args[@]}" -w $'\n%{http_code}' "$api_host$path")"; then
    CLOUDBENCH_API_STATUS=0
    CLOUDBENCH_API_BODY="$response"
    return 1
  fi
  CLOUDBENCH_API_STATUS="${response##*$'\n'}"
  CLOUDBENCH_API_BODY="${response%$'\n'*}"
}

cloudbench_machines_api_token_ensure() {
  local app="$1" lease_ttl="${CLOUDBENCH_CLOUD_LOCK_TTL:-7200}" token_json token_expiry token_name
  [ -n "${CLOUDBENCH_MACHINES_API_TOKEN:-}" ] && return 0
  token_expiry=$((lease_ttl + 600))
  token_name="cloudbench-controller-$$-$(cloudbench_random_token | cut -c1-8)"
  token_json="$(flyctl tokens create deploy -a "$app" -x "${token_expiry}s" -n "$token_name" --json 2>/dev/null)" || return 1
  CLOUDBENCH_MACHINES_API_TOKEN="$(printf '%s' "$token_json" | jq -r '.token // empty' 2>/dev/null)"
  [ -n "$CLOUDBENCH_MACHINES_API_TOKEN" ] || return 1
}

cloudbench_cloud_lock_machine_name() {
  printf '%s\n' "${CLOUDBENCH_CLOUD_LOCK_MACHINE_NAME:-cloudbench-controller-lock}"
}

cloudbench_cloud_lock_machine_id() {
  local app="$1" machine_name
  machine_name="$(cloudbench_cloud_lock_machine_name)"
  cloudbench_machines_api_request GET "/v1/apps/$app/machines" || return 1
  [ "$CLOUDBENCH_API_STATUS" = "200" ] || return 1
  printf '%s' "$CLOUDBENCH_API_BODY" | jq -r --arg name "$machine_name" \
    '.[] | select(.name == $name) | .id' | head -1
}

cloudbench_cloud_lock_acquire() {
  local app="$1" machine_id body nonce description ttl expires_at now watchdog_delay owner_pid
  machine_id="$(cloudbench_cloud_lock_machine_id "$app" || true)"
  if [ -z "$machine_id" ]; then
    echo "FATAL: cloud benchmark controller sentinel is missing; run run-bench-cloud --setup" >&2
    return 1
  fi
  ttl="${CLOUDBENCH_CLOUD_LOCK_TTL:-7200}"
  case "$ttl" in ''|*[!0-9]*|0) echo "FATAL: invalid cloud lock TTL" >&2; return 2 ;; esac
  description="cloudbench-controller pid=$$ host=$(hostname 2>/dev/null || echo unknown)"
  body="$(jq -cn --arg description "$description" --argjson ttl "$ttl" '{description:$description, ttl:$ttl}')"
  cloudbench_machines_api_request POST "/v1/apps/$app/machines/$machine_id/lease" "$body" || return 1
  if [ "$CLOUDBENCH_API_STATUS" != "201" ]; then
    echo "FATAL: cloud benchmark app is already leased by another controller (HTTP $CLOUDBENCH_API_STATUS)" >&2
    return 1
  fi
  nonce="$(printf '%s' "$CLOUDBENCH_API_BODY" | jq -r '.data.nonce // .nonce // empty' 2>/dev/null)"
  [ -n "$nonce" ] || { echo "FATAL: Fly lease response omitted its nonce" >&2; return 1; }
  CLOUDBENCH_CLOUD_LOCK_MACHINE_ID="$machine_id"
  CLOUDBENCH_CLOUD_LOCK_NONCE="$nonce"
  expires_at="$(printf '%s' "$CLOUDBENCH_API_BODY" | jq -r '.data.expires_at // .expires_at // empty' 2>/dev/null)"
  now="$(date +%s)"
  case "$expires_at" in ''|*[!0-9]*) expires_at=$((now + ttl)) ;; esac
  watchdog_delay=$((expires_at - now - 60))
  if [ "$watchdog_delay" -le 0 ]; then
    echo "FATAL: Fly granted a controller lease with less than 60 seconds of safety margin" >&2
    cloudbench_cloud_lock_release "$app"
    return 1
  fi
  owner_pid="$$"
  (
    while [ "$watchdog_delay" -gt 30 ]; do
      sleep 30
      [ "$PPID" = "$owner_pid" ] || exit 0
      watchdog_delay=$((watchdog_delay - 30))
    done
    sleep "$watchdog_delay"
    [ "$PPID" = "$owner_pid" ] || exit 0
    kill -TERM "$owner_pid" 2>/dev/null || true
  ) &
  CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID="$!"
  CLOUDBENCH_CLOUD_LOCK_EXPIRES_AT="$expires_at"
  export CLOUDBENCH_CLOUD_LOCK_MACHINE_ID CLOUDBENCH_CLOUD_LOCK_NONCE \
    CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID CLOUDBENCH_CLOUD_LOCK_EXPIRES_AT
}

cloudbench_cloud_lock_release() {
  local app="$1" machine_id="${CLOUDBENCH_CLOUD_LOCK_MACHINE_ID:-}" nonce="${CLOUDBENCH_CLOUD_LOCK_NONCE:-}"
  if [ -n "${CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID:-}" ]; then
    kill "$CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID" 2>/dev/null || true
    wait "$CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID" 2>/dev/null || true
  fi
  [ -n "$machine_id" ] && [ -n "$nonce" ] || return 0
  cloudbench_machines_api_request DELETE "/v1/apps/$app/machines/$machine_id/lease" "" "$nonce" >/dev/null 2>&1 || true
  unset CLOUDBENCH_CLOUD_LOCK_MACHINE_ID CLOUDBENCH_CLOUD_LOCK_NONCE \
    CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID CLOUDBENCH_CLOUD_LOCK_EXPIRES_AT \
    CLOUDBENCH_MACHINES_API_TOKEN
}

cloudbench_controller_acquire() {
  local path="$1" app="$2"
  cloudbench_controller_lock_acquire "$path" || return 1
  if ! cloudbench_machines_api_token_ensure "$app"; then
    cloudbench_controller_lock_release "$path"
    return 1
  fi
  if ! cloudbench_cloud_lock_acquire "$app"; then
    cloudbench_controller_lock_release "$path"
    return 1
  fi
}

cloudbench_controller_release() {
  local path="$1" app="$2"
  cloudbench_cloud_lock_release "$app"
  cloudbench_controller_lock_release "$path"
}
