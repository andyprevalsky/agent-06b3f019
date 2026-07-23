#!/usr/bin/env bash
set -euo pipefail

: "${EXPECTED_WORKER_BUILD_ID:?EXPECTED_WORKER_BUILD_ID is required}"
: "${EXPECTED_WORKER_DEPLOYMENT_TOKEN:?EXPECTED_WORKER_DEPLOYMENT_TOKEN is required}"
: "${EXPECTED_WORKER_VALIDATION_TASK_QUEUE:?EXPECTED_WORKER_VALIDATION_TASK_QUEUE is required}"
: "${EXPECTED_WORKER_REQUIRE_ACTIVATION:?EXPECTED_WORKER_REQUIRE_ACTIVATION is required}"
: "${EXPECTED_WORKER_ACTIVATION_TIMEOUT_SECONDS:?EXPECTED_WORKER_ACTIVATION_TIMEOUT_SECONDS is required}"

FLY_APP="${FLY_APP:-navi-whisper-lux}"
MACHINES=$(flyctl machines list -a "$FLY_APP" --json)
RETAINED=$(jq '[.[] | select(.state != "destroyed")] | length' <<<"$MACHINES")
STARTED=$(jq '[.[] | select(.state == "started")] | length' <<<"$MACHINES")
MISMATCHED=$(
  jq \
    --arg sha "$EXPECTED_WORKER_BUILD_ID" \
    --arg token "$EXPECTED_WORKER_DEPLOYMENT_TOKEN" \
    --arg validation_queue "$EXPECTED_WORKER_VALIDATION_TASK_QUEUE" \
    --arg timeout "$EXPECTED_WORKER_ACTIVATION_TIMEOUT_SECONDS" \
    --arg activation "$EXPECTED_WORKER_REQUIRE_ACTIVATION" \
    '[.[] | select(
      .state != "destroyed" and
      (
        .config.env.TEMPORAL_WORKER_BUILD_ID != $sha or
        .config.env.TEMPORAL_WORKER_DEPLOYMENT_TOKEN != $token or
        .config.env.TEMPORAL_WORKER_VALIDATION_TASK_QUEUE != $validation_queue or
        .config.env.TEMPORAL_WORKER_ACTIVATION_TIMEOUT_SECONDS != $timeout or
        .config.env.TEMPORAL_WORKER_REQUIRE_ACTIVATION != $activation
      )
    )] | length' <<<"$MACHINES"
)

[ "$RETAINED" -gt 0 ] || {
  echo "No retained candidate machines in $FLY_APP" >&2
  exit 1
}
[ "$STARTED" -gt 0 ] || {
  echo "No started candidate machines in $FLY_APP" >&2
  exit 1
}
[ "$MISMATCHED" -eq 0 ] || {
  echo "$MISMATCHED retained machine(s) do not match build $EXPECTED_WORKER_BUILD_ID deployment=$EXPECTED_WORKER_DEPLOYMENT_TOKEN validation_queue=$EXPECTED_WORKER_VALIDATION_TASK_QUEUE activation=$EXPECTED_WORKER_REQUIRE_ACTIVATION" >&2
  exit 1
}

echo "All $RETAINED retained candidate machines ($STARTED started) match build $EXPECTED_WORKER_BUILD_ID deployment=$EXPECTED_WORKER_DEPLOYMENT_TOKEN validation_queue=$EXPECTED_WORKER_VALIDATION_TASK_QUEUE activation=$EXPECTED_WORKER_REQUIRE_ACTIVATION"
