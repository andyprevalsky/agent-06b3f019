#!/usr/bin/env bash

# Resolve the database used by a running scripts/run.sh stack. Black-box cases
# mix HTTP requests with direct Prisma fixtures, so both sides must use the
# exact same database.
blackbox_service_manifest_db_selection() {
  local manifest_path="$1"
  local expected_base_url="${2:-}"

  python3 - "$manifest_path" "$expected_base_url" <<'PY'
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
expected_url = sys.argv[2].rstrip("/")

if not manifest_path.is_file():
    raise SystemExit(f"Existing-backend service manifest not found: {manifest_path}")

try:
    manifest = json.loads(manifest_path.read_text())
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"Invalid existing-backend service manifest: {error}")

urls = manifest.get("urls") or {}
manifest_url = (urls.get("backend_api") or urls.get("backend") or "").rstrip("/")
if expected_url and (not manifest_url or manifest_url != expected_url):
    raise SystemExit(
        f"Existing-backend manifest URL mismatch: manifest={manifest_url or '<missing>'} "
        f"requested={expected_url or '<missing>'}"
    )

database = manifest.get("database") or {}
if database.get("use_system_postgres") is True:
    print("system|5432|")
    raise SystemExit(0)

ports = manifest.get("ports") or {}
port = ports.get("local_db")
container = database.get("container")
if not isinstance(port, int) or port <= 0 or not isinstance(container, str) or not container:
    raise SystemExit("Existing-backend manifest does not identify its Postgres database")

print(f"docker|{port}|{container}")
PY
}

blackbox_existing_backend_db_selection() {
  blackbox_service_manifest_db_selection "$1" "$2"
}
