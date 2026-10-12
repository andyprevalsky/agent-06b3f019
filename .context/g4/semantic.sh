. /tmp/deploy-env.sh
CONDUCTOR_PORT=$(jq -er '.ports.backend' .context/services.json)
LOCAL_DB_PORT=$(jq -er '.database.runtime_port' .context/services.json)
SEMANTIC_GREP_INVERT="chat full-lifecycle latency" SEMANTIC_WORKERS=4 \
  LOCAL_DB_PORT=$LOCAL_DB_PORT BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh
echo "SEMANTIC_UI_EXIT=$?"
SEMANTIC_WORKERS=1 LOCAL_DB_PORT=$LOCAL_DB_PORT BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh chat-lifecycle-latency
echo "SEMANTIC_LATENCY_EXIT=$?"
