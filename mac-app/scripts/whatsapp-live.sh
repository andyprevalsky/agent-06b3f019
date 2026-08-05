#!/bin/bash
#
# One-command WhatsApp live pairing loop.
#
#   bash mac-app/scripts/whatsapp-live.sh            # pair / reconnect
#   bash mac-app/scripts/whatsapp-live.sh --reset    # forget creds, force fresh QR
#   bash mac-app/scripts/whatsapp-live.sh --verify   # show what landed in the DB, then exit
#
# Brings up whatever is missing (Postgres container, schema, backend), then runs
# the headless harness that drives the real messaging-whatsapp domain and prints
# the pairing QR in this terminal. No Electron build, no onboarding clicks.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$REPO_ROOT/mac-app/.whatsapp-harness"
DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME:-$(basename "$REPO_ROOT")}"
mkdir -p "$STATE_DIR"

# Pick a backend port this workspace actually owns. Bare 3001 belongs to
# whichever workspace grabbed it first; reusing it silently talks to (or
# collides with) a sibling's backend and its database.
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
pick_backend_port() {
  local candidates=()
  [ -n "${WA_BACKEND_PORT:-}" ] && candidates+=("$WA_BACKEND_PORT")
  [ -n "${CONDUCTOR_PORT:-}" ] && candidates+=("$((CONDUCTOR_PORT + 100))" "$CONDUCTOR_PORT")
  candidates+=(3001 3011 3021 3031)
  for p in "${candidates[@]}"; do
    # Reuse a port that is already serving OUR backend; skip any other listener.
    if curl -sf -o /dev/null --max-time 2 "http://localhost:$p/health"; then echo "$p"; return; fi
    if port_free "$p"; then echo "$p"; return; fi
  done
  return 1
}
BACKEND_PORT="$(pick_backend_port)" || { echo "no free backend port" >&2; exit 1; }
BACKEND_URL="http://localhost:${BACKEND_PORT}"

log() { printf '\033[36m[live]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[live] %s\033[0m\n' "$*" >&2; exit 1; }

# --- node 20 (mac-app is pinned; baileys + better-sqlite3 are built against it)
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 20.10.0 >/dev/null 2>&1 || log "node 20.10.0 not installed; using $(node -v)"
fi

# --- database -------------------------------------------------------------
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
    log "Starting existing Postgres container $DB_CONTAINER"
    docker start "$DB_CONTAINER" >/dev/null || die "could not start $DB_CONTAINER"
  else
    die "No container $DB_CONTAINER. Run: bash scripts/setup-db.sh"
  fi
fi
DB_PORT="$(docker port "$DB_CONTAINER" 5432 2>/dev/null | head -1 | sed 's/.*://')"
[ -n "$DB_PORT" ] || die "could not resolve host port for $DB_CONTAINER"
export DATABASE_URL="postgresql://postgres:postgres@localhost:${DB_PORT}/victoria"
export DIRECT_URL="$DATABASE_URL"
log "Postgres $DB_CONTAINER on :$DB_PORT"

# --- verify mode: just report what reached the DB -------------------------
if [ "${1:-}" = "--verify" ]; then
  docker exec "$DB_CONTAINER" psql -U postgres -d victoria -c \
    "SELECT status, \"lastSyncAt\" FROM \"Integration\" WHERE name='whatsapp';"
  docker exec "$DB_CONTAINER" psql -U postgres -d victoria -c \
    "SELECT count(*) AS whatsapp_messages FROM \"MessageRecord\" WHERE channel='WHATSAPP';"
  docker exec "$DB_CONTAINER" psql -U postgres -d victoria -c \
    "SELECT p.\"firstName\", m.\"from\", left(m.message, 44) AS preview, m.timestamp
       FROM \"MessageRecord\" m
       LEFT JOIN \"Person\" p ON p.id = m.\"personId\"
      WHERE m.channel='WHATSAPP'
      ORDER BY m.timestamp DESC LIMIT 15;"
  exit 0
fi

# --- backend --------------------------------------------------------------
if curl -sf -o /dev/null --max-time 3 "$BACKEND_URL/health"; then
  log "Backend already up at $BACKEND_URL"
else
  log "Starting backend on :$BACKEND_PORT ..."
  ( cd "$REPO_ROOT/back-end" && PORT="$BACKEND_PORT" npx tsx src/server.ts \
      > "$STATE_DIR/backend.log" 2>&1 & echo $! > "$STATE_DIR/backend.pid" )
  for _ in $(seq 1 45); do
    curl -sf -o /dev/null --max-time 2 "$BACKEND_URL/health" && break
    sleep 1
  done
  if ! curl -sf -o /dev/null --max-time 2 "$BACKEND_URL/health"; then
    tail -30 "$STATE_DIR/backend.log" >&2
    die "backend did not come up — see $STATE_DIR/backend.log"
  fi
  log "Backend ready (log: $STATE_DIR/backend.log)"
fi

# --- harness --------------------------------------------------------------
export VITE_BACKEND_API_URL="$BACKEND_URL"
export WA_HARNESS_DIR="$STATE_DIR"
[ "${1:-}" = "--reset" ] && export WA_RESET=1 && log "Reset requested — forcing a fresh QR"

log "Harness log: $STATE_DIR/whatsapp-live.log"
log "Verify later with: bash mac-app/scripts/whatsapp-live.sh --verify"
echo
cd "$REPO_ROOT/mac-app" && exec npx tsx scripts/whatsapp-live.ts
