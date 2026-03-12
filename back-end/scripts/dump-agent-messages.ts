#!/usr/bin/env tsx
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agentId = process.argv[2];
  if (!agentId) {
    console.error('Usage: npx tsx back-end/scripts/dump-agent-messages.ts <agent-id>');
    process.exit(1);
  }

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { status: true, goal: true } });
  console.log(`Agent: ${agentId}`);
  console.log(`Status: ${agent?.status}`);
  console.log(`Goal: ${agent?.goal}`);

  const messages = await prisma.message.findMany({
    where: { agentId },
    orderBy: { timestamp: 'asc' },
  });

  console.log(`\nTotal messages: ${messages.length}\n`);
  console.log('='.repeat(120));

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const meta = (m.metadata as any) || {};
    const toolName = meta.toolName || '';
    const toolStatus = meta.toolStatus || '';
    const toolCallId = (meta.toolCallId || '').slice(0, 16);
    const title = meta.title || '';
    const agentType = meta.agentType || '';
    const taskId = (meta.taskId || '').slice(0, 16);
    const exploreTaskId = (meta.exploreTaskId || '').slice(0, 16);
    const checkNum = meta.checkNum ?? '';
    const maxChecks = meta.maxChecks ?? '';
    const waitMode = meta.waitForMode || '';
    const text = (m.message || '').slice(0, 150);

    console.log(`[${String(i).padStart(3)}] ${m.role.padEnd(10)} | ${toolName.padEnd(30)} | ${toolStatus.padEnd(12)} | tcid=${toolCallId.padEnd(16)} | tid=${taskId.padEnd(16)}`);
    console.log(`      title=${title.slice(0, 90)}`);
    if (waitMode) console.log(`      waitMode=${waitMode} checkNum=${checkNum} maxChecks=${maxChecks} exploreTaskId=${exploreTaskId}`);
    if (agentType) console.log(`      agentType=${agentType}`);
    if (text) console.log(`      text=${text}`);
    console.log();
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
