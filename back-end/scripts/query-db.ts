#!/usr/bin/env tsx
/**
 * Query surviving data for pitch deck chart - aggregated by ISO week
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1. User signups
  const users = await prisma.user.findMany({
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`=== USER SIGNUPS BY WEEK (${users.length} total) ===`);
  const signupWeeks = bucketByWeek(users.map(u => u.createdAt));
  for (const [week, count] of signupWeeks) {
    console.log(`  ${week}: ${count}`);
  }

  // 2. Rose API calls
  const apiLogs = await prisma.roseApiKeyLog.findMany({
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n=== ROSE API CALLS BY WEEK (${apiLogs.length} total) ===`);
  const apiWeeks = bucketByWeek(apiLogs.map(l => l.createdAt));
  for (const [week, count] of apiWeeks) {
    console.log(`  ${week}: ${count}`);
  }

  // 3. Agents spawned (GoalHistory + current)
  const archived = await prisma.goalHistory.findMany({
    select: { agentCreatedAt: true },
    orderBy: { agentCreatedAt: 'asc' },
  });
  const current = await prisma.agent.findMany({
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const allAgentDates = [
    ...archived.map(a => a.agentCreatedAt),
    ...current.map(a => a.createdAt),
  ].sort((a, b) => a.getTime() - b.getTime());

  console.log(`\n=== AGENTS SPAWNED BY WEEK (${allAgentDates.length} total) ===`);
  const agentWeeks = bucketByWeek(allAgentDates);
  for (const [week, count] of agentWeeks) {
    console.log(`  ${week}: ${count}`);
  }
}

function bucketByWeek(dates: Date[]): [string, number][] {
  const map = new Map<string, number>();
  for (const d of dates) {
    const key = getMonday(d);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function getMonday(date: Date): string {
  const d = new Date(date);
  // Use UTC to avoid timezone issues
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday = 1
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
