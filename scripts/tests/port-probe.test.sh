#!/usr/bin/env bash
# local_port_in_use must detect a listener with and without lsof on PATH.
# Without lsof the black-box runner used to reserve ports another worktree's
# isolated backend was already serving (cross-run test/database collisions).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/port-probe.sh
source "$ROOT_DIR/scripts/lib/port-probe.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

PORT_FILE="$(mktemp)"
node -e '
  const server = require("net").createServer();
  server.listen(0, "127.0.0.1", () => {
    require("fs").writeFileSync(process.argv[1], String(server.address().port));
  });
  setTimeout(() => process.exit(0), 30000);
' "$PORT_FILE" &
LISTENER_PID=$!
trap 'kill "$LISTENER_PID" 2>/dev/null || true; rm -f "$PORT_FILE"' EXIT

for _ in $(seq 1 100); do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.05
done
PORT="$(cat "$PORT_FILE")"
[[ -n "$PORT" ]] || fail "listener never reported its port"

# A PATH with the shell tools the probe needs but without lsof.
NO_LSOF_BIN="$(mktemp -d)"
for tool in bash ss; do
  if path="$(command -v "$tool")"; then ln -s "$path" "$NO_LSOF_BIN/$tool"; fi
done

PATH="$PATH" local_port_in_use "$PORT" || fail "default PATH: listener on $PORT reported free"
PATH="$NO_LSOF_BIN" local_port_in_use "$PORT" || fail "no lsof (ss): listener on $PORT reported free"
rm -f "$NO_LSOF_BIN/ss"
PATH="$NO_LSOF_BIN" local_port_in_use "$PORT" || fail "no lsof/ss (/dev/tcp): listener reported free"

kill "$LISTENER_PID" 2>/dev/null || true
wait "$LISTENER_PID" 2>/dev/null || true
if PATH="$NO_LSOF_BIN" local_port_in_use "$PORT"; then
  fail "closed port $PORT reported in use"
fi
rm -rf "$NO_LSOF_BIN"
echo "PASS: port probe detects listeners with lsof, ss and /dev/tcp"
