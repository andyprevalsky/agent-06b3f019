#!/usr/bin/env tsx
/**
 * Dump the real SMS supervisor context for the test user.
 * Compare what the agent (Python) sees vs what the SMS supervisor (TS) sees.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find test user
  const user = await prisma.user.findFirst({
    where: { phone: '+19729777432' },
    select: {
      userId: true, name: true, phone: true, city: true, state: true,
      country: true, customSystemPrompt: true, systemName: true,
    },
  });
  if (user === null) { console.log('User not found'); return; }
  console.log('=== USER PROFILE ===');
  console.log(JSON.stringify(user, null, 2));

  const userId = user.userId;

  // Active root agents
  const agents = await prisma.agent.findMany({
    where: {
      userId,
      parentAgentId: null,
      deletedAt: null,
      status: { in: ['ACTIVE', 'PAUSED', 'STARTING_UP', 'COST_LIMIT_REACHED'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      children: {
        where: { deletedAt: null },
        select: { id: true, goal: true, status: true, progress: true, depth: true, treeCostCents: true, priceLimitCents: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  console.log('\n=== ACTIVE AGENTS (SMS supervisor sees this) ===');
  if (agents.length === 0) console.log('  (none)');
  for (const a of agents) {
    const prefix = a.id.substring(0, 6);
    console.log(`  📁 [${prefix}] ${a.goal.substring(0, 80)} — ${a.status} — $${(a.treeCostCents / 100).toFixed(2)}/$${(a.priceLimitCents / 100).toFixed(2)}`);
    for (const c of a.children) {
      console.log(`    📁 [${c.id.substring(0, 6)}] ${c.goal.substring(0, 60)} — ${c.status}`);
    }
  }

  // Pending attention requests
  const requests = await prisma.agentAttentionRequest.findMany({
    where: { userId, userResponse: null },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  console.log('\n=== PENDING ATTENTION REQUESTS (SMS supervisor sees this) ===');
  if (requests.length === 0) console.log('  (none)');
  for (const r of requests) {
    console.log(`  [${r.agentId.substring(0, 6)}] ${r.question.substring(0, 100)} (attn_id: ${r.id})`);
  }

  // Authenticated domains (cookies) — ONLY in agent context, NOT in SMS supervisor
  const cookies = await prisma.cookie.findMany({
    where: { userId },
    select: { domain: true },
    distinct: ['domain'],
  });
  const uniqueDomains = [...new Set(cookies.map(c => c.domain.replace(/^\./, '')))].sort();
  console.log(`\n=== AUTHENTICATED DOMAINS (${uniqueDomains.length}) — ⚠️ AGENT ONLY, not in SMS supervisor ===`);
  console.log('  ' + uniqueDomains.slice(0, 30).join(', '));
  if (uniqueDomains.length > 30) console.log(`  ... +${uniqueDomains.length - 30} more`);

  // Recent communications — ONLY in agent context, NOT in SMS supervisor
  const personMessages = await prisma.messageRecord.findMany({
    where: { person: { userId } },
    orderBy: { timestamp: 'desc' },
    take: 5,
    select: { channel: true, from: true, to: true, message: true, timestamp: true },
  });
  console.log('\n=== RECENT COMMS (last 5) — ⚠️ AGENT ONLY, not in SMS supervisor ===');
  if (personMessages.length === 0) console.log('  (none)');
  for (const m of personMessages) {
    const from = m.from ? m.from.substring(0, 25) : '?';
    const to = m.to ? m.to.substring(0, 25) : '?';
    console.log(`  [${m.channel}] ${m.timestamp.toISOString().substring(0, 16)} From:${from} To:${to}`);
    console.log(`    ${m.message.substring(0, 100)}`);
  }

  // Frequent contacts — ONLY in agent context, NOT in SMS supervisor
  const contacts = await prisma.person.findMany({
    where: { userId, communicationFrequency: { in: ['daily', 'weekly', 'monthly'] } },
    take: 10,
    select: { firstName: true, lastName: true, relation: true, communicationFrequency: true, phoneNumber: true, email: true },
  });
  console.log('\n=== FREQUENT CONTACTS — ⚠️ AGENT ONLY, not in SMS supervisor ===');
  if (contacts.length === 0) console.log('  (none)');
  for (const c of contacts) {
    console.log(`  ${c.firstName} ${c.lastName} | ${c.relation || ''} | ${c.communicationFrequency} | ${c.phoneNumber || c.email || ''}`);
  }

  // SMS Session
  console.log('\n=== SMS SESSION (SMS supervisor only) ===');
  try {
    const session = await prisma.smsSession.findUnique({ where: { userId } });
    if (session === null) {
      console.log('  (none — will be created on first inbound SMS)');
    } else {
      const msgs = typeof session.messages === 'string' ? JSON.parse(session.messages) : session.messages;
      console.log(`  Messages: ${Array.isArray(msgs) ? msgs.length : 0}, Updated: ${session.updatedAt.toISOString()}`);
    }
  } catch {
    console.log('  (table not migrated yet — run prisma migrate deploy)');
  }

  // Visible agent messages (recent TOOL messages) — SMS supervisor context
  const agentIds = agents.map(a => a.id);
  const childIds = agents.flatMap(a => a.children.map(c => c.id));
  const allAgentIds = [...agentIds, ...childIds];

  const VISIBLE_TOOL_NAMES = [
    'send_message_to_user', 'send_message_to_user_execute_phase',
    'completion_summary', 'request_user_approval', 'enable_write_permissions', 'set_plan',
  ];

  if (allAgentIds.length > 0) {
    const toolMessages = await prisma.message.findMany({
      where: { agentId: { in: allAgentIds }, role: 'TOOL' },
      orderBy: { timestamp: 'desc' },
      take: 30,
      select: { agentId: true, text: true, metadata: true, timestamp: true },
    });

    const visible = toolMessages.filter(msg => {
      const meta = msg.metadata as Record<string, any> | null;
      if (meta === null) return false;
      const toolName = meta.toolName as string | undefined;
      const isFinal = meta.isFinalSummary as boolean | undefined;
      if (toolName && VISIBLE_TOOL_NAMES.includes(toolName)) return true;
      if (isFinal) return true;
      return false;
    }).slice(0, 10);

    console.log(`\n=== VISIBLE AGENT MESSAGES (${visible.length}) — SMS supervisor sees this ===`);
    for (const m of visible) {
      const meta = m.metadata as Record<string, any>;
      const prefix = m.agentId.substring(0, 6);
      const tool = meta.toolName || 'completion_summary';
      const text = meta.attentionMessage || meta.completionSummary?.summary || m.text || '';
      const textStr = typeof text === 'string' ? text.substring(0, 100) : JSON.stringify(text).substring(0, 100);
      console.log(`  [${prefix}] ${tool} (${m.timestamp.toISOString().substring(0, 16)}): ${textStr}`);
    }
  }

  // ============== COMPARISON TABLE ==============
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 CONTEXT COMPARISON: Agent (Python) vs SMS Supervisor (TypeScript)');
  console.log('='.repeat(70));
  console.log('');
  console.log('Data Source                        | Agent | SMS Supervisor');
  console.log('-----------------------------------|-------|---------------');
  console.log('User profile (name/phone/city)     |  ✅   |  ✅');
  console.log('Custom system prompt               |  ✅   |  ✅');
  console.log('System name                        |  ✅   |  ✅');
  console.log('Agent hierarchy (root + children)  |  ❌   |  ✅');
  console.log('Pending attention requests         |  ❌   |  ✅');
  console.log('Visible agent messages (FE)        |  ❌   |  ✅');
  console.log('SMS session history                |  ❌   |  ✅');
  console.log('SMS shortcodes                     |  ❌   |  ✅');
  console.log('Authenticated browser domains      |  ✅   |  ❌ ← MISSING');
  console.log('Recent communications (iMsg/SMS)   |  ✅   |  ❌ ← MISSING');
  console.log('Frequent contacts                  |  ✅   |  ❌ ← MISSING');
  console.log('Cookie-based auth detection        |  ✅   |  ❌ ← N/A (no browser)');
  console.log('');
  console.log('The ❌ ← MISSING items are things the SMS supervisor COULD include');
  console.log('but currently does NOT. The agent and SMS supervisor serve different');
  console.log('purposes so not all context is relevant to both.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
