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
  local first_untracked
  ! git -C "$repo" diff --quiet HEAD --binary -- . ":(exclude)agents/benchmarks/history/*.jsonl" 2>/dev/null \
    && return 0
  first_untracked="$(
    git -C "$repo" ls-files --others --exclude-standard \
      | grep -Ev '^agents/benchmarks/history/[^/]+\.jsonl$' \
      | head -1 \
      || true
  )"
  [ -n "$first_untracked" ]
}

# Returned by cloudbench_prepare_workspace_patch when the worktree and the base
# ref differ only by content the patch generator intentionally excludes, so
# there is nothing to ship. This is a normal launch state, NOT a failure: the
# guest simply runs the base ref. Kept distinct from rc=1 (generation broke) so
# a real patch failure can never be silently downgraded to "no delta".
CLOUDBENCH_PATCH_NO_DELTA=2

# Single source of truth for "does this launch ship a workspace patch, and what
# is in it". The launch gate MUST NOT re-derive shippability separately: the
# fleet controller used to gate on "local HEAD != fetchable base" while
# create-worktree-patch.sh excluded append-only history ledgers, so a /descend
# run whose only unpushed commit was its own timing ledger produced an empty
# patch and the controller aborted the whole fleet (2026-07-27, antibot slice).
cloudbench_prepare_workspace_patch() {  # <repo-root> <base-ref> <out-file> [generator]
  local repo="$1" base_ref="$2" out_file="$3"
  local generator="${4:-$repo/scripts/create-worktree-patch.sh}"

  : > "$out_file" || return 1
  if ! bash "$generator" "$repo" "$base_ref" > "$out_file"; then
    : > "$out_file"
    return 1
  fi
  if [ ! -s "$out_file" ]; then
    : > "$out_file"
    return "$CLOUDBENCH_PATCH_NO_DELTA"
  fi
  return 0
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

cloudbench_detach_reexec_tracked() {  # <owner-file> <log-file> <argv...>
  # The detached process is reparented after setsid, so a supervising waiter
  # cannot discover or signal it through the ordinary descendant tree. Publish
  # an atomic PID + birth-identity handshake before exec and do not return until
  # the parent side has observed that exact record.
  local owner_file="$1" log="$2"
  shift 2
  python3 - "$owner_file" "$log" "$@" <<'PY'
import os
import signal
import subprocess
import sys
import time

owner_file, log, *argv = sys.argv[1:]
child_pid = os.fork()
if child_pid:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            fields = {}
            with open(owner_file) as handle:
                for raw in handle:
                    key, _, value = raw.rstrip("\n").partition("=")
                    fields[key] = value
            if int(fields.get("pid", "0")) == child_pid and fields.get("pid_start"):
                raise SystemExit(0)
        except (OSError, ValueError):
            pass
        exited, status = os.waitpid(child_pid, os.WNOHANG)
        if exited:
            raise SystemExit(os.waitstatus_to_exitcode(status))
        time.sleep(0.05)
    try:
        os.kill(child_pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    print("FATAL: detached process did not publish its ownership handshake", file=sys.stderr)
    raise SystemExit(1)

os.setsid()
pid = os.getpid()
pid_start = " ".join(
    subprocess.check_output(
        ["ps", "-p", str(pid), "-o", "lstart="],
        text=True,
        stderr=subprocess.DEVNULL,
    ).split()
)
owner_tmp = f"{owner_file}.tmp.{pid}"
with open(owner_tmp, "w") as handle:
    handle.write("version=1\n")
    handle.write(f"pid={pid}\n")
    handle.write(f"pid_start={pid_start}\n")
    handle.write(f"pgid={os.getpgrp()}\n")
    handle.flush()
    os.fsync(handle.fileno())
os.replace(owner_tmp, owner_file)

fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
null = os.open(os.devnull, os.O_RDONLY)
os.dup2(null, 0)
os.execvp(argv[0], argv)
PY
}

cloudbench_tracked_owner_value() {  # <owner-file> <key>
  local owner_file="$1" key="$2"
  sed -n "s/^${key}=//p" "$owner_file" 2>/dev/null | head -1
}

cloudbench_process_group_exists() {  # <pgid>
  local pgid="$1"
  ps -axo pgid= 2>/dev/null |
    awk -v wanted="$pgid" '$1 == wanted { found = 1 } END { exit !found }'
}

cloudbench_signal_tracked_group() {  # <pid> <pid-start> <signal>
  local pid="$1" pid_start="$2" signal_name="$3"
  cloudbench_pid_matches_start "$pid" "$pid_start" || return 1
  kill -s "$signal_name" -- "-$pid" 2>/dev/null
}

cloudbench_wait_tracked_detached() {  # <owner-file> <status-file>
  local owner_file="$1" status_file="$2"
  shift 2
  local recovery_command=("$@")
  local pid pid_start pgid status pending_signal="" forwarded_signal=""
  local recovery_seconds="${CLOUDBENCH_DETACHED_RECOVERY_SECONDS:-120}"
  local recovery_deadline=0 drain_deadline recovery_required=0

  pid="$(cloudbench_tracked_owner_value "$owner_file" pid)"
  pid_start="$(cloudbench_tracked_owner_value "$owner_file" pid_start)"
  pgid="$(cloudbench_tracked_owner_value "$owner_file" pgid)"
  case "$pid:$pgid" in
    ''|*[!0-9:]*|:*|*:)
      echo "FATAL: detached ownership handshake is malformed" >&2
      return 1
      ;;
  esac
  [ "$pid" = "$pgid" ] && [ -n "$pid_start" ] || {
    echo "FATAL: detached ownership handshake does not identify its session group" >&2
    return 1
  }
  case "$recovery_seconds" in
    ''|*[!0-9]*|0)
      echo "FATAL: detached recovery seconds must be a positive integer" >&2
      return 1
      ;;
  esac

  # A cooperative signal to the waiter must reach the reparented controller.
  # Traps only queue intent; the loop validates PID birth identity immediately
  # before signaling the owned process group.
  trap 'pending_signal=HUP' HUP
  trap 'pending_signal=INT' INT
  trap 'pending_signal=TERM' TERM

  while :; do
    if [ -n "$pending_signal" ] && [ -z "$forwarded_signal" ]; then
      if cloudbench_signal_tracked_group "$pid" "$pid_start" "$pending_signal"; then
        forwarded_signal="$pending_signal"
        recovery_deadline=$((SECONDS + recovery_seconds))
        echo "⚰️  forwarded $pending_signal to detached fleet process group $pgid" >&2
      else
        echo "⚠️  detached fleet owner vanished before $pending_signal forwarding" >&2
      fi
    fi

    # Once cancellation is forwarded, a status marker alone is not terminal:
    # the controller can publish 143 while TERM-resistant descendants still
    # own provider resources. Bound the full process-group drain, then escalate
    # the still-live owned group. Only consume status after the group is gone.
    if [ -n "$forwarded_signal" ]; then
      if cloudbench_process_group_exists "$pgid"; then
        if [ "$SECONDS" -ge "$recovery_deadline" ]; then
          echo "⚠️  detached fleet group survived bounded $forwarded_signal recovery; escalating" >&2
          if cloudbench_pid_matches_start "$pid" "$pid_start" \
              || cloudbench_process_group_exists "$pgid"; then
            kill -s KILL -- "-$pgid" 2>/dev/null || true
          fi
          drain_deadline=$((SECONDS + 10))
          while cloudbench_process_group_exists "$pgid" \
              && [ "$SECONDS" -lt "$drain_deadline" ]; do
            sleep 0.1 || true
          done
          if cloudbench_process_group_exists "$pgid"; then
            trap - HUP INT TERM
            echo "FATAL: detached fleet process group did not drain after KILL" >&2
            return 1
          fi
          recovery_required=1
        else
          sleep 1 || true
          continue
        fi
      fi
      # Even cooperative cancellation gets an out-of-process ownership pass.
      # The wrapper can publish 143 before the controller's EXIT cleanup
      # finishes or fails; group drain proves no process can still mutate the
      # provider, while durable reconciliation proves paid resources are gone.
      recovery_required=1

      # EXIT status publication can lag process-group teardown by a few
      # scheduler ticks. Keep this grace bounded so KILLed wrappers cannot
      # leave their durable waiter polling forever.
      if [ "$recovery_required" = "1" ]; then
        if [ "${#recovery_command[@]}" -eq 0 ]; then
          trap - HUP INT TERM
          echo "FATAL: detached cancellation has no durable ownership recovery command" >&2
          return 1
        fi
        if ! "${recovery_command[@]}"; then
          trap - HUP INT TERM
          echo "FATAL: detached cancellation could not reconcile durable ownership" >&2
          return 1
        fi
      fi
      for _ in $(seq 1 20); do
        [ -s "$status_file" ] && break
        sleep 0.1 || true
      done
      if [ ! -s "$status_file" ]; then
        trap - HUP INT TERM
        rm -f "$owner_file" "$status_file" "$owner_file".tmp.* "$status_file".tmp.* \
          2>/dev/null || true
        echo "FATAL: cancelled detached fleet exited without a status marker" >&2
        return 1
      fi
      break
    fi

    [ -s "$status_file" ] && break

    # A wrapper can be SIGKILLed or fail before atomically publishing status.
    # Never poll forever. If its original process group still has members,
    # request controller cleanup and wait a bounded interval before escalating.
    if ! cloudbench_pid_matches_start "$pid" "$pid_start"; then
      # The wrapper writes status from its EXIT trap. Process reaping and file
      # visibility can race by a few scheduler ticks; give the atomic rename a
      # short bounded grace before classifying the marker as missing.
      for _ in $(seq 1 20); do
        [ -s "$status_file" ] && break
        sleep 0.1 || true
      done
      [ -s "$status_file" ] && continue
      if cloudbench_process_group_exists "$pgid"; then
        kill -s TERM -- "-$pgid" 2>/dev/null || true
        recovery_deadline=$((SECONDS + recovery_seconds))
        while cloudbench_process_group_exists "$pgid" \
            && [ "$SECONDS" -lt "$recovery_deadline" ]; do
          sleep 1 || true
        done
        if cloudbench_process_group_exists "$pgid"; then
          echo "⚠️  detached fleet group survived bounded TERM recovery; escalating" >&2
          kill -s KILL -- "-$pgid" 2>/dev/null || true
        fi
        drain_deadline=$((SECONDS + 10))
        while cloudbench_process_group_exists "$pgid" \
            && [ "$SECONDS" -lt "$drain_deadline" ]; do
          sleep 0.1 || true
        done
        if cloudbench_process_group_exists "$pgid"; then
          trap - HUP INT TERM
          echo "FATAL: detached fleet process group did not drain during wrapper recovery" >&2
          return 1
        fi
      fi
      if [ "${#recovery_command[@]}" -eq 0 ]; then
        trap - HUP INT TERM
        echo "FATAL: dead detached wrapper has no durable ownership recovery command" >&2
        return 1
      fi
      if ! "${recovery_command[@]}"; then
        trap - HUP INT TERM
        echo "FATAL: dead detached wrapper could not reconcile durable ownership" >&2
        return 1
      fi
      trap - HUP INT TERM
      rm -f "$owner_file" "$status_file" "$owner_file".tmp.* "$status_file".tmp.* \
        2>/dev/null || true
      echo "FATAL: detached fleet wrapper exited without a status marker" >&2
      return 1
    fi
    sleep 1 || true
  done

  trap - HUP INT TERM
  status="$(head -1 "$status_file" 2>/dev/null || true)"
  rm -f "$owner_file" "$status_file" "$owner_file".tmp.* "$status_file".tmp.* \
    2>/dev/null || true
  case "$status" in
    ''|*[!0-9]*)
      echo "FATAL: detached fleet wrote an invalid exit status: ${status:-empty}" >&2
      return 1
      ;;
  esac
  if [ "$status" -gt 255 ]; then
    echo "FATAL: detached fleet wrote an out-of-range exit status: $status" >&2
    return 1
  fi
  return "$status"
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

cloudbench_pid_start_time() {
  local pid="$1"
  ps -p "$pid" -o lstart= 2>/dev/null |
    awk '{$1=$1; print}'
}

cloudbench_pid_matches_start() {
  local pid="$1" expected_start="$2" actual_start
  [ -n "$expected_start" ] || return 1
  actual_start="$(cloudbench_pid_start_time "$pid")"
  [ -n "$actual_start" ] && [ "$actual_start" = "$expected_start" ]
}

cloudbench_terminate_tree_and_wait() {
  local timeout_seconds="$1"
  shift

  local pid job_pid start deadline live i
  local roots=() active_roots=() active_jobs=() targets=() target_starts=()
  for pid in "$@"; do
    [ -n "$pid" ] && roots+=("$pid")
  done
  [ "${#roots[@]}" -gt 0 ] || return 0

  # A completed background job can leave its numeric PID in a caller's array.
  # Never rediscover ownership from that number: by cleanup time the OS may
  # have reused it for an unrelated process. Only roots still registered as
  # live jobs of this exact shell are eligible for tree capture.
  while read -r job_pid; do
    [ -n "$job_pid" ] && active_jobs+=("$job_pid")
  done < <(jobs -pr)
  for pid in "${roots[@]}"; do
    for job_pid in "${active_jobs[@]:-}"; do
      if [ "$pid" = "$job_pid" ]; then
        active_roots+=("$pid")
        break
      fi
    done
  done
  [ "${#active_roots[@]}" -gt 0 ] || return 0

  # Autoscalers and provisioners can be blocked inside nested command
  # substitutions (bash -> timeout helper -> flyctl). Killing only the tracked
  # shell reparents those descendants to init, allowing them to mutate durable
  # ownership after controller cleanup has completed. Snapshot the complete,
  # currently-live descendant forest with process birth identity before sending
  # any signal. A root that vanished between jobs(1) and ps(1) is intentionally
  # absent.
  while IFS=$'\t' read -r pid start; do
    if [ -n "$pid" ] && [ -n "$start" ]; then
      targets+=("$pid")
      target_starts+=("$start")
    fi
  done < <(
    ps -axo pid=,ppid=,lstart= 2>/dev/null | python3 -c '
import sys

roots = [int(value) for value in sys.argv[1:]]
children = {}
processes = {}
for raw in sys.stdin:
    fields = raw.split(None, 2)
    if len(fields) != 3:
        continue
    try:
        pid, ppid = map(int, fields[:2])
    except ValueError:
        continue
    processes[pid] = (ppid, " ".join(fields[2].split()))
    children.setdefault(ppid, []).append(pid)

seen = set()
ordered = []

def visit(pid):
    if pid in seen or pid not in processes:
        return
    seen.add(pid)
    for child in children.get(pid, ()):
        visit(child)
    ordered.append((pid, processes[pid][1]))

for root in roots:
    visit(root)
for pid, start in ordered:
    print(f"{pid}\t{start}")
' "${active_roots[@]}"
  )
  [ "${#targets[@]}" -gt 0 ] || return 0

  # Revalidate birth identity immediately before every signal. This prevents a
  # TERM-responsive target that exits during another descendant's grace period
  # from turning the later SIGKILL into a signal to a reused, unrelated PID.
  # Signal parents before children. Because the complete forest is already
  # captured, reparenting cannot lose a target; parent-first ordering prevents
  # a waiting shell from resuming and mutating state when its child exits.
  for ((i = ${#targets[@]} - 1; i >= 0; i--)); do
    cloudbench_pid_matches_start "${targets[$i]}" "${target_starts[$i]}" &&
      kill "${targets[$i]}" 2>/dev/null || true
  done

  deadline=$((SECONDS + timeout_seconds))
  while :; do
    live=0
    for ((i = 0; i < ${#targets[@]}; i++)); do
      if cloudbench_pid_matches_start "${targets[$i]}" "${target_starts[$i]}"; then
        live=1
        break
      fi
    done
    [ "$live" -eq 0 ] && break
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 1
  done

  for ((i = ${#targets[@]} - 1; i >= 0; i--)); do
    if cloudbench_pid_matches_start "${targets[$i]}" "${target_starts[$i]}"; then
      kill -KILL "${targets[$i]}" 2>/dev/null || true
    fi
  done
  # Only direct children are waitable by this shell. Waiting roots is enough
  # to reap the tracked jobs; descendant liveness was handled above.
  for pid in "${active_roots[@]}"; do
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
