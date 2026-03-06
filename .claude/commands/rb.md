Update `scripts/run.sh` to run: back-end + front-end + mac-app + agents + research (all services)

Add front-end if not present:
`(cd front-end && rm -f frontend-logs.log && VITE_DEV_PORT=$FRONTEND_PORT npx vite 2>&1 | tee frontend-logs.log) &`

Add mac-app if not present:
`(cd mac-app && source ~/.nvm/nvm.sh && nvm use 20.10.0 && rm -f mac-app-console-logs.log mac-app-ipc-logs.log && npm run dev 2>&1 | tee mac-app-console-logs.log) &`

Do NOT modify the port allocation preamble at the top of the script. Only add/remove service blocks.
NEVER remove back-end, agents, or research — these are always required. The research service runs Supabase edge functions locally:
`(cd research && rm -f research-logs.log && ./run-local.sh 2>&1 | tee research-logs.log) &`
