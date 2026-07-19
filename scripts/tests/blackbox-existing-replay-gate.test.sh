#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT_FILE="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$PORT_FILE"
}
trap cleanup EXIT

python3 - "$PORT_FILE" <<'PY' &
import http.server
import json
import sys


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/api/test/captures/status":
            self.send_error(404)
            return
        body = json.dumps({"captureEnabled": True, "replayEnabled": False}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write(str(server.server_port))
server.serve_forever()
PY
SERVER_PID=$!

for _ in $(seq 1 50); do
  [[ -s "$PORT_FILE" ]] && break
  kill -0 "$SERVER_PID" 2>/dev/null || {
    echo "FAIL: mock capability server exited before startup" >&2
    exit 1
  }
  sleep 0.1
done
[[ -s "$PORT_FILE" ]] || {
  echo "FAIL: mock capability server did not publish a port" >&2
  exit 1
}

PORT=$(cat "$PORT_FILE")
set +e
OUTPUT=$(
  cd "$ROOT_DIR/back-end" && \
    BLACKBOX_TEST_USE_EXISTING_BACKEND=1 \
    TEST_BASE_URL="http://127.0.0.1:$PORT" \
    bash scripts/run-blackbox-tests.sh 2>&1
)
STATUS=$?
set -e

[[ "$STATUS" -ne 0 ]] || {
  echo "FAIL: capture-only existing backend was accepted" >&2
  exit 1
}
grep -Fq "requires outbound capture and replay" <<<"$OUTPUT" || {
  echo "FAIL: runner did not explain the missing replay capability" >&2
  echo "$OUTPUT" >&2
  exit 1
}
if grep -Fq "Syncing Prisma schema" <<<"$OUTPUT"; then
  echo "FAIL: capability rejection happened after database mutation" >&2
  exit 1
fi

echo "Existing-backend replay capability gate passed."
