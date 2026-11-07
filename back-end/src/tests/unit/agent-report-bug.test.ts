#!/usr/bin/env tsx
/**
 * Unit tests for the root agent report_bug path (agentBugReportService): the
 * Report Bug gates, one frozen boxes.dev request per run, the daily cap, saving
 * (not launching) outside production, and the /rca read view.
 * Every DB and boxes.dev dependency is injected; nothing leaves the process.
 */

import assert from 'node:assert/strict';
import {
  type AgentReportBugDeps,
  MAX_AGENT_BUG_REPORTS_PER_DAY,
  ReportBugLimitError,
  readAgentSelfBugReport,
  reportAgentBugFromAgent,
} from '../../domains/agents/agentBugReportService';
import {
  ReportBugForbiddenError,
  ReportBugNotFoundError,
  ReportBugValidationError,
  type ReportBugLaunchArgs,
} from '../../domains/agents/bugReportService';
import type { AgentSelfBugReportClaim } from '../../domains/agents/repoAgentSelfBugReports';

const ADMIN_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

interface AgentRow {
  userId: string;
  parentAgentId: string | null;
  depth: number;
  isBenchmark: boolean;
  worldModelMode: string;
}

/** In-memory report_bug claim table + fake boxes.dev launcher. */
function agentReportHarness(
  row: Partial<AgentRow> = {},
  options: { filedToday?: number; failLaunches?: number; production?: boolean } = {}
) {
  const agent: AgentRow = {
    userId: ADMIN_ID,
    parentAgentId: null,
    depth: 0,
    isBenchmark: false,
    worldModelMode: 'real',
    ...row,
  };
  const claims = new Map<string, AgentSelfBugReportClaim>();
  const launches: ReportBugLaunchArgs[] = [];
  const recorded: Array<[string, string, string | undefined]> = [];
  let failuresLeft = options.failLaunches ?? 0;
  let counted = 0;
  const deps: AgentReportBugDeps = {
    isProduction: () => options.production ?? true,
    findAgentById: async () => agent as never,
    findClaim: async (agentId) => claims.get(agentId) ?? null,
    claimWithinCap: async (agentId, request, _now, cap) => {
      counted += 1;
      const existing = claims.get(agentId);
      if (existing !== undefined) return existing;
      if ((options.filedToday ?? 0) >= cap) return null;
      const created = { ...request, status: 'STARTED', runId: null };
      claims.set(agentId, created);
      return created;
    },
    claim: async (agentId, request, _now, status = 'RECORDED') => {
      const existing = claims.get(agentId);
      if (existing !== undefined) return existing;
      const created = { ...request, status, runId: null };
      claims.set(agentId, created);
      return created;
    },
    launch: async (args) => {
      launches.push(args);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('boxes.dev API 503: unavailable');
      }
      return { run_id: 'run-agent-1', name: args.name, url: 'https://boxes.dev/x' };
    },
    markLaunched: async (agentId, runId) => {
      const claim = claims.get(agentId);
      if (claim !== undefined) claims.set(agentId, { ...claim, status: 'SUCCEEDED', runId });
    },
    markFailed: async (agentId) => {
      const claim = claims.get(agentId);
      if (claim !== undefined) claims.set(agentId, { ...claim, status: 'FAILED' });
    },
    recordReport: async (agentId, runId, source) => {
      recorded.push([agentId, runId, source]);
    },
  };
  return { deps, claims, launches, recorded, counted: () => counted };
}

async function testAgentReportLaunchesOnceWithAiTitle(): Promise<void> {
  const h = agentReportHarness();
  const first = await reportAgentBugFromAgent(
    ADMIN_ID,
    'agent-root',
    '  grep returned 500  ',
    h.deps
  );
  assert.deepEqual(first, {
    success: true,
    mode: 'launched',
    name: '--ai-- grep returned 500',
    url: 'https://boxes.dev/x',
    run_id: 'run-agent-1',
    already_reported: false,
  });
  assert.deepEqual(h.launches, [
    {
      name: '--ai-- grep returned 500',
      promptText:
        '/goal once you finish the /rca, finish the /deploy - be relentlessly resourceful\n' +
        '/rca the following bug for agent with ID: [agent-root]\n' +
        'Reported by the agent itself with its report_bug tool:\ngrep returned 500',
      idempotencyKey: 'rose-agent-report-bug-agent-root',
    },
  ]);
  assert.deepEqual(h.recorded, [['agent-root', 'run-agent-1', 'agent']]);
  assert.equal(h.claims.get('agent-root')?.description, 'grep returned 500');

  // A retry of the same call returns the same run; a new description files nothing new.
  const retry = await reportAgentBugFromAgent(ADMIN_ID, 'agent-root', 'grep returned 500', h.deps);
  assert.equal(retry.already_reported, false);
  assert.equal(retry.run_id, 'run-agent-1');
  const second = await reportAgentBugFromAgent(ADMIN_ID, 'agent-root', 'web_fetch hung', h.deps);
  assert.equal(second.already_reported, true);
  assert.equal(second.run_id, 'run-agent-1');
  assert.equal(second.name, '--ai-- grep returned 500');
  assert.equal(h.launches.length, 1, 'one boxes.dev launch per agent run');
}

async function testAgentReportRetriesFailedLaunchWithFrozenRequest(): Promise<void> {
  const h = agentReportHarness({}, { failLaunches: 1 });
  await assert.rejects(
    reportAgentBugFromAgent(ADMIN_ID, 'agent-root', 'first description', h.deps),
    /503/
  );
  assert.equal(h.claims.get('agent-root')?.status, 'FAILED');
  const retried = await reportAgentBugFromAgent(ADMIN_ID, 'agent-root', 'reworded', h.deps);
  assert.equal(retried.run_id, 'run-agent-1');
  assert.equal(retried.already_reported, true);
  assert.equal(h.launches.length, 2);
  assert.deepEqual(h.launches[1], h.launches[0], 'retry re-sends the identical keyed request');
}

async function testAgentReportGates(): Promise<void> {
  const reject = async (
    userId: string | undefined,
    row: Partial<AgentRow>,
    description: unknown,
    expected: new (...args: never[]) => Error,
    filedToday = 0,
    production = true
  ): Promise<void> => {
    const h = agentReportHarness(row, { filedToday, production });
    await assert.rejects(
      reportAgentBugFromAgent(userId, 'agent-root', description, h.deps),
      expected
    );
    assert.equal(h.launches.length, 0);
    assert.equal(h.claims.size, 0);
  };
  const anonymous = '00000000-0000-4000-8000-0000000000aa';
  await reject(anonymous, { userId: anonymous }, 'bug', ReportBugForbiddenError);
  await reject(undefined, {}, 'bug', ReportBugForbiddenError);
  await reject(
    ADMIN_ID,
    { userId: '8283e892-b0a4-4298-9ef7-b95bcc67e46b' },
    'bug',
    ReportBugNotFoundError
  );
  await reject(ADMIN_ID, {}, '   ', ReportBugValidationError);
  await reject(ADMIN_ID, { parentAgentId: 'parent', depth: 1 }, 'bug', ReportBugValidationError);
  await reject(ADMIN_ID, { worldModelMode: 'simulate' }, 'bug', ReportBugValidationError);
  await reject(ADMIN_ID, {}, 'bug', ReportBugLimitError, MAX_AGENT_BUG_REPORTS_PER_DAY);
}

/** Outside production, a record_only worker, or a benchmark run: saved for /rca, never launched. */
async function testAgentReportOnlySavesWhenNotLaunching(): Promise<void> {
  const cases: Array<[string, Partial<AgentRow>, boolean, boolean]> = [
    ['non-production backend', {}, false, false],
    ['record_only worker on a production backend', {}, true, true],
    ['benchmark run on a production backend', { isBenchmark: true }, true, false],
  ];
  for (const [label, row, production, recordOnly] of cases) {
    const h = agentReportHarness(row, { production, filedToday: MAX_AGENT_BUG_REPORTS_PER_DAY });
    const options = { recordOnly };
    const first = await reportAgentBugFromAgent(
      ADMIN_ID,
      'agent-root',
      'grep 500',
      h.deps,
      options
    );
    assert.deepEqual(
      first,
      {
        success: true,
        mode: 'recorded',
        name: '--ai-- grep 500',
        url: null,
        run_id: null,
        already_reported: false,
      },
      label
    );
    const claim = h.claims.get('agent-root');
    assert.equal(claim?.status, 'RECORDED', label);
    assert.equal(claim?.description, 'grep 500', label);
    const again = await reportAgentBugFromAgent(ADMIN_ID, 'agent-root', 'other', h.deps, options);
    assert.equal(again.already_reported, true, label);
    assert.equal(again.mode, 'recorded', label);
    assert.equal(h.launches.length, 0, `${label}: nothing launched`);
    assert.equal(h.counted(), 0, `${label}: the daily launch cap does not apply`);
    assert.deepEqual(h.recorded, [], `${label}: the stuck-agent claim is untouched`);
  }
}

async function testReadViewResolvesTreeRoot(): Promise<void> {
  const rows = new Map([
    [
      'root-1',
      {
        name: '--ai-- grep 500',
        promptText: 'p',
        idempotencyKey: 'k',
        description: 'grep 500',
        status: 'RECORDED',
        runId: null,
        createdAt: new Date('2026-11-06T22:00:00Z'),
        updatedAt: new Date('2026-11-06T22:00:01Z'),
      },
    ],
  ]);
  const agents = new Map<string, object>([
    ['root-1', { id: 'root-1', parentAgentId: null, busId: 'root-1' }],
    ['child-1', { id: 'child-1', parentAgentId: 'root-1', busId: 'root-1' }],
    ['root-2', { id: 'root-2', parentAgentId: null, busId: 'root-2' }],
  ]);
  const deps = {
    findAgentById: async (id: string) => (agents.get(id) ?? null) as never,
    findRow: async (id: string) => rows.get(id) ?? null,
  };
  const child = await readAgentSelfBugReport('child-1', deps);
  assert.deepEqual(child, {
    agent_id: 'child-1',
    root_agent_id: 'root-1',
    report: {
      status: 'recorded',
      title: '--ai-- grep 500',
      description: 'grep 500',
      boxes_run_id: null,
      created_at: '2026-11-06T22:00:00.000Z',
      updated_at: '2026-11-06T22:00:01.000Z',
    },
  });
  assert.deepEqual(await readAgentSelfBugReport('root-2', deps), {
    agent_id: 'root-2',
    root_agent_id: 'root-2',
    report: null,
  });
  await assert.rejects(readAgentSelfBugReport('missing', deps), ReportBugNotFoundError);
}

async function testAgentReportCapSkipsRunThatAlreadyReported(): Promise<void> {
  const h = agentReportHarness({}, { filedToday: MAX_AGENT_BUG_REPORTS_PER_DAY });
  h.claims.set('agent-root', {
    name: '--ai-- earlier',
    promptText: 'earlier prompt',
    idempotencyKey: 'rose-agent-report-bug-agent-root',
    description: 'earlier',
    status: 'SUCCEEDED',
    runId: 'run-earlier',
  });
  const result = await reportAgentBugFromAgent(ADMIN_ID, 'agent-root', 'again', h.deps);
  assert.equal(result.run_id, 'run-earlier');
  assert.equal(result.already_reported, true);
  assert.equal(h.launches.length, 0);
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ['agent report launches once with an --ai-- title', testAgentReportLaunchesOnceWithAiTitle],
    [
      'agent report retries a failed launch with the frozen request',
      testAgentReportRetriesFailedLaunchWithFrozenRequest,
    ],
    ['agent report gates owner, run kind, description and daily cap', testAgentReportGates],
    [
      'agent report is only saved outside production, for record_only and for benchmarks',
      testAgentReportOnlySavesWhenNotLaunching,
    ],
    ['agent report read view resolves the tree root for /rca', testReadViewResolvesTreeRoot],
    [
      'agent report daily cap never blocks a run that already reported',
      testAgentReportCapSkipsRunThatAlreadyReported,
    ],
  ];

  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(
        `FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
  if (failed > 0) process.exit(1);
}

void main();
