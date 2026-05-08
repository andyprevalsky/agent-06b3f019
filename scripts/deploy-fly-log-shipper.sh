#!/bin/bash
set -euo pipefail

APP="${FLY_LOG_SHIPPER_APP:-rose-fly-log-shipper}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIPPER_DIR="$ROOT_DIR/observability/fly-log-shipper"

load_env_file() {
  local path="$1"
  [ -f "$path" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue

    local key="${line%%=*}"
    local value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [ -z "${!key:-}" ] || continue

    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    export "$key=$value"
  done < "$path"
}

load_env_file "$ROOT_DIR/back-end/.env"
load_env_file "$ROOT_DIR/agents/.env"

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required env var: $name" >&2
    exit 1
  fi
}

require_env FLY_API_TOKEN
require_env FLY_LOG_SHIPPER_ORG
require_env FLY_LOG_SHIPPER_ACCESS_TOKEN
require_env CLICKHOUSE_ENDPOINT
require_env CLICKHOUSE_USER
require_env CLICKHOUSE_PASSWORD

CLICKHOUSE_DATABASE="${CLICKHOUSE_DATABASE:-observability}"
CLICKHOUSE_TABLE="${CLICKHOUSE_TABLE:-fly_logs}"

if ! flyctl status -a "$APP" >/dev/null 2>&1; then
  flyctl apps create "$APP" --org "$FLY_LOG_SHIPPER_ORG"
fi

flyctl secrets set \
  -a "$APP" \
  ORG="$FLY_LOG_SHIPPER_ORG" \
  ACCESS_TOKEN="$FLY_LOG_SHIPPER_ACCESS_TOKEN" \
  CLICKHOUSE_ENDPOINT="$CLICKHOUSE_ENDPOINT" \
  CLICKHOUSE_DATABASE="$CLICKHOUSE_DATABASE" \
  CLICKHOUSE_TABLE="$CLICKHOUSE_TABLE" \
  CLICKHOUSE_USER="$CLICKHOUSE_USER" \
  CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD"

cd "$SHIPPER_DIR"
flyctl deploy --config fly.toml --app "$APP" --remote-only --ha=false
