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

cloudbench_controller_lock_acquire() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  if command -v shlock >/dev/null 2>&1; then
    shlock -p "$$" -f "$path" || return 1
    CLOUDBENCH_CONTROLLER_LOCK_KIND="shlock"
  elif command -v flock >/dev/null 2>&1; then
    exec {CLOUDBENCH_CONTROLLER_LOCK_FD}> "$path"
    if ! flock -n "$CLOUDBENCH_CONTROLLER_LOCK_FD"; then
      eval "exec ${CLOUDBENCH_CONTROLLER_LOCK_FD}>&-"
      unset CLOUDBENCH_CONTROLLER_LOCK_FD
      return 1
    fi
    printf '%s\n' "$$" >&"$CLOUDBENCH_CONTROLLER_LOCK_FD"
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
    eval "exec ${CLOUDBENCH_CONTROLLER_LOCK_FD}>&-"
    unset CLOUDBENCH_CONTROLLER_LOCK_FD
  fi
  rm -f "$path"
  unset CLOUDBENCH_CONTROLLER_LOCK_KIND CLOUDBENCH_CONTROLLER_LOCK_PATH
}
