/**
 * Root agent report_bug tool — the Report Bug button's /rca automation, filed by
 * the agent for its own run.
 *
 *   report_bug(description)                       (agents/domains/report_bug)
 *     → POST /api/agents/:id/report-bug/by-agent  (internal API key, the agent's own id;
 *       body record_only=true when the worker is not on production Temporal)
 *     → admin owner (the button's gate) + real-world root run (not a sub-agent or simulated run)
 *     → one claim per run: agent-self-bug-report:<id> freezes the first request
 *     → launch = production backend AND not record_only AND not a benchmark run:
 *         daily cap across agents (atomic count + claim, only before a run's first claim)
 *         → boxes.dev thread `--ai-- <description>` with the manual /goal + /rca prompt
 *         → agent-bug-report:<id> (source agent), so the 24h stuck-agent job skips it
 *       otherwise the claim is saved as RECORDED and nothing is launched
 *     → GET /api/agents/:id/report-bug/by-agent: the tree root's report, for /rca
 *
 * 10k agents: one indexed claim read per call, one count + insert on the first,
 * and at most one boxes.dev run per agent run.
 */

import * as repo from './repo';
import {
  buildBugReportChatName,
  buildManualBugReportPrompt,
  launchBugReportAutomation,
  assertReportBugAdmin,
  type ReportBugLaunch,
  type ReportBugLaunchArgs,
  ReportBugNotFoundError,
  ReportBugValidationError,
  validateBugDescription,
} from './bugReportService';
import { getBoxesBugReportAppUrl } from './config';
import { createLogger } from '../../providers/logger';
import { isProductionEnvironment } from '../../providers/productionEnvironment';
import { recordManualAgentBugReport } from './repoAgentBugReports';
import {
  type AgentSelfBugReportClaim,
  type AgentSelfBugReportRequest,
  claimAgentSelfBugReport,
  claimAgentSelfBugReportWithinCap,
  findAgentSelfBugReport,
  findAgentSelfBugReportRow,
  markAgentSelfBugReportFailed,
  markAgentSelfBugReportLaunched,
} from './repoAgentSelfBugReports';

const log = createLogger('ReportBug');

/** Agent-filed reports across all runs per rolling 24h; each run files at most one. */
export const MAX_AGENT_BUG_REPORTS_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ReportBugLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportBugLimitError';
  }
}

export interface AgentReportBugResult {
  success: true;
  /** launched: a boxes.dev /rca run exists; recorded: saved for /rca only (outside production). */
  mode: 'launched' | 'recorded';
  name: string;
  url: string | null;
  run_id: string | null;
  /** True when this run's one report carries an earlier description; this one was not sent. */
  already_reported: boolean;
}

export interface AgentSelfBugReportView {
  agent_id: string;
  root_agent_id: string;
  report: {
    status: 'launched' | 'recorded' | 'launching' | 'launch_failed';
    title: string;
    description: string;
    boxes_run_id: string | null;
    created_at: string;
    updated_at: string;
  } | null;
}

export interface AgentReportBugDeps {
  findAgentById?: typeof repo.findAgentById;
  launch?: (args: ReportBugLaunchArgs) => Promise<ReportBugLaunch>;
  findClaim?: typeof findAgentSelfBugReport;
  claim?: typeof claimAgentSelfBugReport;
  claimWithinCap?: typeof claimAgentSelfBugReportWithinCap;
  markLaunched?: typeof markAgentSelfBugReportLaunched;
  markFailed?: typeof markAgentSelfBugReportFailed;
  recordReport?: typeof recordManualAgentBugReport;
  now?: () => Date;
  isProduction?: () => boolean;
}

/** The Report Bug button's /goal + /rca prompt, marked as filed by the agent itself. */
export function buildAgentBugReportPrompt(agentId: string, description: string): string {
  return buildManualBugReportPrompt(
    agentId,
    `Reported by the agent itself with its report_bug tool:\n${description.trim()}`
  );
}

/** One report per run, so retries and parallel calls all reuse one boxes.dev run. */
export function buildAgentBugReportIdempotencyKey(agentId: string): string {
  return `rose-agent-report-bug-${agentId}`;
}

type ReportableAgent = NonNullable<Awaited<ReturnType<typeof repo.findAgentById>>>;

/** The agent is the owner's own live, real-world root run. */
async function loadReportableRootRun(
  userId: string,
  agentId: string,
  findAgentById: typeof repo.findAgentById
): Promise<ReportableAgent> {
  const agent = await findAgentById(agentId);
  if (agent === null || agent.userId !== userId) {
    throw new ReportBugNotFoundError();
  }
  if (agent.parentAgentId !== null || agent.depth !== 0 || agent.worldModelMode !== 'real') {
    throw new ReportBugValidationError(
      'Only a real-world root agent run can report a bug (not a sub-agent or simulated run)'
    );
  }
  return agent;
}

/** The run's existing claim, or a new one when the daily cap allows it (atomically). */
async function claimReport(
  agentId: string,
  request: AgentSelfBugReportRequest,
  now: Date,
  deps: AgentReportBugDeps
): Promise<AgentSelfBugReportClaim> {
  const existing = await (deps.findClaim ?? findAgentSelfBugReport)(agentId);
  if (existing !== null) return existing;
  const claim = await (deps.claimWithinCap ?? claimAgentSelfBugReportWithinCap)(
    agentId,
    request,
    now,
    MAX_AGENT_BUG_REPORTS_PER_DAY,
    new Date(now.getTime() - DAY_MS)
  );
  if (claim === null) {
    throw new ReportBugLimitError(
      `Agents already filed ${MAX_AGENT_BUG_REPORTS_PER_DAY} bug reports in the last 24 hours`
    );
  }
  return claim;
}

/** Launch the frozen request, then record the run on both claims. */
async function launchClaim(
  agentId: string,
  claim: AgentSelfBugReportClaim,
  deps: AgentReportBugDeps
): Promise<ReportBugLaunch> {
  let launched: ReportBugLaunch;
  try {
    launched = await (deps.launch ?? launchBugReportAutomation)({
      name: claim.name,
      promptText: claim.promptText,
      idempotencyKey: claim.idempotencyKey,
    });
  } catch (error) {
    await (deps.markFailed ?? markAgentSelfBugReportFailed)(
      agentId,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
  // The run exists. A failed write leaves the claim retryable and the identical
  // keyed request returns this same run, so it must not fail the launch.
  try {
    await (deps.markLaunched ?? markAgentSelfBugReportLaunched)(agentId, launched.run_id);
    await (deps.recordReport ?? recordManualAgentBugReport)(agentId, launched.run_id, 'agent');
  } catch (error) {
    log.error('Failed to record agent bug report', {
      rose_agent_id: agentId,
      run_id: launched.run_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return launched;
}

function claimResult(
  claim: AgentSelfBugReportClaim,
  already_reported: boolean
): AgentReportBugResult {
  const launched = claim.status === 'SUCCEEDED' && claim.runId !== null;
  return {
    success: true,
    mode: launched ? 'launched' : 'recorded',
    name: claim.name,
    url: launched ? getBoxesBugReportAppUrl() : null,
    run_id: launched ? claim.runId : null,
    already_reported,
  };
}

/** File the calling root agent's one bug report (see the file header for every gate). */
export async function reportAgentBugFromAgent(
  userId: string | undefined,
  agentId: string,
  description: unknown,
  deps: AgentReportBugDeps = {},
  options: { recordOnly?: boolean } = {}
): Promise<AgentReportBugResult> {
  assertReportBugAdmin(userId);
  const trimmed = validateBugDescription(description);
  const agent = await loadReportableRootRun(
    userId,
    agentId,
    deps.findAgentById ?? repo.findAgentById
  );
  const production = (deps.isProduction ?? (() => isProductionEnvironment(process.env)))();
  const launch = production && options.recordOnly !== true && !agent.isBenchmark;

  const request: AgentSelfBugReportRequest = {
    name: `--ai-- ${buildBugReportChatName(trimmed)}`,
    promptText: buildAgentBugReportPrompt(agentId, trimmed),
    idempotencyKey: buildAgentBugReportIdempotencyKey(agentId),
    description: trimmed,
  };
  const now = (deps.now ?? (() => new Date()))();
  if (!launch) {
    // Saved for /rca only: no boxes.dev run, so no daily cap.
    const recorded =
      (await (deps.findClaim ?? findAgentSelfBugReport)(agentId)) ??
      (await (deps.claim ?? claimAgentSelfBugReport)(agentId, request, now, 'RECORDED'));
    log.info('Recorded agent bug report without launching', {
      rose_agent_id: agentId,
      production,
      record_only: options.recordOnly === true,
      benchmark: agent.isBenchmark,
    });
    return claimResult(recorded, recorded.promptText !== request.promptText);
  }
  const claim = await claimReport(agentId, request, now, deps);
  const already_reported = claim.promptText !== request.promptText;
  if (claim.status === 'RECORDED' || (claim.status === 'SUCCEEDED' && claim.runId !== null)) {
    return claimResult(claim, already_reported);
  }

  // Do not log the description — it can carry customer incident text.
  log.info('Submitting agent bug report to boxes.dev automation', {
    rose_agent_id: agentId,
    description_chars: trimmed.length,
  });
  const launched = await launchClaim(agentId, claim, deps);
  return {
    success: true,
    mode: 'launched',
    name: launched.name,
    url: launched.url,
    run_id: launched.run_id,
    already_reported,
  };
}

const VIEW_STATUS = {
  SUCCEEDED: 'launched',
  RECORDED: 'recorded',
  STARTED: 'launching',
  FAILED: 'launch_failed',
} as const;

/** The report_bug report of the tree that `agentId` belongs to (filed by its root), for /rca. */
export async function readAgentSelfBugReport(
  agentId: string,
  deps: {
    findAgentById?: typeof repo.findAgentById;
    findRow?: typeof findAgentSelfBugReportRow;
  } = {}
): Promise<AgentSelfBugReportView> {
  const agent = await (deps.findAgentById ?? repo.findAgentById)(agentId);
  if (agent === null) throw new ReportBugNotFoundError();
  const rootId = agent.parentAgentId === null ? agent.id : (agent.busId ?? agent.id);
  const row = await (deps.findRow ?? findAgentSelfBugReportRow)(rootId);
  if (row === null) return { agent_id: agentId, root_agent_id: rootId, report: null };
  return {
    agent_id: agentId,
    root_agent_id: rootId,
    report: {
      status: VIEW_STATUS[row.status as keyof typeof VIEW_STATUS] ?? 'launching',
      title: row.name,
      description: row.description,
      boxes_run_id: row.runId,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    },
  };
}
