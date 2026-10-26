#!/usr/bin/env bash
set -euo pipefail

validate_local_database_url() {
  local variable_name=$1
  local value=${!variable_name:-}
  if [ -z "$value" ]; then
    echo "$variable_name must be explicitly set for a local Prisma push" >&2
    exit 2
  fi
  node -e '
    const parsed = new URL(process.argv[1]);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) process.exit(1);
    // libpq/Prisma prefer a `host`/`hostaddr` query parameter over the authority.
    if (["host", "hostaddr"].some((key) => parsed.searchParams.has(key))) process.exit(1);
  ' "$value" || {
    echo "Refusing Prisma push: $variable_name is not a localhost database" >&2
    exit 2
  }
}

# Prisma schema.prisma has a directUrl. Overriding only DATABASE_URL can still
# send db push to DIRECT_URL, so both values must independently be local.
validate_local_database_url DATABASE_URL
validate_local_database_url DIRECT_URL

if [ "${PRISMA_LOCAL_PUSH_DRY_RUN:-0}" = "1" ]; then
  echo "Local Prisma push target validation passed"
  exit 0
fi

# Long-lived local databases can hold blank or duplicated phones that would
# block the unique User.phone index; normalize them on this same local target.
bash "$(dirname "${BASH_SOURCE[0]}")/normalize-local-user-phones.sh" "$DIRECT_URL" >/dev/null
bash "$(dirname "${BASH_SOURCE[0]}")/backfill-local-message-record-owner.sh" "$DIRECT_URL" >/dev/null

npx prisma db push "$@"
# Push cannot model the gin_trgm_ops index; restore it from its migration.
bash "$(dirname "${BASH_SOURCE[0]}")/apply-local-message-record-trgm-index.sh" "$DIRECT_URL" >/dev/null
