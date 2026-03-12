#!/usr/bin/env tsx
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const userId = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

  // Find root agents that spawned children (have sub-agents)
  const rootAgentsWithChildren = await prisma.agent.findMany({
    where: {
      userId,
      parentAgentId: null,
      children: { some: {} },
    },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: {
      id: true,
      goal: true,
      status: true,
      createdAt: true,
      model: true,
      depth: true,
    },
  });

  console.log(`=== ROOT AGENTS WITH CHILDREN (last 3) ===`);
  for (const a of rootAgentsWithChildren) {
    const childCount = await prisma.agent.count({ where: { parentAgentId: a.id } });
    console.log(`\nID: ${a.id}`);
    console.log(`Goal: ${a.goal?.slice(0, 150)}`);
    console.log(`Status: ${a.status}`);
    console.log(`Model: ${a.model}`);
    console.log(`Created: ${a.createdAt}`);
    console.log(`Direct children: ${childCount}`);
  }

  if (rootAgentsWithChildren.length === 0) {
    console.log('No root agents with children found');
    return;
  }

  // Use the most recent one with children
  const rootAgent = rootAgentsWithChildren[0];

  // Get entire tree
  const allTreeAgents = await prisma.agent.findMany({
    where: {
      userId,
      OR: [
        { id: rootAgent.id },
        { busId: { not: null } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      goal: true,
      status: true,
      createdAt: true,
      model: true,
      depth: true,
      parentAgentId: true,
      busId: true,
    },
  });

  // Find all descendants by following parentAgentId
  const descendants = new Set<string>([rootAgent.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of allTreeAgents) {
      if (a.parentAgentId && descendants.has(a.parentAgentId) && !descendants.has(a.id)) {
        descendants.add(a.id);
        changed = true;
      }
    }
  }

  const tree = allTreeAgents.filter(a => descendants.has(a.id));

  console.log(`\n=== AGENT TREE (${tree.length} agents) ===`);
  for (const a of tree) {
    const indent = '  '.repeat(a.depth || 0);
    const parent = a.parentAgentId ? ` (parent: ${a.parentAgentId.slice(0, 8)}...)` : ' (ROOT)';
    console.log(`${indent}[depth=${a.depth}] ${a.id.slice(0, 12)} | ${a.status} | ${a.goal?.slice(0, 100)}${parent}`);
  }

  // Focus: Show the ROOT agent's spawn_sub_agent tool calls to see what context it passed
  console.log('\n=== ROOT AGENT SPAWN CALLS (what context was passed to children) ===');
  const rootMessages = await prisma.message.findMany({
    where: { agentId: rootAgent.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      text: true,
      metadata: true,
      createdAt: true,
    },
  });

  console.log(`Root agent total messages: ${rootMessages.length}`);

  // Show the USER messages (what context the root had)
  console.log('\n--- ROOT: User-provided context ---');
  for (const m of rootMessages.filter(m => m.role === 'USER')) {
    console.log(`  [USER] (${m.createdAt}): ${(m.text || '').slice(0, 500)}`);
  }

  // Show ASSISTANT reasoning messages
  console.log('\n--- ROOT: Assistant reasoning ---');
  for (const m of rootMessages.filter(m => m.role === 'ASSISTANT')) {
    console.log(`  [ASSISTANT]: ${(m.text || '').slice(0, 400)}`);
  }

  // Show spawn_sub_agent calls
  console.log('\n--- ROOT: spawn_sub_agent tool calls ---');
  for (const m of rootMessages) {
    const meta = m.metadata as any;
    if (meta?.toolName === 'spawn_sub_agent' || meta?.toolName === 'spawn_agent') {
      const status = meta?.toolStatus || '';
      console.log(`\n  [TOOL] ${meta.toolName} status=${status}`);
      console.log(`  subAgentId: ${meta?.subAgentId || 'N/A'}`);
      console.log(`  text: ${(m.text || '').slice(0, 600)}`);
    }
  }

  // Show what each CHILD agent actually received as its first messages
  console.log('\n\n=== CHILD AGENTS: What they received vs what they needed ===');
  for (const a of tree.filter(t => t.depth === 1)) {
    const childMessages = await prisma.message.findMany({
      where: { agentId: a.id },
      orderBy: { createdAt: 'asc' },
      take: 12,
      select: {
        id: true,
        role: true,
        text: true,
        metadata: true,
        createdAt: true,
        filePointer: true,
      },
    });

    console.log(`\n--- Child: ${a.id.slice(0, 12)} (depth=${a.depth}) ---`);
    console.log(`Goal (full): ${a.goal}`);
    console.log(`\nFirst messages received:`);
    for (const m of childMessages) {
      const meta = m.metadata as any;
      const toolName = meta?.toolName || '';
      const toolStatus = meta?.toolStatus || '';
      const fp = m.filePointer as any;
      const fpInfo = fp ? ` [FILE: ${fp.original_filename || fp.storage_path || 'unknown'}]` : '';
      console.log(`  [${m.role}]${toolName ? ` tool=${toolName}` : ''}${toolStatus ? ` status=${toolStatus}` : ''}${fpInfo}: ${(m.text || '').slice(0, 400)}`);
    }
  }

  // Show depth-2 agents too
  console.log('\n\n=== GRANDCHILD AGENTS (depth=2): What they received ===');
  for (const a of tree.filter(t => t.depth === 2).slice(0, 5)) {
    const childMessages = await prisma.message.findMany({
      where: { agentId: a.id },
      orderBy: { createdAt: 'asc' },
      take: 8,
      select: {
        id: true,
        role: true,
        text: true,
        metadata: true,
        createdAt: true,
        filePointer: true,
      },
    });

    console.log(`\n--- Grandchild: ${a.id.slice(0, 12)} (depth=${a.depth}, parent=${a.parentAgentId?.slice(0, 12)}) ---`);
    console.log(`Goal (full): ${a.goal?.slice(0, 300)}`);
    console.log(`\nFirst messages:`);
    for (const m of childMessages.slice(0, 6)) {
      const meta = m.metadata as any;
      const toolName = meta?.toolName || '';
      const fp = m.filePointer as any;
      const fpInfo = fp ? ` [FILE: ${fp.original_filename || fp.storage_path || 'unknown'}]` : '';
      console.log(`  [${m.role}]${toolName ? ` tool=${toolName}` : ''}${fpInfo}: ${(m.text || '').slice(0, 300)}`);
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
