#!/usr/bin/env bash

# Shared fail-closed helpers for the cloud benchmark environment handoff.
# This file is sourced by both the macOS controller and Linux benchmark VMs.

# sysexits.h EX_TEMPFAIL: the caller may retry this exact failure without
# weakening handling for ordinary runner/configuration failures.
CLOUDBENCH_CAPACITY_BUSY_EXIT_CODE=75

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

cloudbench_worktree_has_changes() {  # <repo-root>
  local repo="$1"
  ! git -C "$repo" diff --quiet HEAD --binary 2>/dev/null \
    || [ -n "$(git -C "$repo" ls-files --others --exclude-standard | head -1)" ]
}

cloudbench_central_hub_runs_root() {  # <port>
  curl --noproxy '*' -fsS --max-time 2 \
    "http://127.0.0.1:$1/hub-meta.json" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("hub_runs_dir", ""))' \
      2>/dev/null
}

cloudbench_central_hub_matches() {  # <port> <expected-runs-root>
  local actual_root expected_root
  expected_root="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$2")"
  actual_root="$(cloudbench_central_hub_runs_root "$1" || true)"
  [ -n "$actual_root" ] && [ "$actual_root" = "$expected_root" ]
}

cloudbench_select_central_hub_port() {  # <preferred-port> <expected-runs-root>
  local preferred="$1" expected_root="$2" candidate

  # A Conductor port can be reused while another workspace's persistent hub is
  # still alive. Reuse a listener only when it identifies the same runs root;
  # otherwise leave that workspace untouched and select the first free/matching
  # port. The identity endpoint also makes a previously rebased hub reusable by
  # later runs from this workspace.
  for candidate in $(seq "$preferred" $((preferred + 500))); do
    if ! lsof -tiTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
    if cloudbench_central_hub_matches "$candidate" "$expected_root"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "FATAL: no free central benchmark hub port in ${preferred}..$((preferred + 500))" >&2
  return 1
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

cloudbench_detach_reexec() {  # cloudbench_detach_reexec <log-file> <argv...>
  # Re-exec the given command in its OWN SESSION (fork → setsid → exec), stdin
  # from /dev/null, stdout+stderr appended to <log-file>. A long controller
  # launched from a terminal or agent session otherwise dies with that
  # session's process group (observed: a 28-machine fleet torn down mid-run by
  # launcher exit). macOS ships no setsid(1), so use Python's os.setsid.
  local log="$1"; shift
  python3 - "$log" "$@" <<'PY'
import os, sys
log, *argv = sys.argv[1:]
if os.fork():
    sys.exit(0)
os.setsid()
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
null = os.open(os.devnull, os.O_RDONLY)
os.dup2(null, 0)
os.execvp(argv[0], argv)
PY
}

cloudbench_fleet_workspace_name() {  # <bench-name> <controller-id> <ordinal>
  # Temporal task queues inherit this workspace name and cap it at 48 chars.
  # Truncate only the human-readable bench segment: the controller + ordinal
  # suffix is the isolation boundary and must remain complete for every name.
  local bench="$1" controller_id="$2" ordinal="$3"
  local suffix sanitized max_bench_length
  case "$controller_id:$ordinal" in
    *[!0-9:]*)
      echo "FATAL: fleet workspace controller and ordinal must be numeric" >&2
      return 1
      ;;
    :*|*:)
      echo "FATAL: fleet workspace controller and ordinal must be non-empty" >&2
      return 1
      ;;
  esac
  suffix="-$controller_id-$ordinal"
  max_bench_length=$((48 - 4 - ${#suffix}))
  [ "$max_bench_length" -ge 1 ] || {
    echo "FATAL: fleet workspace uniqueness suffix exceeds the 48-character limit" >&2
    return 1
  }
  sanitized="$(printf '%s' "$bench" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
  sanitized="${sanitized:0:$max_bench_length}"
  [ -n "$sanitized" ] || sanitized="bench"
  printf 'flt-%s%s' "$sanitized" "$suffix"
}

cloudbench_fetchable_ref() {  # <repo-root> <requested-ref> <allow-local-patch-01>
  # Fly guests can fetch only objects reachable from an advertised origin ref.
  # When the requested local commit is unpushed, run from its fetchable
  # origin/main ancestor and let create-worktree-patch carry the complete
  # committed + uncommitted workspace delta.
  local root="$1" requested="$2" allow_patch="$3" resolved base
  if ! resolved="$(git -C "$root" rev-parse --verify "${requested}^{commit}" 2>/dev/null)"; then
    # Preserve remote-only branch/tag names that this checkout cannot resolve.
    printf '%s' "$requested"
    return 0
  fi
  if git -C "$root" branch -r --contains "$resolved" --format='%(refname:short)' 2>/dev/null \
      | grep -q '^origin/'; then
    printf '%s' "$resolved"
    return 0
  fi
  if [ "$allow_patch" != "1" ]; then
    echo "FATAL: requested benchmark commit $resolved is not fetchable from origin and local patch shipping is disabled" >&2
    return 1
  fi
  base="$(git -C "$root" merge-base "$resolved" origin/main 2>/dev/null)" || {
    echo "FATAL: requested benchmark commit $resolved has no fetchable origin/main base" >&2
    return 1
  }
  [ -n "$base" ] || {
    echo "FATAL: requested benchmark commit $resolved has no fetchable origin/main base" >&2
    return 1
  }
  echo "📦 local commit $resolved is not on origin; guest will fetch $base and receive the complete workspace delta as a patch" >&2
  printf '%s' "$base"
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

cloudbench_terminate_and_wait() {
  local timeout_seconds="$1"
  shift

  local pid deadline live
  local pids=()
  for pid in "$@"; do
    [ -n "$pid" ] && pids+=("$pid")
  done
  [ "${#pids[@]}" -gt 0 ] || return 0

  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done

  deadline=$((SECONDS + timeout_seconds))
  while :; do
    live=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        live=1
        break
      fi
    done
    [ "$live" -eq 0 ] && break
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 1
  done

  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
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

# Python-side manifest list + fingerprint (single source of truth — sync-deps,
# the fleet preflight, and --refresh-deps must agree byte-for-byte or the
# warm-snapshot freshness check misfires).
CLOUDBENCH_PYTHON_MANIFESTS=(agents/requirements.txt)
cloudbench_manifest_fingerprint() {
    local root="$1"
    shift
    python3 - "$root" "$@" <<'FPY'
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
digest = hashlib.sha256()
for relative in sys.argv[2:]:
    path = root / relative
    if not path.is_file():
        raise SystemExit(f"missing dependency manifest: {path}")
    digest.update(relative.encode())
    digest.update(b"\0")
    digest.update(path.read_bytes())
    digest.update(b"\0")
print(digest.hexdigest())
FPY
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
  local path="$1" owner status
  if ! mkdir -p "$(dirname "$path")"; then
    echo "FATAL: could not create cloud benchmark controller lock directory" >&2
    return 1
  fi
  if command -v shlock >/dev/null 2>&1; then
    status=0
    shlock -p "$$" -f "$path" || status=$?
    if [ "$status" -ne 0 ]; then
      owner="$(cat "$path" 2>/dev/null || true)"
      if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
        echo "CLOUDBENCH_RETRYABLE_CAPACITY=local_lock_busy" >&2
        return "$CLOUDBENCH_CAPACITY_BUSY_EXIT_CODE"
      fi
      echo "FATAL: cloud benchmark local controller lock acquisition failed" >&2
      return 1
    fi
    CLOUDBENCH_CONTROLLER_LOCK_KIND="shlock"
  elif command -v flock >/dev/null 2>&1; then
    if ! exec {CLOUDBENCH_CONTROLLER_LOCK_FD}<> "$path"; then
      echo "FATAL: could not open cloud benchmark local controller lock" >&2
      return 1
    fi
    status=0
    flock -n "$CLOUDBENCH_CONTROLLER_LOCK_FD" || status=$?
    if [ "$status" -ne 0 ]; then
      exec {CLOUDBENCH_CONTROLLER_LOCK_FD}>&-
      unset CLOUDBENCH_CONTROLLER_LOCK_FD
      if [ "$status" -eq 1 ]; then
        echo "CLOUDBENCH_RETRYABLE_CAPACITY=local_lock_busy" >&2
        return "$CLOUDBENCH_CAPACITY_BUSY_EXIT_CODE"
      fi
      echo "FATAL: cloud benchmark local controller lock acquisition failed (exit $status)" >&2
      return "$status"
    fi
    printf '%s\n' "$$" > "$path"
    CLOUDBENCH_CONTROLLER_LOCK_KIND="flock"
  else
    echo "FATAL: shlock or flock is required for the cloud benchmark controller lock" >&2
    return 1
  fi
  CLOUDBENCH_CONTROLLER_LOCK_PATH="$path"
}

cloudbench_controller_lock_acquire_wait() {
  local path="$1" retry_seconds="${2:-10}" status owner
  case "$retry_seconds" in
    ''|*[!0-9]*|0)
      echo "FATAL: cloud benchmark controller retry interval must be a positive integer" >&2
      return 2
      ;;
  esac

  while true; do
    status=0
    cloudbench_controller_lock_acquire "$path" || status=$?
    [ "$status" -eq 0 ] && return 0

    owner="$(cat "$path" 2>/dev/null || true)"
    if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
      echo "Cloud benchmark controller is busy (local pid $owner); retrying in ${retry_seconds}s..."
      sleep "$retry_seconds"
      continue
    fi

    echo "FATAL: cloud benchmark controller lock failed without a live owner" >&2
    return "$status"
  done
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

# NOTE: the cross-host Fly "sentinel lease" (a machine lease held on the
# cloudbench-controller-lock machine for a whole run) was removed on purpose.
# Concurrent workstreams are supported by construction instead: the run path
# only READS shared app state (run-bench-cloud --verify-secrets), forks
# immutable warm-volume snapshots, and mutates nothing but the machines it
# created. The only lock a run takes is the workspace-local controller lock
# above.
