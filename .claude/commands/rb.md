Update conductor.json run script to: back-end + front-end + mac-app + agents (all services)

Add front-end if not present:
`(cd front-end && rm -f frontend-logs.log && npx vite 2>&1 | tee frontend-logs.log) &`

Add mac-app if not present:
`(cd mac-app && source ~/.nvm/nvm.sh && nvm use 20.10.0 && rm -f mac-app-console-logs.log && npm run dev 2>&1 | tee mac-app-console-logs.log) &`
