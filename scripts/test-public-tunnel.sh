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

status=""
for attempt in $(seq 1 60); do
    status="$(curl -fsS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE_URL/test_payment" 2>/dev/null || true)"
    if [ "$status" = "200" ]; then
        break
    fi
    sleep 1
done
if [ "$status" != "200" ]; then
    echo "❌ $PUBLIC_BASE_URL/test_payment returned HTTP $status, expected 200"
    exit 1
fi

echo "✅ Public tunnel smoke passed: $PUBLIC_BASE_URL"
