#!/bin/bash
set -e

if [ -z "$CONDUCTOR_PORT" ]; then
  echo '❌ CONDUCTOR_PORT not set. Run via Conductor.'
  exit 1
fi

export BACKEND_PORT=$CONDUCTOR_PORT
export FRONTEND_PORT=$(($BACKEND_PORT + 1))
export HEALTH_PORT=$(($BACKEND_PORT + 2))
export BACKEND_API_URL=http://localhost:$BACKEND_PORT
export VITE_BACKEND_API_URL=http://localhost:$BACKEND_PORT
export BACKEND_URL=http://localhost:$BACKEND_PORT
export MAC_APP_PORT=5174
export ALLOWED_ORIGINS=http://localhost:$FRONTEND_PORT,http://localhost:$MAC_APP_PORT
export TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME

echo "🔌 Ports: backend=$BACKEND_PORT frontend=$FRONTEND_PORT health=$HEALTH_PORT queue=$TEMPORAL_TASK_QUEUE"

(cd back-end && rm -f backend-logs.log && PORT=$BACKEND_PORT npx tsx watch src/server.ts 2>&1 | tee backend-logs.log) &
(cd front-end && rm -f frontend-logs.log && VITE_DEV_PORT=$FRONTEND_PORT npx vite 2>&1 | tee frontend-logs.log) &
(cd mac-app && source ~/.nvm/nvm.sh && nvm use 20.10.0 && rm -f mac-app-console-logs.log mac-app-ipc-logs.log && VITE_BACKEND_API_URL=http://localhost:$BACKEND_PORT npm run dev 2>&1 | tee mac-app-console-logs.log) &
(cd agents && source venv/bin/activate && HEALTH_CHECK_PORT=$HEALTH_PORT ./scripts/run_local_worker.sh) &
(cd research && rm -f research-logs.log && ./run-local.sh 2>&1 | tee research-logs.log) &

wait
