/**
 * report_bug's own claim table against the real DB: the daily launch cap is
 * atomic across agents (also when requests take the lock out of timestamp
 * order), saved (RECORDED) reports never count toward it, and a
 * run that already claimed keeps its claim at the cap.
 */

import { assert, prisma, randomUUID, test } from './agents-blackbox-harness';
import {
  agentSelfBugReportKey,
  claimAgentSelfBugReport,
  claimAgentSelfBugReportWithinCap,
} from '../../domains/agents/repoAgentSelfBugReports';

const HOUR_MS = 60 * 60 * 1000;

function request(agentId: string, description: string) {
  return {
    name: `--ai-- ${description}`,
    promptText: `/rca the following bug for agent with ID: [${agentId}]\n${description}`,
    idempotencyKey: `rose-agent-report-bug-${agentId}`,
    description,
  };
}

test('report_bug daily launch cap is atomic across concurrent first reports', async () => {
  // The window has no upper bound, so start it days in the future: no other
  // suite's claims fall inside it.
  const now = new Date(Date.now() + 50 * 24 * HOUR_MS);
  const since = new Date(now.getTime() - 24 * HOUR_MS);
  const recorded = [randomUUID(), randomUUID()];
  const launching = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  try {
    for (const id of recorded) {
      await claimAgentSelfBugReport(id, request(id, 'saved only'), now);
    }
    const claims = await Promise.all(
      launching.map((id) =>
        claimAgentSelfBugReportWithinCap(id, request(id, 'boom'), now, 2, since)
      )
    );
    const won = launching.filter((_, index) => claims[index] !== null);
    assert(won.length === 2, `exactly the cap may claim, got ${won.length}`);
    assert(
      claims.every((claim) => claim === null || claim.status === 'STARTED'),
      'launching claims start STARTED'
    );
    const again = await claimAgentSelfBugReportWithinCap(
      won[0],
      request(won[0], 'x'),
      now,
      2,
      since
    );
    assert(again?.description === 'boom', 'a run that already claimed keeps its claim at the cap');
    const rows = await prisma.toolSideEffect.findMany({
      where: { operationKey: { in: [...recorded, ...launching].map(agentSelfBugReportKey) } },
      select: { status: true },
    });
    const statuses = rows.map((row) => row.status).sort();
    assert(
      statuses.join() === 'RECORDED,RECORDED,STARTED,STARTED',
      `saved reports never count toward the cap, got ${statuses.join()}`
    );
  } finally {
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: { in: [...recorded, ...launching].map(agentSelfBugReportKey) } },
    });
  }
});

test('report_bug daily launch cap counts a newer claim that took the lock first', async () => {
  // Requests can take the lock out of timestamp order: the later request claims
  // first, then the earlier one must still count it. Both windows start after
  // the first case's rows.
  const later = new Date(Date.now() + 60 * 24 * HOUR_MS);
  const earlier = new Date(later.getTime() - 1000);
  const first = randomUUID();
  const second = randomUUID();
  try {
    const won = await claimAgentSelfBugReportWithinCap(
      first,
      request(first, 'boom'),
      later,
      1,
      new Date(later.getTime() - 24 * HOUR_MS)
    );
    assert(won?.status === 'STARTED', 'the first claim takes the only cap slot');
    const late = await claimAgentSelfBugReportWithinCap(
      second,
      request(second, 'boom'),
      earlier,
      1,
      new Date(earlier.getTime() - 24 * HOUR_MS)
    );
    assert(late === null, 'an earlier-stamped request may not take a slot already claimed');
  } finally {
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: { in: [first, second].map(agentSelfBugReportKey) } },
    });
  }
});
