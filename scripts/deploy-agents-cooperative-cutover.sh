#!/usr/bin/env bash
# Cooperative agent-generation cutover on Fly.
#
# Same surface hash  → rolling `flyctl deploy` (activity-drain via kill_timeout).
# Changed surface hash → keep old-gen machines polling the old queue, bring up
# new-gen machines on the new image/hash, flip AgentQueuePointer, wait up to
# 45 minutes for cooperative continue_as_new handoff, then force-migrate any
# stragglers and retire old-gen machines.
#
# Required env:
#   FLY_API_TOKEN, APP, SURFACE_HASH, GENERATION_QUEUE, BUILD_ID,
#   DEPLOYMENT_TOKEN, DATABASE_URL (and Temporal creds for migrate/count)
set -euo pipefail

if [ -z "${FLY_API_TOKEN:-}" ]; then
  echo "FLY_API_TOKEN is required" >&2
  exit 2
fi
export FLY_API_TOKEN

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

APP="${APP:-${FLY_APP_NAME:-}}"
if [ -z "$APP" ]; then
  APP=$(grep -E '^\s*app\s*=' "$ROOT/agents/fly.toml" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
fi
APP="${APP:?APP (or FLY_APP_NAME) is required}"
SURFACE_HASH="${SURFACE_HASH:?SURFACE_HASH is required}"
GENERATION_QUEUE="${GENERATION_QUEUE:?GENERATION_QUEUE is required}"
BUILD_ID="${BUILD_ID:?BUILD_ID is required}"
DEPLOYMENT_TOKEN="${DEPLOYMENT_TOKEN:?DEPLOYMENT_TOKEN is required}"
# 45 minutes cooperative drain SLO before force-migrate.
DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-2700}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-30}"

MIN=$(grep -E '^\s*MIN_MACHINES\s*=' "$ROOT/agents/fly.toml" | head -1 | sed -E 's/.*"([0-9]+)".*/\1/')
MIN=${MIN:-8}

cd "$ROOT/back-end"
npm ci --workspaces=false --ignore-scripts
npx prisma generate

pointer_read() {
  npx tsx scripts/set-agent-queue-pointer.ts --read
}

pointer_field() {
  # Last JSON object line; Prisma may log before the payload.
  printf '%s' "$1" | node -e 'const f=process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n").reverse()){const t=l.trim();if(!t.startsWith("{"))continue;try{const o=JSON.parse(t);if(o&&("surfaceHash"in o||o===null)){if(o===null){process.stdout.write("");return}process.stdout.write(String(o[f]||""));return}}catch{}}process.stdout.write("")})' "$2"
}

POINTER_OUT="$(pointer_read || true)"
CURRENT_HASH="$(pointer_field "$POINTER_OUT" surfaceHash)"
CURRENT_QUEUE="$(pointer_field "$POINTER_OUT" taskQueue)"

echo "Live pointer hash='${CURRENT_HASH:-<none>}' queue='${CURRENT_QUEUE:-<none>}'"
echo "Deploy hash='$SURFACE_HASH' queue='$GENERATION_QUEUE'"

machine_ids_for_hash() {
  local hash="$1"
  flyctl machines list -a "$APP" --json | jq -r --arg h "$hash" '
    .[]
    | select((.config.env.TEMPORAL_WORKER_SURFACE_HASH // "") == $h)
    | .id
  '
}

all_started_ids() {
  flyctl machines list -a "$APP" --json | jq -r '.[] | select(.state=="started") | .id'
}

started_ids_for_hash() {
  local hash="$1"
  flyctl machines list -a "$APP" --json | jq -r --arg h "$hash" '
    .[]
    | select(.state=="started")
    | select((.config.env.TEMPORAL_WORKER_SURFACE_HASH // "") == $h)
    | .id
  '
}

if [ "$CURRENT_HASH" = "$SURFACE_HASH" ]; then
  echo "Surface unchanged — rolling deploy with activity-boundary drain"
  cd "$ROOT/agents"
  flyctl deploy --remote-only \
    --env TEMPORAL_WORKER_BUILD_ID="$BUILD_ID" \
    --env TEMPORAL_WORKER_SURFACE_HASH="$SURFACE_HASH" \
    --env TEMPORAL_WORKER_DEPLOYMENT_TOKEN="$DEPLOYMENT_TOKEN" \
    --env TEMPORAL_WORKER_REQUIRE_ACTIVATION="0"
  # Scale excess back to MIN (same-gen only — do not stop other generations).
  STARTED="$(started_ids_for_hash "$SURFACE_HASH")"
  COUNT=0
  for ID in $STARTED; do
    COUNT=$((COUNT + 1))
    if [ "$COUNT" -gt "$MIN" ]; then
      flyctl machines stop "$ID" -a "$APP" || true
    fi
  done
  echo "Same-generation rolling deploy complete"
  exit 0
fi

echo "Surface CHANGED ('${CURRENT_HASH:-<none>}' -> '$SURFACE_HASH') — overlapping cooperative cutover"

cd "$ROOT/agents"
# Build+push only. Do NOT replace old-gen machines; they must keep serving the
# old queue until agents hand off (or the 45m force-migrate fires).
IMAGE_LABEL="cutover-${SURFACE_HASH}-${DEPLOYMENT_TOKEN}"
if ! flyctl deploy --remote-only --build-only --push \
    --image-label "$IMAGE_LABEL" \
    -a "$APP" \
    --env TEMPORAL_WORKER_BUILD_ID="$BUILD_ID" \
    --env TEMPORAL_WORKER_SURFACE_HASH="$SURFACE_HASH" \
    --env TEMPORAL_WORKER_DEPLOYMENT_TOKEN="$DEPLOYMENT_TOKEN" \
    --env TEMPORAL_WORKER_REQUIRE_ACTIVATION="0" \
    2>&1 | tee /tmp/fly-build.log; then
  echo "❌ fly build-only deploy failed" >&2
  exit 1
fi
IMAGE_REF="registry.fly.io/${APP}:${IMAGE_LABEL}"
if ! grep -q "$IMAGE_LABEL" /tmp/fly-build.log 2>/dev/null; then
  # Best-effort: some flyctl versions omit the label in stdout; registry tag is canonical.
  echo "⚠️  build log did not mention $IMAGE_LABEL — using $IMAGE_REF"
fi
echo "Built image: $IMAGE_REF"

TEMPLATE_ID="$(all_started_ids | head -1)"
if [ -z "$TEMPLATE_ID" ]; then
  TEMPLATE_ID="$(flyctl machines list -a "$APP" --json | jq -r '.[0].id // empty')"
fi
if [ -z "$TEMPLATE_ID" ]; then
  echo "❌ no existing machine to clone as a template" >&2
  exit 1
fi

EXISTING_NEW="$(machine_ids_for_hash "$SURFACE_HASH" | wc -l | tr -d ' ')"
NEED=$((MIN - EXISTING_NEW))
if [ "$NEED" -lt 0 ]; then NEED=0; fi
echo "New-gen machines present=$EXISTING_NEW need_create=$NEED (min=$MIN)"

for i in $(seq 1 "$NEED"); do
  NAME="gen-${SURFACE_HASH}-$(date +%s)-$i"
  echo "Cloning template $TEMPLATE_ID -> $NAME"
  CLONE_OUT="$(flyctl machine clone "$TEMPLATE_ID" -a "$APP" --name "$NAME" 2>&1)" || {
    echo "❌ machine clone failed: $CLONE_OUT" >&2
    exit 1
  }
  NEW_ID="$(printf '%s\n' "$CLONE_OUT" \
    | sed -nE 's/^[[:space:]]*Machine ([0-9a-f]+) has been created[.][.][.]$/\1/p' \
    | tail -1)"
  if [ -z "$NEW_ID" ]; then
    NEW_ID="$(flyctl machines list -a "$APP" -j | jq -r --arg n "$NAME" '.[] | select(.name==$n) | .id' | head -1)"
  fi
  if [ -z "$NEW_ID" ]; then
    echo "❌ machine clone failed (no id): $CLONE_OUT" >&2
    exit 1
  fi
  flyctl machine update "$NEW_ID" -a "$APP" --image "$IMAGE_REF" --yes \
    --env "TEMPORAL_WORKER_BUILD_ID=$BUILD_ID" \
    --env "TEMPORAL_WORKER_SURFACE_HASH=$SURFACE_HASH" \
    --env "TEMPORAL_WORKER_DEPLOYMENT_TOKEN=$DEPLOYMENT_TOKEN" \
    --env "TEMPORAL_WORKER_REQUIRE_ACTIVATION=0"
  flyctl machines start "$NEW_ID" -a "$APP" || true
done

echo "Waiting for new-gen machines to pass /health..."
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
  healthy=0
  for ID in $(machine_ids_for_hash "$SURFACE_HASH"); do
    if flyctl machines list -a "$APP" -j | jq -e --arg id "$ID" '.[] | select(.id==$id and .state=="started")' >/dev/null; then
      healthy=$((healthy + 1))
    fi
  done
  echo "  new-gen started=$healthy / $MIN"
  if [ "$healthy" -ge "$MIN" ]; then
    break
  fi
  sleep 5
done

cd "$ROOT/back-end"
echo "Flipping AgentQueuePointer to $GENERATION_QUEUE"
npx tsx scripts/set-agent-queue-pointer.ts \
  --queue "$GENERATION_QUEUE" --surface-hash "$SURFACE_HASH" --by "deploy-${BUILD_ID}"
sleep 6

OLD_QUEUE="$CURRENT_QUEUE"
if [ -z "$OLD_QUEUE" ] && [ -n "$CURRENT_HASH" ]; then
  OLD_QUEUE="navi-agent-tasks@${CURRENT_HASH}"
fi

if [ -z "$OLD_QUEUE" ]; then
  echo "No previous generation queue — nothing to drain"
  exit 0
fi

# Temporal client logs INFO to stdout (logger.ts). Never assign the raw
# command output to OPEN — a polluted multiline string never equals "0", so
# the drain loop would burn the full 45m SLO even with an empty queue and
# then lose the race with the GHA step timeout during machine retirement
# (seen on run 33817062156: 0 open workflows the whole time, step killed at 60m).
count_open_on_queue() {
  local raw
  raw="$(npx tsx scripts/count-open-workflows-on-queue.ts --queue "$1" 2>/dev/null || true)"
  printf '%s\n' "$raw" | awk '/^[0-9]+$/{n=$0} END{if (n == "") print "?"; else print n}'
}

echo "Cooperative drain of $OLD_QUEUE (timeout=${DRAIN_TIMEOUT_SECONDS}s, force-migrate after SLO)"
drain_deadline=$((SECONDS + DRAIN_TIMEOUT_SECONDS))
while true; do
  OPEN="$(count_open_on_queue "$OLD_QUEUE")"
  echo "  open workflows on $OLD_QUEUE: $OPEN"
  if [ "$OPEN" = "0" ]; then
    echo "✅ Old generation drained via cooperative handoff"
    break
  fi
  if [ "$SECONDS" -ge "$drain_deadline" ]; then
    echo "⏰ 45m SLO reached with $OPEN workflows still on $OLD_QUEUE — force-clearing stragglers"
    if ! npx tsx scripts/force-clear-generation-queue.ts --queue "$OLD_QUEUE" --execute; then
      OPEN_AFTER="$(count_open_on_queue "$OLD_QUEUE")"
      if [ "$OPEN_AFTER" != "0" ]; then
        echo "❌ force-clear left $OPEN_AFTER workflow(s) on $OLD_QUEUE" >&2
        exit 1
      fi
      echo "⚠️  force-clear reported errors but old queue is empty — continuing cutover"
    fi
    break
  fi
  sleep "$DRAIN_POLL_SECONDS"
done

echo "Retiring old-generation machines (hash=${CURRENT_HASH:-unknown})"
if [ -n "$CURRENT_HASH" ]; then
  for ID in $(machine_ids_for_hash "$CURRENT_HASH"); do
    echo "  stopping+destroying old-gen machine $ID"
    flyctl machines stop "$ID" -a "$APP" || true
    flyctl machines destroy "$ID" -a "$APP" --force || true
  done
fi

echo "✅ Cooperative cutover complete for generation $SURFACE_HASH"
