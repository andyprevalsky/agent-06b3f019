/**
 * 24h stuck-agent bug reports: every real prod agent run that is not COMPLETED
 * 24 hours after it started gets exactly one Report Bug /rca launch, unless it
 * already has a manual or automated report.
 *
 * Runs the real job against the real DB with a fake boxes.dev launcher, scoped
 * to the agents seeded here (candidateAgentIds) and to explicit clocks so the
 * global daily cap and other suites' rows cannot interfere.
 */

import {
  assert,
  createAnonymousSession,
  prisma,
  randomUUID,
  test,
  trackedAgentIds,
  withTransientDbRetry,
} from './agents-blackbox-harness';
import { reportAgentBug, type ReportBugLaunchArgs } from '../../domains/agents/bugReportService';
import {
  AGENT_BUG_REPORT_OPERATION_TYPE,
  agentBugReportKey,
  claimStuckAgentBugReport,
  markStuckAgentBugReportLaunched,
} from '../../domains/agents/repoAgentBugReports';
import {
  MAX_STUCK_AGENT_REPORTS_PER_DAY,
  STUCK_AGENT_REPORTS_FIRST_CREATED_AT,
  runStuckAgentBugReports,
} from '../../domains/agents/stuckAgentBugReportService';

const HOUR_MS = 60 * 60 * 1000;
const ANDY_ADMIN_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const EPOCH = new Date(0);

/** The user-approved description; any edit to it must be re-approved. */
const APPROVED_DESCRIPTION = (status: string) =>
  [
    `Not completed 24h after start (status: ${status}). Classify:`,
    '- Stalled on user input',
    '  - took too long → speed it up without changing the model or the trajectory via prompts or context injection',
    '  - hit a price limit → cut cost via cache hits or planner memory; prompt changes only as a last resort',
    '  - asked the user for feedback when it should have found an alternative path to completion',
    '- Died from a harness issue (infinite tool calls, faulty tool, etc.)',
    '- PASS: taking longer than 24h but still making good progress; the goal is complex enough to justify an exceedingly long execution',
    'All approval requests go to the main agent for user approval.',
  ].join('\n');

/** Each case gets its own past clock, days apart, so daily-cap windows never overlap. */
function caseClock(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * HOUR_MS);
}

type AgentStatusValue =
  'ACTIVE' | 'PAUSED' | 'FAILED' | 'COMPLETED' | 'OUT_OF_CREDITS' | 'COST_LIMIT_REACHED';

interface SeedOptions {
  status?: AgentStatusValue;
  createdAt: Date;
  tools?: string[];
  isBenchmark?: boolean;
  worldModelMode?: string;
  parentAgentId?: string;
  deleted?: boolean;
}

/** An anonymous session promoted to a real (non-fixture) person. */
async function createRealPerson(label: string): Promise<string> {
  const session = await createAnonymousSession(`stuck-report-${label}`);
  await withTransientDbRetry(`promote-${label}`, () =>
    prisma.user.update({
      where: { userId: session.user.id },
      data: { name: 'Jordan Rivera', email: `jordan.${randomUUID()}@riveraworks.co` },
    })
  );
  return session.user.id;
}

async function seedAgent(userId: string, label: string, options: SeedOptions): Promise<string> {
  const agentId = randomUUID();
  trackedAgentIds.add(agentId);
  await withTransientDbRetry(`seed-stuck-${label}`, async () => {
    await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        goal: `stuck-report ${label}`,
        title: `Plan the ${label} trip`,
        status: options.status ?? 'ACTIVE',
        busId: agentId,
        createdAt: options.createdAt,
        isBenchmark: options.isBenchmark ?? false,
        worldModelMode: options.worldModelMode ?? 'real',
        parentAgentId: options.parentAgentId ?? null,
        depth: options.parentAgentId === undefined ? 0 : 1,
        deletedAt: options.deleted === true ? options.createdAt : null,
      },
    });
    for (const toolName of options.tools ?? ['web_search']) {
      await prisma.toolUsage.create({
        data: { agentId, userId, toolName, totalCostCents: 0, usageItems: [] },
      });
    }
  });
  return agentId;
}

function fakeLauncher(options: { failTimes?: number; delayMs?: number } = {}) {
  const calls: ReportBugLaunchArgs[] = [];
  let failuresLeft = options.failTimes ?? 0;
  const launch = async (args: ReportBugLaunchArgs) => {
    calls.push(args);
    if (options.delayMs !== undefined) await new Promise((r) => setTimeout(r, options.delayMs));
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('boxes.dev API 503: unavailable');
    }
    return {
      run_id: `run-${calls.length}-${randomUUID()}`,
      name: args.name,
      url: 'https://boxes.dev/x',
    };
  };
  return { calls, launch, isConfigured: () => true };
}

async function claimOf(agentId: string) {
  return prisma.toolSideEffect.findUnique({ where: { operationKey: agentBugReportKey(agentId) } });
}

async function dropClaims(agentIds: string[]): Promise<void> {
  await prisma.toolSideEffect.deleteMany({
    where: { operationKey: { in: agentIds.map(agentBugReportKey) } },
  });
}

function agentIdInPrompt(promptText: string): string {
  const match = /^\/rca the following bug for agent with ID: \[([^\]]+)\]\n/.exec(promptText);
  assert(match !== null, `prompt must start with the Report Bug /rca line: ${promptText}`);
  return match[1];
}

test('stuck-agent reports launch one /rca per real run not COMPLETED after 24h', async () => {
  const now = caseClock(3);
  const old = new Date(now.getTime() - 30 * HOUR_MS);
  const person = await createRealPerson('eligible');
  const anonymous = (await createAnonymousSession('stuck-report-anon')).user.id;

  const eligible = new Map<string, string>();
  for (const status of [
    'ACTIVE',
    'PAUSED',
    'FAILED',
    'OUT_OF_CREDITS',
    'COST_LIMIT_REACHED',
  ] as const) {
    eligible.set(await seedAgent(person, status, { status, createdAt: old }), status);
  }
  const parent = [...eligible.keys()][0];
  const skipped = [
    await seedAgent(person, 'completed', { status: 'COMPLETED', createdAt: old }),
    await seedAgent(person, 'young', { createdAt: new Date(now.getTime() - 23 * HOUR_MS) }),
    await seedAgent(person, 'chat-only', { createdAt: old, tools: ['chat_router'] }),
    await seedAgent(person, 'no-tools', { createdAt: old, tools: [] }),
    await seedAgent(person, 'benchmark', { createdAt: old, isBenchmark: true }),
    await seedAgent(person, 'simulated', { createdAt: old, worldModelMode: 'simulate' }),
    await seedAgent(person, 'sub-agent', { createdAt: old, parentAgentId: parent }),
    await seedAgent(person, 'archived', { createdAt: old, deleted: true }),
    await seedAgent(anonymous, 'anonymous', { createdAt: old }),
  ];
  const all = [...eligible.keys(), ...skipped];

  try {
    const fake = fakeLauncher();
    const summary = await runStuckAgentBugReports(
      { now, candidateAgentIds: all, firstCreatedAt: EPOCH },
      fake
    );
    assert(summary.launched === eligible.size, `launched ${JSON.stringify(summary)}`);

    const launchedIds = fake.calls.map((call) => agentIdInPrompt(call.promptText));
    assert(
      [...launchedIds].sort().join() === [...eligible.keys()].sort().join(),
      `launched exactly the not-COMPLETED real runs, got ${launchedIds.join()}`
    );
    for (const call of fake.calls) {
      const agentId = agentIdInPrompt(call.promptText);
      const status = eligible.get(agentId) ?? '';
      assert(
        call.promptText ===
          `/rca the following bug for agent with ID: [${agentId}]\n${APPROVED_DESCRIPTION(status)}`,
        `prompt must be the approved Report Bug text, got ${call.promptText}`
      );
      assert(call.name.startsWith('--ai-- '), `thread title needs --ai--, got ${call.name}`);
      assert(
        call.idempotencyKey === `rose-stuck-agent-24h-${agentId}`,
        `per-agent idempotency key, got ${call.idempotencyKey}`
      );
      const claim = await claimOf(agentId);
      assert(claim?.status === 'SUCCEEDED', `claim should be SUCCEEDED, got ${claim?.status}`);
      assert(claim.operationType === AGENT_BUG_REPORT_OPERATION_TYPE, 'claim operation type');
      assert(claim.externalId?.startsWith('run-') === true, 'claim stores the boxes.dev run id');
    }
    for (const agentId of skipped) {
      assert((await claimOf(agentId)) === null, `agent ${agentId} must not be reported`);
    }

    const again = fakeLauncher();
    await runStuckAgentBugReports({ now, candidateAgentIds: all, firstCreatedAt: EPOCH }, again);
    assert(again.calls.length === 0, 'an already reported agent is never reported again');
  } finally {
    await dropClaims(all);
  }
});

test('stuck-agent reports skip agents that already have a manual Report Bug', async () => {
  const now = caseClock(6);
  const person = await createRealPerson('manual');
  const agentId = await seedAgent(person, 'manual', {
    createdAt: new Date(now.getTime() - 30 * HOUR_MS),
  });
  try {
    await reportAgentBug(ANDY_ADMIN_USER_ID, agentId, 'Checkout never finished', {
      launch: async () => ({ run_id: 'run-manual', name: 'n', url: 'https://boxes.dev/x' }),
    });
    const claim = await claimOf(agentId);
    assert(claim?.status === 'SUCCEEDED', `manual report recorded, got ${claim?.status}`);

    const fake = fakeLauncher();
    await runStuckAgentBugReports(
      { now, candidateAgentIds: [agentId], firstCreatedAt: EPOCH },
      fake
    );
    assert(fake.calls.length === 0, 'a manually reported agent must be skipped');
  } finally {
    await dropClaims([agentId]);
  }
});

test('stuck-agent reports retry a failed launch with the identical frozen request', async () => {
  const now = caseClock(9);
  const person = await createRealPerson('retry');
  const agentId = await seedAgent(person, 'retry', {
    createdAt: new Date(now.getTime() - 30 * HOUR_MS),
  });
  const scope = { candidateAgentIds: [agentId], firstCreatedAt: EPOCH };
  try {
    const failing = fakeLauncher({ failTimes: 1 });
    const first = await runStuckAgentBugReports({ now, ...scope }, failing);
    assert(first.failed === 1, `first launch fails, got ${JSON.stringify(first)}`);
    assert((await claimOf(agentId))?.status === 'FAILED', 'failed launch is recorded');

    // The agent changes between attempts; the retry must still send the first
    // request, because boxes.dev rejects a reused key with a different body.
    await prisma.agent.update({
      where: { id: agentId },
      data: { status: 'FAILED', title: 'A different title' },
    });

    const early = fakeLauncher();
    await runStuckAgentBugReports(
      { now: new Date(now.getTime() + 30 * 60 * 1000), ...scope },
      early
    );
    assert(early.calls.length === 0, 'no retry before the backoff elapses');

    const retry = fakeLauncher();
    await runStuckAgentBugReports(
      { now: new Date(now.getTime() + 61 * 60 * 1000), ...scope },
      retry
    );
    assert(retry.calls.length === 1, 'retried after the backoff');
    assert(
      JSON.stringify(retry.calls[0]) === JSON.stringify(failing.calls[0]),
      `retry must resend the identical keyed request, got ${JSON.stringify(retry.calls[0])}`
    );
    assert(
      retry.calls[0].promptText.includes('(status: ACTIVE)'),
      'the frozen prompt keeps the status observed at the first attempt'
    );
    assert((await claimOf(agentId))?.status === 'SUCCEEDED', 'retry is recorded');
  } finally {
    await dropClaims([agentId]);
  }
});

test('stuck-agent reports keep retrying at most daily and never give up inside the lookback', async () => {
  const start = caseClock(30);
  const person = await createRealPerson('no-give-up');
  const createdAt = new Date(start.getTime() - 30 * HOUR_MS);
  const agentId = await seedAgent(person, 'no-give-up', { createdAt });
  const scope = { candidateAgentIds: [agentId], firstCreatedAt: EPOCH };
  try {
    const failing = fakeLauncher({ failTimes: 100 });
    let clock = start;
    for (let tick = 0; tick < 8; tick += 1) {
      await runStuckAgentBugReports({ now: clock, ...scope }, failing);
      clock = new Date(clock.getTime() + 25 * HOUR_MS);
    }
    assert(failing.calls.length === 8, `one attempt per day, got ${failing.calls.length}`);
    const claim = await claimOf(agentId);
    assert(claim?.status === 'FAILED', 'failing claim stays FAILED');
    assert(
      typeof (claim.request as { nextAttemptAt?: unknown }).nextAttemptAt === 'string',
      'a failing claim always has a next attempt'
    );

    const pastLookback = fakeLauncher();
    await runStuckAgentBugReports(
      { now: new Date(createdAt.getTime() + 15 * 24 * HOUR_MS), ...scope },
      pastLookback
    );
    assert(pastLookback.calls.length === 0, 'runs older than the lookback are no longer picked');
  } finally {
    await dropClaims([agentId]);
  }
});

test('stuck-agent reports stop the tick at the first launch failure', async () => {
  const now = caseClock(33);
  const person = await createRealPerson('breaker');
  const agentIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    agentIds.push(
      await seedAgent(person, `breaker-${i}`, {
        createdAt: new Date(now.getTime() - (30 + i) * HOUR_MS),
      })
    );
  }
  try {
    const failing = fakeLauncher({ failTimes: 100 });
    const summary = await runStuckAgentBugReports(
      { now, candidateAgentIds: agentIds, firstCreatedAt: EPOCH },
      failing
    );
    assert(
      failing.calls.length === 1,
      `one failed launch ends the tick, got ${failing.calls.length}`
    );
    assert(summary.failed === 1 && summary.deferred === 2, `summary ${JSON.stringify(summary)}`);
    const untouched = await Promise.all(agentIds.slice(1).map(claimOf));
    assert(
      untouched.every((claim) => claim === null),
      'deferred agents keep their attempts'
    );
  } finally {
    await dropClaims(agentIds);
  }
});

test('stuck-agent reports reclaim a crashed launch only after the stale window', async () => {
  const now = caseClock(36);
  const person = await createRealPerson('reclaim');
  const createdAt = new Date(now.getTime() - 30 * HOUR_MS);
  const crashed = await seedAgent(person, 'crashed', { createdAt });
  const inFlight = await seedAgent(person, 'in-flight', { createdAt });
  const frozen = { name: '--ai-- Not completed after 24h: frozen', promptText: 'frozen prompt' };
  try {
    for (const [agentId, ageMinutes] of [
      [crashed, 11],
      [inFlight, 5],
    ] as const) {
      await prisma.toolSideEffect.create({
        data: {
          operationKey: agentBugReportKey(agentId),
          operationType: AGENT_BUG_REPORT_OPERATION_TYPE,
          status: 'STARTED',
          externalId: `dead-owner-${agentId}`,
          request: { agentId, source: 'stuck_24h', attempts: 1, ...frozen },
        },
      });
      const touchedAt = new Date(now.getTime() - ageMinutes * 60 * 1000);
      await prisma.$executeRaw`UPDATE "ToolSideEffect" SET "updatedAt" = ${touchedAt} WHERE "operationKey" = ${agentBugReportKey(agentId)}`;
    }
    const fake = fakeLauncher();
    await runStuckAgentBugReports(
      { now, candidateAgentIds: [crashed, inFlight], firstCreatedAt: EPOCH },
      fake
    );
    assert(fake.calls.length === 1, `only the stale claim is reclaimed, got ${fake.calls.length}`);
    assert(
      fake.calls[0].promptText === frozen.promptText && fake.calls[0].name === frozen.name,
      'a reclaimed launch resends the crashed owner request'
    );
    assert((await claimOf(crashed))?.status === 'SUCCEEDED', 'reclaimed launch is recorded');
    assert((await claimOf(inFlight))?.status === 'STARTED', 'an in-flight claim is left alone');
  } finally {
    await dropClaims([crashed, inFlight]);
  }
});

test('stuck-agent reports skip an agent whose failed automated report was replaced by a manual one', async () => {
  const now = caseClock(39);
  const person = await createRealPerson('manual-over-failed');
  const agentId = await seedAgent(person, 'manual-over-failed', {
    createdAt: new Date(now.getTime() - 30 * HOUR_MS),
  });
  const scope = { candidateAgentIds: [agentId], firstCreatedAt: EPOCH };
  try {
    await runStuckAgentBugReports({ now, ...scope }, fakeLauncher({ failTimes: 1 }));
    assert((await claimOf(agentId))?.status === 'FAILED', 'automated launch failed first');

    await reportAgentBug(ANDY_ADMIN_USER_ID, agentId, 'Checkout never finished', {
      launch: async () => ({ run_id: 'run-manual-2', name: 'n', url: 'https://boxes.dev/x' }),
    });
    const claim = await claimOf(agentId);
    assert(
      claim?.status === 'SUCCEEDED' && claim.externalId === 'run-manual-2',
      `manual report replaces the failed claim, got ${claim?.status}/${claim?.externalId}`
    );

    const later = fakeLauncher();
    await runStuckAgentBugReports({ now: new Date(now.getTime() + 2 * HOUR_MS), ...scope }, later);
    assert(later.calls.length === 0, 'no automated retry after a manual report');
  } finally {
    await dropClaims([agentId]);
  }
});

test('stuck-agent reports launch once when two ticks race', async () => {
  const now = caseClock(15);
  const person = await createRealPerson('race');
  const agentIds = [
    await seedAgent(person, 'race-a', { createdAt: new Date(now.getTime() - 30 * HOUR_MS) }),
    await seedAgent(person, 'race-b', { createdAt: new Date(now.getTime() - 30 * HOUR_MS) }),
  ];
  try {
    const fake = fakeLauncher({ delayMs: 200 });
    const options = { now, candidateAgentIds: agentIds, firstCreatedAt: EPOCH };
    await Promise.all([
      runStuckAgentBugReports(options, fake),
      runStuckAgentBugReports(options, fake),
    ]);
    const launched = fake.calls.map((call) => agentIdInPrompt(call.promptText)).sort();
    assert(
      launched.join() === [...agentIds].sort().join(),
      `each agent launched exactly once, got ${launched.join()}`
    );
  } finally {
    await dropClaims(agentIds);
  }
});

test('stuck-agent reports stop at the daily cap and report the newest runs first', async () => {
  const now = caseClock(18);
  const person = await createRealPerson('cap');
  const priorIds = Array.from({ length: MAX_STUCK_AGENT_REPORTS_PER_DAY - 2 }, () => randomUUID());
  const agentIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    // cap-0 is the newest run, cap-3 the oldest.
    agentIds.push(
      await seedAgent(person, `cap-${i}`, {
        createdAt: new Date(now.getTime() - (30 + 10 * i) * HOUR_MS),
      })
    );
  }
  try {
    await prisma.toolSideEffect.createMany({
      data: priorIds.map((agentId) => ({
        operationKey: agentBugReportKey(agentId),
        operationType: AGENT_BUG_REPORT_OPERATION_TYPE,
        status: 'SUCCEEDED',
        externalId: `run-prior-${agentId}`,
        request: { agentId, source: 'stuck_24h', attempts: 1 },
        createdAt: new Date(now.getTime() - HOUR_MS),
        updatedAt: new Date(now.getTime() - HOUR_MS),
      })),
    });
    const fake = fakeLauncher();
    const summary = await runStuckAgentBugReports(
      { now, candidateAgentIds: agentIds, firstCreatedAt: EPOCH },
      fake
    );
    assert(
      fake.calls.length === 2,
      `only the remaining daily budget launches, got ${fake.calls.length}`
    );
    assert(summary.capRemaining === 0, `cap exhausted, got ${summary.capRemaining}`);
    const launched = fake.calls.map((call) => agentIdInPrompt(call.promptText));
    assert(
      launched.join() === agentIds.slice(0, 2).join(),
      'the newest runs are reported first, while their worker logs are still retained'
    );
  } finally {
    await dropClaims([...priorIds, ...agentIds]);
  }
});

test('stuck-agent reports count a successful old-claim retry against the current daily cap', async () => {
  const now = caseClock(60);
  const old = new Date(now.getTime() - 48 * HOUR_MS);
  const person = await createRealPerson('retry-cap');
  const retryId = await seedAgent(person, 'old-retry', {
    createdAt: new Date(old.getTime() - 30 * HOUR_MS),
  });
  const pendingId = await seedAgent(person, 'pending-after-retry', {
    createdAt: new Date(now.getTime() - 30 * HOUR_MS),
  });
  const priorIds = Array.from({ length: MAX_STUCK_AGENT_REPORTS_PER_DAY - 1 }, () => randomUUID());
  try {
    await prisma.toolSideEffect.create({
      data: {
        operationKey: agentBugReportKey(retryId),
        operationType: AGENT_BUG_REPORT_OPERATION_TYPE,
        status: 'FAILED',
        request: {
          agentId: retryId,
          source: 'stuck_24h',
          attempts: 1,
          nextAttemptAt: new Date(now.getTime() - HOUR_MS).toISOString(),
        },
        createdAt: old,
        updatedAt: old,
      },
    });
    await prisma.toolSideEffect.createMany({
      data: priorIds.map((agentId) => ({
        operationKey: agentBugReportKey(agentId),
        operationType: AGENT_BUG_REPORT_OPERATION_TYPE,
        status: 'SUCCEEDED',
        externalId: `run-prior-${agentId}`,
        request: { agentId, source: 'stuck_24h', attempts: 1 },
        createdAt: new Date(now.getTime() - HOUR_MS),
        updatedAt: new Date(now.getTime() - HOUR_MS),
      })),
    });
    const ownerId = randomUUID();
    const retry = await claimStuckAgentBugReport(
      retryId,
      ownerId,
      { name: 'old retry', promptText: 'retry the original report' },
      now,
      now,
      new Date(now.getTime() - HOUR_MS)
    );
    assert(retry !== null, 'the old failed claim is reclaimed');
    assert(
      await markStuckAgentBugReportLaunched(retryId, ownerId, 'retried-report', now),
      'the reclaimed launch is recorded'
    );
    const next = fakeLauncher();
    const summary = await runStuckAgentBugReports(
      {
        now: new Date(now.getTime() + 60_000),
        candidateAgentIds: [pendingId],
        firstCreatedAt: EPOCH,
      },
      next
    );
    assert(next.calls.length === 0, 'a successful retry must exhaust the current daily cap');
    assert(summary.capRemaining === 0, 'the retry counts in the current window');
    const claim = await claimOf(retryId);
    assert(claim?.createdAt.getTime() === old.getTime(), 'the original claim time stays frozen');
    assert(claim.updatedAt.getTime() === now.getTime(), 'success records the actual launch time');
  } finally {
    await dropClaims([retryId, pendingId, ...priorIds]);
  }
});

test('stuck-agent reports never backfill runs created before the start line', async () => {
  // 48h after the start line both runs are old enough; only the start line differs.
  const now = new Date(STUCK_AGENT_REPORTS_FIRST_CREATED_AT.getTime() + 48 * HOUR_MS);
  const person = await createRealPerson('start-line');
  const before = await seedAgent(person, 'before-start', {
    createdAt: new Date(STUCK_AGENT_REPORTS_FIRST_CREATED_AT.getTime() - HOUR_MS),
  });
  const after = await seedAgent(person, 'after-start', {
    createdAt: new Date(STUCK_AGENT_REPORTS_FIRST_CREATED_AT.getTime() + HOUR_MS),
  });
  try {
    const fake = fakeLauncher();
    await runStuckAgentBugReports({ now, candidateAgentIds: [before, after] }, fake);
    const launched = fake.calls.map((call) => agentIdInPrompt(call.promptText));
    assert(
      launched.join() === after,
      `only the run created after the start line is reported, got ${launched.join()}`
    );
  } finally {
    await dropClaims([before, after]);
  }
});

test('stuck-agent reports do nothing when the Report Bug automation is not configured', async () => {
  const fake = fakeLauncher();
  const summary = await runStuckAgentBugReports(
    { now: caseClock(21), candidateAgentIds: [randomUUID()], firstCreatedAt: EPOCH },
    { launch: fake.launch, isConfigured: () => false }
  );
  assert(summary.configured === false && fake.calls.length === 0, 'unconfigured job is a no-op');
});
