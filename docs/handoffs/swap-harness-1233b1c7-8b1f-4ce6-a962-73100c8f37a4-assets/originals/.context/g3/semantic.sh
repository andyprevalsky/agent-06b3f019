. /home/boxes/rose/.context/g3/env.sh
CONDUCTOR_PORT=$(jq -er '.ports.backend' .context/services.json)
LOCAL_DB_PORT=$(jq -er '.database.runtime_port' .context/services.json)
SEMANTIC_GREP_INVERT="chat full-lifecycle latency" SEMANTIC_WORKERS=4 \
  LOCAL_DB_PORT=$LOCAL_DB_PORT BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh; e1=$?
SEMANTIC_WORKERS=1 LOCAL_DB_PORT=$LOCAL_DB_PORT BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh chat-lifecycle-latency; e2=$?
echo "SEMANTIC_DONE ui=$e1 latency=$e2"
