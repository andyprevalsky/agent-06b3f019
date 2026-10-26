import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const USER_ID = process.env.BENCHMARK_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const FIXTURE_DOMAIN = 'grep-benchmark.local';

const manifest = {
  messages: {
    regex: 'Aurora budget: phase-17 approved',
    multiline_start: 'Multiline incident START',
    multiline_end: 'incident END',
    after_context: 'After-context evidence: forecast packet delivered',
    before_context: 'Before-context evidence: finance owner noted',
    pagination: 'Ledger entry 21: offset target confirmed',
    mixed_case: 'MiXeDcAsE Beacon',
  },
  network: {
    name: 'Mara Voss',
    company: 'Northstar Calibration Group',
    title: 'Principal Signal Cartographer',
    relation: 'benchmark verification contact',
    communication_frequency: 'quarterly lighthouse cadence',
  },
  agent_network: {
    user: 'Atlas handoff was confirmed by the user',
    assistant: 'Atlas handoff confirmed in assistant response',
    required_roles: ['USER', 'ASSISTANT', 'TOOL'],
  },
};

async function cleanup() {
  await prisma.person.deleteMany({
    where: {
      userId: USER_ID,
      email: { endsWith: `@${FIXTURE_DOMAIN}` },
    },
  });
}

async function applyAgentNetwork(rootAgentId: string) {
  const root = await prisma.agent.findFirst({
    where: { id: rootAgentId, userId: USER_ID },
    select: { id: true, busId: true },
  });
  if (!root) {
    throw new Error(`Root agent ${rootAgentId} not found for benchmark user`);
  }

  const seeded = await prisma.agent.create({
    data: {
      userId: USER_ID,
      goal: 'grep benchmark seeded agent-network branch',
      status: 'COMPLETED',
      parentAgentId: root.id,
      busId: root.busId,
      depth: 1,
    },
  });

  await prisma.message.createMany({
    data: [
      {
        agentId: seeded.id,
        role: 'USER',
        text: manifest.agent_network.user,
        metadata: { benchmark: 'grep-explore-stress', expectedRole: 'USER' },
        createdAt: new Date('2026-01-04T10:00:00Z'),
      },
      {
        agentId: seeded.id,
        role: 'ASSISTANT',
        text: manifest.agent_network.assistant,
        metadata: { benchmark: 'grep-explore-stress', expectedRole: 'ASSISTANT' },
        createdAt: new Date('2026-01-04T10:01:00Z'),
      },
      {
        agentId: seeded.id,
        role: 'TOOL',
        text: 'Atlas handoff confirmed in tool result.',
        metadata: {
          benchmark: 'grep-explore-stress',
          expectedRole: 'TOOL',
          toolStatus: 'FINISHED',
        },
        createdAt: new Date('2026-01-04T10:02:00Z'),
      },
      {
        agentId: seeded.id,
        role: 'SYSTEM',
        text: 'Atlas handoff system breadcrumb.',
        metadata: { benchmark: 'grep-explore-stress', expectedRole: 'SYSTEM' },
        createdAt: new Date('2026-01-04T10:03:00Z'),
      },
    ],
  });

  process.stdout.write(JSON.stringify({ ...manifest, seeded_agent_network_agent_id: seeded.id }));
}

async function apply() {
  await prisma.user.upsert({
    where: { userId: USER_ID },
    create: { userId: USER_ID },
    update: {},
  });
  await cleanup();

  const lighthouse = await prisma.person.create({
    data: {
      userId: USER_ID,
      firstName: 'Lighthouse',
      lastName: 'Archive',
      email: `lighthouse.archive@${FIXTURE_DOMAIN}`,
      messagesExchanged: 40,
    },
  });

  await prisma.messageRecord.createMany({
    data: [
      {
        personId: lighthouse.id,
        userId: USER_ID,
        channel: 'EMAIL',
        from: 'lighthouse@benchmark.local',
        to: 'andy@benchmark.local',
        timestamp: new Date('2026-01-01T10:00:00Z'),
        externalId: 'grep-quarterly-lighthouse-brief',
        message: [
          'Quarterly Lighthouse Brief',
          manifest.messages.before_context,
          manifest.messages.regex,
          manifest.messages.after_context,
        ].join('\n'),
      },
      {
        personId: lighthouse.id,
        userId: USER_ID,
        channel: 'EMAIL',
        from: 'lighthouse@benchmark.local',
        to: 'andy@benchmark.local',
        timestamp: new Date('2026-01-02T10:00:00Z'),
        externalId: 'grep-multiline-incident-note',
        message: [
          'Multiline Incident Note',
          manifest.messages.multiline_start,
          'requires cross-line search',
          manifest.messages.multiline_end,
          manifest.messages.mixed_case,
        ].join('\n'),
      },
      ...Array.from({ length: 30 }, (_, idx) => ({
        personId: lighthouse.id,
        userId: USER_ID,
        channel: 'EMAIL' as const,
        from: 'ledger@benchmark.local',
        to: 'andy@benchmark.local',
        // Grep returns matches newest-first (timestamp DESC). Entry 1 is the
        // newest and entry 30 the oldest, so the descending result order is
        // entry 1, 2, ..., 30. This makes offset:20 land exactly on entry 21
        // (the seeded "offset target confirmed" marker). If timestamps instead
        // increased with entry number, offset:20 would land on entry 10 and the
        // pagination sub-task would be unsatisfiable.
        timestamp: new Date(`2026-01-03T10:${String(29 - idx).padStart(2, '0')}:00Z`),
        externalId: `grep-pagination-ledger-${idx + 1}`,
        message: `Pagination Ledger\nLedger entry ${idx + 1}: ${
          idx + 1 === 21 ? 'offset target confirmed' : 'ordinary ledger row'
        }`,
      })),
    ],
  });

  await prisma.person.create({
    data: {
      userId: USER_ID,
      firstName: 'Mara',
      lastName: 'Voss',
      email: `mara.voss@${FIXTURE_DOMAIN}`,
      company: manifest.network.company,
      title: manifest.network.title,
      relation: manifest.network.relation,
      communicationFrequency: manifest.network.communication_frequency,
      messagesExchanged: 90,
    },
  });

  process.stdout.write(JSON.stringify(manifest));
}

async function main() {
  const action = process.argv[2] || 'apply';
  if (action === 'cleanup') {
    await cleanup();
    return;
  }
  if (action === 'apply') {
    await apply();
    return;
  }
  if (action === 'apply-agent-network') {
    const rootAgentId = process.argv[3];
    if (!rootAgentId) {
      throw new Error('apply-agent-network requires a root agent id');
    }
    await applyAgentNetwork(rootAgentId);
    return;
  }
  throw new Error(`Unknown action: ${action}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
