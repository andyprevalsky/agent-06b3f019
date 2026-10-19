#!/usr/bin/env bash
source /home/boxes/rose/.context/g4/env.sh
CONDUCTOR_PORT=$(jq -er '.ports.backend' .context/services.json)
LOCAL_DB_PORT=$(jq -er '.database.runtime_port' .context/services.json)
SEMANTIC_GREP_INVERT="chat full-lifecycle latency" SEMANTIC_WORKERS=4 \
  LOCAL_DB_PORT=$LOCAL_DB_PORT BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh > .context/g4/semantic-ui.log 2>&1; echo "exit=$?" >> .context/g4/semantic-ui.log
SEMANTIC_WORKERS=1 LOCAL_DB_PORT=$LOCAL_DB_PORT BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh chat-lifecycle-latency > .context/g4/semantic-latency.log 2>&1; echo "exit=$?" >> .context/g4/semantic-latency.log
