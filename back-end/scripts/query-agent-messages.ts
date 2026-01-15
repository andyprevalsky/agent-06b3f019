import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agentId = '4e66e941-7b83-466c-a466-b1135782d64a';

  const messages = await prisma.message.findMany({
    where: { agentId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      text: true,
      metadata: true,
      createdAt: true,
      filePointer: true,
    }
  });

  console.log(`Found ${messages.length} messages for agent ${agentId}:\n`);

  // Find the "sit back" message index
  const sitBackIndex = messages.findIndex(m =>
    m.text?.includes('sit back, relax')
  );

  console.log(`"Sit back" message at index: ${sitBackIndex}\n`);

  // Show messages after "sit back" - skip the first one (sit back itself)
  const afterSitBack = sitBackIndex >= 0 ? messages.slice(sitBackIndex + 1) : messages;

  for (const msg of afterSitBack) {
    console.log(`${'='.repeat(70)}`);
    console.log(`ID: ${msg.id}`);
    console.log(`Role: ${msg.role}`);
    console.log(`Created: ${msg.createdAt}`);

    // Show text (truncated)
    const textStr = msg.text || '(empty)';
    console.log(`Text: ${textStr.substring(0, 300)}${textStr.length > 300 ? '...' : ''}`);

    // Show metadata
    if (msg.metadata && Object.keys(msg.metadata).length > 0) {
      const meta = msg.metadata as Record<string, unknown>;
      console.log(`Metadata:`);
      console.log(`  toolCallId: ${meta.toolCallId || '-'}`);
      console.log(`  toolName: ${meta.toolName || '-'}`);
      console.log(`  toolStatus: ${meta.toolStatus || '-'}`);
      console.log(`  title: ${meta.title || '-'}`);
      if (meta.subAgentIds) {
        console.log(`  subAgentIds: ${JSON.stringify(meta.subAgentIds)}`);
      }
      if (meta.busId) {
        console.log(`  busId: ${meta.busId}`);
      }
    }

    if (msg.filePointer) {
      console.log(`FilePointer: ${JSON.stringify(msg.filePointer)}`);
    }
    console.log('');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
