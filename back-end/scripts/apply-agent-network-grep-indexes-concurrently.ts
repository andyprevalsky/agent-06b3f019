import { execFileSync } from 'node:child_process';

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL or DIRECT_URL is required');
}

function toPsqlUrl(url: string) {
  const parsed = new URL(url);
  parsed.searchParams.delete('pgbouncer');
  return parsed.toString();
}

const statements = [
  'CREATE EXTENSION IF NOT EXISTS pg_trgm',
  'SET statement_timeout = 0',
  `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_agent_network_grep_trgm_idx"
    ON public."Message"
    USING gin (
      ((text || E'\\n' || COALESCE(metadata::text, '') || E'\\n' || COALESCE("filePointer"::text, '')))
      public.gin_trgm_ops
    )
  `,
  `
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_agentId_createdAt_id_idx"
    ON public."Message" ("agentId", "createdAt" DESC, id DESC)
  `,
];

function main() {
  const psqlUrl = toPsqlUrl(databaseUrl);
  for (const statement of statements) {
    execFileSync('psql', [psqlUrl, '-v', 'ON_ERROR_STOP=1', '-c', statement], {
      stdio: 'inherit',
    });
  }
  console.log(
    JSON.stringify({
      ok: true,
      indexes: ['Message_agent_network_grep_trgm_idx', 'Message_agentId_createdAt_id_idx'],
    })
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
