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

# A prior clone can succeed on Fly while flyctl times out waiting for it to
# start. It may still carry the template's old env, or it may already carry
# this generation's hash but be stopped with an earlier deployment token.
candidate_ids_for_hash() {
  local hash="$1"
  flyctl machines list -a "$APP" --json | jq -r --arg h "$hash" '
    .[]
    | select((.name // "") | startswith("gen-" + $h + "-"))
    | .id
  '
}

# The Machines API intermittently answers an update with 408/5xx (run
# 36958270333). The update is safe to repeat — image and env are fixed for this
# rollout — so retry it in-run instead of failing the whole cutover.
MACHINE_UPDATE_ATTEMPTS="${MACHINE_UPDATE_ATTEMPTS:-4}"
configure_new_machine() {
  local id="$1" attempt
  for ((attempt = 1; attempt <= MACHINE_UPDATE_ATTEMPTS; attempt++)); do
    if flyctl machine update "$id" -a "$APP" --image "$IMAGE_REF" --yes \
      --skip-start --skip-health-checks \
      --env "TEMPORAL_WORKER_BUILD_ID=$BUILD_ID" \
      --env "TEMPORAL_WORKER_SURFACE_HASH=$SURFACE_HASH" \
      --env "TEMPORAL_WORKER_DEPLOYMENT_TOKEN=$DEPLOYMENT_TOKEN" \
      --env "TEMPORAL_WORKER_REQUIRE_ACTIVATION=0"; then
      flyctl machines start "$id" -a "$APP" || true
      return 0
    fi
    if [ "$attempt" -lt "$MACHINE_UPDATE_ATTEMPTS" ]; then
      echo "⚠️  machine update $id failed (attempt $attempt/$MACHINE_UPDATE_ATTEMPTS); retrying in $((attempt * 15))s" >&2
      sleep $((attempt * 15))
    fi
  done
  echo "❌ machine update $id failed after $MACHINE_UPDATE_ATTEMPTS attempts" >&2
  return 1
}

all_started_ids() {
  flyctl machines list -a "$APP" --json | jq -r '.[] | select(.state=="started") | .id'
}

if [ "$CURRENT_HASH" = "$SURFACE_HASH" ]; then
  echo "Surface unchanged — rolling deploy with activity-boundary drain"
  cd "$ROOT/agents"
  flyctl deploy --remote-only \
    --env TEMPORAL_WORKER_BUILD_ID="$BUILD_ID" \
    --env TEMPORAL_WORKER_SURFACE_HASH="$SURFACE_HASH" \
    --env TEMPORAL_WORKER_DEPLOYMENT_TOKEN="$DEPLOYMENT_TOKEN" \
    --env TEMPORAL_WORKER_REQUIRE_ACTIVATION="0"
  # Excess same-generation machines are left to the in-worker autoscaler,
  # which only stops peers reporting zero in-flight activities. Stopping them
  # here by position would SIGTERM machines mid-activity.
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

for ID in $(candidate_ids_for_hash "$SURFACE_HASH"); do
  echo "Adopting previously cloned machine $ID for generation $SURFACE_HASH"
  configure_new_machine "$ID"
done

EXISTING_NEW="$(machine_ids_for_hash "$SURFACE_HASH" | wc -l | tr -d ' ')"
NEED=$((MIN - EXISTING_NEW))
if [ "$NEED" -lt 0 ]; then NEED=0; fi
echo "New-gen machines present=$EXISTING_NEW need_create=$NEED (min=$MIN)"

for ((i = 1; i <= NEED; i++)); do
  NAME="gen-${SURFACE_HASH}-$(date +%s)-$i"
  echo "Cloning template $TEMPLATE_ID -> $NAME"
  # clone --detach returns once the Machine exists. The cloned old image may
  # start and stop before flyctl's default five-minute state wait completes.
  CLONE_OUT="$(flyctl machine clone "$TEMPLATE_ID" -a "$APP" --name "$NAME" --detach 2>&1)" || {
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
  configure_new_machine "$NEW_ID"
done

echo "Waiting for new-gen machines to pass /health..."
deadline=$((SECONDS + 300))
healthy=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! NEW_GEN_STATES="$(flyctl machines list -a "$APP" --json | jq -r --arg h "$SURFACE_HASH" '
    .[]
    | select((.config.env.TEMPORAL_WORKER_SURFACE_HASH // "") == $h)
    | "\(.id) \(.state)"
  ')"; then
    echo "  ⚠️  machines list failed; retrying" >&2
    sleep 5
    continue
  fi
  healthy="$(printf '%s\n' "$NEW_GEN_STATES" | awk '$2 == "started" { n++ } END { print n + 0 }')"
  echo "  new-gen started=$healthy / $MIN"
  if [ "$healthy" -ge "$MIN" ]; then
    break
  fi
  # Fly refuses a start issued while the preceding update is still replacing
  # the VM ("failed_precondition: machine getting replaced"; run 36963508348),
  # so a single start right after the update is not enough.
  for ID in $(printf '%s\n' "$NEW_GEN_STATES" |
    awk -v need="$((MIN - healthy))" '($2 == "stopped" || $2 == "created") && n < need { n++; print $1 }'); do
    flyctl machines start "$ID" -a "$APP" || true
  done
  sleep 5
done

if [ "$healthy" -lt "$MIN" ]; then
  echo "❌ only $healthy / $MIN new-generation machines started; refusing to flip the queue pointer" >&2
  exit 1
fi

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
  # Capture status separately: the TS helper can print a count and still exit
  # non-zero (e.g. prisma.$disconnect failure). Masking with `|| true` would
  # let drain/post-clear treat that unknown state as a real integer (incl. 0).
  local raw status
  raw="$(npx tsx scripts/count-open-workflows-on-queue.ts --queue "$1" 2>/dev/null)" && status=0 || status=$?
  if [ "$status" -ne 0 ]; then
    printf '?\n'
    return 0
  fi
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
  # Cap total retire wall-clock so N serial machines cannot burn the GHA step
  # after drain already succeeded (12 machines × 240s would be 48m alone).
  retire_deadline=$((SECONDS + 900))
  for ID in $(machine_ids_for_hash "$CURRENT_HASH"); do
    if [ "$SECONDS" -ge "$retire_deadline" ]; then
      echo "⚠️  old-gen retire budget (15m) exhausted — leftover machines deferred to next deploy"
      break
    fi
    echo "  stopping+destroying old-gen machine $ID"
    # Bound each call — a hung stop/destroy previously burned the whole GHA
    # step after drain had already succeeded (pointer flipped, old queue=0).
    # --kill-after ensures flyctl cannot ignore SIGTERM and overrun the budget.
    timeout --kill-after=30s 120 flyctl machines stop "$ID" -a "$APP" || true
    timeout --kill-after=30s 120 flyctl machines destroy "$ID" -a "$APP" --force || true
  done
fi

echo "✅ Cooperative cutover complete for generation $SURFACE_HASH"
