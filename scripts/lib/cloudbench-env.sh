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
    key = key.strip()
    if key.startswith("export") and key[6:7].isspace():  # dotenv's `export KEY=value`
        key = key[6:].strip()
    if key != wanted:
        continue
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    print(value)
    break
PY
}

# Number of distinct values assigned to <key> in a dotenv file (`KEY=` or
# `export KEY=`). Repeated identical assignments count once.
cloudbench_env_distinct_value_count() {  # <path> <key>
  python3 - "$1" "$2" <<'PY'
from pathlib import Path
import sys

path, wanted = sys.argv[1:3]
values = set()
for raw in Path(path).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    key = key.strip()
    if key.startswith("export") and key[6:7].isspace():
        key = key[6:].strip()
    if key != wanted:
        continue
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    values.add(value)
print(len(values))
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

# The controller stages this immutable source manifest separately from app
# secrets. Call before decoding either blob: the companion app-secret digests
# alone permit a coherent rotation to change an already prepared source.
cloudbench_verify_source_guest_env() {
  local source_env_helper="${CLOUDBENCH_SOURCE_ENV_HELPER:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/cloudbench-source-env.py}"
  [ -f "$source_env_helper" ] || { echo 'FATAL: missing source environment loader' >&2; return 1; }
  local source_env_mode
  source_env_mode="$(python3 "$source_env_helper" mode)" || return 1
  case "$source_env_mode" in
    none) ;;
    owned-capsule-v1) python3 "$source_env_helper" check-effective || return 1 ;;
    *) return 1 ;;
  esac
  python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

def need(value):
    if not value:
        raise ValueError('source guest environment contract rejected')

def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result)
        result[key] = value
    return result

def read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_size <= 1024 * 1024)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(1024 * 1024 + 1)
        after = os.fstat(fd)
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
             == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))
        need(len(raw) == before.st_size)
        return raw
    finally:
        os.close(fd)

try:
    path, expected, protocol = (os.environ.get(key, '') for key in (
        'CLOUDBENCH_SOURCE_MANIFEST_FILE', 'CLOUDBENCH_SOURCE_MANIFEST_SHA256',
        'CLOUDBENCH_SOURCE_LEASE_PROTOCOL'))
    provenance = os.environ.get('CLOUDBENCH_EXECUTION_PROVENANCE_FILE', '')
    # Prefer an existing controller-owned destination to an arbitrary ambient
    # path. The trusted worker wrapper selects /data; primary boot selects /.
    fixed = ('/cloudbench-execution-provenance.json', '/data/cloudbench-execution-provenance.json')
    candidates = ((provenance,) if provenance in fixed else ()) + fixed
    provenance = next((candidate for candidate in candidates if os.path.lexists(candidate)), provenance)
    document = json.loads(read(provenance), object_pairs_hook=unique) if provenance else None
    if provenance:
        need(isinstance(document, dict) and isinstance(document.get('config'), dict)
             and isinstance(document['config'].get('values'), dict))
    source_protocol = document['config']['values'].get('base_source_lease_protocol', 'none') if provenance else 'none'
    need(source_protocol in ('none', 'cloudbench-source-lease-v1'))
    if not any((path, expected, protocol)):
        need(source_protocol == 'none')
        sys.exit(0)  # Historical V1 launches have no source contract.
    need(path and os.path.isabs(path) and re.fullmatch('[a-f0-9]{64}', expected)
         and protocol == 'cloudbench-source-lease-v1')
    raw = read(path)
    need(hashlib.sha256(raw).hexdigest() == expected)
    manifest = json.loads(raw, object_pairs_hook=unique)
    need(isinstance(manifest, dict) and type(manifest.get('version')) is int
         and manifest['version'] == 2 and manifest.get('lease_protocol') == protocol)
    mode = manifest.get('guest_env_mode', 'none')
    capsule = manifest.get('guest_env_capsule_sha256', 'none')
    need(mode in ('none', 'owned-capsule-v1'))
    need(os.environ.get('CLOUDBENCH_SOURCE_GUEST_ENV_MODE', 'none') == mode
         and os.environ.get('CLOUDBENCH_SOURCE_GUEST_ENV_CAPSULE_SHA256', 'none') == capsule)
    if document:
        need(document['config']['values'].get('base_source_guest_env_mode', 'none') == mode
             and document['config']['values'].get('base_source_guest_env_capsule_sha256', 'none') == capsule)
    contract = manifest.get('guest_env_sha256')
    need(isinstance(contract, dict) and set(contract) == {'AGENTS_ENV_B64', 'BACKEND_ENV_B64'})
    need(all(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) for value in contract.values()))
    if document:
        need(document['config']['values']['base_source_manifest_sha256'] == expected)
    observed = {}
    for key, digest in contract.items():
        value = os.environ.get(key, '')
        need(value)
        observed[key] = hashlib.sha256(value.encode()).hexdigest()
        need(observed[key] == digest)
    machine = os.environ.get('FLY_MACHINE_ID', '')
    token = os.environ.get('CLOUDBENCH_RUN_TOKEN', '')
    need(re.fullmatch('[a-f0-9]+', machine) and re.fullmatch('[A-Za-z0-9._-]{1,160}', token))
    receipt = dict(schema='cloudbench-source-guest-env-v1', machine_id=machine,
                   run_token=token, source_manifest_sha256=expected, guest_env_sha256=observed)
    if mode == 'owned-capsule-v1':
        receipt.update(guest_env_mode=mode, guest_env_capsule_sha256=capsule)
    directory = Path(os.environ.get('CLOUDBENCH_DATA_DIR', '/data'))
    need(directory.is_absolute())
    target = directory / ('cloudbench-source-guest-env-' + token + '.json')
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        saved = json.loads(read(target), object_pairs_hook=unique)
        need(type(saved.pop('observed_at', None)) is int and saved == receipt)
    else:
        with os.fdopen(fd, 'wb') as stream:
            stream.write((json.dumps(dict(receipt, observed_at=int(time.time())), sort_keys=True) + '\n').encode())
            stream.flush()
            os.fsync(stream.fileno())
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
except (ValueError, OSError, KeyError, TypeError):
    print('FATAL: prepared source guest environment contract rejected', file=sys.stderr)
    sys.exit(1)
PY
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
    | python3 -S -c 'import json,sys; print(json.load(sys.stdin).get("hub_runs_dir", ""))' \
      2>/dev/null
}

cloudbench_central_hub_matches() {  # <port> <expected-runs-root>
  local actual_root expected_root
  expected_root="$(python3 -S -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$2")"
  actual_root="$(cloudbench_central_hub_runs_root "$1" || true)"
  [ -n "$actual_root" ] && [ "$actual_root" = "$expected_root" ]
}

cloudbench_central_hub_owner_matches() {  # <port> <runs-root> <repo-root> <owner-file>
  local port="$1" runs_root="$2" repo_root="$3" owner_file="$4"
  local metadata pid pid_start pgid actual_pgid
  [ -f "$owner_file" ] || return 1
  metadata="$(curl --noproxy '*' -fsS --max-time 2 \
    "http://127.0.0.1:$port/hub-meta.json" 2>/dev/null)" || return 1
  HUB_METADATA_JSON="$metadata" python3 -S - "$owner_file" "$port" \
    "$runs_root" "$repo_root" <<'PY' || return 1
import json
import os
import stat
import sys
from pathlib import Path

owner_path = Path(sys.argv[1])
port = int(sys.argv[2])
runs_root = Path(sys.argv[3]).resolve()
repo_root = Path(sys.argv[4]).resolve()
context_dir = (runs_root / "_hub").resolve()
command = (repo_root / "agents/benchmarks/agent_link_server.py").resolve()

fields = {}
for raw in owner_path.read_text(encoding="utf-8").splitlines():
    key, separator, value = raw.partition("=")
    if not separator or key in fields:
        raise SystemExit(1)
    fields[key] = value
required = {
    "version", "pid", "pid_start", "pgid", "owner_token", "command",
    "argv_sha256", "root", "runs_root", "repo_root", "context_dir",
    "host", "port", "status",
}
if set(fields) != required or fields["version"] != "1":
    raise SystemExit(1)
try:
    pid = int(fields["pid"])
    pgid = int(fields["pgid"])
    owner_port = int(fields["port"])
except ValueError:
    raise SystemExit(1)
token = fields["owner_token"]
digest = fields["argv_sha256"]
if (
    pid <= 1
    or pgid != pid
    or owner_port != port
    or len(token) != 32
    or any(character not in "0123456789abcdef" for character in token)
    or len(digest) != 64
    or any(character not in "0123456789abcdef" for character in digest)
    or not fields["pid_start"]
    or fields["host"] != "127.0.0.1"
    or fields["status"] != "live-transfer-required"
    or Path(fields["root"]).resolve() != runs_root
    or Path(fields["runs_root"]).resolve() != runs_root
    or Path(fields["repo_root"]).resolve() != repo_root
    or Path(fields["context_dir"]).resolve() != context_dir
    or Path(fields["command"]).resolve() != command
    or owner_path.resolve().parent != context_dir
    or owner_path.name != f"agent-link-server.{port}.{token}.owner"
    or stat.S_IMODE(owner_path.stat().st_mode) & 0o222
):
    raise SystemExit(1)

try:
    metadata = json.loads(os.environ["HUB_METADATA_JSON"])
except (KeyError, TypeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
if not isinstance(metadata, dict):
    raise SystemExit(1)
try:
    metadata_pid = int(metadata.get("pid", 0))
    metadata_port = int(metadata.get("port", 0))
except (TypeError, ValueError):
    raise SystemExit(1)
if (
    metadata_pid != pid
    or metadata_port != port
    or metadata.get("pid_start") != fields["pid_start"]
    or metadata.get("owner_token") != token
    or metadata.get("argv_sha256") != digest
    or Path(str(metadata.get("root", ""))).resolve() != runs_root
    or Path(str(metadata.get("hub_runs_dir", ""))).resolve() != runs_root
    or Path(str(metadata.get("repo_root", ""))).resolve() != repo_root
    or Path(str(metadata.get("context_dir", ""))).resolve() != context_dir
    or Path(str(metadata.get("command", ""))).resolve() != command
):
    raise SystemExit(1)
PY
  pid="$(cloudbench_tracked_owner_value "$owner_file" pid)"
  pid_start="$(cloudbench_tracked_owner_value "$owner_file" pid_start)"
  pgid="$(cloudbench_tracked_owner_value "$owner_file" pgid)"
  cloudbench_pid_matches_start "$pid" "$pid_start" || return 1
  actual_pgid="$(ps -p "$pid" -o pgid= 2>/dev/null | awk '{$1=$1; print}')"
  [ "$pgid" = "$pid" ] && [ "$actual_pgid" = "$pgid" ]
}

cloudbench_central_hub_owner_for() {  # <port> <runs-root> <repo-root>
  local port="$1" runs_root="$2" repo_root="$3" owner_file
  for owner_file in "$runs_root/_hub"/agent-link-server."$port".*.owner; do
    [ -f "$owner_file" ] || continue
    if cloudbench_central_hub_owner_matches "$port" "$runs_root" \
      "$repo_root" "$owner_file"; then
      printf '%s\n' "$owner_file"
      return 0
    fi
  done
  return 1
}

cloudbench_terminate_central_hub_owner() {  # <port> <runs-root> <repo-root> <owner-file> [seconds]
  local port="$1" runs_root="$2" repo_root="$3" owner_file="$4"
  local timeout_seconds="${5:-5}" pid pid_start pgid deadline group_state
  case "$timeout_seconds" in ''|*[!0-9]*|0) return 1 ;; esac
  cloudbench_central_hub_owner_matches "$port" "$runs_root" "$repo_root" \
    "$owner_file" || return 1
  pid="$(cloudbench_tracked_owner_value "$owner_file" pid)"
  pid_start="$(cloudbench_tracked_owner_value "$owner_file" pid_start)"
  pgid="$(cloudbench_tracked_owner_value "$owner_file" pgid)"
  cloudbench_signal_tracked_group "$pid" "$pid_start" TERM || return 1
  deadline=$((SECONDS + timeout_seconds))
  while cloudbench_pid_matches_start "$pid" "$pid_start" \
    && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.1
  done
  if cloudbench_pid_matches_start "$pid" "$pid_start"; then
    cloudbench_signal_tracked_group "$pid" "$pid_start" KILL || return 1
  fi
  deadline=$((SECONDS + 10))
  group_state="$(cloudbench_process_group_state "$pgid")"
  while [ "$group_state" = "live" ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.1
    group_state="$(cloudbench_process_group_state "$pgid")"
  done
  [ "$group_state" = "absent" ] || return 1
  python3 - "$owner_file" <<'PY'
import hashlib
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
owner_bytes = path.read_bytes()
fields = {}
for raw in owner_bytes.decode("utf-8").splitlines():
    key, separator, value = raw.partition("=")
    if not separator or key in fields:
        raise SystemExit(1)
    fields[key] = value
terminal = path.with_name(f"{path.name}.terminal")
terminal_fields = {
    "version": "1",
    "owner_file": str(path.resolve()),
    "owner_sha256": hashlib.sha256(owner_bytes).hexdigest(),
    "pid": fields.get("pid", ""),
    "pid_start": fields.get("pid_start", ""),
    "pgid": fields.get("pgid", ""),
    "owner_token": fields.get("owner_token", ""),
    "disposition": "terminated-verified",
    "terminated_at": datetime.now(timezone.utc).isoformat(),
}
temporary = terminal.with_name(f"{terminal.name}.tmp.{os.getpid()}")
try:
    with temporary.open("x", encoding="utf-8") as handle:
        for key, value in terminal_fields.items():
            handle.write(f"{key}={value}\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.chmod(0o444)
    os.replace(temporary, terminal)
finally:
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
PY
}

cloudbench_tcp_listener_present() {  # <port>
  # lsof is present on macOS developer hosts but absent from the Amazon Linux
  # cloud controller image.  Treating command-not-found as "no listener" made
  # the fleet select an occupied foreign hub port.  A TCP connect probe answers
  # the question we actually need here and is portable to every controller
  # because Python is already a hard cloudbench dependency.
  #
  # Exit codes:
  #   0 — listener present
  #   1 — no listener (port free)
  #   2 — bad argument
  #   3 — probe failed (timeout / python / unexpected); callers must fail closed
  python3 -S - "$1" <<'PY'
import errno
import socket
import sys

try:
    port = int(sys.argv[1])
except (IndexError, ValueError):
    raise SystemExit(2)
if not 1 <= port <= 65535:
    raise SystemExit(2)

try:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        result = probe.connect_ex(("127.0.0.1", port))
        if result in (0, errno.EAGAIN, errno.EWOULDBLOCK):
            # A full accept backlog can return EAGAIN on macOS; the port is
            # still occupied and must not be selected for another hub.
            raise SystemExit(0)
        if result == errno.ECONNREFUSED:
            raise SystemExit(1)
        raise SystemExit(3)
except SystemExit:
    raise
except Exception:
    raise SystemExit(3)
PY
}

cloudbench_tcp_port_bindable() {  # <port>
  # Mirrors the hub's own bind (127.0.0.1 with SO_REUSEADDR, as
  # http.server.HTTPServer sets it), then releases the port immediately.
  #
  # Exit codes:
  #   0 — bindable now
  #   1 — address in use (non-listening occupant or a listener that just won)
  #   2 — bad argument
  #   3 — probe failed; callers must fail closed
  python3 -S - "$1" <<'PY'
import errno
import socket
import sys

try:
    port = int(sys.argv[1])
except (IndexError, ValueError):
    raise SystemExit(2)
if not 1 <= port <= 65535:
    raise SystemExit(2)

try:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))
except OSError as error:
    raise SystemExit(1 if error.errno == errno.EADDRINUSE else 3)
except Exception:
    raise SystemExit(3)
PY
}

cloudbench_select_central_hub_port() {  # <preferred-port> <expected-runs-root>
  local preferred="$1" expected_root="$2" candidate probe_rc

  # A Conductor port can be reused while another workspace's persistent hub is
  # still alive. Reuse a listener only when it identifies the same runs root;
  # otherwise leave that workspace untouched and select the first free/matching
  # port. The identity endpoint also makes a previously rebased hub reusable by
  # later runs from this workspace.
  for candidate in $(seq "$preferred" $((preferred + 500))); do
    # Capture probe_rc BEFORE interpreting it. `if cmd; then …; fi` resets $?
    # to 0 when cmd is false and there is no else — so reading $? after the if
    # always looked like "probe failed with rc=0" on free ports and refused
    # fail-open even when the port was actually free (broke hub bring-up).
    cloudbench_tcp_listener_present "$candidate"
    probe_rc=$?
    if [ "$probe_rc" -eq 0 ]; then
      if cloudbench_central_hub_matches "$candidate" "$expected_root"; then
        printf '%s\n' "$candidate"
        return 0
      fi
      continue
    fi
    if [ "$probe_rc" -eq 1 ]; then
      # A refused connect only proves nobody is listening. A loopback client's
      # ephemeral port, its 60-second TIME_WAIT or a bound-only socket still
      # makes the hub's bind fail with EADDRINUSE, and every start attempt
      # would otherwise reselect that same port. Skip it like a foreign hub.
      cloudbench_tcp_port_bindable "$candidate"
      probe_rc=$?
      if [ "$probe_rc" -eq 0 ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
      [ "$probe_rc" -eq 1 ] && continue
    fi
    echo "FATAL: central hub TCP probe failed on port ${candidate} (rc=${probe_rc}); refusing fail-open port selection" >&2
    return 1
  done

  echo "FATAL: no free central benchmark hub port in ${preferred}..$((preferred + 500))" >&2
  return 1
}

# Benchmark guests may use their own Temporal Cloud namespace so their workers,
# autoscaler queue observations and stale-workflow sweeps never spend the
# production namespace's action and Visibility API budgets.
#
#   controller agents/.env + back-end/.env ──(unchanged, prod settings)──┐
#   private override (.env.benchmark-temporal, 0600) ──► guest copies only ─┴─► AGENTS_ENV_B64/BACKEND_ENV_B64
#
# The override file holds exactly CLOUDBENCH_GUEST_TEMPORAL_ADDRESS,
# CLOUDBENCH_GUEST_TEMPORAL_NAMESPACE and CLOUDBENCH_GUEST_TEMPORAL_API_KEY.
# Default location: beside the real (symlink-resolved) agents/.env, else the
# main checkout's agents/.env.benchmark-temporal for a linked Git worktree. Set
# CLOUDBENCH_GUEST_TEMPORAL_ENV_FILE=<path> to choose another file (which must
# then exist) or =off to stage the controller's settings unchanged. No file (or
# =off) stages the controller's bytes, which
# cloudbench_require_staged_guest_temporal_namespace refuses for any app with a
# committed guest namespace unless they already carry it.
cloudbench_guest_temporal_override_file() {  # [agents-env]; prints path or nothing
  local explicit="${CLOUDBENCH_GUEST_TEMPORAL_ENV_FILE-}" agents_env="${1:-agents/.env}" candidate common
  [ "$explicit" = off ] && return 0
  if [ -n "$explicit" ]; then
    [ -f "$explicit" ] || {
      echo "❌ CLOUDBENCH_GUEST_TEMPORAL_ENV_FILE=$explicit does not exist." >&2
      return 1
    }
    printf '%s\n' "$explicit"
    return 0
  fi
  candidate="$(python3 -c 'import os, sys; print(os.path.join(os.path.dirname(os.path.realpath(sys.argv[1])), ".env.benchmark-temporal"))' "$agents_env")" || return 1
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
    common="$(git -C "$(dirname "$agents_env")" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
    candidate=""
    if [ "$(basename "${common:-x}")" = .git ]; then
      candidate="$(dirname "$common")/agents/.env.benchmark-temporal"
    fi
  fi
  if [ -n "$candidate" ] && { [ -e "$candidate" ] || [ -L "$candidate" ]; }; then
    printf '%s\n' "$candidate"
  fi
  return 0
}

# cloudbench_write_guest_temporal_env_files <agents-env> <backend-env> <override> <private-out-dir>
# Writes <out>/agents.env and <out>/backend.env: byte copies of the sources with
# only TEMPORAL_ADDRESS/TEMPORAL_NAMESPACE/TEMPORAL_API_KEY replaced (appended
# when absent). Never modifies the sources. Prints the guest namespace.
cloudbench_write_guest_temporal_env_files() {
  python3 - "$@" <<'PY'
import os, re, stat, sys

agents_env, backend_env, override, out_dir = sys.argv[1:5]
REQUIRED = {
    "CLOUDBENCH_GUEST_TEMPORAL_ADDRESS": "TEMPORAL_ADDRESS",
    "CLOUDBENCH_GUEST_TEMPORAL_NAMESPACE": "TEMPORAL_NAMESPACE",
    "CLOUDBENCH_GUEST_TEMPORAL_API_KEY": "TEMPORAL_API_KEY",
}

def die(message):
    print("❌ guest Temporal override: " + message, file=sys.stderr)
    raise SystemExit(1)

info = os.stat(override)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
    die("%s must be a regular file owned by this user with mode 0600" % override)
values = {}
with open(override, encoding="utf-8") as handle:
    for number, line in enumerate(handle, 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"(?:export\s+)?([A-Z0-9_]+)=(.*)", line)
        if not match or match.group(1) not in REQUIRED:
            die("%s line %d is not one of %s" % (override, number, ", ".join(sorted(REQUIRED))))
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not value or re.search(r"[\s\"'#]", value):
            die("%s has an empty or unquotable %s" % (override, match.group(1)))
        if match.group(1) in values:
            die("%s repeats %s" % (override, match.group(1)))
        values[match.group(1)] = value
missing = sorted(set(REQUIRED) - set(values))
if missing:
    die("%s is missing %s" % (override, ", ".join(missing)))
if not re.fullmatch(r"[A-Za-z0-9.-]+:[0-9]+", values["CLOUDBENCH_GUEST_TEMPORAL_ADDRESS"]):
    die("CLOUDBENCH_GUEST_TEMPORAL_ADDRESS must be host:port")
replacements = {target: values[source] for source, target in REQUIRED.items()}
pattern = re.compile(rb"^(\s*(?:export\s+)?)(" + b"|".join(k.encode() for k in replacements) + rb")\s*=")

info = os.lstat(out_dir)
if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
    die("output directory must be a private directory")

for source, name in ((agents_env, "agents.env"), (backend_env, "backend.env")):
    with open(source, "rb") as handle:
        raw = handle.read()
    lines = raw.splitlines(keepends=True)
    seen = set()
    rendered = []
    for line in lines:
        match = pattern.match(line)
        if match:
            key = match.group(2).decode()
            seen.add(key)
            ending = line[len(line.rstrip(b"\r\n")):]
            line = match.group(1) + match.group(2) + b"=" + replacements[key].encode() + ending
        rendered.append(line)
    body = b"".join(rendered)
    absent = [key for key in replacements if key not in seen]
    if absent and body and not body.endswith(b"\n"):
        body += b"\n"
    for key in absent:
        body += key.encode() + b"=" + replacements[key].encode() + b"\n"
    fd = os.open(os.path.join(out_dir, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(body)
print(replacements["TEMPORAL_NAMESPACE"])
PY
}

# Committed guest Temporal namespace per bench app. The namespace name is not a
# secret (the address and API key stay in the private override), so every host
# and fresh checkout agrees on what the shared bench-app secrets must carry.
# 2026-10-19: a host without the override restaged the bench app with the
# production namespace and the next launch's guests refused to start.
cloudbench_expected_guest_temporal_namespace() {  # <app>; prints namespace or nothing
  case "${1:-}" in
    navi-whisper-lux-bench) printf '%s\n' rose-labs-bench.tch2n ;;
  esac
}

# cloudbench_require_staged_guest_temporal_namespace <app> <override-or-empty> <agents-env> <backend-env>
# Refuses, before any secret is staged, guest copies whose TEMPORAL_NAMESPACE is
# not the app's committed guest namespace. Apps without one are unchecked.
cloudbench_require_staged_guest_temporal_namespace() {
  local app="$1" override="$2" agents_env="$3" backend_env="$4" expected path actual count
  expected="$(cloudbench_expected_guest_temporal_namespace "$app")"
  [ -n "$expected" ] || return 0
  for path in "$agents_env" "$backend_env"; do
    # cloudbench_env_value reads the first assignment while guest dotenv loaders
    # apply the last, so conflicting repeats could pass this check and still run
    # the guest on another namespace. Identical repeats are harmless.
    count="$(cloudbench_env_distinct_value_count "$path" TEMPORAL_NAMESPACE 2>/dev/null)" || count=""
    if [ "$count" != 0 ] && [ "$count" != 1 ]; then
      echo "❌ Refusing to stage $app guest secrets: $(basename "$path") assigns ${count:-an unreadable number of} different TEMPORAL_NAMESPACE values; keep one value, then retry." >&2
      return 1
    fi
    actual="$(cloudbench_env_value "$path" TEMPORAL_NAMESPACE 2>/dev/null)" || actual=""
    [ "$actual" = "$expected" ] && continue
    if [ -z "$override" ]; then
      echo "❌ Refusing to stage $app guest secrets: guests must use Temporal namespace $expected, but no guest Temporal override was found, so they would get this controller's TEMPORAL_NAMESPACE=${actual:-<unset>}. Install the private 0600 agents/.env.benchmark-temporal (CLOUDBENCH_GUEST_TEMPORAL_ADDRESS/_NAMESPACE/_API_KEY) beside the real agents/.env, or point CLOUDBENCH_GUEST_TEMPORAL_ENV_FILE at it, then retry." >&2
    else
      echo "❌ Refusing to stage $app guest secrets: the guest Temporal override $override yields TEMPORAL_NAMESPACE=${actual:-<unset>} in $(basename "$path"), but $app guests must use $expected. Fix CLOUDBENCH_GUEST_TEMPORAL_NAMESPACE in that file, then retry." >&2
    fi
    return 1
  done
}

# cloudbench_require_guest_temporal_namespace <agents-env> <backend-env> <expected>
# A guest decodes the shared bench-app AGENTS_ENV_B64/BACKEND_ENV_B64 secrets,
# which only a maintenance op (--refresh-secrets/--setup/--refresh-wmh) stages.
# run-bench-cloud binds the app's committed guest namespace by default (a
# launcher such as the original600 operator may bind its own), so stale secrets
# fail before any Temporal worker instead of silently running every guest on the
# controller/production namespace. Empty = no check (apps without one).
cloudbench_require_guest_temporal_namespace() {
  local agents_env="$1" backend_env="$2" expected="${3:-}" path actual count
  [ -n "$expected" ] || return 0
  for path in "$agents_env" "$backend_env"; do
    count="$(cloudbench_env_distinct_value_count "$path" TEMPORAL_NAMESPACE 2>/dev/null)" || count=""
    if [ "$count" != 0 ] && [ "$count" != 1 ]; then
      echo "FATAL: guest $(basename "$path") assigns ${count:-an unreadable number of} different TEMPORAL_NAMESPACE values; the loaded value is ambiguous. Restage the bench app secrets with one value." >&2
      return 1
    fi
    actual="$(cloudbench_env_value "$path" TEMPORAL_NAMESPACE 2>/dev/null)" || actual=""
    if [ "$actual" != "$expected" ]; then
      echo "FATAL: guest $(basename "$path") TEMPORAL_NAMESPACE=${actual:-<unset>} differs from the launcher's guest namespace $expected; the bench app secrets predate the guest override. Restage them: bash scripts/run-bench-cloud --refresh-secrets" >&2
      return 1
    fi
  done
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

# AgentCard Organization MCP cardholder resolution needs both OAuth client
# credentials. Stale Fly BACKEND_ENV_B64 blobs (names-only verify) have shipped
# without them and produced guest 502 Missing AGENTCARD_ORG_OAUTH_CLIENT_ID
# during /descend daily (epoch-3). Fail closed as soon as the decoded .env is
# written — refresh with: bash scripts/run-bench-cloud --refresh-secrets
CLOUDBENCH_AGENTCARD_ORG_OAUTH_MIN_LEN=20
cloudbench_require_agentcard_org_oauth() {
  local backend_env="$1"
  local client_id client_secret
  client_id="$(cloudbench_env_value "$backend_env" AGENTCARD_ORG_OAUTH_CLIENT_ID)"
  client_secret="$(cloudbench_env_value "$backend_env" AGENTCARD_ORG_OAUTH_CLIENT_SECRET)"
  if [ "${#client_id}" -lt "$CLOUDBENCH_AGENTCARD_ORG_OAUTH_MIN_LEN" ]; then
    echo "FATAL: back-end/.env missing AGENTCARD_ORG_OAUTH_CLIENT_ID (len=${#client_id})." >&2
    echo "   Stale BACKEND_ENV_B64 will 502 AgentCard setup. Refresh: bash scripts/run-bench-cloud --refresh-secrets" >&2
    return 1
  fi
  if [ "${#client_secret}" -lt "$CLOUDBENCH_AGENTCARD_ORG_OAUTH_MIN_LEN" ]; then
    echo "FATAL: back-end/.env missing AGENTCARD_ORG_OAUTH_CLIENT_SECRET (len=${#client_secret})." >&2
    echo "   Stale BACKEND_ENV_B64 will 502 AgentCard setup. Refresh: bash scripts/run-bench-cloud --refresh-secrets" >&2
    return 1
  fi
  echo "agentcard org oauth verified: id_len=${#client_id} secret_len=${#client_secret}"
}

# Benchmark guests restore their own database, so without a shared authority
# every guest runs its own compute-token lease semaphore and cooldowns on the
# same real credentials (70 copies held ~80 live leases on one GPT token whose
# capacity is 16 and drew 429s). back-end routes.compute.ts already delegates
# internal /compute-code/* requests to COMPUTE_TOKEN_AUTHORITY_URL; this points
# a guest's backend at production's single lease store. The guest's internal
# BACKEND_API_KEY is production's, so it authenticates the delegation.
# CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL selects another origin; =off keeps the
# guest-local semaphore. An authority already in the env file is left as is.
CLOUDBENCH_DEFAULT_COMPUTE_TOKEN_AUTHORITY_URL=https://navi-j9a9.onrender.com
cloudbench_apply_compute_token_authority() {  # <backend-env>
  local backend_env="$1" url api_key existing
  url="${CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL-$CLOUDBENCH_DEFAULT_COMPUTE_TOKEN_AUTHORITY_URL}"
  if [ "$url" = off ]; then
    echo "compute-token authority: off (guest-local leases)"
    return 0
  fi
  existing="$(cloudbench_env_value "$backend_env" COMPUTE_TOKEN_AUTHORITY_URL)" || return 1
  if [ -n "$existing" ]; then
    [ -n "$(cloudbench_env_value "$backend_env" COMPUTE_TOKEN_AUTHORITY_API_KEY)" ] || {
      echo "FATAL: back-end/.env sets COMPUTE_TOKEN_AUTHORITY_URL without COMPUTE_TOKEN_AUTHORITY_API_KEY" >&2
      return 1
    }
    echo "compute-token authority: $existing (from back-end/.env)"
    return 0
  fi
  case "$url" in
    https://*) ;;
    *) echo "FATAL: compute-token authority must be an https origin, got ${url:-<empty>}" >&2; return 1 ;;
  esac
  url="${url%/}"
  case "${url#https://}" in
    ''|*/*|*@*|*\?*|*\#*) echo "FATAL: compute-token authority must be a bare https origin, got $url" >&2; return 1 ;;
  esac
  api_key="$(cloudbench_env_value "$backend_env" BACKEND_API_KEY)" || return 1
  [ -n "$api_key" ] || {
    echo "FATAL: back-end/.env has no BACKEND_API_KEY to authenticate the compute-token authority" >&2
    return 1
  }
  if [ -s "$backend_env" ] && [ "$(tail -c 1 "$backend_env")" != "" ]; then
    printf '\n' >> "$backend_env"
  fi
  printf 'COMPUTE_TOKEN_AUTHORITY_URL=%s\nCOMPUTE_TOKEN_AUTHORITY_API_KEY=%s\n' "$url" "$api_key" >> "$backend_env"
  echo "compute-token authority: $url"
}

# Canonical parent projection: approved backend bytes remain unchanged.
cloudbench_write_guest_browser_env_files() {
  python3 - "$@" <<'PYBROWSER'
import hashlib, json, os, re, stat, sys
agents, backend, prod_backend, prod_worker, directory = sys.argv[1:]
allowed = {'kernel', 'tilion', 'steel', 'browser-use'}
def need(ok, reason):
    if not ok: raise SystemExit('guest browser projection: ' + reason)
need(prod_backend in allowed and prod_worker in allowed, 'invalid production enum')
info = os.lstat(directory)
need(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077, 'private output directory required')
sha = lambda raw: hashlib.sha256(raw).hexdigest()
pattern = re.compile(rb'^(\s*(?:export\s+)?BROWSER_PROVIDER\s*=)([^\r\n]*)(\r?\n)?$')
manifest = {'schema':'cloudbench-guest-browser-projection-v1',
            'production_sources':{'backend':'render:Navi','worker':'fly:navi-whisper-lux'},
            'production_browser_provider':prod_backend,'production_worker_browser_provider':prod_worker,
            'allowed_changes':{'agents.env':['BROWSER_PROVIDER'],'backend.env':[]},'files':{}}
for source, name, provider in ((agents,'agents.env',prod_worker),(backend,'backend.env',prod_backend)):
    need(os.path.isfile(source) and not os.path.islink(source), 'regular source file required')
    raw = open(source,'rb').read(); lines=raw.splitlines(keepends=True)
    matches=[(i,pattern.fullmatch(line)) for i,line in enumerate(lines) if re.match(rb'^\s*(?:export\s+)?BROWSER_PROVIDER\s*=',line)]
    need(len(matches)==1 and matches[0][1] is not None,'exact single explicit BROWSER_PROVIDER required')
    index, match = matches[0]; original=match[2].strip()
    if len(original)>=2 and original[:1]==original[-1:] and original[:1] in (b'"',b"'"): original=original[1:-1]
    need(original.decode() in allowed,'invalid original provider')
    if name=='backend.env':
        need(original.decode()==provider,'backend provider must already match production')
        body=raw
    else:
        lines[index]=match[1]+provider.encode()+(match[3] or b''); body=b''.join(lines)
    need(open(source,'rb').read()==raw,'source changed during projection')
    fd=os.open(os.path.join(directory,name),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as target: target.write(body)
    manifest['files'][name]={'original_sha256':sha(raw),'projected_sha256':sha(body),
                             'original_provider':original.decode(),'projected_provider':provider}
fd=os.open(os.path.join(directory,'browser-projection.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as target: json.dump(manifest,target,sort_keys=True); target.write('\n')
PYBROWSER
}

cloudbench_validate_browser_provider_contract() {
  local agents_env="$1" backend_env="$2" prod_backend="$3" prod_worker="$4"
  local agents_provider backend_provider
  agents_provider="$(cloudbench_env_value "$agents_env" BROWSER_PROVIDER)"
  backend_provider="$(cloudbench_env_value "$backend_env" BROWSER_PROVIDER)"

  case "$prod_backend" in tilion|kernel|steel|browser-use) ;; *)
    echo "FATAL: production backend BROWSER_PROVIDER is invalid: ${prod_backend:-<unset>}" >&2
    return 1
  esac
  case "$prod_worker" in tilion|kernel|steel|browser-use) ;; *)
    echo "FATAL: production worker BROWSER_PROVIDER is invalid: ${prod_worker:-<unset>}" >&2
    return 1
  esac
  # Backend selects new sessions; workers consume their recorded provider.
  # Mirror each production role independently, not one role into the other.
  if [ "$backend_provider" != "$prod_backend" ]; then
    echo "FATAL: benchmark backend env does not match production: local=${backend_provider:-<unset>} prod=$prod_backend" >&2
    return 1
  fi
  if [ "$agents_provider" != "$prod_worker" ]; then
    echo "FATAL: benchmark worker env does not match production: local=${agents_provider:-<unset>} prod=$prod_worker" >&2
    return 1
  fi
  # Guests get provider keys only through the whole-file env blobs (the same
  # way KERNEL_API_KEY arrives). A Tilion contract without its key would fail
  # every browser /init on the guest; stop before staging or booting.
  if [ "$prod_backend" = tilion ]; then
    local tilion_key
    tilion_key="$(cloudbench_env_value "$backend_env" TILION_API_KEY)"
    if [ -z "$tilion_key" ]; then
      echo "FATAL: back-end/.env has no TILION_API_KEY for BROWSER_PROVIDER=tilion." >&2
      echo "   Add it to back-end/.env, then: bash scripts/run-bench-cloud --refresh-secrets" >&2
      return 1
    fi
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
for directory in ("/proc/self/fd", "/dev/fd"):
    try:
        inherited_descriptors = os.listdir(directory)
        break
    except OSError:
        inherited_descriptors = None
if inherited_descriptors is None:
    os.closerange(3, os.sysconf("SC_OPEN_MAX"))
else:
    for value in inherited_descriptors:
        try:
            descriptor = int(value)
            if descriptor > 2:
                os.close(descriptor)
        except (OSError, ValueError):
            pass
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
import secrets
import signal
import subprocess
import sys
import time

owner_file, log, *argv = sys.argv[1:]
group_token = secrets.token_hex(16)
pending_signal = []

def defer_signal(signum, _frame):
    if not pending_signal:
        pending_signal.append(signum)

for signal_name in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signal_name, defer_signal)

child_pid = os.fork()
if child_pid:
    def cancel_child():
        try:
            if os.getpgid(child_pid) == child_pid:
                os.killpg(child_pid, signal.SIGKILL)
            else:
                os.kill(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(child_pid, 0)
        except ChildProcessError:
            pass

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if pending_signal:
            cancel_child()
            raise SystemExit(128 + pending_signal[0])
        try:
            fields = {}
            with open(owner_file) as handle:
                for raw in handle:
                    key, _, value = raw.rstrip("\n").partition("=")
                    fields[key] = value
            if (
                int(fields.get("pid", "0")) == child_pid
                and fields.get("pid_start")
                and fields.get("pgid") == str(child_pid)
                and fields.get("group_token") == group_token
            ):
                raise SystemExit(0)
        except (OSError, ValueError):
            pass
        exited, status = os.waitpid(child_pid, os.WNOHANG)
        if exited:
            raise SystemExit(os.waitstatus_to_exitcode(status))
        time.sleep(0.05)
    cancel_child()
    print("FATAL: detached process did not publish its ownership handshake", file=sys.stderr)
    raise SystemExit(1)

if pending_signal:
    raise SystemExit(128 + pending_signal[0])
os.setsid()
pid = os.getpid()
# Keep an immutable, birth-identified session leader alive until every process
# in the detached group is gone.  Waiters can then escalate the exact group
# without ever treating a reused numeric PGID as proof of ownership.
for signal_name in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signal_name, lambda _signum, _frame: None)
if pending_signal:
    raise SystemExit(128 + pending_signal[0])
before_owner_ready = os.environ.get("CLOUDBENCH_TEST_TRACKED_DETACH_BEFORE_OWNER_READY")
before_owner_release = os.environ.get("CLOUDBENCH_TEST_TRACKED_DETACH_BEFORE_OWNER_RELEASE")
if before_owner_ready:
    with open(before_owner_ready, "w") as handle:
        handle.write(f"{pid}\n")
    while before_owner_release and not os.path.exists(before_owner_release):
        time.sleep(0.01)
if os.path.exists("/proc/self/stat"):
    with open("/proc/sys/kernel/random/boot_id", encoding="utf-8") as handle:
        boot_id = handle.read().strip()
    with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as handle:
        stat = handle.read()
    stat_fields = stat[stat.rfind(")") + 2 :].split()
    if not boot_id or len(stat_fields) <= 19 or not stat_fields[19].isdigit():
        raise SystemExit("FATAL: could not read the detached process birth identity")
    pid_start = f"proc-start:{boot_id}:{stat_fields[19]}"
else:
    pid_start = " ".join(
        subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "lstart="],
            text=True,
            stderr=subprocess.DEVNULL,
        ).split()
    )
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
null = os.open(os.devnull, os.O_RDONLY)
os.dup2(null, 0)
for directory in ("/proc/self/fd", "/dev/fd"):
    try:
        inherited_descriptors = os.listdir(directory)
        break
    except OSError:
        inherited_descriptors = None
if inherited_descriptors is None:
    os.closerange(3, os.sysconf("SC_OPEN_MAX"))
else:
    for value in inherited_descriptors:
        try:
            descriptor = int(value)
            if descriptor > 2:
                os.close(descriptor)
        except (OSError, ValueError):
            pass
os.environ["CLOUDBENCH_TRACKED_GROUP_TOKEN"] = group_token

release_read, release_write = os.pipe()
command_pid = os.fork()
if command_pid == 0:
    os.close(release_write)
    for signal_name in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(signal_name, signal.SIG_DFL)
    released = os.read(release_read, 1)
    os.close(release_read)
    if released != b"1":
        raise SystemExit(1)
    os.execvp(argv[0], argv)

os.close(release_read)
owner_tmp = f"{owner_file}.tmp.{pid}"
try:
    with open(owner_tmp, "w") as handle:
        handle.write("version=1\n")
        handle.write(f"pid={pid}\n")
        handle.write(f"pid_start={pid_start}\n")
        handle.write(f"pgid={os.getpgrp()}\n")
        handle.write(f"group_token={group_token}\n")
        handle.write(f"command_pid={command_pid}\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(owner_tmp, owner_file)
except BaseException:
    os.close(release_write)
    try:
        os.waitpid(command_pid, 0)
    except ChildProcessError:
        pass
    raise
os.write(release_write, b"1")
os.close(release_write)

command_status = None
while True:
    if command_status is None:
        exited, status = os.waitpid(command_pid, os.WNOHANG)
        if exited:
            command_status = os.waitstatus_to_exitcode(status)
    if command_status is not None:
        try:
            observed = subprocess.run(
                ["ps", "-axo", "pid=,pgid="],
                check=False,
                capture_output=True,
                text=True,
                timeout=1,
                start_new_session=True,
            )
        except (OSError, subprocess.TimeoutExpired):
            time.sleep(0.05)
            continue
        if observed.returncode != 0:
            time.sleep(0.05)
            continue
        members = []
        for raw in observed.stdout.splitlines():
            fields = raw.split()
            if len(fields) == 2 and fields[1] == str(pid) and fields[0] != str(pid):
                members.append(fields[0])
        if not members:
            raise SystemExit(command_status)
    time.sleep(0.05)
PY
}

cloudbench_tracked_owner_value() {  # <owner-file> <key>
  local owner_file="$1" key="$2"
  sed -n "s/^${key}=//p" "$owner_file" 2>/dev/null | head -1
}

cloudbench_process_group_state() {  # <pgid> -> live|absent|unknown
  local pgid="$1" observed observed_pgid
  if ! observed="$(ps -axo pgid= 2>/dev/null)"; then
    echo unknown
    return 0
  fi
  while read -r observed_pgid; do
    if [ "$observed_pgid" = "$pgid" ]; then
      echo live
      return 0
    fi
  done <<< "$observed"
  echo absent
}

cloudbench_process_group_exists() {  # <pgid>
  [ "$(cloudbench_process_group_state "$1")" = "live" ]
}

cloudbench_pid_exists() {  # <pid>
  kill -0 "$1" 2>/dev/null
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
  local pid pid_start pgid group_token group_state status pending_signal="" forwarded_signal=""
  local recovery_seconds="${CLOUDBENCH_DETACHED_RECOVERY_SECONDS:-120}"
  local recovery_deadline=0 drain_deadline recovery_required=0
  local terminal_grace_seconds="${CLOUDBENCH_DETACHED_TERMINAL_GRACE_SECONDS:-2}"
  local terminal_term_seconds="${CLOUDBENCH_DETACHED_TERMINAL_TERM_SECONDS:-5}"
  local terminal_deadline=0 terminal_term_sent=0 terminal_teardown_failed=0

  pid="$(cloudbench_tracked_owner_value "$owner_file" pid)"
  pid_start="$(cloudbench_tracked_owner_value "$owner_file" pid_start)"
  pgid="$(cloudbench_tracked_owner_value "$owner_file" pgid)"
  group_token="$(cloudbench_tracked_owner_value "$owner_file" group_token)"
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
  [ "${#group_token}" -eq 32 ] || {
    echo "FATAL: detached ownership handshake has an invalid group token" >&2
    return 1
  }
  case "$group_token" in
    *[!0-9a-f]*)
      echo "FATAL: detached ownership handshake has an invalid group token" >&2
      return 1
      ;;
  esac
  case "$recovery_seconds" in
    ''|*[!0-9]*|0)
      echo "FATAL: detached recovery seconds must be a positive integer" >&2
      return 1
      ;;
  esac
  case "$terminal_grace_seconds:$terminal_term_seconds" in
    *[!0-9:]*|:*|*:0)
      echo "FATAL: detached terminal drain bounds must be non-negative grace and positive TERM seconds" >&2
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
      group_state="$(cloudbench_process_group_state "$pgid")"
      if [ "$group_state" = "unknown" ]; then
        trap - HUP INT TERM
        echo "FATAL: could not prove detached fleet process-group state during cancellation" >&2
        return 1
      fi
      if [ "$group_state" = "absent" ] && cloudbench_pid_exists "$pid"; then
        trap - HUP INT TERM
        echo "FATAL: detached group probe contradicted its still-live identity anchor" >&2
        return 1
      fi
      if [ "$group_state" = "live" ]; then
        if [ "$SECONDS" -ge "$recovery_deadline" ]; then
          echo "⚠️  detached fleet group survived bounded $forwarded_signal recovery; escalating" >&2
          if ! cloudbench_pid_matches_start "$pid" "$pid_start"; then
            group_state="$(cloudbench_process_group_state "$pgid")"
            if [ "$group_state" != "absent" ] || cloudbench_pid_exists "$pid"; then
              trap - HUP INT TERM
              echo "FATAL: detached fleet identity anchor vanished before KILL escalation" >&2
              return 1
            fi
          else
            kill -s KILL -- "-$pgid" 2>/dev/null || true
          fi
          drain_deadline=$((SECONDS + 10))
          group_state="$(cloudbench_process_group_state "$pgid")"
          while [ "$group_state" = "live" ] \
              && [ "$SECONDS" -lt "$drain_deadline" ]; do
            sleep 0.1 || true
            group_state="$(cloudbench_process_group_state "$pgid")"
          done
          if [ "$group_state" != "absent" ] || cloudbench_pid_exists "$pid"; then
            trap - HUP INT TERM
            echo "FATAL: detached fleet process group was not proven drained after KILL" >&2
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

    if [ -s "$status_file" ]; then
      group_state="$(cloudbench_process_group_state "$pgid")"
      if [ "$group_state" = "unknown" ]; then
        trap - HUP INT TERM
        echo "FATAL: detached terminal status arrived while process-group state was unknown" >&2
        return 1
      fi
      if [ "$group_state" = "absent" ]; then
        if cloudbench_pid_exists "$pid"; then
          trap - HUP INT TERM
          echo "FATAL: detached terminal group probe contradicted its still-live identity anchor" >&2
          return 1
        fi
        if [ "$terminal_term_sent" = "1" ]; then
          recovery_required=1
          terminal_teardown_failed=1
        fi
        break
      fi
      if ! cloudbench_pid_matches_start "$pid" "$pid_start"; then
        # The persistent anchor can exit between the group and PID probes once
        # the final command has drained. Re-probe; only the jointly absent
        # state is terminal, never the earlier numeric-PGID observation alone.
        group_state="$(cloudbench_process_group_state "$pgid")"
        if [ "$group_state" = "absent" ] && ! cloudbench_pid_exists "$pid"; then
          if [ "$terminal_term_sent" = "1" ]; then
            recovery_required=1
            terminal_teardown_failed=1
          fi
          break
        fi
        trap - HUP INT TERM
        echo "FATAL: detached terminal status arrived after its identity anchor vanished with an unproven group" >&2
        return 1
      fi
      if [ "$terminal_deadline" = "0" ]; then
        terminal_deadline=$((SECONDS + terminal_grace_seconds))
      elif [ "$terminal_term_sent" = "0" ] \
          && [ "$SECONDS" -ge "$terminal_deadline" ]; then
        echo "⚠️  detached terminal status arrived before its owned group drained; requesting teardown" >&2
        kill -s TERM -- "-$pgid" 2>/dev/null || true
        terminal_term_sent=1
        terminal_deadline=$((SECONDS + terminal_term_seconds))
      elif [ "$terminal_term_sent" = "1" ] \
          && [ "$SECONDS" -ge "$terminal_deadline" ]; then
        if ! cloudbench_pid_matches_start "$pid" "$pid_start"; then
          group_state="$(cloudbench_process_group_state "$pgid")"
          if [ "$group_state" != "absent" ] || cloudbench_pid_exists "$pid"; then
            trap - HUP INT TERM
            echo "FATAL: detached identity anchor vanished before terminal KILL escalation" >&2
            return 1
          fi
        else
          kill -s KILL -- "-$pgid" 2>/dev/null || true
        fi
        drain_deadline=$((SECONDS + 10))
        group_state="$(cloudbench_process_group_state "$pgid")"
        while [ "$group_state" = "live" ] \
            && [ "$SECONDS" -lt "$drain_deadline" ]; do
          sleep 0.1 || true
          group_state="$(cloudbench_process_group_state "$pgid")"
        done
        if [ "$group_state" != "absent" ] || cloudbench_pid_exists "$pid"; then
          trap - HUP INT TERM
          echo "FATAL: detached terminal process group was not proven drained after KILL" >&2
          return 1
        fi
        recovery_required=1
        terminal_teardown_failed=1
        break
      fi
      sleep 0.1 || true
      continue
    fi

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
      group_state="$(cloudbench_process_group_state "$pgid")"
      if [ "$group_state" = "unknown" ]; then
        trap - HUP INT TERM
        echo "FATAL: detached fleet identity anchor vanished while process-group state was unknown" >&2
        return 1
      fi
      if [ "$group_state" = "live" ]; then
        # A hard-dead/mismatched leader removes the only immutable authority to
        # address this process group. Numeric PGID reuse is not ownership proof.
        # Retain the rendezvous and require operator/audited recovery.
        trap - HUP INT TERM
        echo "FATAL: detached fleet identity anchor vanished while its numeric process group remained live" >&2
        return 1
      fi
      if cloudbench_pid_exists "$pid"; then
        trap - HUP INT TERM
        echo "FATAL: detached wrapper probe contradicted its still-live identity anchor" >&2
        return 1
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
  if [ "$terminal_teardown_failed" = "1" ]; then
    if [ "${#recovery_command[@]}" -eq 0 ]; then
      echo "FATAL: forced detached terminal teardown has no durable ownership recovery command" >&2
      return 1
    fi
    if ! "${recovery_command[@]}"; then
      echo "FATAL: forced detached terminal teardown could not reconcile durable ownership" >&2
      return 1
    fi
  fi
  status="$(head -1 "$status_file" 2>/dev/null || true)"
  # Ownership rendezvous is retired after group drain; the printed terminal
  # receipt remains available to the independent monitor after --wait returns.
  rm -f "$owner_file" "$owner_file".tmp.* "$status_file".tmp.* \
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
  if [ "$terminal_teardown_failed" = "1" ]; then
    echo "FATAL: detached command published terminal status before its owned process group drained" >&2
    return 1
  fi
  return "$status"
}

cloudbench_guest_autoscaler_poll_seconds() {  # <concurrent-guests> [calls-per-second] [floor-seconds]
  # Every guest worker's queue observation spends three Temporal Cloud Visibility
  # API calls (CountWorkflowExecutions + two DescribeTaskQueue). Production shares
  # that namespace budget, so this host's concurrent guests together spend at most
  # the configured calls/s. Never poll faster than the controller reads the
  # result; a malformed input falls back to the conservative production-safe value.
  local guests="$1" budget="${2:-${CLOUDBENCH_TEMPORAL_VISIBILITY_CALLS_PER_SECOND:-20}}" floor="${3:-10}"
  awk -v guests="$guests" -v budget="$budget" -v floor="$floor" 'BEGIN {
    if (guests !~ /^[0-9]+$/ || guests < 1) guests = 1
    if (floor !~ /^[0-9]+$/ || floor < 1) floor = 10
    if (budget !~ /^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/ || budget <= 0) budget = 20
    seconds = 3 * guests / budget
    whole = int(seconds); if (whole < seconds) whole++
    if (whole < floor) whole = floor
    print whole
  }'
}

cloudbench_fleet_guest_identity() {  # <fleet-owner-token>
  # Guest identities reach shared services: the Temporal Cloud namespace shared
  # with production, the guest's queue-scoped stale-workflow termination and its
  # Steel ownership marker. A controller PID is not globally unique: identical
  # disposable controllers reuse PIDs and seconds across hosts. Derive the
  # identity from the fleet's random owner token instead, so exact-owner
  # recovery re-derives it while the raw ownership token stays out of names.
  local owner="$1"
  case "$owner" in
    *[!0-9a-f]*|'')
      echo "FATAL: fleet guest identity requires the 32-hex fleet owner token" >&2
      return 1
      ;;
  esac
  [ "${#owner}" -eq 32 ] || {
    echo "FATAL: fleet guest identity requires the 32-hex fleet owner token" >&2
    return 1
  }
  python3 -c 'import hashlib, sys; print(hashlib.sha256(b"cloudbench-fleet-guest-identity-v1\0" + sys.argv[1].encode()).hexdigest()[:12])' "$owner"
}

cloudbench_fleet_workspace_name() {  # <bench-name> <fleet-owner-token> <ordinal>
  # Temporal task queues inherit this workspace name and cap it at 48 chars.
  # Truncate only the human-readable bench segment: the owner identity +
  # ordinal suffix is the isolation boundary and must remain complete.
  local bench="$1" owner="$2" ordinal="$3"
  local identity suffix sanitized max_bench_length
  case "$ordinal" in
    *[!0-9]*|'')
      echo "FATAL: fleet workspace ordinal must be numeric" >&2
      return 1
      ;;
  esac
  identity="$(cloudbench_fleet_guest_identity "$owner")" || return 1
  suffix="-$identity-$ordinal"
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

cloudbench_origin_advertises_commit() {  # <repo-root> <full-sha>
  # Only admit an exact ref currently advertised by the same private repository
  # the guest helper fetches. Local origin/* refs may be stale after deletion.
  # An unreadable origin is uncertainty, so callers retain full patch delivery.
  local root="$1" resolved="$2" origin token header
  origin="$(git -C "$root" config --get remote.origin.url 2>/dev/null)" || return 1
  case "$origin" in
    https://github.com/Rose-Ai-Labs/rose.git|https://github.com/Rose-Ai-Labs/rose|git@github.com:Rose-Ai-Labs/rose.git|ssh://git@github.com/Rose-Ai-Labs/rose.git) ;;
    *) return 1 ;;
  esac
  token="$(cloudbench_controller_github_token "$root" 2>/dev/null)" || return 1
  [ -n "$token" ] || return 1
  header="$(cloudbench_github_basic_auth_header "$token")" || return 1
  CLOUDBENCH_FETCHABLE_AUTH_HEADER="$header" python3 - "$root" "$resolved" <<'PY'
import os
import signal
import subprocess
import sys
import tempfile

env = os.environ.copy()
header = env.pop("CLOUDBENCH_FETCHABLE_AUTH_HEADER")
# Discovery must not inherit repository-local URL rewrites, alternate Git dirs,
# or ambient command-line config that could redirect credentials or advertise a
# different repository. Auth is URL scoped and redirects are never followed.
for key in tuple(env):
    if key.startswith(("GIT_CONFIG", "GIT_TRACE")) or key in {
        "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CURL_VERBOSE",
    }:
        del env[key]
env.update(GIT_CONFIG_COUNT="3",
           GIT_CONFIG_KEY_0="http.https://github.com/Rose-Ai-Labs/rose.git.extraheader",
           GIT_CONFIG_VALUE_0=header, GIT_CONFIG_KEY_1="credential.helper",
           GIT_CONFIG_VALUE_1="", GIT_CONFIG_KEY_2="http.followRedirects",
           GIT_CONFIG_VALUE_2="false", GIT_TERMINAL_PROMPT="0",
           GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
           GIT_CONFIG_NOSYSTEM="1")

def interrupted(_signum, _frame):
    raise InterruptedError("source admission interrupted")

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
child = None
try:
    # A file prevents a remote helper retaining stdout from holding communicate
    # open after git has exited. Ref advertisements above 4 MiB stay unverified.
    with tempfile.TemporaryFile() as output_file:
        child = subprocess.Popen(
            ["git", "ls-remote", "--heads", "--tags",
             "https://github.com/Rose-Ai-Labs/rose.git"],
            cwd="/", env=env, stdout=output_file, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        child.wait(timeout=10)
        if child.returncode == 0:
            output_file.seek(0)
            output = output_file.read(4 * 1024 * 1024 + 1)
            if len(output) <= 4 * 1024 * 1024:
                for line in output.splitlines():
                    fields = line.split()
                    if len(fields) == 2 and fields[0] == sys.argv[2].encode("ascii") and fields[1].startswith((b"refs/heads/", b"refs/tags/")):
                        raise SystemExit(0)
except (OSError, ValueError, subprocess.TimeoutExpired):
    pass
finally:
    if child is not None and child.returncode is None:
        # This unreaped Popen owns the new session; never signal a discovered PID.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
raise SystemExit(1)
PY
}

cloudbench_fetchable_ref() {  # <repo-root> <requested-ref> <allow-local-patch-01>
  # Guest and warm-refresh fetches both use the controller-token exact-SHA
  # helper. Preserve the main fast path; admit feature/tag tips only after a
  # bounded authenticated live-origin advertisement, never local tracking refs.
  # Otherwise carry the complete committed + uncommitted delta from main.
  local root="$1" requested="$2" allow_patch="$3" resolved base
  if ! resolved="$(git -C "$root" rev-parse --verify "${requested}^{commit}" 2>/dev/null)"; then
    # Preserve remote-only branch/tag names that this checkout cannot resolve.
    printf '%s' "$requested"
    return 0
  fi
  if git -C "$root" rev-parse --verify 'origin/main^{commit}' >/dev/null 2>&1 \
      && git -C "$root" merge-base --is-ancestor "$resolved" origin/main 2>/dev/null; then
    printf '%s' "$resolved"
    return 0
  fi
  if cloudbench_origin_advertises_commit "$root" "$resolved"; then
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

# Resolve a request-scoped GitHub token for private-repo git-sync on Fly guests.
# Cursor Cloud / CI often inject an invalid GITHUB_TOKEN while the working
# credential lives in git url.insteadOf (or gh hosts.yml). Prefer those live
# controller credentials over durable Fly/.env secrets that go stale.
cloudbench_git_insteadof_github_token() {
  local cfg line token=""
  cfg="$(git config --get-regexp '^url\..*\.insteadof$' 2>/dev/null || true)"
  [ -n "$cfg" ] || return 1
  while IFS= read -r line; do
    case "$line" in
      *'https://x-access-token:'*'@github.com/'*|*x-access-token:*@github.com*)
        token="${line#*x-access-token:}"
        token="${token%%@github.com*}"
        token="${token%%@github.com/*}"
        ;;
    esac
    [ -n "$token" ] && printf '%s' "$token" && return 0
  done <<< "$cfg"
  return 1
}

# Read the repository-scoped credential through Git's configured helper. On
# boxes.dev the working short-lived credential is intentionally exposed only
# through this standard interface; it is not copied into gh hosts.yml or an
# ambient token variable. Keep the request path-scoped so helpers using
# credential.useHttpPath cannot return a credential for another repository.
cloudbench_git_credential_github_token() {
  local workspace_root="${1:-${CLOUDBENCH_FLEET_ROOT:-.}}"
  local key value token=""
  while IFS='=' read -r key value; do
    [ "$key" = password ] && token="$value"
  done < <(
    printf '%s\n' \
      'protocol=https' \
      'host=github.com' \
      'path=Rose-Ai-Labs/rose.git' \
      '' \
      | GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true \
          git -c credential.interactive=false -C "$workspace_root" credential fill 2>/dev/null || true
  )
  [ -n "$token" ] || return 1
  printf '%s' "$token"
}

cloudbench_resolve_controller_github_token() {
  local token="" dotenv backend_env agents_env
  local workspace_root="${1:-${CLOUDBENCH_FLEET_ROOT:-.}}"
  backend_env="${2:-$workspace_root/back-end/.env}"
  agents_env="${3:-$workspace_root/agents/.env}"
  if [ -n "${CLOUDBENCH_GITHUB_TOKEN_B64:-}" ]; then
    token="$(printf '%s' "$CLOUDBENCH_GITHUB_TOKEN_B64" | base64 -d 2>/dev/null || true)"
    [ -n "$token" ] && { printf '%s' "$token"; return 0; }
  fi
  token="$(cloudbench_git_insteadof_github_token 2>/dev/null || true)"
  [ -n "$token" ] && { printf '%s' "$token"; return 0; }
  token="$(cloudbench_git_credential_github_token "$workspace_root" 2>/dev/null || true)"
  [ -n "$token" ] && { printf '%s' "$token"; return 0; }
  if command -v gh >/dev/null 2>&1; then
    # gh prefers $GITHUB_TOKEN even when it is invalid; strip it so hosts.yml wins.
    # Also clear GH_TOKEN for this subprocess; keep `env -u GITHUB_TOKEN gh auth token`
    # contiguous so cloudbench-env.test.sh can pin the contract.
    token="$(GH_TOKEN= env -u GITHUB_TOKEN gh auth token 2>/dev/null || true)"
    [ -n "$token" ] && { printf '%s' "$token"; return 0; }
  fi
  token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [ -z "$token" ]; then
    for dotenv in "$backend_env" "$agents_env"; do
      [ -f "$dotenv" ] || continue
      token="$(cloudbench_env_value "$dotenv" GITHUB_TOKEN 2>/dev/null || true)"
      [ -z "$token" ] || break
    done
  fi
  [ -n "$token" ] || return 1
  printf '%s' "$token"
}

# Canonical name used by main's warm_source_fetch_ref / export helpers.
cloudbench_controller_github_token() {
  cloudbench_resolve_controller_github_token "$@"
}

cloudbench_github_basic_auth_header() {  # <token>
  local token="$1"
  [ -n "$token" ] || return 1
  printf 'Authorization: Basic %s' "$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
}

# Serialize sibling updates and publish complete dotenvs without printing values.
cloudbench_upsert_env_key() {
  local dest="$1" key="$2" val="$3"
  [ -n "$dest" ] && [ -n "$key" ] || return 1
  DEST="$dest" KEY="$key" VAL="$val" python3 - <<'PYINNER'
import fcntl
import os
from pathlib import Path
import tempfile

# Resolve aliases before choosing the lock, preserving existing dotenv symlinks.
p = Path(os.environ["DEST"]).resolve()
key = os.environ["KEY"]
val = os.environ["VAL"]
if any(ch in val for ch in ' \t\n"\'#$`\\'):
    escaped = val.replace("\\", "\\\\").replace('"', '\\"')
    rendered = f'{key}="{escaped}"'
else:
    rendered = f"{key}={val}"
p.parent.mkdir(parents=True, exist_ok=True)
# Keep this inode: unlinking a lock can let a later writer lock a different file.
lock_fd = os.open(p.with_name(p.name + ".cloudbench-upsert.lock"), os.O_CREAT | os.O_RDWR, 0o600)
with os.fdopen(lock_fd, "a") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    original = p.read_text() if p.exists() else ""
    out = []
    found = False
    for line in original.splitlines():
        if line.startswith(key + "="):
            out.append(rendered)
            found = True
        else:
            out.append(line)
    if not found:
        out.append(rendered)
    updated = "\n".join(out) + "\n"
    if updated == original:
        if p.stat().st_mode & 0o777 != 0o600:
            os.chmod(p, 0o600)
    else:
        fd, name = tempfile.mkstemp(dir=p.parent, prefix=p.name + ".cloudbench-upsert.")
        temporary = Path(name)
        try:
            with os.fdopen(fd, "w") as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(updated)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, p)
        finally:
            temporary.unlink(missing_ok=True)
PYINNER
}

# I-03 ignored invalid $GITHUB_TOKEN for fetch-ref but left the process env and
# local .env files on the injected github_pat_. Children that still read
# $GITHUB_TOKEN (gh, git extraheader, dotenv) then 401. Export the working
# hosts.yml / insteadOf credential into this process and any listed .env paths.
cloudbench_export_controller_github_token() {
  local token dest
  token="$(cloudbench_controller_github_token)" || return 1
  export GITHUB_TOKEN="$token"
  for dest in "$@"; do
    [ -n "$dest" ] || continue
    cloudbench_upsert_env_key "$dest" GITHUB_TOKEN "$token" || return 1
  done
  echo "controller GITHUB_TOKEN exported (len=${#GITHUB_TOKEN})" >&2
  return 0
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

cloudbench_status_proxy_lifecycle_response_accepted() {
  case "$1" in
    204|410|425) return 0 ;;
    *) return 1 ;;
  esac
}

# Campaign transports use keyed broker leases, never a shared PID sentinel.
cloudbench_shared_relay_enabled() {
  [ -n "${CLOUDBENCH_SHARED_RELAY_AUTHORITY:-}${CLOUDBENCH_SHARED_RELAY_DIRECTORY:-}" ]
}
cloudbench_shared_relay_request() {  # action token [route arguments]
  local action="$1" token="$2" start
  shift 2
  start="$(cloudbench_pid_start_time "$$")" || return 1
  [ -n "$start" ] || return 1
  python3 "${CLOUDBENCH_SCRIPT_SNAPSHOT:-${CLOUDBENCH_RUNTIME_SCRIPT_ROOT:-$ROOT_DIR/scripts}}/cloudbench-shared-relay.py" \
    "$action" --authority "${CLOUDBENCH_SHARED_RELAY_AUTHORITY:?}" \
    --directory "${CLOUDBENCH_SHARED_RELAY_DIRECTORY:?}" \
    --owner-pid "$$" --owner-start "$start" --token "$token" "$@"
}
cloudbench_proxy_alive() {  # PID variable name; shared mode has no route PID
  local name="$1" lease_name="${1}_LEASE" live_name="${1}_LIVE" observed="" marker
  if cloudbench_shared_relay_enabled; then
    [ -n "${!lease_name:-}" ] && [ -n "${!live_name:-}" ] || return 1
    cloudbench_pid_matches_start "${CLOUDBENCH_SHARED_RELAY_PID:?}" "${CLOUDBENCH_SHARED_RELAY_BIRTH:?}" || return 1
    cloudbench_pid_matches_start "${CLOUDBENCH_SHARED_RELAY_AGENT_PID:?}" "${CLOUDBENCH_SHARED_RELAY_AGENT_BIRTH:?}" || return 1
    [ -S "$CLOUDBENCH_SHARED_RELAY_DIRECTORY/control.sock" ] && [ ! -L "$CLOUDBENCH_SHARED_RELAY_DIRECTORY/control.sock" ] || return 1
    marker="$CLOUDBENCH_SHARED_RELAY_DIRECTORY/leases/${!lease_name}.live"
    [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
    IFS= read -r observed < "$marker" || return 1
    [ "$observed" = "${!live_name}" ]
  else
    [ -n "${!name:-}" ] && kill -0 "${!name}" 2>/dev/null
  fi
}
cloudbench_proxy_stop() {  # exact route only; never signal the broker
  local name="$1" lease_name="${1}_LEASE" token_name="${1}_TOKEN"
  if cloudbench_shared_relay_enabled; then
    if [ -n "${!lease_name:-}" ]; then
      cloudbench_shared_relay_request release "${!token_name:-}" --lease "${!lease_name}" >/dev/null || return 1
      printf -v "$lease_name" '%s' ''
    fi
  else
    cloudbench_terminate_and_wait 5 "${!name:-}"
  fi
  printf -v "$name" '%s' ''
}
cloudbench_shared_proxy_start() {  # same signature as data-plane proxy
  local port="$1" remote="$2" host="$3" log="$4" name="$5" label="$6"
  local timeout="${7:-${CLOUDBENCH_DATA_PROXY_READY_TIMEOUT:-180}}" result lease started health live_path live_value rc
  local lease_name="${5}_LEASE" token_name="${5}_TOKEN" live_name="${5}_LIVE"
  local last_http=not_probed curl_exit=not_probed proxy_alive=not_checked readiness_reason=deadline
  local token="${RUN_LOG_TOKEN:-${RUN_ID:?}}-$label-$port"
  started="$(date +%s)"
  while :; do
    rc=0
    result="$(cloudbench_shared_relay_request acquire "$token" \
      --mid "${mid:-${CLOUDBENCH_RELAY_MACHINE_ID:?}}" --remote-ip "$host" \
      --remote-port "$remote" --local-port "$port")" || rc=$?
    [ "$rc" != 0 ] || break
    [ "$rc" != 98 ] || return 98
    [ $(( $(date +%s) - started )) -lt "$timeout" ] || return 1
    sleep 1
  done
  # Extract a well-formed granted lease even when the rest is unusable, so a
  # rejected response releases it instead of leaking the broker's route.
  # A non-whitespace separator keeps empty fields positional.
  IFS="$(printf '\037')" read -r lease live_path live_value <<< "$(printf '%s' "$result" | python3 -c 'import json,re,sys;v=json.load(sys.stdin);v=v if isinstance(v,dict) else {};s=v.get("lease");s=s if isinstance(s,str) and re.fullmatch(r"[a-f0-9-]{32,36}",s) else "";print(s,v.get("live_path",""),v.get("live_value",""),sep="\037")' 2>/dev/null)"
  if ! { [ -n "$lease" ] && [ "$live_path" = "$CLOUDBENCH_SHARED_RELAY_DIRECTORY/leases/$lease.live" ] && [ -n "$live_value" ]; }; then
    [ -z "$lease" ] || cloudbench_shared_relay_request release "$token" --lease "$lease" >/dev/null || true
    return 1
  fi
  printf -v "$name" '%s' ''
  printf -v "$lease_name" '%s' "$lease"
  printf -v "$token_name" '%s' "$token"
  printf -v "$live_name" '%s' "$live_value"
  printf 'shared relay lease %s: localhost:%s -> %s:%s\n' "$lease" "$port" "$host" "$remote" >> "$log"
  [ "$label" = status ] || return 0
  while [ $(( $(date +%s) - started )) -lt "$timeout" ]; do
    if cloudbench_proxy_alive "$name"; then
      proxy_alive=true
    else
      proxy_alive=false
      readiness_reason=proxy_not_alive
      break
    fi
    curl_exit=0
    health="$(curl --noproxy '*' -sS --max-time 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/driver-health" 2>/dev/null)" || curl_exit=$?
    case "$health" in
      [0-9][0-9][0-9]) last_http="$health" ;;
      *) last_http=invalid_code ;;
    esac
    if cloudbench_status_proxy_lifecycle_response_accepted "$health"; then return 0; fi
    sleep 1
  done
  # Keep only observations already made by the readiness loop, never response bodies.
  printf 'status readiness failed: reason=%s last_http=%s curl_exit=%s proxy_alive=%s\n' \
    "$readiness_reason" "$last_http" "$curl_exit" "$proxy_alive" >> "$log" || true
  cloudbench_proxy_stop "$name" || return 1
  return 1
}

# Charge one bounded controller step to a readiness budget. Every step of the
# proxy launcher has a fixed ceiling (curl --max-time, settle, terminate grace,
# fixed sleeps), so wall-clock time past that ceiling is a host stall (VM pause,
# laptop sleep, cgroup freeze), not evidence about the tunnel. Production replay
# 20261028-181310-2300577: the devbox VM paused 537 s (kernel audit seq
# 73645→73646, 18:33:12→18:42:09Z) while six status proxies were retrying
# through Fly GraphQL 503s; the wall-clock budget expired during the pause and
# six healthy guests were failed closed without one post-thaw attempt, while
# the three already-established tunnels recovered in 20 s. The stall is logged
# and excluded; the budget keeps counting only bounded controller work.
#   cloudbench_charge_bounded_step <charged-var> <stalled-var> <step-started-epoch> <ceiling-s> <log> <label> [minimum-s]
cloudbench_charge_bounded_step() {
  local charged_var="$1" stalled_var="$2" step_started="$3" ceiling="$4" log_file="$5" label="$6"
  # Subsecond failed probes still consume a bounded budget unit when requested.
  local elapsed excess minimum="${7:-0}"
  elapsed=$(( $(date +%s) - step_started ))
  [ "$elapsed" -ge "$minimum" ] || elapsed="$minimum"
  if [ "$elapsed" -gt "$ceiling" ]; then
    excess=$(( elapsed - ceiling ))
    printf '[%s] %s: host stall %ss during a %ss-bounded step (excluded from the readiness budget)\n' \
      "$(date -u +%H:%M:%S)" "$label" "$excess" "$ceiling" >> "$log_file"
    printf -v "$stalled_var" '%s' "$(( ${!stalled_var} + excess ))"
    elapsed="$ceiling"
  fi
  printf -v "$charged_var" '%s' "$(( ${!charged_var} + elapsed ))"
}

cloudbench_start_data_plane_proxy() {  # <local-port> <remote-port> <host> <log> <pid-var> <label> [timeout]
  local local_port="$1" remote_port="$2" host="$3" log_file="$4"
  local pid_var="$5" label="$6" timeout="${7:-${CLOUDBENCH_DATA_PROXY_READY_TIMEOUT:-180}}"
  local settle="${CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS:-3}" settle_whole
  # Bound decimal parsing before shell comparisons/arithmetic or any launch.
  if [[ ! "$timeout" =~ ^[0-9]+$ ]]; then
    printf 'Invalid proxy readiness timeout: expected a positive decimal integer\n' >&2
    return 2
  fi
  timeout="${timeout#"${timeout%%[!0]*}"}"
  if [ -z "$timeout" ] || [ "${#timeout}" -gt 18 ]; then
    printf 'Invalid proxy readiness timeout: outside supported positive integer range\n' >&2
    return 2
  fi
  if [[ ! "$settle" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] || [ "${#settle}" -gt 32 ]; then
    settle=3
  fi
  if cloudbench_shared_relay_enabled; then
    cloudbench_shared_proxy_start "$local_port" "$remote_port" "$host" "$log_file" "$pid_var" "$label" "$timeout"
    return $?
  fi
  local pid attempt=0 probe_path="/" health_code attempt_first_line
  # Budget accounting: only bounded controller work is charged (see
  # cloudbench_charge_bounded_step). Ceilings are the sum of each segment's
  # fixed limits plus slack for a loaded host.
  local charged=0 stalled=0 step_started attempt_ceiling wait_ceiling=15 retire_ceiling=15
  local wait_budget probe_budget sleep_budget fresh_budget probe_elapsed thaw_probe_used=0 did_thaw_probe
  settle_whole="${settle%%.*}"
  case "$settle_whole" in ''|*[!0-9]*) settle_whole=3 ;; esac
  settle_whole="${settle_whole#"${settle_whole%%[!0]*}"}"
  [ -n "$settle_whole" ] || settle_whole=0
  if [ "${#settle_whole}" -gt 18 ]; then settle=3; settle_whole=3; fi
  attempt_ceiling=$(( 30 + settle_whole ))
  # Retain earlier attempts: ensure_status_proxy re-enters this launcher after a
  # transport loss, and truncating here erased the original readiness evidence
  # of every guest that later passed (replay above).
  if [ -s "$log_file" ]; then
    printf '[%s] %s proxy (re)start: earlier attempts retained above\n' \
      "$(date -u +%H:%M:%S)" "$label" >> "$log_file"
  else
    : > "$log_file"
  fi
  [ "$label" = "status" ] && probe_path="/driver-health"
  while [ "$charged" -lt "$timeout" ]; do
    attempt=$((attempt + 1))
    step_started="$(date +%s)"
    attempt_first_line=$(( $(wc -l < "$log_file" 2>/dev/null || echo 0) + 1 ))
    printf '[%s] %s proxy attempt %s: localhost:%s -> %s:%s\n' \
      "$(date -u +%H:%M:%S)" "$label" "$attempt" "$local_port" "$host" "$remote_port" \
      >> "$log_file"
    # Exec in this background child so $! still identifies native Fly.
    (
      if [ -n "${REGISTRY_RECOVERY_GUARD_FD:-}" ]; then
        exec {REGISTRY_RECOVERY_GUARD_FD}<&- || exit 1
      fi
      exec flyctl proxy "$local_port:$remote_port" "$host" -a "$APP" --bind-addr 127.0.0.1 -q
    ) >> "$log_file" 2>&1 &
    pid=$!
    # flyctl resolves the remote host lazily on the first client connection.
    # Trigger lazy DNS, but classify a local bind collision before waiting.
    sleep 0.5
    curl --noproxy '*' -sS --max-time 2 -o /dev/null \
      "http://127.0.0.1:$local_port$probe_path" 2>/dev/null || true
    # Only this attempt's output may classify a collision: the retained log can
    # still hold an earlier port's collision that the caller already rotated away.
    if tail -n +"$attempt_first_line" "$log_file" 2>/dev/null \
      | grep -Eiq 'listen tcp .*bind: address already in use|address already in use'; then
      wait "$pid" 2>/dev/null || true
      printf -v "$pid_var" '%s' ""
      return 98
    fi
    # Require a short post-probe survival window for asynchronous lazy-DNS failures.
    sleep "$settle"
    cloudbench_charge_bounded_step charged stalled "$step_started" "$attempt_ceiling" \
      "$log_file" "$label proxy attempt $attempt"
    if kill -0 "$pid" 2>/dev/null; then
      if [ "$label" != "status" ]; then
        printf -v "$pid_var" '%s' "$pid"
        return 0
      fi
      # HTTP unavailability is not process failure: a live flyctl can still be
      # initializing WireGuard or waiting for the guest status service. Keep its
      # progress within the original readiness deadline; restart only on exit.
      while kill -0 "$pid" 2>/dev/null && [ "$charged" -lt "$timeout" ]; do
        step_started="$(date +%s)"
        wait_budget=$((timeout - charged))
        [ "$wait_budget" -le "$wait_ceiling" ] || wait_budget="$wait_ceiling"
        # Reserve a sleep second when available; the last second still gets
        # one bounded observation of this same live proxy.
        sleep_budget=0
        [ "$wait_budget" -le 1 ] || sleep_budget=1
        probe_budget=$((wait_budget - sleep_budget))
        [ "$probe_budget" -le 3 ] || probe_budget=3
        fresh_budget=0
        did_thaw_probe=0
        health_code="$(curl --noproxy '*' -sS --max-time "$probe_budget" -o /dev/null -w '%{http_code}' \
          "http://127.0.0.1:$local_port/driver-health" 2>/dev/null || true)"
        if ! cloudbench_status_proxy_lifecycle_response_accepted "$health_code" && [ "$sleep_budget" -gt 0 ]; then
          sleep "$sleep_budget"
        fi
        probe_elapsed=$(( $(date +%s) - step_started ))
        if ! cloudbench_status_proxy_lifecycle_response_accepted "$health_code" \
          && [ "$probe_elapsed" -gt "$wait_budget" ] && [ "$thaw_probe_used" -eq 0 ]; then
          # Reserve the first probe's fixed bound and optional sleep before one fresh
          # observation. Both probes stay inside this one existing wait step.
          fresh_budget=$((wait_budget - probe_budget - sleep_budget))
          [ "$fresh_budget" -le 3 ] || fresh_budget=3
          if [ "$fresh_budget" -gt 0 ]; then
            thaw_probe_used=1
            did_thaw_probe=1
            health_code="$(curl --noproxy '*' -sS --max-time "$fresh_budget" -o /dev/null -w '%{http_code}' \
              "http://127.0.0.1:$local_port/driver-health" 2>/dev/null || true)"
          else
            fresh_budget=0
          fi
        fi
        if ! cloudbench_status_proxy_lifecycle_response_accepted "$health_code"; then
          printf '[%s] status proxy lifecycle HTTP %s not accepted; waiting on pid %s\n' \
            "$(date -u +%H:%M:%S)" "${health_code:-000}" "$pid" >> "$log_file"
        fi
        cloudbench_charge_bounded_step charged stalled "$step_started" "$wait_budget" \
          "$log_file" "$label proxy attempt $attempt wait" 1
        if [ "$did_thaw_probe" -eq 1 ]; then
          printf 'status proxy: post-thaw probe charged=%s timeout=%s\n' "$charged" "$timeout" >> "$log_file"
        fi
        if cloudbench_status_proxy_lifecycle_response_accepted "$health_code" \
          && kill -0 "$pid" 2>/dev/null; then
          printf -v "$pid_var" '%s' "$pid"
          return 0
        fi
      done
      step_started="$(date +%s)"
      cloudbench_terminate_and_wait 5 "$pid"
    else
      step_started="$(date +%s)"
      wait "$pid" 2>/dev/null || true
    fi
    # Reaping makes a late lazy-start bind failure visible for port rotation.
    if tail -n +"$attempt_first_line" "$log_file" 2>/dev/null | grep -Eiq 'listen tcp .*bind: address already in use|address already in use'; then
      printf -v "$pid_var" '%s' ""
      return 98
    fi
    sleep 2
    cloudbench_charge_bounded_step charged stalled "$step_started" "$retire_ceiling" \
      "$log_file" "$label proxy attempt $attempt retire"
  done
  printf -v "$pid_var" '%s' ""
  echo "❌ $label data-plane proxy did not become ready within ${timeout}s (charged ${charged}s of bounded work; ${stalled}s of host stall excluded)" >&2
  tail -20 "$log_file" 2>/dev/null | sed 's/^/   /' >&2 || true
  # Ordinary remote readiness failures retain the bounded same-host retry
  # behavior above; only local ownership collisions ask the caller to rotate.
  return 1
}

# Process birth identity must stay fixed for one process incarnation. Linux
# ps(1) renders lstart as the kernel's *current* boot-time estimate plus the
# start tick, so every wall-clock step (observed: +143s after a VM snapshot
# fork) rewrites the lstart of every live process and turns live owners into
# "replaced" PIDs. Linux therefore uses the boot-relative /proc start tick,
# qualified by boot_id. macOS has no /proc and records lstart once at fork.
# Matching dispatches on the recorded format, so lstart records written by an
# older controller keep their original meaning.
cloudbench_legacy_pid_start_time() {
  local pid="$1"
  ps -p "$pid" -o lstart= 2>/dev/null |
    awk '{$1=$1; print}'
}

cloudbench_proc_pid_observation() {  # <pid> -> "<proc-start identity>\t<state>"
  local pid="$1" boot_id="" stat_line="" rest
  local -a fields=()
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  { IFS= read -r boot_id < /proc/sys/kernel/random/boot_id; } 2>/dev/null || return 1
  { IFS= read -r stat_line < "/proc/$pid/stat"; } 2>/dev/null || return 1
  case "$stat_line" in *') '*) ;; *) return 1 ;; esac
  rest="${stat_line##*) }"
  read -r -a fields <<< "$rest"
  [ -n "$boot_id" ] && [ "${#fields[@]}" -gt 19 ] || return 1
  case "${fields[19]}" in ''|*[!0-9]*) return 1 ;; esac
  printf 'proc-start:%s:%s\t%s\n' "$boot_id" "${fields[19]}" "${fields[0]}"
}

cloudbench_pid_start_time() {
  local pid="$1" observation
  if [ -r /proc/self/stat ]; then
    observation="$(cloudbench_proc_pid_observation "$pid")" || return 0
    printf '%s\n' "${observation%%$'\t'*}"
    return 0
  fi
  cloudbench_legacy_pid_start_time "$pid"
}

cloudbench_pid_start_time_like() {  # <pid> <recorded-identity>
  case "$2" in
    proc-start:*)
      [ -r /proc/self/stat ] || return 0
      cloudbench_pid_start_time "$1"
      ;;
    *) cloudbench_legacy_pid_start_time "$1" ;;
  esac
}

cloudbench_pid_observation_like() {  # <pid> <recorded-identity> -> "<identity>\t<state>"
  case "$2" in
    proc-start:*)
      [ -r /proc/self/stat ] || return 0
      cloudbench_proc_pid_observation "$1" || true
      ;;
    *)
      ps -p "$1" -o lstart= -o stat= 2>/dev/null |
        awk 'NF >= 6 {state=$NF; NF--; $1=$1; print $0 "\t" state}'
      ;;
  esac
}

cloudbench_pid_birth_state() {  # <pid> <expected-start> -> live|absent|unknown
  local pid="$1" expected_start="$2" actual_start ps_status
  case "$pid" in ''|*[!0-9]*) echo unknown; return 0 ;; esac
  [ "$pid" -gt 1 ] && [ -n "$expected_start" ] \
    || { echo unknown; return 0; }
  actual_start="$(cloudbench_pid_start_time_like "$pid" "$expected_start")"
  if [ -n "$actual_start" ]; then
    if [ "$actual_start" = "$expected_start" ]; then
      echo live
    else
      # The numeric PID exists, but the recorded process birth does not.
      echo absent
    fi
    return 0
  fi
  # procps/BSD ps use status 1 for a well-formed PID that does not exist.
  # If the PID concurrently appeared, kill -0 catches it and preserves the
  # fail-closed unknown state rather than claiming an absence.
  ps_status=0
  ps -p "$pid" -o pid= >/dev/null 2>&1 || ps_status=$?
  if [ "$ps_status" -eq 1 ] && ! kill -0 "$pid" 2>/dev/null; then
    echo absent
  else
    echo unknown
  fi
}

cloudbench_pid_matches_start() {
  local observation
  case "$2" in
    proc-start:*)
      # A boolean birth match needs one native observation, not the nested
      # command substitutions used to classify absent versus unknown owners.
      # Both classifications are non-matches here; keep their richer API intact.
      case "$1" in ''|*[!0-9]*) return 1 ;; esac
      [ "$1" -gt 1 ] && [ -r /proc/self/stat ] || return 1
      observation="$(cloudbench_proc_pid_observation "$1")" || return 1
      [ "${observation%%$'\t'*}" = "$2" ]
      ;;
    *) [ "$(cloudbench_pid_birth_state "$1" "$2")" = "live" ] ;;
  esac
}

# Teardown calls these from EXIT traps, where a bare `return` reports the
# status from before the trap rather than the last command. Let the scanner or
# matcher be the final command so its own status is the function's status.
cloudbench_process_birth_table() {  # -> "<pid> <ppid> <birth identity>" per live process
  if [ -r /proc/self/stat ]; then
    python3 - <<'PY'
import os
import sys

with open("/proc/sys/kernel/random/boot_id", encoding="utf-8") as handle:
    boot_id = handle.read().strip()
if not boot_id:
    raise SystemExit(1)
rows = []
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    try:
        with open(f"/proc/{name}/stat", encoding="utf-8", errors="replace") as handle:
            stat = handle.read()
    except OSError:
        continue
    fields = stat[stat.rfind(")") + 2 :].split()
    if len(fields) <= 19 or not fields[1].isdigit() or not fields[19].isdigit():
        raise SystemExit(1)
    rows.append(f"{name} {fields[1]} proc-start:{boot_id}:{fields[19]}")
if not rows:
    raise SystemExit(1)
sys.stdout.write("\n".join(rows) + "\n")
PY
  else
    ps -axo pid=,ppid=,lstart= 2>/dev/null
  fi
}

cloudbench_terminate_tree_and_wait() {
  local timeout_seconds="$1"
  shift

  local pid job_pid start deadline live i actual_start state unresolved
  local observation process_stat expected_start process_table target_snapshot
  local captured_root kill_verify_seconds root_state
  local roots=() active_roots=() active_jobs=() targets=() target_starts=()
  local target_states=() remaining_roots=()
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
  # any signal. Capture ps(1) and parser status synchronously: process
  # substitution discards both exit codes and can turn an unavailable process
  # table into an empty, falsely successful teardown.
  if ! process_table="$(cloudbench_process_birth_table)"; then
    echo "Could not capture the process table for owned tree teardown" >&2
    return 1
  fi
  if ! target_snapshot="$(python3 -c '
import sys

roots = [int(value) for value in sys.argv[1:]]
children = {}
processes = {}
for raw in sys.stdin:
    if not raw.strip():
        continue
    fields = raw.split(None, 2)
    if len(fields) != 3:
        raise SystemExit(1)
    try:
        pid, ppid = map(int, fields[:2])
    except ValueError:
        raise SystemExit(1)
    start = " ".join(fields[2].split())
    if pid <= 0 or ppid < 0 or not start or pid in processes:
        raise SystemExit(1)
    processes[pid] = (ppid, start)
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
' "${active_roots[@]}" <<< "$process_table")"; then
    echo "Could not parse the process table for owned tree teardown" >&2
    return 1
  fi
  while IFS=$'\t' read -r pid start; do
    if [ -n "$pid" ] && [ -n "$start" ]; then
      targets+=("$pid")
      target_starts+=("$start")
    fi
  done <<< "$target_snapshot"

  # Every root that the shell still owns must have an exact birth in the one
  # successful snapshot before any signal is sent. A root can also exit cleanly
  # between the jobs(1) sample and the process-table snapshot (common once
  # mandatory autoscalers publish autoscaler.completed-after-child during guest
  # shutdown). Reap those already-terminal roots instead of failing closed on a
  # TOCTOU. Fail closed only when the shell still claims a live job that the
  # kernel/snapshot cannot account for — descendants may already be reparented.
  remaining_roots=()
  for job_pid in "${active_roots[@]}"; do
    captured_root=0
    for pid in "${targets[@]:-}"; do
      if [ "$pid" = "$job_pid" ]; then
        captured_root=1
        break
      fi
    done
    if [ "$captured_root" = "1" ]; then
      remaining_roots+=("$job_pid")
      continue
    fi

    # Never `wait` here without positive evidence that it returns at once: a
    # live root would block this bounded teardown until it exits, and Bash 5.2
    # can keep listing a child that died from the same group signal as Running
    # after the kernel reaped it. Classify the root from the kernel instead.
    # An absent root is terminal, exactly like one that exited between the job
    # sample and the snapshot; a zombie is reaped at once. A live root that the
    # one snapshot cannot account for fails closed without being signalled.
    if [ -r /proc/self/stat ]; then
      if [ ! -e "/proc/$job_pid" ]; then
        root_state=absent
      else
        observation="$(cloudbench_proc_pid_observation "$job_pid")" || observation=""
        root_state="${observation##*$'\t'}"
        [ -n "$observation" ] || root_state=unknown
      fi
    else
      root_state="$(ps -o stat= -p "$job_pid" 2>/dev/null | tr -d ' ')" || root_state=""
      if [ -z "$root_state" ] && ! kill -0 "$job_pid" 2>/dev/null; then
        root_state=absent
      fi
    fi
    case "$root_state" in
      absent) continue ;;
      Z*)
        wait "$job_pid" 2>/dev/null || true
        continue
        ;;
    esac
    echo "Owned process root $job_pid was absent from the teardown snapshot" >&2
    return 1
  done
  active_roots=()
  if [ "${#remaining_roots[@]}" -gt 0 ]; then
    active_roots=("${remaining_roots[@]}")
  fi
  [ "${#active_roots[@]}" -gt 0 ] || return 0

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
        # An exact single-thread Linux zombie cannot execute during TERM grace.
        # Keep the shared birth matcher unchanged: ownership is not liveness.
        observation="$(cloudbench_pid_observation_like "${targets[$i]}" "${target_starts[$i]}")" || observation=""
        actual_start="${observation%$'\t'*}"
        process_stat="${observation##*$'\t'}"
        if [ "$actual_start" = "${target_starts[$i]}" ] && [[ "$process_stat" = Z* ]] \
            && [ -d "/proc/${targets[$i]}/task" ]; then
          # Read the kernel directory directly; caller glob options cannot
          # hide a live peer. Failed enumeration remains nonterminal here.
          if python3 - "${targets[$i]}" <<'PY_SINGLETON_ZOMBIE'
import os
import sys
try:
    directory = os.open('/proc/' + sys.argv[1] + '/task',
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        singleton = os.listdir(directory) == [sys.argv[1]]
    finally:
        os.close(directory)
except OSError:
    raise SystemExit(1)
raise SystemExit(0 if singleton else 1)
PY_SINGLETON_ZOMBIE
          then
            observation="$(cloudbench_pid_observation_like "${targets[$i]}" "${target_starts[$i]}")" || observation=""
            if [ "${observation%$'\t'*}" = "${target_starts[$i]}" ] \
                && [[ "${observation##*$'\t'}" = Z* ]]; then
              continue
            fi
          fi
        fi
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

  # A waitable root can remain visible as a zombie after honoring KILL. Reap
  # only an exact captured root birth that ps(1) marks Z; waiting on any other
  # state could block beyond this function's bound. Reparented descendant
  # zombies are not waitable here, but are terminal/non-mutating below.
  for pid in "${active_roots[@]}"; do
    expected_start=""
    for ((i = 0; i < ${#targets[@]}; i++)); do
      if [ "${targets[$i]}" = "$pid" ]; then
        expected_start="${target_starts[$i]}"
        break
      fi
    done
    [ -n "$expected_start" ] || continue
    observation="$(cloudbench_pid_observation_like "$pid" "$expected_start")" || observation=""
    case "$observation" in
      *$'\t'*)
        actual_start="${observation%$'\t'*}"
        process_stat="${observation##*$'\t'}"
        if [ "$actual_start" = "$expected_start" ]; then
          case "$process_stat" in
            Z*) wait "$pid" 2>/dev/null || true ;;
          esac
        fi
        ;;
    esac
  done

  # SIGKILL delivery is not proof of process death (for example, a task can
  # remain uninterruptible), and a failed ps(1) lookup is not proof that the
  # captured birth disappeared. Recheck every captured birth for a fresh,
  # bounded grace period. A different non-empty birth means PID reuse and is
  # deliberately terminal for the original process; an empty/malformed birth
  # while kill -0 still sees the PID is unknown and therefore fails closed.
  # The kernel completes a SIGKILL asynchronously, so a zero TERM grace still
  # re-observes the captured births instead of judging them at delivery time.
  kill_verify_seconds="$timeout_seconds"
  [ "$kill_verify_seconds" -ge 5 ] || kill_verify_seconds=5
  deadline=$((SECONDS + kill_verify_seconds))
  while :; do
    unresolved=0
    target_states=()
    for ((i = 0; i < ${#targets[@]}; i++)); do
      observation="$(cloudbench_pid_observation_like "${targets[$i]}" "${target_starts[$i]}")" ||
        observation=""
      case "$observation" in
        *$'\t'*)
          actual_start="${observation%$'\t'*}"
          process_stat="${observation##*$'\t'}"
          ;;
        *)
          actual_start=""
          process_stat=""
          ;;
      esac
      if [ -n "$actual_start" ]; then
        if [ "$actual_start" = "${target_starts[$i]}" ]; then
          case "$process_stat" in
            Z*) state=zombie ;;
            *)
              state=survivor
              unresolved=1
              ;;
          esac
        else
          state=replaced
        fi
      elif kill -0 "${targets[$i]}" 2>/dev/null; then
        state=unknown
        unresolved=1
      else
        state=absent
      fi
      target_states+=("$state")
    done
    [ "$unresolved" -eq 0 ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      for ((i = 0; i < ${#targets[@]}; i++)); do
        case "${target_states[$i]}" in
          survivor)
            echo "Process ${targets[$i]} (${target_starts[$i]}) survived SIGKILL verification" >&2
            ;;
          unknown)
            echo "Process ${targets[$i]} still exists but its birth identity is unknown after SIGKILL" >&2
            ;;
        esac
      done
      return 1
    fi
    sleep 1
  done

  # Only direct children are waitable by this shell. Waiting roots is enough
  # to reap the tracked jobs after every captured birth was verified terminal.
  for pid in "${active_roots[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  return 0
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

# Warm-source clones require a fully stopped donor. Transitional states
# (started/starting/stopping/replacing/created/creating/updating/restarting)
# are normal during concurrent maintenance; aborting immediately turns a brief
# race into a fleet-wide INFRA failure. Wait for stopped, fail closed on
# destroy or timeout. state_reader must print the current provider state for
# the given machine id.
cloudbench_wait_machine_stopped() {
  local state_reader="$1" machine_id="$2" max_attempts="$3" retry_delay_seconds="$4"
  local attempt state

  for attempt in $(seq 1 "$max_attempts"); do
    state="$($state_reader "$machine_id" 2>/dev/null || true)"
    case "$state" in
      stopped) return 0 ;;
      destroyed|destroying)
        echo "Machine $machine_id became unavailable while waiting to stop (state=$state)" >&2
        return 1
        ;;
      created|creating|replacing|started|starting|stopping|updating|restarting|"")
        if [ "$attempt" -eq 1 ] || [ $((attempt % 5)) -eq 0 ]; then
          echo "⏳ waiting for machine $machine_id to stop (state=${state:-unknown}, attempt $attempt/$max_attempts)"
        fi
        ;;
      *)
        echo "Machine $machine_id has unexpected state while waiting to stop (state=$state)" >&2
        return 1
        ;;
    esac
    [ "$attempt" -ge "$max_attempts" ] || sleep "$retry_delay_seconds"
  done

  echo "Machine $machine_id did not become stopped (last_state=${state:-unknown})" >&2
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

# Dependency snapshots belong to the donor, not to a controller checkout. Keep
# each manifest set independently addressable so concurrent branches can reuse
# their own completed snapshot without rebuilding one another's dependencies.
cloudbench_warm_deps_metadata_key() {
  python3 -c 'import hashlib,sys; print("rose_cloudbench_deps_" + hashlib.sha256((sys.argv[1] + "\0" + sys.argv[2]).encode()).hexdigest()[:32])' "$1" "$2"
}

cloudbench_publish_warm_deps_state() {
  local key
  key="$(cloudbench_warm_deps_metadata_key "$4" "$5")" || return 1
  # The metadata-only endpoint does not update, start, or restart a Machine.
  # Auth stays in the process environment, never in argv or output.
  python3 -c '
import json, os, shutil, subprocess, sys, urllib.error, urllib.parse, urllib.request

app, machine, volume, node, python, epoch, snapshot, key = sys.argv[1:]
token = os.environ.get("FLY_API_TOKEN", "")
if not token:
    raise SystemExit(1)
scheme = "Bearer"
for prefix in ("Bearer ", "FlyV1 "):
    if token.startswith(prefix):
        scheme, token = prefix.strip(), token[len(prefix):].strip()
        break
# Fly sessions can contain expired third-party discharges. Refresh the same
# selected credential through flyctl rather than posting its raw .env value.
# Short-lived refreshed auth stays in memory; publication remains optional.
if token.startswith(("fm1r_", "fm1a_", "fm2_")):
    fly = shutil.which("flyctl") or shutil.which("fly")
    if not fly:
        raise SystemExit(1)
    auth_env = os.environ.copy()
    auth_env.pop("FLY_ACCESS_TOKEN", None)
    try:
        auth = subprocess.run([fly, "auth", "token", "--json", "--quiet"],
                              env=auth_env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, check=True, timeout=60)
        refreshed = json.loads(auth.stdout).get("token")
        if not isinstance(refreshed, str) or not refreshed.strip():
            raise ValueError("missing refreshed auth")
        token = refreshed.strip()
        scheme = "FlyV1"
        for prefix in ("Bearer ", "FlyV1 "):
            if token.startswith(prefix):
                scheme, token = prefix.strip(), token[len(prefix):].strip()
                break
        if not token:
            raise ValueError("empty refreshed auth")
    except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
        raise SystemExit(1)
host = os.environ.get("FLY_API_HOSTNAME", "https://api.machines.dev").rstrip("/")
if not host.startswith(("https://", "http://")):
    host = "https://" + host
endpoint = urllib.parse.urlsplit(host)
if endpoint.scheme != "https" and not (
    endpoint.scheme == "http" and endpoint.hostname in {"localhost", "127.0.0.1", "::1"}
):
    raise SystemExit(1)
path = "/v1/apps/{}/machines/{}/metadata/{}".format(*(urllib.parse.quote(part, safe="") for part in (app, machine, key)))
value = " ".join((node, python, epoch, snapshot, volume, machine, app))
request = urllib.request.Request(host + path, data=json.dumps({"value": value}).encode(), method="POST", headers={"Authorization": scheme + " " + token, "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(request, timeout=60) as response:
        raise SystemExit(0 if response.status == 204 else 1)
except (urllib.error.URLError, OSError, ValueError):
    raise SystemExit(1)
' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$key"
}

cloudbench_warm_deps_state_from_inventory() {
  local key
  key="$(cloudbench_warm_deps_metadata_key "$4" "$5")" || return 1
  python3 -c '
import datetime, json, re, sys

app, machine_id, volume_id, node, python, key = sys.argv[1:]
try:
    inventory = json.load(sys.stdin)
    machines = [m for m in inventory["machines"] if m.get("id") == machine_id]
    if len(machines) != 1:
        raise ValueError("ambiguous donor")
    config = machines[0]["config"]
    if not any(m.get("volume") == volume_id for m in config.get("mounts", [])):
        raise ValueError("donor volume changed")
    fields = config.get("metadata", {}).get(key, "").split()
    if len(fields) != 7 or fields[:2] != [node, python] or fields[4:] != [volume_id, machine_id, app]:
        raise ValueError("unproven dependencies")
    if not all(re.fullmatch(r"[0-9a-f]{64}", fp) for fp in fields[:2]):
        raise ValueError("invalid fingerprints")
    epoch = int(fields[2])
    if epoch <= 0 or not re.fullmatch(r"[A-Za-z0-9_-]+", fields[3]):
        raise ValueError("invalid snapshot identity")
    complete = {"created", "complete", "completed", "ready"}
    for snapshot in inventory["snapshots"]:
        if snapshot.get("id") != fields[3] or str(snapshot.get("status", "")).lower() not in complete or int(snapshot.get("size") or 0) <= 0:
            continue
        created = datetime.datetime.fromisoformat(snapshot["created_at"].replace("Z", "+00:00")).timestamp()
        if created >= epoch - 60:
            print(" ".join(fields[:4]))
            raise SystemExit(0)
except (KeyError, TypeError, ValueError, AttributeError):
    pass
raise SystemExit(1)
' "$1" "$2" "$3" "$4" "$5" "$key"
}

# Print "node python epoch snapshot" of the NEWEST dependency proof published on
# the donor (stdin: `machines list --json`). Every dependency refresh installs
# its trees on the one donor volume and publishes with its snapshot epoch, so
# the newest proof names the trees the volume currently holds — whichever
# checkout or devbox wrote it. Snapshot-only maintenance (--refresh-wmh) must
# republish under exactly these fingerprints, never a checkout's local receipt.
cloudbench_warm_deps_latest_proof() {  # <app> <machine-id> <volume-id>
  python3 -c '
import json, re, sys

app, machine_id, volume_id = sys.argv[1:]
try:
    machines = [m for m in json.load(sys.stdin) if isinstance(m, dict) and m.get("id") == machine_id]
    if len(machines) != 1:
        raise ValueError("ambiguous donor")
    config = machines[0]["config"]
    if not any(m.get("volume") == volume_id for m in config.get("mounts", [])):
        raise ValueError("donor volume changed")
    best = None
    for key, value in (config.get("metadata") or {}).items():
        if not key.startswith("rose_cloudbench_deps_") or not isinstance(value, str):
            continue
        fields = value.split()
        if len(fields) != 7 or fields[4:] != [volume_id, machine_id, app]:
            continue
        if not all(re.fullmatch(r"[0-9a-f]{64}", fp) for fp in fields[:2]):
            continue
        if not re.fullmatch(r"[1-9][0-9]*", fields[2]) or not re.fullmatch(r"[A-Za-z0-9_-]+", fields[3]):
            continue
        if best is None or int(fields[2]) > int(best[2]):
            best = fields
    if best is None:
        raise ValueError("no dependency proof")
    print(" ".join(best[:4]))
except (KeyError, TypeError, ValueError, AttributeError):
    raise SystemExit(1)
' "$1" "$2" "$3"
}

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
lock = json.loads(lock_path.read_text())
# Runtime policy belongs to the service/image configuration, not the installed
# dependency graph. npm mirrors package.json's engines field into only the root
# package entry, so normalize it out without weakening package/version checks.
root_package = lock.get("packages", {}).get("")
if isinstance(root_package, dict):
    root_package.pop("engines", None)
digest.update(b"back-end/package-lock.json\0")
digest.update(json.dumps(lock, sort_keys=True, separators=(",", ":")).encode())
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
    if [ "$status" -eq 1 ]; then
      owner="$(cat "$path" 2>/dev/null || true)"
      if { ! [[ "$owner" =~ ^[0-9]+$ ]] || ! kill -0 "$owner" 2>/dev/null; } &&
         [ "$path" -ef "/dev/fd/$CLOUDBENCH_CONTROLLER_LOCK_FD" ]; then
        # PID metadata can disappear after contention. Trust only a fresh
        # kernel lock on the same inode; never replace a stale-looking path.
        status=0
        flock -n "$CLOUDBENCH_CONTROLLER_LOCK_FD" || status=$?
        if [ "$status" -eq 0 ] &&
           [ ! "$path" -ef "/dev/fd/$CLOUDBENCH_CONTROLLER_LOCK_FD" ]; then
          flock -u "$CLOUDBENCH_CONTROLLER_LOCK_FD" 2>/dev/null || true
          status=1
        fi
      fi
    fi
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

cloudbench_controller_github_token_b64() {
  local token
  token="$(cloudbench_controller_github_token "${1:-${ROOT_DIR:-.}}")" || return 1
  printf '%s' "$token" | base64 | tr -d '\n'
}

cloudbench_git_auth_header_from_tokens() {
  local controller_b64="${1:-}" machine_token="${2:-}" token=""
  if [ -n "$controller_b64" ]; then
    token="$(printf '%s' "$controller_b64" | base64 -d 2>/dev/null || true)"
  fi
  if [ -z "$token" ] && [ -n "$machine_token" ]; then
    token="$machine_token"
  fi
  [ -n "$token" ] || return 1
  printf 'Authorization: Basic %s' "$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
}

# Checked bytes are executed directly, so an altered authority cannot run its
# own verification code (or change between verification and interpretation).
cloudbench_mutation_launch_code() {
  cat <<'PY'
import hashlib, json, os, sys
from pathlib import Path
helper = Path(sys.argv[1])
code = helper.read_bytes()
expected = json.loads(os.environ['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'])['source']['sha256']['cloudbench-campaign-mutation.py']
if hashlib.sha256(code).hexdigest() != expected:
    raise ValueError('native mutation authority changed before execution')
sys.argv = sys.argv[1:]
exec(compile(code, str(helper), 'exec'), {'__name__': '__main__', '__file__': str(helper)})
PY
}

cloudbench_mutation_admission() {
  python3 -S -c "$(cloudbench_mutation_launch_code)" "$@"
}

# Central Rose credential broker: the same origin production worker plans bind
# (scripts/production_worker_process.py).
CLOUDBENCH_PEOPLE_CREDENTIAL_BROKER_ORIGIN="https://navi-j9a9.onrender.com"

# Prints the people credential broker a benchmark stack's worker must use, or
# nothing when the operator configured one explicitly. Benchmark stacks route
# BACKEND_API_URL to their own isolated backend, whose seeded database never
# holds a rotating Lantern grant, so without an explicit bearer or broker every
# people_search fails with LANTERN_NOT_CONNECTED. A nonblank value in the
# process environment or the agents env file counts as explicit.
cloudbench_people_credential_broker_default() {  # <agents-env-file>
  local env_file="$1" key value
  for key in PEOPLE_CREDENTIAL_BROKER_URL PEOPLE_API_TOKEN; do
    value="${!key:-}"
    if [ -z "$value" ] && [ -f "$env_file" ]; then
      value="$(cloudbench_env_value "$env_file" "$key")"
    fi
    [ -n "${value//[[:space:]]/}" ] && return 0
  done
  printf '%s\n' "$CLOUDBENCH_PEOPLE_CREDENTIAL_BROKER_ORIGIN"
}

# Compute-token authority for benchmark guests (A1, approved 2026-10-20).
# Each guest restores its own database with copies of the same real compute
# tokens, so lease capacity, rate-limit marks and the shared Foundry cooldown
# are only correct when every guest delegates them to one backend
# (RCA 2026-10-20-bench-guests-ran-independent-compute-token-semaphores).
# Prints the authority URL, or nothing for BENCHMARK_COMPUTE_TOKEN_AUTHORITY=off
# (diagnostics only: the guest then keeps its own copied token state).
CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_ORIGIN="https://navi-j9a9.onrender.com"
cloudbench_compute_token_authority_url() {
  case "${BENCHMARK_COMPUTE_TOKEN_AUTHORITY:-on}" in
    off|OFF|Off|0|false|no) return 0 ;;
  esac
  printf '%s\n' "${CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL-$CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_ORIGIN}"
}

# Production Temporal namespace (mirror of agents/temporal_connection.py and
# back-end/src/providers/temporalNamespaceIsolation.ts). Not a secret.
ROSE_PRODUCTION_TEMPORAL_NAMESPACE=rose-labs-us-east-1.tch2n

# stack_bench_temporal_exports [agents-env]
# Prints `export TEMPORAL_ADDRESS=… TEMPORAL_NAMESPACE=… TEMPORAL_API_KEY=…`
# lines that move a dev/benchmark stack (scripts/run.sh) off the production
# namespace onto the benchmark namespace from the private guest override
# (agents/.env.benchmark-temporal), or prints nothing when the stack already
# targets a loopback dev server or another namespace. Fails when the stack
# would otherwise use production's namespace: its per-stack queue is orphaned
# when the stack stops (4,094 Running workflows on 2026-10-27).
stack_bench_temporal_exports() {
  local agents_env="${1:-agents/.env}" address namespace override
  address="${TEMPORAL_ADDRESS-}"
  [ -n "$address" ] || [ ! -f "$agents_env" ] || address="$(cloudbench_env_value "$agents_env" TEMPORAL_ADDRESS)"
  namespace="${TEMPORAL_NAMESPACE-}"
  [ -n "$namespace" ] || [ ! -f "$agents_env" ] || namespace="$(cloudbench_env_value "$agents_env" TEMPORAL_NAMESPACE)"
  case "${address%:*}" in localhost|127.0.0.1|::1|\[::1\]) return 0 ;; esac
  [ "$namespace" = "$ROSE_PRODUCTION_TEMPORAL_NAMESPACE" ] || return 0
  override="$(cloudbench_guest_temporal_override_file "$agents_env")" || return 1
  if [ -z "$override" ]; then
    echo "❌ This stack would run in the production Temporal namespace $ROSE_PRODUCTION_TEMPORAL_NAMESPACE. Install the private 0600 agents/.env.benchmark-temporal (CLOUDBENCH_GUEST_TEMPORAL_ADDRESS/_NAMESPACE/_API_KEY; boxes.dev managed env provides it), or export TEMPORAL_ADDRESS/TEMPORAL_NAMESPACE/TEMPORAL_API_KEY for a non-production namespace." >&2
    return 1
  fi
  python3 - "$override" "$ROSE_PRODUCTION_TEMPORAL_NAMESPACE" <<'PY'
import os, re, shlex, stat, sys

override, production = sys.argv[1:3]
keys = {
    "CLOUDBENCH_GUEST_TEMPORAL_ADDRESS": "TEMPORAL_ADDRESS",
    "CLOUDBENCH_GUEST_TEMPORAL_NAMESPACE": "TEMPORAL_NAMESPACE",
    "CLOUDBENCH_GUEST_TEMPORAL_API_KEY": "TEMPORAL_API_KEY",
}
info = os.stat(override)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
    sys.exit("❌ %s must be a regular file owned by this user with mode 0600" % override)
values = {}
for line in open(override, encoding="utf-8"):
    match = re.fullmatch(r"\s*(?:export\s+)?([A-Z0-9_]+)=(.*?)\s*", line.rstrip("\r\n"))
    if match and match.group(1) in keys:
        value = match.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[keys[match.group(1)]] = value
missing = sorted(source for source, target in keys.items() if not values.get(target))
if missing:
    sys.exit("❌ %s is missing %s" % (override, ", ".join(missing)))
if values["TEMPORAL_NAMESPACE"] == production:
    sys.exit("❌ %s names the production Temporal namespace; dev and benchmark stacks need the benchmark namespace" % override)
for name in ("TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_API_KEY"):
    print("export %s=%s" % (name, shlex.quote(values[name])))
PY
}

# A volume snapshot proof cannot establish the baked /app inputs used by fresh
# storage. Consume only an explicitly pinned, verified image-build receipt.
cloudbench_verify_image_dependency_receipt() {  # <receipt> <sha256> <source-id> <node> <python>
    python3 -c '
import hashlib, json, re, sys
from pathlib import Path
try:
    path, expected, source, node, python = sys.argv[1:]
    if not re.fullmatch("[0-9a-f]{64}", expected):
        raise ValueError("missing pinned image-build receipt SHA256")
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("image-build receipt checksum differs")
    proof = json.loads(raw)
    rows = [row for row in json.load(sys.stdin) if row.get("id") == source]
    if len(rows) != 1:
        raise ValueError("image source missing or ambiguous")
    row = rows[0]
    digest = (row.get("image_ref") or {}).get("digest") or row["config"]["image"].rpartition("@")[2]
    if not re.fullmatch("sha256:[0-9a-f]{64}", digest):
        raise ValueError("source image has no immutable digest")
    if proof.get("schema") != "cloudbench-image-build-v1" or proof.get("publication_verified") is not True:
        raise ValueError("image publication is unverified")
    image = proof.get("published_image_ref", "")
    if image.rpartition("@")[2] != digest or proof.get("image_ref") != image or proof.get("published_digest") != digest:
        raise ValueError("image receipt does not cover actual source image")
    if proof.get("node_dependency_fingerprint") != node or proof.get("python_dependency_fingerprint") != python:
        raise ValueError("baked image dependency identity differs from requested ref")
except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
    print("Fresh-storage image dependency admission refused: " + str(error), file=sys.stderr)
    raise SystemExit(1)
' "$@"
}

# Guest-only Node launch policy; never rewrite production or staged dotenv blobs.
cloudbench_kernel_proxy_node_options() {
    local guard="$1/back-end/scripts/blackbox-kernel-proxy-custody.cjs"
    if [ ! -f "$guard" ] || [ ! -r "$guard" ] || [ -L "$guard" ]; then
        echo '❌ cloud guest Kernel proxy custody preload is missing or unsafe' >&2
        return 1
    fi
    case "$guard" in
        *'"'*|*'\'*|*$'\n'*|*$'\r'*)
            echo '❌ cloud guest Kernel proxy custody path cannot be encoded safely' >&2
            return 1 ;;
    esac
    printf '%s--require="%s"\n' "${NODE_OPTIONS:+$NODE_OPTIONS }" "$guard"
}

# Project a controller's existing custody preload into a fixed guest policy bit.
# Never forward its checkout-specific NODE_OPTIONS path to another machine.
cloudbench_kernel_proxy_custody_policy() {
    case "${CLOUDBENCH_KERNEL_PROXY_CUSTODY-0}" in
        0|1) ;;
        *) echo '❌ invalid cloud guest Kernel proxy custody policy' >&2; return 1 ;;
    esac
    case "${NODE_OPTIONS:-}" in
        *blackbox-kernel-proxy-custody.cjs*) printf '1\n' ;;
        *) printf '%s\n' "${CLOUDBENCH_KERNEL_PROXY_CUSTODY-0}" ;;
    esac
}
