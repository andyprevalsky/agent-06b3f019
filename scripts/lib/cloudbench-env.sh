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

cloudbench_controller_lock_path() {
  local root_dir="$1" resource_name="$2" common_dir safe_resource
  common_dir="$(git -C "$root_dir" rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$common_dir" ]; then
    case "$common_dir" in
      /*) ;;
      *) common_dir="$root_dir/$common_dir" ;;
    esac
    common_dir="$(cd "$common_dir" 2>/dev/null && pwd -P)" || common_dir=""
  fi
  [ -n "$common_dir" ] || common_dir="$root_dir/.context"
  safe_resource="$(printf '%s' "$resource_name" | tr -c 'A-Za-z0-9._-' '-')"
  printf '%s/cloudbench-controller-%s.lock\n' "$common_dir" "$safe_resource"
}

cloudbench_controller_mode_needs_lock() {
  local mode="$1" parent_lock_held="${2:-0}"
  [ "$parent_lock_held" != "1" ] || return 1
  [ "$mode" != "run" ]
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

cloudbench_machines_api_request() {
  local method="$1" path="$2" body="${3:-}" nonce="${4:-}" response
  local api_host="${FLY_API_HOSTNAME:-https://api.machines.dev}"
  local api_token="${CLOUDBENCH_MACHINES_API_TOKEN:-${FLY_API_TOKEN:-}}"
  [ -n "$api_token" ] || {
    echo "FATAL: Machines API token is required" >&2
    return 1
  }
  local -a args=(
    -sS --connect-timeout 5 --max-time 30 -X "$method"
    -H "Authorization: Bearer $api_token"
    -H "Content-Type: application/json"
  )
  [ -n "$nonce" ] && args+=(-H "fly-machine-lease-nonce: $nonce")
  [ -n "$body" ] && args+=(-d "$body")
  if ! response="$(curl "${args[@]}" -w $'\n%{http_code}' "$api_host$path")"; then
    CLOUDBENCH_API_STATUS="0"
    CLOUDBENCH_API_BODY="$response"
    return 1
  fi
  CLOUDBENCH_API_STATUS="${response##*$'\n'}"
  CLOUDBENCH_API_BODY="${response%$'\n'*}"
}

cloudbench_cloud_lock_machine_name() {
  printf '%s\n' "${CLOUDBENCH_CLOUD_LOCK_MACHINE_NAME:-cloudbench-controller-lock}"
}

cloudbench_cloud_lock_machine_id() {
  local app="$1" machine_name
  machine_name="$(cloudbench_cloud_lock_machine_name)"
  cloudbench_machines_api_request GET "/v1/apps/$app/machines" || return 1
  [ "$CLOUDBENCH_API_STATUS" = "200" ] || return 1
  printf '%s' "$CLOUDBENCH_API_BODY" | CONTROLLER_LOCK_NAME="$machine_name" python3 -c '
import json, os, sys
for machine in json.load(sys.stdin) or []:
    if machine.get("name") == os.environ["CONTROLLER_LOCK_NAME"] and machine.get("id"):
        print(machine["id"])
        break
'
}

cloudbench_cloud_lock_machine_ensure() {
  local app="$1" region="$2" machine_name machine_id body
  machine_name="$(cloudbench_cloud_lock_machine_name)"
  machine_id="$(cloudbench_cloud_lock_machine_id "$app" || true)"
  [ -n "$machine_id" ] && {
    printf '%s\n' "$machine_id"
    return 0
  }
  body="$(python3 - "$machine_name" "$region" <<'PY'
import json, sys
name, region = sys.argv[1:]
print(json.dumps({
    "name": name,
    "region": region,
    "config": {
        "image": "flyio/hellofly:latest",
        "auto_destroy": False,
        "restart": {"policy": "no"},
        "guest": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 256},
    },
    "skip_launch": True,
}, separators=(",", ":")))
PY
)"
  cloudbench_machines_api_request POST "/v1/apps/$app/machines" "$body" || return 1
  case "$CLOUDBENCH_API_STATUS" in 200|201|409) ;; *) return 1 ;; esac
  machine_id="$(printf '%s' "$CLOUDBENCH_API_BODY" | python3 -c '
import json, sys
try:
    print((json.load(sys.stdin) or {}).get("id") or "")
except Exception:
    print("")
' 2>/dev/null)"
  [ -n "$machine_id" ] || machine_id="$(cloudbench_cloud_lock_machine_id "$app" || true)"
  [ -n "$machine_id" ] || return 1
  printf '%s\n' "$machine_id"
}

cloudbench_cloud_lock_acquire() {
  local app="$1" region="$2" ttl="$3" machine_id description body nonce expires_at now watchdog_delay owner_pid
  case "$ttl" in
    ''|*[!0-9]*|0) echo "FATAL: cloud controller lease TTL must be a positive integer" >&2; return 2 ;;
  esac
  machine_id="$(cloudbench_cloud_lock_machine_ensure "$app" "$region")" || {
    echo "FATAL: could not create or resolve the cloud controller sentinel" >&2
    return 1
  }
  description="cloudbench pid=$$ host=$(hostname 2>/dev/null || echo unknown)"
  body="$(python3 - "$description" "$ttl" <<'PY'
import json, sys
print(json.dumps({"description": sys.argv[1][:64], "ttl": int(sys.argv[2])}, separators=(",", ":")))
PY
)"
  cloudbench_machines_api_request POST "/v1/apps/$app/machines/$machine_id/lease" "$body" || return 1
  if [ "$CLOUDBENCH_API_STATUS" = "409" ]; then
    echo "FATAL: cloud benchmark app is owned by another controller (Fly lease conflict)" >&2
    return 75
  fi
  [ "$CLOUDBENCH_API_STATUS" = "201" ] || {
    echo "FATAL: cloud controller lease acquisition failed (HTTP $CLOUDBENCH_API_STATUS)" >&2
    return 1
  }
  nonce="$(printf '%s' "$CLOUDBENCH_API_BODY" | python3 -c '
import json, sys
data = json.load(sys.stdin) or {}
print((data.get("data") or data).get("nonce") or "")
')"
  [ -n "$nonce" ] || {
    echo "FATAL: Fly lease response omitted its nonce" >&2
    return 1
  }
  expires_at="$(printf '%s' "$CLOUDBENCH_API_BODY" | python3 -c '
import json, sys
data = json.load(sys.stdin) or {}
print((data.get("data") or data).get("expires_at") or "")
')"
  now="$(date +%s)"
  case "$expires_at" in ''|*[!0-9]*) expires_at=$((now + ttl)) ;; esac
  watchdog_delay=$((expires_at - now - 60))
  if [ "$watchdog_delay" -le 0 ]; then
    echo "FATAL: Fly granted a controller lease without a 60-second safety margin" >&2
    cloudbench_machines_api_request DELETE "/v1/apps/$app/machines/$machine_id/lease" "" "$nonce" >/dev/null 2>&1 || true
    return 1
  fi
  CLOUDBENCH_CLOUD_LOCK_MACHINE_ID="$machine_id"
  CLOUDBENCH_CLOUD_LOCK_NONCE="$nonce"
  owner_pid="$$"
  (
    sleep "$watchdog_delay"
    [ "$PPID" = "$owner_pid" ] || exit 0
    kill -TERM "$owner_pid" 2>/dev/null || true
  ) &
  CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID="$!"
}

cloudbench_cloud_lock_release() {
  local app="$1" machine_id="${CLOUDBENCH_CLOUD_LOCK_MACHINE_ID:-}" nonce="${CLOUDBENCH_CLOUD_LOCK_NONCE:-}"
  if [ -n "${CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID:-}" ]; then
    kill "$CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID" 2>/dev/null || true
    wait "$CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID" 2>/dev/null || true
  fi
  if [ -n "$machine_id" ] && [ -n "$nonce" ]; then
    cloudbench_machines_api_request DELETE "/v1/apps/$app/machines/$machine_id/lease" "" "$nonce" >/dev/null 2>&1 || true
  fi
  unset CLOUDBENCH_CLOUD_LOCK_MACHINE_ID CLOUDBENCH_CLOUD_LOCK_NONCE CLOUDBENCH_CLOUD_LOCK_WATCHDOG_PID
}

cloudbench_cloud_lock_machine_destroy() {
  local app="$1" machine_id="${CLOUDBENCH_CLOUD_LOCK_MACHINE_ID:-}" nonce="${CLOUDBENCH_CLOUD_LOCK_NONCE:-}"
  [ -n "$machine_id" ] && [ -n "$nonce" ] || return 1
  cloudbench_machines_api_request DELETE "/v1/apps/$app/machines/$machine_id?force=true" "" "$nonce" || return 1
  [ "$CLOUDBENCH_API_STATUS" = "200" ] || return 1
  unset CLOUDBENCH_CLOUD_LOCK_MACHINE_ID CLOUDBENCH_CLOUD_LOCK_NONCE
}

cloudbench_controller_acquire() {
  local path="$1" app="$2" region="$3" ttl="$4" rc
  cloudbench_controller_lock_acquire "$path" || return 1
  cloudbench_cloud_lock_acquire "$app" "$region" "$ttl" || {
    rc=$?
    cloudbench_controller_lock_release "$path"
    return "$rc"
  }
}

cloudbench_controller_release() {
  local path="$1" app="$2"
  cloudbench_cloud_lock_release "$app"
  cloudbench_controller_lock_release "$path"
}
