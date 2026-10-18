#!/usr/bin/env bash
set -euo pipefail

ROOT="${CLOUDBENCH_ROOT_UNDER_TEST:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
if [ "$(uname -s)" != "Linux" ]; then
    exec python3 "$ROOT/scripts/tests/run-cloudbench-controller-linux.py" \
        --fixture status-service-shutdown
fi

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

tmp="$(mktemp -d)"
server_pid=""
driver_pid=""
unowned_pid=""
cleanup() {
    [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
    [ -z "$driver_pid" ] || kill -KILL "$driver_pid" 2>/dev/null || true
    [ -z "$unowned_pid" ] || kill "$unowned_pid" 2>/dev/null || true
    rm -rf "$tmp"
}
trap cleanup EXIT

# Reuse the existing owning control on Linux without adding pytest or dotenv
# to the offline controller image. Its host family skips this native branch.
python3 - "$ROOT" "$tmp" <<'PY_COHORT_OWNER'
import ast
import os
from pathlib import Path
import subprocess
import sys

root, temporary = map(Path, sys.argv[1:])
source = root / 'agents/benchmarks/cloudbench_campaign_inventory_test.py'
name = 'test_campaign_inventory_seed_preflight_native_linux_owner_tick_and_legacy_formats'
function = next(node for node in ast.parse(source.read_text()).body
                if isinstance(node, ast.FunctionDef) and node.name == name)
namespace = {'Path': Path, 'os': os, 'subprocess': subprocess, 'ROOT': root}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
scope = temporary / 'seed-owner'
scope.mkdir()
namespace[name](scope)
print('PASS: native cohort owner, wrong parent/publisher ticks and legacy birth format')
PY_COHORT_OWNER

# Reuse the permanent cache-parent permission controls in this root Linux
# namespace; derive their cases from the actual pytest decorator. Non-root
# hosts reach this fixture through the root controller container, so a skip
# here would only hide the permission control.
python3 - "$ROOT" <<'PY_CACHE_PARENT'
import ast
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if sys.platform != 'linux' or os.geteuid() != 0:
    sys.exit('FAIL: native cache-parent controls need root Linux; '
             'run scripts/tests/run-cloudbench-controller-linux.py --fixture status-service-shutdown')

root = Path(sys.argv[1])
source = root / 'agents/benchmarks/cloudbench_dependency_sync_test.py'
name = 'test_prebuilt_checkout_browser_cache_parent_is_runtime_writable'
function = next(node for node in ast.parse(source.read_text()).body
                if isinstance(node, ast.FunctionDef) and node.name == name)
parameter = function.decorator_list[0]
assert ast.literal_eval(parameter.args[0]) == 'parent_state'
cases = ast.literal_eval(parameter.args[1])
function.decorator_list = []
namespace = {'os': os, 'sys': sys, 'subprocess': subprocess,
             'DRIVER_SCRIPT': root / 'scripts/cloudbench-run.sh'}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
for state in cases:
    # The native control's runtime user needs a traversable fixture root.
    # Keep it separate from this fixture's private status/authentication files.
    scope = Path(tempfile.mkdtemp(prefix='rose-cache-parent-'))
    try:
        namespace[name](scope, state)
    finally:
        shutil.rmtree(scope)
print('PASS: native checkout cache parent permissions in all permanent states')
PY_CACHE_PARENT

# Exercise the actual server at the create-before-write boundary. A killed
# writer and concurrent readers must never expose a partial generation.
python3 - "$ROOT/scripts/cloudbench-status-server.py" "$tmp" <<'PY_GENERATION'
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

source, temporary = map(Path, sys.argv[1:])
bootstrap = r"""
import os, runpy, sys, time
from pathlib import Path
source, root, marker, release, mode, ready = sys.argv[1:]
native_open = os.open
def intercepted_open(path, flags, *args, **kwargs):
    descriptor = native_open(path, flags, *args, **kwargs)
    name = Path(path).name
    if flags & os.O_CREAT and (name == 'bench.log.generation' or
                              name.startswith('.bench.log.generation.')):
        Path(marker).write_text('opened\n')
        if mode == 'crash':
            os._exit(73)
        deadline = time.monotonic() + 5
        while not Path(release).exists():
            assert time.monotonic() < deadline, 'writer was not released'
            time.sleep(.01)
    return descriptor
os.open = intercepted_open
sys.argv = [source, '--bind', '127.0.0.1', '--port', '0', '--directory', root,
            '--ready-file', ready]
runpy.run_path(source, run_name='__main__')
"""

def await_file(path, process):
    deadline = time.monotonic() + 5
    while not path.exists():
        assert process.poll() is None, process.stdout.read().decode()
        assert time.monotonic() < deadline, f'owned server did not publish {path.name}'
        time.sleep(.01)

def generation(ready):
    with urllib.request.urlopen(
        f'http://127.0.0.1:{ready.read_text().strip()}/bench.log?offset=0&limit=32',
        timeout=2,
    ) as response:
        assert response.read() == b'owned log\n'
        return response.headers['X-Cloudbench-Log-Generation']

failures = []
for mode in ('crash', 'concurrent'):
    root = temporary / mode
    root.mkdir()
    (root / 'bench.log').write_text('owned log\n')
    marker, release = root / 'opened', root / 'release'
    first_ready, second_ready = root / 'first.ready', root / 'second.ready'
    processes = []
    try:
        first = subprocess.Popen(
            [sys.executable, '-c', bootstrap, str(source), str(root), str(marker),
             str(release), mode, str(first_ready)], stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        processes.append(first)
        await_file(marker, first)
        if mode == 'crash':
            assert first.wait(timeout=5) == 73
        second = subprocess.Popen(
            [sys.executable, str(source), '--bind', '127.0.0.1', '--port', '0',
             '--directory', str(root), '--ready-file', str(second_ready)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        processes.append(second)
        await_file(second_ready, second)
        winner = generation(second_ready)
        assert re.fullmatch(r'[0-9a-f]{32}', winner)
        assert (root / 'bench.log.generation').read_text().strip() == winner
        assert (root / 'bench.log.generation').stat().st_mode & 0o777 == 0o600
        release.touch()
        if mode == 'concurrent':
            await_file(first_ready, first)
            assert generation(first_ready) == winner, 'concurrent writer replaced winner'
    except AssertionError as error:
        failures.append(f'{mode}: {error}')
    finally:
        release.touch()
        for process in processes:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
assert not failures, '\n'.join(failures)
print('PASS: killed and concurrent generation publishers preserve complete ownership')
PY_GENERATION

run_token="test-run-$$"
auth_token="test-auth-$$"
ready_file="$tmp/status.ready"
driver_script="$tmp/fake-driver.sh"

cat > "$driver_script" <<'SH'
#!/usr/bin/env bash
set -u
root="$1"
run_token="$2"
trap '
  printf "replay-finalized\n" > "$root/replay.finalized"
  printf "%s\n" "$run_token" > "$root/cloudbench-driver-clean-$run_token.ack.tmp"
  mv "$root/cloudbench-driver-clean-$run_token.ack.tmp" "$root/cloudbench-driver-clean-$run_token.ack"
  while [ ! -e "$root/driver-exit.release" ]; do sleep 0.01; done
  exit 0
' TERM
while :; do sleep 1; done
SH
chmod +x "$driver_script"

CLOUDBENCH_RUN_TOKEN="$run_token" "$driver_script" "$tmp" "$run_token" &
driver_pid=$!
printf '%s\n' "$driver_pid" > "$tmp/cloudbench-driver.pid"
printf 'running\n' > "$tmp/cloudbench-driver.state"

# This is the production-shaped status-service boundary: the caller supplies a
# run token, binds a data-plane listener, and waits for an atomic ready marker.
CLOUDBENCH_BARRIER_TOKEN="$auth_token" \
    python3 "$ROOT/scripts/cloudbench-status-server.py" \
        --bind 127.0.0.1 --port 0 --directory "$tmp" \
        --run-token "$run_token" --ready-file "$ready_file" \
        >"$tmp/status.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 100); do
    [ -s "$ready_file" ] && break
    kill -0 "$server_pid" 2>/dev/null || {
        wait "$server_pid" || status=$?
        cat "$tmp/status.log" >&2
        fail "production-shaped status service exited before ready (status ${status:-0})"
    }
    sleep 0.05
done
[ -s "$ready_file" ] || fail "status service did not become ready"
port="$(cat "$ready_file")"

unauthorized="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:$port/shutdown")"
[ "$unauthorized" = 403 ] || fail "unauthenticated shutdown returned HTTP $unauthorized"
kill -0 "$driver_pid" 2>/dev/null || fail "unauthenticated request signalled the guest driver"

mkdir -p "$tmp/repo/.context/cloudbench/logs"
printf 'version=1\ntoken=%s\nstate=clean\n' "$run_token" \
    > "$tmp/cloudbench-interrupt-cleanup-$run_token.status"
printf '{"state":"quiesced"}\n' \
    > "$tmp/cloudbench-guest-quiescence-$run_token.json"
printf '{"state":"active"}\n' \
    > "$tmp/cloudbench-guest-state-$run_token.json"
printf '{"root_disposition":"database-absent"}\n' \
    > "$tmp/cloudbench-zero-allocation-$run_token.json"
printf '{"tasks":[]}\n' > "$tmp/repo/.context/cloudbench/run.json"
printf 'bounded backend evidence\n' \
    > "$tmp/repo/.context/cloudbench/logs/backend.log"
recovery_paths=(
    "/cloudbench-interrupt-cleanup-$run_token.status"
    "/cloudbench-guest-quiescence-$run_token.json"
    "/cloudbench-guest-state-$run_token.json"
    "/cloudbench-zero-allocation-$run_token.json"
    "/repo/.context/cloudbench/run.json"
    "/repo/.context/cloudbench/logs/backend.log"
)
for recovery_path in "${recovery_paths[@]}"; do
    unauthenticated_evidence="$(curl -sS -o /dev/null -w '%{http_code}' \
        "http://127.0.0.1:$port$recovery_path")"
    [ "$unauthenticated_evidence" = 403 ] \
        || fail "unauthenticated recovery evidence returned HTTP $unauthenticated_evidence: $recovery_path"
    authenticated_evidence="$(curl -sS -o "$tmp/recovery-response" -w '%{http_code}' \
        -H "Authorization: Bearer $auth_token" \
        "http://127.0.0.1:$port$recovery_path")"
    [ "$authenticated_evidence" = 200 ] \
        || fail "authenticated recovery evidence returned HTTP $authenticated_evidence: $recovery_path"
    cmp "$tmp/recovery-response" "$tmp${recovery_path}" \
        || fail "recovery evidence response differed from exact guest file: $recovery_path"
done

ln -s "$tmp/repo/.context/cloudbench/run.json" "$tmp/recovery-run-alias.json"
unauthenticated_alias="$(curl -sS -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$port/recovery-run-alias.json")"
[ "$unauthenticated_alias" = 403 ] \
    || fail "recovery evidence alias bypassed authentication with HTTP $unauthenticated_alias"
authenticated_alias="$(curl -sS -o "$tmp/recovery-alias-response" -w '%{http_code}' \
    -H "Authorization: Bearer $auth_token" \
    "http://127.0.0.1:$port/recovery-run-alias.json")"
[ "$authenticated_alias" = 200 ] \
    || fail "authenticated recovery evidence alias returned HTTP $authenticated_alias"
cmp "$tmp/recovery-alias-response" "$tmp/repo/.context/cloudbench/run.json" \
    || fail "authenticated recovery alias differed from exact guest file"

python3 - "$tmp/cloudbench-interrupt-cleanup-$run_token.status" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).write_bytes(b"x" * 65_537)
PY
oversized_evidence="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $auth_token" \
    "http://127.0.0.1:$port/cloudbench-interrupt-cleanup-$run_token.status")"
[ "$oversized_evidence" = 413 ] \
    || fail "oversized recovery evidence returned HTTP $oversized_evidence"

before_request="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $auth_token" \
    "http://127.0.0.1:$port/shutdown-health")"
[ "$before_request" = 409 ] || fail "shutdown health before request returned HTTP $before_request"

requested="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $auth_token" \
    "http://127.0.0.1:$port/shutdown")"
[ "$requested" = 202 ] || fail "authenticated shutdown returned HTTP $requested"

for _ in $(seq 1 100); do
    [ -s "$tmp/cloudbench-driver-clean-$run_token.ack" ] && break
    sleep 0.05
done
[ -s "$tmp/cloudbench-driver-clean-$run_token.ack" ] \
    || fail "driver did not publish its cleanup acknowledgement"
acknowledged_post="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $auth_token" \
    "http://127.0.0.1:$port/shutdown")"
[ "$acknowledged_post" = 202 ] \
    || fail "cleanup acknowledgement terminalized POST for a running driver (HTTP $acknowledged_post)"
pre_exit_code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $auth_token" \
    "http://127.0.0.1:$port/shutdown-health")"
[ "$pre_exit_code" = 202 ] \
    || fail "cleanup acknowledgement terminalized a running driver (HTTP $pre_exit_code)"
[ -s "$tmp/replay.finalized" ] || fail "cleanup acknowledged before replay finalization"

touch "$tmp/driver-exit.release"
wait "$driver_pid"
driver_pid=""
rm -f "$tmp/cloudbench-driver.pid"
printf 'exited\n' > "$tmp/cloudbench-driver.state.tmp"
mv "$tmp/cloudbench-driver.state.tmp" "$tmp/cloudbench-driver.state"

ack_code=""
for _ in $(seq 1 100); do
    ack_code="$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $auth_token" \
        "http://127.0.0.1:$port/shutdown-health")"
    [ "$ack_code" = 204 ] && break
    sleep 0.05
done
[ "$ack_code" = 204 ] || fail "guest cleanup was never acknowledged (HTTP $ack_code)"

# A stale/reused pid must never let one run signal another process.
rm -f "$tmp/cloudbench-shutdown-$run_token.request" \
    "$tmp/cloudbench-driver-clean-$run_token.ack"
sleep 60 &
unowned_pid=$!
printf '%s\n' "$unowned_pid" > "$tmp/cloudbench-driver.pid"
printf 'running\n' > "$tmp/cloudbench-driver.state"
wrong_owner="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $auth_token" \
    "http://127.0.0.1:$port/shutdown")"
[ "$wrong_owner" = 409 ] || fail "unowned driver pid returned HTTP $wrong_owner"
kill -0 "$unowned_pid" 2>/dev/null || fail "status service signalled a process owned by another run"
kill "$unowned_pid"
wait "$unowned_pid" 2>/dev/null || true
unowned_pid=""

# A shutdown racing driver startup remains durable for the boot entrypoint.
rm -f "$tmp/cloudbench-driver.pid" "$tmp/cloudbench-driver.state" \
    "$tmp/cloudbench-shutdown-$run_token.request"
booting="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $auth_token" \
    "http://127.0.0.1:$port/shutdown")"
[ "$booting" = 202 ] || fail "pre-driver shutdown returned HTTP $booting"
[ -e "$tmp/cloudbench-shutdown-$run_token.request" ] \
    || fail "pre-driver shutdown request was not durable"

if CLOUDBENCH_BARRIER_TOKEN="$auth_token" \
    python3 "$ROOT/scripts/cloudbench-status-server.py" \
        --bind 127.0.0.1 --port 0 --directory "$tmp" \
        --run-token 'invalid/token' >"$tmp/invalid-token.log" 2>&1; then
    fail "status service accepted an unsafe run token"
fi
rg -q 'invalid run token' "$tmp/invalid-token.log" \
    || fail "unsafe run token did not fail at the owned validation boundary"

echo "PASS: status service enforces authenticated run-scoped shutdown and cleanup acknowledgement"
