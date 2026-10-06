#!/bin/bash
set -eo pipefail

SERVICES_MANIFEST="${BENCHMARK_CONTEXT_DIR:-.context}/services.json"

if [ -f "$SERVICES_MANIFEST" ]; then
    BACKEND_PORT_FROM_MANIFEST="$(
        SERVICES_MANIFEST="$SERVICES_MANIFEST" python3 -c '
import json
import os
from pathlib import Path

data = json.loads(Path(os.environ["SERVICES_MANIFEST"]).read_text())
print(data.get("ports", {}).get("backend", ""))
'
    )"
    PUBLIC_BASE_URL_FROM_MANIFEST="$(
        SERVICES_MANIFEST="$SERVICES_MANIFEST" python3 -c '
import json
import os
from pathlib import Path

data = json.loads(Path(os.environ["SERVICES_MANIFEST"]).read_text())
print(data.get("urls", {}).get("public", ""))
'
    )"
fi

BACKEND_PORT="${BACKEND_PORT:-${BACKEND_PORT_FROM_MANIFEST:-}}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${PUBLIC_BASE_URL_FROM_MANIFEST:-}}"

if [ -z "$BACKEND_PORT" ]; then
    echo "❌ BACKEND_PORT is required for public tunnel smoke."
    exit 1
fi
if [ -z "$PUBLIC_BASE_URL" ] || [ "$PUBLIC_BASE_URL" = "null" ] || [ "$PUBLIC_BASE_URL" = "http://localhost" ]; then
    echo "❌ PUBLIC_BASE_URL must be a stable public HTTPS URL."
    exit 1
fi
if ! printf '%s' "$PUBLIC_BASE_URL" | grep -Eq '^https://[^/]+$'; then
    echo "❌ PUBLIC_BASE_URL must be exactly an HTTPS origin, got: $PUBLIC_BASE_URL"
    exit 1
fi

expected_json="{\"url\":\"$PUBLIC_BASE_URL\"}"
actual_json=""
for attempt in $(seq 1 60); do
    actual_json="$(curl -fsS "http://localhost:$BACKEND_PORT/api/test-payment/public-url" 2>/dev/null || true)"
    if [ "$actual_json" = "$expected_json" ]; then
        break
    fi
    sleep 1
done
if [ "$actual_json" != "$expected_json" ]; then
    echo "❌ /api/test-payment/public-url returned $actual_json, expected $expected_json"
    exit 1
fi

# Cloud browsers are this origin's only consumer, so ask as one. Providers that
# gate browsers behind an interstitial pass curl's own User-Agent: localtunnel
# answers a browser with a 511 password page that a cloud browser can never get
# past, which surfaced as payment tasks timing out instead of failing here.
BROWSER_USER_AGENT="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
# The mount point in front-end/index.html.
APP_SHELL_MARKER='<div id="root">'
body_file="$(mktemp "${TMPDIR:-/tmp}/rose-public-tunnel.XXXXXX")"
trap 'rm -f "$body_file"' EXIT

status=""
for attempt in $(seq 1 60); do
    status="$(curl -sS -o "$body_file" -w '%{http_code}' \
        -A "$BROWSER_USER_AGENT" "$PUBLIC_BASE_URL/test_payment" 2>/dev/null || true)"
    if [ "$status" = "200" ] && grep -qF "$APP_SHELL_MARKER" "$body_file"; then
        break
    fi
    # 511 Network Authentication Required is a tunnel's browser gate, not a
    # transient state of the stack.
    [ "$status" = "511" ] && break
    sleep 1
done
if [ "$status" != "200" ]; then
    echo "❌ $PUBLIC_BASE_URL/test_payment returned HTTP $status to a browser, expected 200"
    [ "$status" = "511" ] && echo "   The tunnel provider gates browsers behind an interstitial that cloud browsers cannot pass."
    exit 1
fi
if ! grep -qF "$APP_SHELL_MARKER" "$body_file"; then
    echo "❌ $PUBLIC_BASE_URL/test_payment answered a browser with a page that is not the app (tunnel interstitial?)"
    exit 1
fi

echo "✅ Public tunnel smoke passed: $PUBLIC_BASE_URL"
