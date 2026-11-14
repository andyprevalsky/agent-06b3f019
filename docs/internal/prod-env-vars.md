# Production env vars

Policy: adding, setting or removing env vars and credential values on Render, Fly, Vercel and Supabase needs no approval; first verify the target service, key precedence and consumers, stage keys before switching behavior, then validate health and the affected feature and roll back on regression. Rotating or revoking a credential needs Andy's explicit OK. Store every new value in every location below, never only in chat, and keep values out of logs, chat, Git and shell argv.

Never `source` an `.env` file (`agents/.env` is not shell-safe and leaks a token fragment). Load it with python-dotenv's CLI from the agents venv: `agents/venv/bin/dotenv -f <file> run -- <command>`. Commands below assume `$VALUE` is already in your shell, and pipe it on stdin.

## Render backend (service `srv-d3jga77diees73cgrvk0`)

- Read only with `cd back-end && npx tsx scripts/render-env.ts` (masked), `... KEY [KEY...]` (exact values), `--show` or `--json`. It paginates; a raw `env-vars?limit=100` request truncates at 100 of the service's 117+ vars and once made a present key look unset.
- Set one key:
  `cd back-end && printf %s "$VALUE" | ../agents/venv/bin/dotenv -f .env run -- sh -c 'python3 -c "import json,sys; print(json.dumps({\"value\": sys.stdin.read()}))" | curl -sf -X PUT -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars/KEY" -d @-'`

## Fly agents (app `navi-whisper-lux`)

- Read: `cd agents && venv/bin/dotenv -f .env run -- flyctl secrets list -a navi-whisper-lux`.
- Set: `cd agents && printf 'KEY=%s\n' "$VALUE" | venv/bin/dotenv -f .env run -- flyctl secrets import -a navi-whisper-lux` (add `--stage` to stage without restarting Machines).

## Vercel frontend (project in `front-end/`)

- Read: `cd front-end && vercel env ls production`.
- Set: `cd front-end && printf %s "$VALUE" | vercel env add KEY production`.

## Supabase functions (project `kzlurqihzaolhzsbkctf`)

- Read: `cd agents && venv/bin/dotenv -f .env run -- supabase secrets list --project-ref kzlurqihzaolhzsbkctf`.
- Set: write `KEY=VALUE` to a private (`umask 077`) temp file outside the checkout, run `cd agents && venv/bin/dotenv -f .env run -- supabase secrets set --env-file <that file> --project-ref kzlurqihzaolhzsbkctf`, then delete the file.

## boxes.dev managed env (Template box and future devboxes)

`printf %s "$VALUE" | dvb-onbox env set --file <agents/.env|back-end/.env> --name KEY --value-stdin` (needs the `edit-project-settings` permission).

## Rose project env files

Rose is replacing boxes.dev, so also write every key to the Rose project env files:

- Project `1ec468d5-95dc-4754-a385-1c9abe784cd4`; file IDs: `agents/.env` = `0dea3e6d-2c25-42ef-8c57-9cf84907aced`, `back-end/.env` = `cf1f2a24-4aeb-41a5-8f9c-3870dbee6083`. `GET https://api.roselabs.ai/api/projects/1ec468d5-95dc-4754-a385-1c9abe784cd4/env-files` lists files and variable names, never values.
- Set: `PUT https://api.roselabs.ai/api/projects/1ec468d5-95dc-4754-a385-1c9abe784cd4/env-files/<fileId>` with headers `X-API-Key: <BACKEND_API_KEY>` and `X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30` and body `{"variables":[{"name":"KEY","value":"VALUE","description":"..."}]}`. Listed variables are merged into the file; `removeVariables: ["KEY"]` deletes one.
- Send the request from a Python script (`urllib`, values loaded with `dotenv_values`) so values never appear in argv or output.
