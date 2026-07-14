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

# Execute one command through Fly SSH while preserving it as a single login-shell
# argument. Callers must keep credentials in the Machine environment rather than
# interpolating secret values into command, because Fly forwards command in its
# local and remote process arguments.
cloudbench_ssh_exec() {
  local app="$1" machine_id="$2" command="$3" payload decoder
  payload="$(printf '%s' "$command" | base64 | tr -d '\n')"
  decoder="printf '%s' '$payload' | base64 -d | bash -s"
  FLY ssh console -a "$app" --machine "$machine_id" \
    -C "bash -lc $(printf '%q' "$decoder")"
}

# Emit a remote-shell prelude for private Git operations. The Machine secret is
# consumed through a one-shot stdin pipe by GIT_ASKPASS: it never appears in
# Fly, shell, gosu, or Git argv, and is removed from the rose process environment.
# A stopped/restarted warm Machine should have no rose processes; fail closed if
# that isolation precondition is ever violated.
cloudbench_remote_git_auth_prelude() {
  cat <<'CLOUDBENCH_GIT_AUTH'
: "${GITHUB_TOKEN:?GITHUB_TOKEN is missing from the Machine environment}"
if pgrep -u rose >/dev/null 2>&1; then
  echo 'refusing private Git auth while an unowned rose process is running' >&2
  exit 1
fi
CLOUDBENCH_GIT_AUTH_DIR="$(mktemp -d /tmp/cloudbench-git-auth.XXXXXX)"
chmod 0711 "$CLOUDBENCH_GIT_AUTH_DIR"
CLOUDBENCH_GIT_ASKPASS="$CLOUDBENCH_GIT_AUTH_DIR/askpass"
cleanup_cloudbench_git_askpass() { rm -rf "$CLOUDBENCH_GIT_AUTH_DIR"; }
trap cleanup_cloudbench_git_askpass EXIT HUP INT TERM
cat > "$CLOUDBENCH_GIT_ASKPASS" <<'CLOUDBENCH_ASKPASS'
#!/bin/sh
case "$1" in
  *sername*) printf '%s\n' 'x-access-token' ;;
  *assword*) IFS= read -r token < "$CLOUDBENCH_GIT_TOKEN_PIPE"; printf '%s\n' "$token" ;;
  *) exit 1 ;;
esac
CLOUDBENCH_ASKPASS
chmod 0755 "$CLOUDBENCH_GIT_ASKPASS"
cloudbench_git_with_machine_token() {
  local token_pipe="$CLOUDBENCH_GIT_AUTH_DIR/token.fifo" writer rc
  rm -f "$token_pipe"
  mkfifo "$token_pipe"
  chown rose:rose "$token_pipe"
  chmod 0600 "$token_pipe"
  (printf '%s\n' "$GITHUB_TOKEN" > "$token_pipe") &
  writer=$!
  if gosu rose env -u GITHUB_TOKEN HOME=/home/rose \
      GIT_ASKPASS="$CLOUDBENCH_GIT_ASKPASS" \
      CLOUDBENCH_GIT_TOKEN_PIPE="$token_pipe" GIT_TERMINAL_PROMPT=0 \
      timeout 120 "$@" </dev/null; then
    rc=0
  else
    rc=$?
  fi
  kill "$writer" 2>/dev/null || true
  wait "$writer" 2>/dev/null || true
  rm -f "$token_pipe"
  return "$rc"
}
CLOUDBENCH_GIT_AUTH
}

cloudbench_fleet_workspace_name() {
  local bench="$1" run_token="$2" index="$3" prefix="flt-" suffix slug digest max_slug head_length
  suffix="-$run_token-$index"
  max_slug=$((48 - ${#prefix} - ${#suffix}))
  [ "$max_slug" -ge 10 ] || {
    echo "FATAL: cloud benchmark fleet run token is too long for a unique workspace name" >&2
    return 2
  }
  slug="$(printf '%s' "$bench" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
  [ -n "$slug" ] || slug="bench"
  if [ "${#slug}" -gt "$max_slug" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      digest="$(printf '%s' "$slug" | sha256sum | awk '{print substr($1, 1, 8)}')"
    else
      digest="$(printf '%s' "$slug" | shasum -a 256 | awk '{print substr($1, 1, 8)}')"
    fi
    head_length=$((max_slug - ${#digest} - 1))
    slug="${slug:0:$head_length}-$digest"
  fi
  printf '%s%s%s\n' "$prefix" "$slug" "$suffix"
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

cloudbench_activate_machine_environment() {
  local machine_id="$1" app="$2"
  local max_attempts="${CLOUDBENCH_MACHINE_UPDATE_ATTEMPTS:-3}"
  local retry_delay="${CLOUDBENCH_MACHINE_UPDATE_RETRY_DELAY:-2}"
  local attempt=1 output

  case "$max_attempts" in
    ''|*[!0-9]*|0)
      echo "FATAL: CLOUDBENCH_MACHINE_UPDATE_ATTEMPTS must be a positive integer" >&2
      return 2
      ;;
  esac
  case "$retry_delay" in
    ''|*[!0-9]*)
      echo "FATAL: CLOUDBENCH_MACHINE_UPDATE_RETRY_DELAY must be a non-negative integer" >&2
      return 2
      ;;
  esac

  while [ "$attempt" -le "$max_attempts" ]; do
    if output="$(FLY machine update "$machine_id" -a "$app" --skip-start --yes 2>&1)"; then
      printf '%s\n' "$output" | sed 's/^/      /'
      return 0
    fi
    printf '%s\n' "$output" | sed 's/^/      /' >&2
    if [ "$attempt" -eq "$max_attempts" ]; then
      return 1
    fi
    echo "      machine update attempt $attempt/$max_attempts failed; retrying in ${retry_delay}s" >&2
    sleep "$retry_delay"
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

cloudbench_is_controller_shell() {
  [ "${BASH_SUBSHELL:-0}" -eq 0 ]
}

cloudbench_dispatch_controller_cleanup() {
  local exit_code="$1" callback="$2"
  shift 2
  if cloudbench_is_controller_shell; then
    "$callback" "$@"
  fi
  return "$exit_code"
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

cloudbench_random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

cloudbench_controller_parent_valid() {
  local path="$1" owner_pid owner_token lock_pid
  [ -n "${CLOUDBENCH_CONTROLLER_TOKEN:-}" ] || return 1
  read -r owner_pid owner_token < "$path.owner" 2>/dev/null || return 1
  lock_pid="$(cat "$path" 2>/dev/null || true)"
  [ "$owner_pid" = "$lock_pid" ] || return 1
  [ "$owner_token" = "$CLOUDBENCH_CONTROLLER_TOKEN" ] || return 1
  kill -0 "$owner_pid" 2>/dev/null
}

cloudbench_controller_lock_acquire() {
  local path="$1" owner_file owner status attempt acquired=0
  if ! mkdir -p "$(dirname "$path")"; then
    echo "FATAL: could not create cloud benchmark controller lock directory" >&2
    return 1
  fi
  if command -v shlock >/dev/null 2>&1; then
    for attempt in 1 2; do
      if shlock -p "$$" -f "$path"; then
        CLOUDBENCH_CONTROLLER_LOCK_KIND="shlock"
        CLOUDBENCH_CONTROLLER_LOCK_PATH="$path"
        acquired=1
        break
      fi
      # shlock uses one non-zero code for both contention and filesystem
      # errors. Only a live PID in the completed lock file proves contention.
      owner="$(cat "$path" 2>/dev/null || true)"
      case "$owner" in
        ''|*[!0-9]*) ;;
        *) kill -0 "$owner" 2>/dev/null && return 75 ;;
      esac
      # The owner can exit between shlock's collision and our liveness read.
      # Retry that handoff race once; a repeated unowned failure is an error.
      [ "$attempt" -eq 1 ] || break
    done
    if [ "$acquired" != 1 ]; then
      echo "FATAL: could not create cloud benchmark controller lock: $path" >&2
      return 1
    fi
  elif command -v flock >/dev/null 2>&1; then
    if ! exec {CLOUDBENCH_CONTROLLER_LOCK_FD}<> "$path"; then
      echo "FATAL: could not open cloud benchmark controller lock: $path" >&2
      return 1
    fi
    flock -n -E 75 "$CLOUDBENCH_CONTROLLER_LOCK_FD"
    status=$?
    if [ "$status" -ne 0 ]; then
      exec {CLOUDBENCH_CONTROLLER_LOCK_FD}>&-
      unset CLOUDBENCH_CONTROLLER_LOCK_FD
      [ "$status" -eq 75 ] && return 75
      echo "FATAL: could not acquire cloud benchmark controller lock: $path" >&2
      return "$status"
    fi
    printf '%s\n' "$$" > "$path"
    CLOUDBENCH_CONTROLLER_LOCK_KIND="flock"
  else
    echo "FATAL: shlock or flock is required for the cloud benchmark controller lock" >&2
    return 1
  fi
  CLOUDBENCH_CONTROLLER_PID="$$"
  CLOUDBENCH_CONTROLLER_TOKEN="$(cloudbench_random_token)"
  owner_file="$path.owner"
  if ! (umask 077; printf '%s %s\n' "$CLOUDBENCH_CONTROLLER_PID" "$CLOUDBENCH_CONTROLLER_TOKEN" > "$owner_file"); then
    rm -f "$path" "$owner_file"
    return 1
  fi
  export CLOUDBENCH_CONTROLLER_PID CLOUDBENCH_CONTROLLER_TOKEN
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
  rm -f "$path" "$path.owner"
  unset CLOUDBENCH_CONTROLLER_LOCK_KIND CLOUDBENCH_CONTROLLER_LOCK_PATH \
    CLOUDBENCH_CONTROLLER_PID CLOUDBENCH_CONTROLLER_TOKEN
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
  local app="$1" lease_ttl="${CLOUDBENCH_CLOUD_LOCK_TTL:-7200}" token_json token_expiry token_name now
  now="$(date +%s)"
  if [ -n "${CLOUDBENCH_MACHINES_API_TOKEN:-}" ]; then
    if [ "${CLOUDBENCH_MACHINES_API_TOKEN_MANAGED:-0}" != "1" ] || \
       [ "$now" -lt $(( ${CLOUDBENCH_MACHINES_API_TOKEN_EXPIRES_AT:-0} - 60 )) ]; then
      return 0
    fi
    unset CLOUDBENCH_MACHINES_API_TOKEN CLOUDBENCH_MACHINES_API_TOKEN_MANAGED \
      CLOUDBENCH_MACHINES_API_TOKEN_EXPIRES_AT
  fi
  token_expiry=$((lease_ttl + 600))
  token_name="cloudbench-controller-$$-$(cloudbench_random_token | cut -c1-8)"
  token_json="$(flyctl tokens create deploy -a "$app" -x "${token_expiry}s" -n "$token_name" --json 2>/dev/null)" || return 1
  CLOUDBENCH_MACHINES_API_TOKEN="$(printf '%s' "$token_json" | jq -r '.token // empty' 2>/dev/null)"
  [ -n "$CLOUDBENCH_MACHINES_API_TOKEN" ] || return 1
  CLOUDBENCH_MACHINES_API_TOKEN_MANAGED=1
  CLOUDBENCH_MACHINES_API_TOKEN_EXPIRES_AT=$((now + token_expiry))
  export CLOUDBENCH_MACHINES_API_TOKEN CLOUDBENCH_MACHINES_API_TOKEN_MANAGED \
    CLOUDBENCH_MACHINES_API_TOKEN_EXPIRES_AT
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

cloudbench_cloud_lock_machine_ensure() {
  local app="$1" region="$2" image="${3:-flyio/hellofly:latest}" machine_name machine_id body
  machine_name="$(cloudbench_cloud_lock_machine_name)"
  machine_id="$(cloudbench_cloud_lock_machine_id "$app" || true)"
  [ -n "$machine_id" ] && { printf '%s\n' "$machine_id"; return 0; }
  body="$(jq -cn --arg name "$machine_name" --arg region "$region" --arg image "$image" '{
    name: $name,
    region: $region,
    config: {
      image: $image,
      auto_destroy: false,
      restart: {policy: "no"},
      guest: {cpu_kind: "shared", cpus: 1, memory_mb: 256}
    },
    skip_launch: true
  }')"
  cloudbench_machines_api_request POST "/v1/apps/$app/machines" "$body" || return 1
  case "$CLOUDBENCH_API_STATUS" in 200|201|409) ;; *) return 1 ;; esac
  machine_id="$(printf '%s' "$CLOUDBENCH_API_BODY" | jq -r '.id // empty' 2>/dev/null)"
  [ -n "$machine_id" ] || machine_id="$(cloudbench_cloud_lock_machine_id "$app" || true)"
  [ -n "$machine_id" ] || return 1
  printf '%s\n' "$machine_id"
}

cloudbench_cloud_lock_acquire() {
  local app="$1" machine_id body nonce description ttl expires_at now watchdog_delay owner_pid
  CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON=""
  if ! machine_id="$(cloudbench_cloud_lock_machine_id "$app")"; then
    CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON="api_error"
    echo "FATAL: could not list cloud benchmark controller sentinel" >&2
    return 1
  fi
  if [ -z "$machine_id" ]; then
    CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON="sentinel_missing"
    echo "FATAL: cloud benchmark controller sentinel is missing; run run-bench-cloud --setup" >&2
    return 1
  fi
  ttl="${CLOUDBENCH_CLOUD_LOCK_TTL:-7200}"
  case "$ttl" in
    ''|*[!0-9]*|0)
      CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON="config_error"
      echo "FATAL: invalid cloud lock TTL" >&2
      return 2
      ;;
  esac
  description="cloudbench-controller pid=$$ host=$(hostname 2>/dev/null || echo unknown)"
  body="$(jq -cn --arg description "$description" --argjson ttl "$ttl" '{description:$description, ttl:$ttl}')"
  if ! cloudbench_machines_api_request POST "/v1/apps/$app/machines/$machine_id/lease" "$body"; then
    CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON="api_error"
    return 1
  fi
  if [ "$CLOUDBENCH_API_STATUS" != "201" ]; then
    if [ "$CLOUDBENCH_API_STATUS" = "409" ]; then
      CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON="busy"
    else
      CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON="api_error"
      echo "FATAL: could not acquire cloud benchmark app lease (HTTP $CLOUDBENCH_API_STATUS)" >&2
    fi
    return 1
  fi
  nonce="$(printf '%s' "$CLOUDBENCH_API_BODY" | jq -r '.data.nonce // .nonce // empty' 2>/dev/null)"
  if [ -z "$nonce" ]; then
    CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON="response_error"
    echo "FATAL: Fly lease response omitted its nonce" >&2
    return 1
  fi
  CLOUDBENCH_CLOUD_LOCK_MACHINE_ID="$machine_id"
  CLOUDBENCH_CLOUD_LOCK_NONCE="$nonce"
  expires_at="$(printf '%s' "$CLOUDBENCH_API_BODY" | jq -r '.data.expires_at // .expires_at // empty' 2>/dev/null)"
  now="$(date +%s)"
  case "$expires_at" in ''|*[!0-9]*) expires_at=$((now + ttl)) ;; esac
  watchdog_delay=$((expires_at - now - 60))
  if [ "$watchdog_delay" -le 0 ]; then
    CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON="response_error"
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
    CLOUDBENCH_MACHINES_API_TOKEN CLOUDBENCH_MACHINES_API_TOKEN_MANAGED \
    CLOUDBENCH_MACHINES_API_TOKEN_EXPIRES_AT
}

cloudbench_cloud_lock_machine_destroy() {
  local app="$1" machine_id="${CLOUDBENCH_CLOUD_LOCK_MACHINE_ID:-}" nonce="${CLOUDBENCH_CLOUD_LOCK_NONCE:-}"
  [ -n "$machine_id" ] && [ -n "$nonce" ] || return 1
  cloudbench_machines_api_request DELETE "/v1/apps/$app/machines/$machine_id?force=true" "" "$nonce" || return 1
  [ "$CLOUDBENCH_API_STATUS" = "200" ] || return 1
  unset CLOUDBENCH_CLOUD_LOCK_MACHINE_ID CLOUDBENCH_CLOUD_LOCK_NONCE
}

cloudbench_machine_create_stopped() {
  local app="$1" name="$2" region="$3" image="$4" volume_id="$5" mount_path="$6"
  local cpu_kind="$7" cpus="$8" memory_mb="$9" body machine_id
  case "$cpu_kind" in shared|performance) ;; *) return 2 ;; esac
  case "$cpus" in ''|*[!0-9]*|0) return 2 ;; esac
  case "$memory_mb" in ''|*[!0-9]*|0) return 2 ;; esac
  body="$(jq -cn \
    --arg name "$name" --arg region "$region" --arg image "$image" \
    --arg volume "$volume_id" --arg path "$mount_path" --arg cpu_kind "$cpu_kind" \
    --argjson cpus "$cpus" --argjson memory_mb "$memory_mb" '{
      name: $name,
      region: $region,
      config: {
        image: $image,
        auto_destroy: false,
        restart: {policy: "no"},
        guest: {cpu_kind: $cpu_kind, cpus: $cpus, memory_mb: $memory_mb},
        mounts: [{volume: $volume, path: $path}]
      },
      skip_launch: true
    }')" || return 1
  cloudbench_machines_api_request POST "/v1/apps/$app/machines" "$body" || return 1
  case "$CLOUDBENCH_API_STATUS" in 200|201) ;; *) return 1 ;; esac
  machine_id="$(printf '%s' "$CLOUDBENCH_API_BODY" | jq -r '.id // empty' 2>/dev/null)"
  [ -n "$machine_id" ] || return 1
  printf '%s\n' "$machine_id"
}

cloudbench_machine_lease_acquire() {
  local app="$1" machine_id="$2" description="${3:-cloudbench-primary}" ttl body nonce
  ttl="${CLOUDBENCH_CLOUD_LOCK_TTL:-7200}"
  # Fly accepts at most 64 runes for an AcquireLeaseRequest description. Keep
  # the stable prefix plus as much run/bench context as the provider permits.
  description="${description:0:64}"
  body="$(jq -cn --arg description "$description" --argjson ttl "$ttl" '{description:$description, ttl:$ttl}')"
  cloudbench_machines_api_request POST "/v1/apps/$app/machines/$machine_id/lease" "$body" || return 1
  case "$CLOUDBENCH_API_STATUS" in
    201) ;;
    409) return 75 ;;
    *)
      echo "Machine lease acquisition failed for $machine_id (HTTP $CLOUDBENCH_API_STATUS)" >&2
      return 1
      ;;
  esac
  nonce="$(printf '%s' "$CLOUDBENCH_API_BODY" | jq -r '.data.nonce // .nonce // empty' 2>/dev/null)"
  [ -n "$nonce" ] || return 1
  printf '%s\n' "$nonce"
}

cloudbench_machine_lease_acquire_retry() {
  local app="$1" machine_id="$2" description="$3" attempts="${4:-45}" delay="${5:-2}" attempt nonce rc
  case "$attempts" in ''|*[!0-9]*|0) return 2 ;; esac
  case "$delay" in ''|*[!0-9]*) return 2 ;; esac
  attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    if nonce="$(cloudbench_machine_lease_acquire "$app" "$machine_id" "$description")"; then
      printf '%s\n' "$nonce"
      return 0
    else
      rc=$?
    fi
    [ "$rc" -eq 75 ] || return "$rc"
    [ "$attempt" -eq "$attempts" ] && break
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  return 1
}

cloudbench_machine_start_with_lease() {
  local app="$1" machine_id="$2" nonce="$3"
  local attempts="${CLOUDBENCH_MACHINE_START_ATTEMPTS:-30}"
  local delay="${CLOUDBENCH_MACHINE_START_RETRY_DELAY:-1}" attempt=1
  case "$attempts" in ''|*[!0-9]*|0) return 2 ;; esac
  case "$delay" in ''|*[!0-9]*) return 2 ;; esac
  while [ "$attempt" -le "$attempts" ]; do
    cloudbench_machines_api_request POST "/v1/apps/$app/machines/$machine_id/start" '{}' "$nonce" || return 1
    [ "$CLOUDBENCH_API_STATUS" = "200" ] && return 0
    if [ "$CLOUDBENCH_API_STATUS" != "412" ] || \
       ! printf '%s' "$CLOUDBENCH_API_BODY" | grep -Fqi 'machine getting replaced'; then
      echo "Machine start failed for $machine_id (HTTP $CLOUDBENCH_API_STATUS)" >&2
      return 1
    fi
    [ "$attempt" -eq "$attempts" ] && break
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  echo "Machine replacement did not settle before start for $machine_id" >&2
  return 1
}

cloudbench_machine_destroy_with_lease() {
  local app="$1" machine_id="$2" nonce="$3"
  cloudbench_machines_api_request \
    DELETE "/v1/apps/$app/machines/$machine_id?force=true" "" "$nonce" || return 1
  [ "$CLOUDBENCH_API_STATUS" = "200" ] || {
    echo "Machine destroy failed for $machine_id (HTTP $CLOUDBENCH_API_STATUS)" >&2
    return 1
  }
}

cloudbench_machines_api_status_is_transient() {
  case "$1" in
    0|408|409|425|429|500|502|503|504) return 0 ;;
    *) return 1 ;;
  esac
}

cloudbench_activate_machine_environment_with_lease() {
  local app="$1" machine_id="$2" nonce="$3" body failure_stage status
  local attempts="${CLOUDBENCH_MACHINE_ACTIVATION_ATTEMPTS:-3}"
  local delay="${CLOUDBENCH_MACHINE_ACTIVATION_RETRY_DELAY:-2}" attempt=1
  case "$attempts" in ''|*[!0-9]*|0) return 2 ;; esac
  case "$delay" in ''|*[!0-9]*) return 2 ;; esac
  while [ "$attempt" -le "$attempts" ]; do
    failure_stage="read"
    status=0
    if cloudbench_machines_api_request GET "/v1/apps/$app/machines/$machine_id"; then
      status="$CLOUDBENCH_API_STATUS"
    else
      status="${CLOUDBENCH_API_STATUS:-0}"
    fi

    if [ "$status" = "200" ]; then
      if ! body="$(printf '%s' "$CLOUDBENCH_API_BODY" | jq -ce '{
      config: .config,
      name: .name,
      region: .region,
      skip_launch: true
      } + (if .version then {current_version: .version} else {} end)')"; then
        echo "Machine environment activation received an invalid Machine response for $machine_id" >&2
        return 1
      fi

      failure_stage="update"
      status=0
      if cloudbench_machines_api_request \
        POST "/v1/apps/$app/machines/$machine_id" "$body" "$nonce"; then
        status="$CLOUDBENCH_API_STATUS"
      else
        status="${CLOUDBENCH_API_STATUS:-0}"
      fi
      [ "$status" = "200" ] && return 0
    fi

    if ! cloudbench_machines_api_status_is_transient "$status"; then
      echo "Machine environment activation $failure_stage failed for $machine_id (HTTP $status)" >&2
      return 1
    fi

    [ "$attempt" -eq "$attempts" ] && break
    echo "Machine environment activation $failure_stage had a transient failure for $machine_id (HTTP $status, attempt $attempt/$attempts); retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  echo "Machine environment activation failed for $machine_id after $attempts transient attempts (last_stage=$failure_stage, HTTP $status)" >&2
  return 1
}

cloudbench_machine_release_lease() {
  local app="$1" machine_id="$2" nonce="$3" status
  if ! cloudbench_machines_api_request \
    DELETE "/v1/apps/$app/machines/$machine_id/lease" "" "$nonce"; then
    status="${CLOUDBENCH_API_STATUS:-0}"
    echo "Machine lease release failed for $machine_id (HTTP $status)" >&2
    return 1
  fi
  status="${CLOUDBENCH_API_STATUS:-0}"
  case "$status" in
    2??) return 0 ;;
    *)
      echo "Machine lease release failed for $machine_id (HTTP $status)" >&2
      return 1
      ;;
  esac
}

cloudbench_machine_wait_stopped_with_lease() {
  local app="$1" machine_id="$2" nonce="$3" attempts="$4" delay="$5"
  local attempt=1 status state
  case "$attempts" in ''|*[!0-9]*|0) return 2 ;; esac
  case "$delay" in ''|*[!0-9]*) return 2 ;; esac

  while [ "$attempt" -le "$attempts" ]; do
    status=0
    if cloudbench_machines_api_request \
      GET "/v1/apps/$app/machines/$machine_id" "" "$nonce"; then
      status="${CLOUDBENCH_API_STATUS:-0}"
    else
      status="${CLOUDBENCH_API_STATUS:-0}"
    fi
    if [ "$status" = "200" ]; then
      state="$(printf '%s' "$CLOUDBENCH_API_BODY" | jq -er \
        --arg machine_id "$machine_id" \
        'select(.id == $machine_id) | .state // empty' 2>/dev/null)" || state=""
      case "$state" in
        stopped) return 0 ;;
        created|replacing|started|starting|stopping) ;;
        *)
          echo "Machine $machine_id returned unsafe state ${state:-unknown} while confirming stop" >&2
          return 1
          ;;
      esac
    elif ! cloudbench_machines_api_status_is_transient "$status"; then
      echo "Machine state verification failed while stopping $machine_id (HTTP $status)" >&2
      return 1
    fi

    [ "$attempt" -ge "$attempts" ] && break
    [ "$delay" -gt 0 ] && sleep "$delay"
    attempt=$((attempt + 1))
  done
  echo "Machine $machine_id did not reach authoritative stopped state; retaining its lease" >&2
  return 1
}

cloudbench_machine_stop_and_release_lease() {
  local app="$1" machine_id="$2" nonce="$3" status verify_attempts verify_delay
  if ! cloudbench_machines_api_request \
    POST "/v1/apps/$app/machines/$machine_id/stop" '{}' "$nonce"; then
    status="${CLOUDBENCH_API_STATUS:-0}"
    echo "Machine stop failed for $machine_id (HTTP $status)" >&2
    return 1
  fi
  status="${CLOUDBENCH_API_STATUS:-0}"
  case "$status" in
    200)
      verify_attempts="${CLOUDBENCH_MACHINE_STOP_VERIFY_ATTEMPTS:-30}"
      verify_delay="${CLOUDBENCH_MACHINE_STOP_VERIFY_RETRY_DELAY:-1}"
      ;;
    409)
      # A stop conflict can mean either "already stopped" or an unsafe
      # lifecycle transition. Release ownership only after an authoritative
      # read proves this exact Machine is stopped.
      verify_attempts=1
      verify_delay=0
      ;;
    *)
      echo "Machine stop failed for $machine_id (HTTP $status)" >&2
      return 1
      ;;
  esac
  cloudbench_machine_wait_stopped_with_lease \
    "$app" "$machine_id" "$nonce" "$verify_attempts" "$verify_delay" || return 1
  cloudbench_machine_release_lease "$app" "$machine_id" "$nonce"
}

cloudbench_controller_acquire() {
  local path="$1" app="$2" status
  CLOUDBENCH_CONTROLLER_ACQUIRE_REASON=""
  cloudbench_controller_lock_acquire "$path"
  status=$?
  if [ "$status" -ne 0 ]; then
    if [ "$status" -eq 75 ]; then
      CLOUDBENCH_CONTROLLER_ACQUIRE_REASON="local_busy"
    else
      CLOUDBENCH_CONTROLLER_ACQUIRE_REASON="local_error"
    fi
    return 1
  fi
  if ! cloudbench_machines_api_token_ensure "$app"; then
    CLOUDBENCH_CONTROLLER_ACQUIRE_REASON="token_error"
    cloudbench_controller_lock_release "$path"
    return 1
  fi
  if ! cloudbench_cloud_lock_acquire "$app"; then
    if [ "${CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON:-}" = "busy" ]; then
      CLOUDBENCH_CONTROLLER_ACQUIRE_REASON="cloud_busy"
    else
      CLOUDBENCH_CONTROLLER_ACQUIRE_REASON="cloud_${CLOUDBENCH_CLOUD_LOCK_ACQUIRE_REASON:-unknown}"
    fi
    cloudbench_controller_lock_release "$path"
    return 1
  fi
}

# Serialize legitimate fleet controllers at the provider-owned sentinel. A Hub
# request is already visible and claimed when its runner reaches this boundary,
# so lease contention is queueing, not a benchmark failure. Retry only explicit
# ownership contention; auth, API, and sentinel errors still fail immediately.
cloudbench_controller_wait_acquire() {
  local path="$1" app="$2" interval="${CLOUDBENCH_CONTROLLER_RETRY_INTERVAL:-5}"
  local attempts=0 reason delay

  while ! cloudbench_controller_acquire "$path" "$app"; do
    reason="${CLOUDBENCH_CONTROLLER_ACQUIRE_REASON:-unknown}"
    case "$reason" in
      local_busy|cloud_busy)
        attempts=$((attempts + 1))
        if [ "$attempts" -eq 1 ]; then
          if [ "$reason" = "cloud_busy" ]; then
            echo "⏳ another controller owns the shared benchmark app; queued for lease handoff..."
          else
            echo "⏳ another controller owns this workspace; queued for lock handoff..."
          fi
        elif [ $((attempts % 12)) -eq 0 ]; then
          echo "   still queued for benchmark controller handoff (${attempts} checks)"
        fi
        case "$interval" in
          *.*) delay="$interval" ;;
          *) delay=$((interval + RANDOM % 3)) ;;
        esac
        sleep "$delay"
        ;;
      *)
        echo "FATAL: cloud benchmark controller acquisition failed ($reason)" >&2
        return 1
        ;;
    esac
  done

  if [ "$attempts" -gt 0 ]; then
    echo "✅ benchmark controller handoff acquired after $attempts checks"
  fi
}

# Guard the narrow startup window before the fleet's full resource cleanup trap
# is installed. It is safe to install before waiting: release is ownership-
# checked and is a no-op until a local or provider lock has actually been won.
cloudbench_controller_install_release_guard() {
  CLOUDBENCH_CONTROLLER_GUARD_PATH="$1"
  CLOUDBENCH_CONTROLLER_GUARD_APP="$2"
  trap cloudbench_controller_release_guard_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

cloudbench_controller_release_guard_cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  cloudbench_controller_release \
    "${CLOUDBENCH_CONTROLLER_GUARD_PATH:-}" \
    "${CLOUDBENCH_CONTROLLER_GUARD_APP:-}" || true
  exit "$status"
}

cloudbench_controller_release() {
  local path="$1" app="$2"
  cloudbench_cloud_lock_release "$app"
  cloudbench_controller_lock_release "$path"
}
