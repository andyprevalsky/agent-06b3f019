#!/usr/bin/env bash
# run-blackbox-tests.sh owns an isolated backend and a port lock for the length
# of one run. Both must be gone when it exits: a surviving backend keeps serving
# (and writing to the test database) on a port no run will reclaim, and a
# surviving lock makes every later run skip that port.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Resolve the root exactly as run-blackbox-tests.sh does, so a deploy env that
# moves artifacts (BLACKBOX_TEST_ARTIFACT_ROOT) is probed and cleaned in place.
ARTIFACT_ROOT="${BLACKBOX_TEST_ARTIFACT_ROOT:-${CONTRACT_TEST_ARTIFACT_ROOT:-$ROOT_DIR/.context/test-runs}}"
RUN_ID="teardown-probe-$$-$RANDOM"
ARTIFACT_DIR="$ARTIFACT_ROOT/$RUN_ID"
TERM_RUN_ID="teardown-term-probe-$$-$RANDOM"
TERM_ARTIFACT_DIR="$ARTIFACT_ROOT/$TERM_RUN_ID"
TERM_OUTPUT="$(mktemp)"
# Port locks are host-wide (one root for every worktree), resolved as the runner does.
HOST_LOCK_ROOT="${BLACKBOX_TEST_PORT_LOCK_ROOT:-${CONTRACT_TEST_PORT_LOCK_ROOT:-/tmp/rose-blackbox-port-locks-$(id -u)}}"
OTHER_ARTIFACT_ROOT="$(mktemp -d)"
HELD_LOCK=""
FOREIGN_PID=""
PORT=""
TERM_PORT=""
RUNNER_PID=""

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$RUNNER_PID" ]] && kill -0 "$RUNNER_PID" 2>/dev/null; then
    kill -KILL "$RUNNER_PID" 2>/dev/null || true
  fi
  for port in "$PORT" "$TERM_PORT"; do
    if [[ -n "$port" ]]; then
      lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | xargs kill -KILL 2>/dev/null || true
    fi
  done
  if [[ -n "$FOREIGN_PID" ]]; then kill "$FOREIGN_PID" 2>/dev/null || true; fi
  if [[ -n "$HELD_LOCK" ]]; then rmdir "$HELD_LOCK" 2>/dev/null || true; fi
  rm -rf "$ARTIFACT_DIR" "$TERM_ARTIFACT_DIR" "$TERM_OUTPUT" "$OTHER_ARTIFACT_ROOT"
}
trap cleanup EXIT

assert_released() {
  local manifest="$1" label="$2" port base_url lock_dir
  port=$(jq -er '.port' "$manifest")
  base_url=$(jq -er '.base_url' "$manifest")
  if curl -fsS -m 2 "$base_url/health" >/dev/null 2>&1; then
    fail "$label: the isolated backend is still serving $base_url after the runner exited"
  fi
  lock_dir=$(jq -er '.port_lock_dir' "$manifest")
  [[ "$lock_dir" == "$HOST_LOCK_ROOT/$port" ]] || fail "$label: lock $lock_dir is not host-wide"
  if [[ -d "$lock_dir" ]]; then
    fail "$label: port lock $port outlived the run"
  fi
  echo "$port"
}

set +e
OUTPUT=$(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_RUN_ID="$RUN_ID" \
    bash scripts/run-blackbox-tests.sh __teardown_probe__ 2>&1
)
STATUS=$?
set -e

[[ "$STATUS" -ne 0 ]] || fail "an unknown domain was accepted"
grep -Fq "Backend ready at" <<<"$OUTPUT" || {
  echo "$OUTPUT" >&2
  fail "the isolated backend never became ready"
}
grep -Fq "Unknown domain(s): __teardown_probe__" <<<"$OUTPUT" || {
  echo "$OUTPUT" >&2
  fail "the runner did not reach the black-box test runner"
}

PORT=$(jq -er '.port' "$ARTIFACT_DIR/manifest.json")
assert_released "$ARTIFACT_DIR/manifest.json" "normal exit" >/dev/null
echo "PASS: isolated backend and port lock $PORT released on exit"

# SIGTERM while the backend boots. Bash resumes a script after a signal trap
# returns, so a cleanup-only TERM trap released the lock and kept going.
(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_RUN_ID="$TERM_RUN_ID" \
    exec bash scripts/run-blackbox-tests.sh __teardown_probe__
) >"$TERM_OUTPUT" 2>&1 &
RUNNER_PID=$!

for _ in $(seq 1 1200); do
  grep -Fq "Starting isolated backend" "$TERM_OUTPUT" && break
  kill -0 "$RUNNER_PID" 2>/dev/null || break
  sleep 0.1
done
grep -Fq "Starting isolated backend" "$TERM_OUTPUT" || {
  cat "$TERM_OUTPUT" >&2
  fail "the TERM probe never reached backend launch"
}
# Let the launch line and BACKEND_PID assignment run before signalling.
sleep 1
grep -Fq "Backend ready at" "$TERM_OUTPUT" && fail "the backend became ready before the TERM probe could signal"
TERM_PORT=$(jq -er '.port' "$TERM_ARTIFACT_DIR/manifest.json")

kill -TERM "$RUNNER_PID"
set +e
wait "$RUNNER_PID"
TERM_STATUS=$?
set -e
RUNNER_PID=""

if [[ "$TERM_STATUS" -ne 143 ]]; then
  cat "$TERM_OUTPUT" >&2
  fail "the runner exited $TERM_STATUS after SIGTERM; it must stop with 143"
fi
if grep -Eq "Backend ready at|Backend process exited before becoming ready" "$TERM_OUTPUT"; then
  cat "$TERM_OUTPUT" >&2
  fail "the runner kept running after its SIGTERM cleanup"
fi
assert_released "$TERM_ARTIFACT_DIR/manifest.json" "SIGTERM" >/dev/null
echo "PASS: SIGTERM stops the runner with 143 and releases backend and port lock $TERM_PORT"

# A free local port for the cases below (bound, read, released).
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

# Another worktree's run holds a port lock: a run under a different artifact
# root must honour that reservation and choose another port.
HELD_PORT="$(free_port)"
mkdir -p "$HOST_LOCK_ROOT"
HELD_LOCK="$HOST_LOCK_ROOT/$HELD_PORT"
mkdir "$HELD_LOCK"
OTHER_RUN_ID="teardown-other-root-$$-$RANDOM"
set +e
OTHER_OUTPUT=$(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_ARTIFACT_ROOT="$OTHER_ARTIFACT_ROOT" \
    BLACKBOX_TEST_BACKEND_START_PORT="$HELD_PORT" \
    BLACKBOX_TEST_RUN_ID="$OTHER_RUN_ID" \
    bash scripts/run-blackbox-tests.sh __teardown_probe__ 2>&1
)
set -e
OTHER_PORT=$(jq -er '.port' "$OTHER_ARTIFACT_ROOT/$OTHER_RUN_ID/manifest.json") || {
  echo "$OTHER_OUTPUT" >&2
  fail "the other-root run wrote no manifest"
}
[[ "$OTHER_PORT" != "$HELD_PORT" ]] ||
  fail "a run under another artifact root reused port $HELD_PORT locked by a different worktree"
rmdir "$HELD_LOCK"
HELD_LOCK=""
echo "PASS: a host-wide port lock held by another worktree is honoured ($HELD_PORT -> $OTHER_PORT)"

# Something else already serves /health on the chosen port. The runner must not
# run tests against it: its backend and database are not this run's.
if ! command -v lsof >/dev/null 2>&1 && ! command -v ss >/dev/null 2>&1; then
  echo "SKIP: no lsof/ss to attribute listeners; foreign-backend refusal not exercised"
  exit 0
fi
FOREIGN_PORT_FILE="$(mktemp)"
node -e '
  const server = require("http").createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
  });
  server.listen(0, "127.0.0.1", () => {
    require("fs").writeFileSync(process.argv[1], String(server.address().port));
  });
  setTimeout(() => process.exit(0), 120000);
' "$FOREIGN_PORT_FILE" &
FOREIGN_PID=$!
for _ in $(seq 1 100); do
  [[ -s "$FOREIGN_PORT_FILE" ]] && break
  sleep 0.05
done
FOREIGN_PORT="$(cat "$FOREIGN_PORT_FILE")"
rm -f "$FOREIGN_PORT_FILE"
[[ -n "$FOREIGN_PORT" ]] || fail "the foreign health server never reported its port"
FOREIGN_RUN_ID="teardown-foreign-$$-$RANDOM"
set +e
FOREIGN_OUTPUT=$(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_BACKEND_PORT="$FOREIGN_PORT" \
    BLACKBOX_TEST_RUN_ID="$FOREIGN_RUN_ID" \
    bash scripts/run-blackbox-tests.sh __teardown_probe__ 2>&1
)
FOREIGN_STATUS=$?
set -e
rm -rf "${ARTIFACT_ROOT:?}/$FOREIGN_RUN_ID"
[[ "$FOREIGN_STATUS" -ne 0 ]] || fail "the runner accepted a backend it did not start"
grep -Fq "not this run's backend" <<<"$FOREIGN_OUTPUT" || {
  echo "$FOREIGN_OUTPUT" >&2
  fail "the runner did not report the foreign listener"
}
if grep -Fq "Unknown domain(s)" <<<"$FOREIGN_OUTPUT"; then
  fail "tests ran against a backend this run did not start"
fi
[[ ! -d "$HOST_LOCK_ROOT/$FOREIGN_PORT" ]] || fail "the refused run left its port lock behind"
# The refusal lands while npx is still spawning the server; none of the run's
# processes (they carry its run id in their environment) may outlive it.
run_survivors() {
  if [[ -d /proc/self ]]; then
    grep -lsz "^BLACKBOX_TEST_RUN_ID=$1\$" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3 || true
  else
    ps -Eww -A -o pid=,command= 2>/dev/null | grep -F "BLACKBOX_TEST_RUN_ID=$1" | grep -vF grep |
      awk '{print $1}' || true
  fi
}
SURVIVORS=""
for _ in $(seq 1 12); do
  SURVIVORS="$(run_survivors "$FOREIGN_RUN_ID" | tr '\n' ' ')"
  [[ -n "${SURVIVORS// /}" ]] && break
  sleep 0.25
done
if [[ -n "${SURVIVORS// /}" ]]; then
  read -ra SURVIVOR_PIDS <<<"$SURVIVORS"
  kill -TERM "${SURVIVOR_PIDS[@]}" 2>/dev/null || true
  fail "the refused run left its backend processes running: $SURVIVORS"
fi
echo "PASS: a healthy port served by another process is refused before any test runs"
