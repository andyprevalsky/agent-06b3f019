import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Message_agent_network_grep_trgm_idx"
    ON "Message"
    USING gin (
      ((text || E'\\n' || COALESCE(metadata::text, '') || E'\\n' || COALESCE("filePointer"::text, '')))
      gin_trgm_ops
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Message_agentId_createdAt_id_idx"
    ON "Message" ("agentId", "createdAt" DESC, id DESC)
  `);
  console.log(
    JSON.stringify({
      ok: true,
      indexes: ['Message_agent_network_grep_trgm_idx', 'Message_agentId_createdAt_id_idx'],
    })
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await prisma.$disconnect();
    process.exit(1);
  });
