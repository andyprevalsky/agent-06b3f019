#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# shellcheck source=scripts/lib/blackbox-db.sh
source "$ROOT_DIR/scripts/lib/blackbox-db.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cat >"$TMP_ROOT/system.json" <<'JSON'
{
  "urls": {"backend_api": "http://localhost:55240"},
  "ports": {"local_db": 55245},
  "database": {
    "container": "victoria-db-test",
    "use_system_postgres": true
  }
}
JSON

selection="$(blackbox_existing_backend_db_selection "$TMP_ROOT/system.json" "http://localhost:55240/")"
[ "$selection" = "system|5432|" ] ||
  fail "system-Postgres stack must override a concurrently visible Docker container"

cat >"$TMP_ROOT/docker.json" <<'JSON'
{
  "urls": {"backend": "http://localhost:55240"},
  "ports": {"local_db": 55245},
  "database": {
    "container": "victoria-db-test",
    "use_system_postgres": false
  }
}
JSON

selection="$(blackbox_existing_backend_db_selection "$TMP_ROOT/docker.json" "http://localhost:55240")"
[ "$selection" = "docker|55245|victoria-db-test" ] ||
  fail "Docker-backed stack must select its manifest-recorded container and port"

selection="$(blackbox_service_manifest_db_selection "$TMP_ROOT/docker.json")"
[ "$selection" = "docker|55245|victoria-db-test" ] ||
  fail "coverage must select the workspace manifest database without a backend URL"

grep -Fq 'blackbox_service_manifest_db_selection' "$ROOT_DIR/back-end/scripts/run-coverage.sh" ||
  fail "backend coverage must prefer the workspace manifest database"
grep -Fq 'BLACKBOX_EXISTING_DB_SELECTION' "$ROOT_DIR/back-end/scripts/run-blackbox-tests.sh" ||
  fail "existing-backend blackbox runs must accept an authoritative caller DB selection"
grep -Fq 'BLACKBOX_EXISTING_DB_SELECTION="$COVERAGE_DB_SELECTION"' "$ROOT_DIR/back-end/scripts/run-coverage.sh" ||
  fail "coverage must pass its authoritative DB selection to its instrumented backend tests"

if blackbox_existing_backend_db_selection "$TMP_ROOT/docker.json" "http://localhost:55260" >/dev/null 2>&1; then
  fail "a manifest for a different backend must be rejected"
fi

if blackbox_existing_backend_db_selection "$TMP_ROOT/missing.json" "http://localhost:55240" >/dev/null 2>&1; then
  fail "an existing-backend run without a database manifest must fail closed"
fi

echo "blackbox DB selection tests passed"
