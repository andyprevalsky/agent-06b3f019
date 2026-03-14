#!/usr/bin/env tsx
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agentId = process.argv[2];
  if (!agentId) {
    console.error('Usage: npx tsx back-end/scripts/query-agent-tools.ts <agent-id>');
    process.exit(1);
  }

  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    console.log('Agent not found');
    process.exit(0);
  }
  console.log(`Status: ${agent.status}`);
  console.log(`Goal: ${(agent.goal || '').substring(0, 200)}`);

  const msgs = await prisma.message.findMany({
    where: { agentId },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`Total messages: ${msgs.length}\n`);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    let meta: any = {};
    if (typeof m.metadata === 'string') {
      try { meta = JSON.parse(m.metadata); } catch {}
    } else if (m.metadata) {
      meta = m.metadata;
    }
    const toolName = meta.toolName || '';
    const toolStatus = meta.toolStatus || '';
    const text = (m.message || '').substring(0, 400);

    // Show all messages, full content for spawn_agent and assistant messages
    const showFull = toolName === 'spawn_agent' || toolName === 'set_plan' || m.role === 'ASSISTANT' || m.role === 'USER';
    const displayText = showFull ? (m.message || '').substring(0, 2000) : text;
    console.log(`[${i}][${m.role}] tool=${toolName} status=${toolStatus} title=${meta.title || ''}`);
    if (displayText.trim()) {
      console.log(`  ${displayText}`);
    }
    console.log();
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
