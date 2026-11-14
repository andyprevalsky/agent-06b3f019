# back-end

Backend rules (Express/TypeScript/Prisma on Render). The root `CLAUDE.md` still applies; numbers in parentheses are stable rule IDs.

## Tests

- Cover every API change in `src/tests/blackbox/<domain>.blackbox.ts` (rule 3).
- `.env` points `DATABASE_URL` and `DIRECT_URL` at the PROD pooler, so a direct `npx tsx --test src/tests/unit/<file>.test.ts` runs against production (DB-backed unit tests wrote fixture rows there on 2026-10-23 and 2026-10-27).
- Run DB-backed unit tests only through `npm run test:unit` or the blackbox/coverage runners, which point both URLs at local Postgres; pass `BACKEND_UNIT_DATABASE_URL=<local victoria_<workspace> URL>` to choose the database explicitly.
- `src/providers/database.ts` refuses queries from a `src/tests/` entrypoint with a non-local URL; never set `BACKEND_UNIT_ALLOW_REMOTE_DB=1` or `BLACKBOX_TEST_ALLOW_REMOTE_DATABASE=1` to get past it.
- On a Fly host, launch local backend test children with `env -u FLY_APP_NAME` (for example `env -u FLY_APP_NAME npm run test:coverage`): any defined value, even empty, selects production mode and suppresses the local LLM dumps the Rose and stream-contract blackboxes assert. Keep the parent controller's Fly identity.

## Migrations

- Never run `prisma db push` or `prisma migrate dev` from this directory: `.env` targets PROD, and a push drops every index Prisma cannot model (trigram, partial, expression).
- Never use `prisma migrate dev` even locally: its shadow database replays the squashed baseline, whose Supabase RLS policies (`auth.uid()`) and `realtime.*` triggers do not exist on plain Postgres.
- Name the local database explicitly: `LOCAL=postgresql://postgres:postgres@localhost:5432/<local db>`. On a box with `.cloud-env`, `victoria` is that box's own database and may be named here; elsewhere use your workspace's database.
- Edit `prisma/schema.prisma`, then, BEFORE the local push (while the local database still has the old schema), author the migration with `npx prisma migrate diff --from-url "$LOCAL" --to-schema-datamodel prisma/schema.prisma --script` into `prisma/migrations/<timestamp>_<name>/migration.sql` (timestamp from `date +%Y%m%d%H%M%S`).
- Review the SQL, then apply it locally with `DATABASE_URL="$LOCAL" DIRECT_URL="$LOCAL" npm run prisma:push:local`, which refuses any non-localhost target.
- Commit the migration directory with the schema change. Prod `migrate deploy` applies only `<timestamp>_<name>/migration.sql` directories; a loose `.sql` in the migrations root is ignored.
- `src/tests/structural/migration-drift.test.ts` fails when the schema and migrations drift in either direction.
- History is one squashed baseline, `00000000000000_init` (prod `pg_dump` of 2026-07-06 cleaned by `scripts/clean-baseline-dump.py`, marked applied with `migrate resolve --applied`); to re-baseline after major drift, rerun that script on a fresh dump and re-resolve.

## Logging

Always log these, with a `[Component]` prefix, the relevant IDs, and payloads truncated to 200 characters:

1. HTTP requests: method, path, body, response status, duration.
2. External calls (Temporal, LLM, third-party APIs): request and response.
3. Workflow events: phase transitions, signals, completion or failure.
4. Tool execution: tool name, input summary, output summary, duration.
5. DB mutations: table, operation, record ID.
6. Errors: message, stack and context (`agentId`, `userId`).

## Data providers

- Model a new user-data provider first as a normalized, grep-searchable document source with explicit sync state, source metadata, snapshot revision semantics, prod-path tests and a prod-data benchmark, before adding bespoke provider behavior (rule 23).
