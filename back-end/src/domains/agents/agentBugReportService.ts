/**
 * Root agent report_bug tool — the Report Bug button's /rca automation, filed by
 * the agent for its own run.
 *
 *   report_bug(description)                       (agents/domains/report_bug)
 *     → POST /api/agents/:id/report-bug/by-agent  (internal API key, the agent's own id)
 *     → production backend only (dev, devbox and benchmark stacks refuse)
 *     → admin owner (the button's gate) + real root run
 *       (not a sub-agent, benchmark or simulated run)
 *     → one claim per run: agent-self-bug-report:<id> freezes the first request,
 *       so retries and parallel calls re-send it under one idempotency key
 *     → daily cap across agents, checked only before a run's first claim
 *     → boxes.dev thread `--ai-- <description>` with the manual /goal + /rca prompt
 *     → agent-bug-report:<id> (source agent), so the 24h stuck-agent job skips it
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
  type ReportBugResult,
  ReportBugValidationError,
  validateBugDescription,
} from './bugReportService';
import { getBoxesBugReportAppUrl } from './config';
import { createLogger } from '../../providers/logger';
import { isProductionEnvironment } from '../../providers/productionEnvironment';
import {
  type AgentSelfBugReportClaim,
  type AgentSelfBugReportRequest,
  claimAgentSelfBugReport,
  countAgentSelfBugReportsBetween,
  findAgentSelfBugReport,
  markAgentSelfBugReportFailed,
  markAgentSelfBugReportLaunched,
  recordManualAgentBugReport,
} from './repoAgentBugReports';

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

export class ReportBugNotProductionError extends Error {
  constructor() {
    super('Agent bug reports are filed only in production');
    this.name = 'ReportBugNotProductionError';
  }
}

export interface AgentReportBugResult extends ReportBugResult {
  /** True when this run's one report carries an earlier description; this one was not sent. */
  already_reported: boolean;
}

export interface AgentReportBugDeps {
  findAgentById?: typeof repo.findAgentById;
  launch?: (args: ReportBugLaunchArgs) => Promise<ReportBugLaunch>;
  findClaim?: typeof findAgentSelfBugReport;
  claim?: typeof claimAgentSelfBugReport;
  countClaims?: typeof countAgentSelfBugReportsBetween;
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

/** The agent is the owner's own live, real-world, non-benchmark root run. */
async function assertReportableRootRun(
  userId: string,
  agentId: string,
  findAgentById: typeof repo.findAgentById
): Promise<void> {
  const agent = await findAgentById(agentId);
  if (agent === null || agent.userId !== userId) {
    throw new ReportBugNotFoundError();
  }
  if (
    agent.parentAgentId !== null ||
    agent.depth !== 0 ||
    agent.isBenchmark ||
    agent.worldModelMode !== 'real'
  ) {
    throw new ReportBugValidationError(
      'Only a real root agent run can report a bug (not a sub-agent, benchmark or simulated run)'
    );
  }
}

/** The run's existing claim, or a new one when the daily cap allows it. */
async function claimReport(
  agentId: string,
  request: AgentSelfBugReportRequest,
  now: Date,
  deps: AgentReportBugDeps
): Promise<AgentSelfBugReportClaim> {
  const existing = await (deps.findClaim ?? findAgentSelfBugReport)(agentId);
  if (existing !== null) return existing;
  const filedToday = await (deps.countClaims ?? countAgentSelfBugReportsBetween)(
    new Date(now.getTime() - DAY_MS),
    now
  );
  if (filedToday >= MAX_AGENT_BUG_REPORTS_PER_DAY) {
    throw new ReportBugLimitError(
      `Agents already filed ${MAX_AGENT_BUG_REPORTS_PER_DAY} bug reports in the last 24 hours`
    );
  }
  return (deps.claim ?? claimAgentSelfBugReport)(agentId, request, now);
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

/** File the calling root agent's one bug report (see the file header for every gate). */
export async function reportAgentBugFromAgent(
  userId: string | undefined,
  agentId: string,
  description: unknown,
  deps: AgentReportBugDeps = {}
): Promise<AgentReportBugResult> {
  assertReportBugAdmin(userId);
  if (!(deps.isProduction ?? (() => isProductionEnvironment(process.env)))()) {
    throw new ReportBugNotProductionError();
  }
  const trimmed = validateBugDescription(description);
  await assertReportableRootRun(userId, agentId, deps.findAgentById ?? repo.findAgentById);

  const request: AgentSelfBugReportRequest = {
    name: `--ai-- ${buildBugReportChatName(trimmed)}`,
    promptText: buildAgentBugReportPrompt(agentId, trimmed),
    idempotencyKey: buildAgentBugReportIdempotencyKey(agentId),
  };
  const now = (deps.now ?? (() => new Date()))();
  const claim = await claimReport(agentId, request, now, deps);
  const already_reported = claim.promptText !== request.promptText;
  if (claim.status === 'SUCCEEDED' && claim.runId !== null) {
    const url = getBoxesBugReportAppUrl();
    return { success: true, name: claim.name, url, run_id: claim.runId, already_reported };
  }

  // Do not log the description — it can carry customer incident text.
  log.info('Submitting agent bug report to boxes.dev automation', {
    rose_agent_id: agentId,
    description_chars: trimmed.length,
  });
  const launched = await launchClaim(agentId, claim, deps);
  return {
    success: true,
    name: launched.name,
    url: launched.url,
    run_id: launched.run_id,
    already_reported,
  };
}
