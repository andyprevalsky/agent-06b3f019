/**
 * 24h stuck-agent bug reports.
 *
 * Every real prod agent run that is not COMPLETED 24 hours after it started gets
 * one Report Bug /rca launch, unless it already has a manual or automated report.
 *
 *   serverCron (hourly)
 *     → findStuckAgentCandidates   live root real-person runs, ≥24h old, not COMPLETED,
 *                                  ran a non-chat tool, no report claim
 *     → claimStuckAgentBugReport   unique ToolSideEffect row per agent (exactly once
 *                                  across replicas and overlapping ticks)
 *     → launchBugReportAutomation  boxes.dev Bug Report automation, same /rca prompt
 *                                  syntax as the Report Bug button, per-agent
 *                                  idempotency key
 *     → SUCCEEDED (run id) | FAILED (retry with backoff, then give up)
 *
 * The DB is the only state: a missed tick, restart, or deploy catches up on the
 * next tick. No Slack. Work per tick is one indexed window query plus at most
 * MAX_LAUNCHES_PER_TICK launches, and launches are capped per day, so it is
 * independent of total agent count.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../providers/logger';
import {
  buildBugReportPrompt,
  buildBugReportTitle,
  isBugReportAutomationConfigured,
  launchBugReportAutomation,
  type ReportBugLaunch,
  type ReportBugLaunchArgs,
} from './bugReportService';
import {
  claimStuckAgentBugReport,
  countStuckAgentBugReportsBetween,
  findStuckAgentCandidates,
  markStuckAgentBugReportFailed,
  markStuckAgentBugReportLaunched,
  readAgentBugReportAttempts,
  type StuckAgentCandidate,
} from './repoAgentBugReports';

const log = createLogger('StuckAgentBugReports');

const HOUR_MS = 60 * 60 * 1000;
export const STUCK_AGENT_REPORT_AFTER_MS = 24 * HOUR_MS;
/** Only runs created from here on are reported; older ones are not backfilled. */
export const STUCK_AGENT_REPORTS_FIRST_CREATED_AT = new Date('2026-10-20T00:00:00.000Z');
/** Runs older than this are never picked up, which keeps the window query bounded. */
const LOOKBACK_MS = 14 * 24 * HOUR_MS;
const MAX_LAUNCHES_PER_TICK = 10;
export const MAX_STUCK_AGENT_REPORTS_PER_DAY = 20;
/** A STARTED claim older than this belongs to a crashed launch and is reclaimable. */
const STALE_CLAIM_MS = 10 * 60 * 1000;
const MAX_LAUNCH_ATTEMPTS = 6;

export function buildStuckAgentBugDescription(status: string): string {
  return [
    `Not completed 24h after start (status: ${status}). Classify:`,
    '- Stalled on user input',
    '  - took too long → speed it up without changing the model or the trajectory via prompts or context injection',
    '  - hit a price limit → cut cost via cache hits or planner memory; prompt changes only as a last resort',
    '  - asked the user for feedback when it should have found an alternative path to completion',
    '- Died from a harness issue (infinite tool calls, faulty tool, etc.)',
    '- PASS: taking longer than 24h but still making good progress; the goal is complex enough to justify an exceedingly long execution',
    'All approval requests go to the main agent for user approval.',
  ].join('\n');
}

/** Agent-created threads carry the --ai-- prefix. */
export function buildStuckAgentBugTitle(agentTitle: string): string {
  return `--ai-- Not completed after 24h: ${buildBugReportTitle(agentTitle)}`;
}

/** Fixed per agent, so a retry after an ambiguous failure reuses the original run. */
export function stuckAgentBugReportIdempotencyKey(agentId: string): string {
  return `rose-stuck-agent-24h-${agentId}`;
}

/** Exponential backoff from 1h, capped at 24h; null after the last attempt. */
function nextAttemptAt(now: Date, attempts: number): Date | null {
  if (attempts >= MAX_LAUNCH_ATTEMPTS) return null;
  const delay = Math.min(HOUR_MS * 2 ** Math.max(0, attempts - 1), 24 * HOUR_MS);
  return new Date(now.getTime() + delay);
}

export interface StuckAgentBugReportOptions {
  now?: Date;
  /** Restrict the scan to these agents (tests). */
  candidateAgentIds?: string[];
  /** Override the no-backfill start line (tests). */
  firstCreatedAt?: Date;
}

export interface StuckAgentBugReportDeps {
  launch?: (args: ReportBugLaunchArgs) => Promise<ReportBugLaunch>;
  isConfigured?: () => boolean;
}

export interface StuckAgentBugReportSummary {
  configured: boolean;
  candidates: number;
  launched: number;
  failed: number;
  claimLost: number;
  capRemaining: number;
}

type LaunchOutcome = 'launched' | 'failed' | 'claim_lost';

async function reportStuckAgent(
  agent: StuckAgentCandidate,
  now: Date,
  launch: (args: ReportBugLaunchArgs) => Promise<ReportBugLaunch>
): Promise<LaunchOutcome> {
  const ownerId = randomUUID();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  if (!(await claimStuckAgentBugReport(agent.id, ownerId, now, staleBefore))) {
    return 'claim_lost';
  }

  try {
    const launched = await launch({
      name: buildStuckAgentBugTitle(agent.title),
      promptText: buildBugReportPrompt(agent.id, buildStuckAgentBugDescription(agent.status)),
      idempotencyKey: stuckAgentBugReportIdempotencyKey(agent.id),
    });
    const recorded = await markStuckAgentBugReportLaunched(
      agent.id,
      ownerId,
      launched.run_id,
      new Date()
    );
    log.info('Launched stuck-agent bug report', {
      rose_agent_id: agent.id,
      agent_status: agent.status,
      run_id: launched.run_id,
      recorded,
    });
    return 'launched';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = await readAgentBugReportAttempts(agent.id);
    const retryAt = nextAttemptAt(now, attempts);
    await markStuckAgentBugReportFailed(agent.id, ownerId, message, retryAt);
    log.error('Stuck-agent bug report launch failed', {
      rose_agent_id: agent.id,
      attempts,
      next_attempt_at: retryAt?.toISOString() ?? 'none (gave up)',
      error: message,
    });
    return 'failed';
  }
}

export async function runStuckAgentBugReports(
  options: StuckAgentBugReportOptions = {},
  deps: StuckAgentBugReportDeps = {}
): Promise<StuckAgentBugReportSummary> {
  const now = options.now ?? new Date();
  const summary: StuckAgentBugReportSummary = {
    configured: (deps.isConfigured ?? isBugReportAutomationConfigured)(),
    candidates: 0,
    launched: 0,
    failed: 0,
    claimLost: 0,
    capRemaining: 0,
  };
  if (!summary.configured) return summary;

  const reportedToday = await countStuckAgentBugReportsBetween(
    new Date(now.getTime() - 24 * HOUR_MS),
    now
  );
  summary.capRemaining = Math.max(0, MAX_STUCK_AGENT_REPORTS_PER_DAY - reportedToday);
  const limit = Math.min(MAX_LAUNCHES_PER_TICK, summary.capRemaining);
  if (limit === 0) return summary;

  const lookbackStart = new Date(now.getTime() - LOOKBACK_MS);
  const firstCreatedAt = options.firstCreatedAt ?? STUCK_AGENT_REPORTS_FIRST_CREATED_AT;
  const candidates = await findStuckAgentCandidates({
    createdFrom: lookbackStart > firstCreatedAt ? lookbackStart : firstCreatedAt,
    createdBefore: new Date(now.getTime() - STUCK_AGENT_REPORT_AFTER_MS),
    now,
    staleBefore: new Date(now.getTime() - STALE_CLAIM_MS),
    limit,
    candidateAgentIds: options.candidateAgentIds,
  });
  summary.candidates = candidates.length;

  const launch = deps.launch ?? launchBugReportAutomation;
  for (const agent of candidates) {
    const outcome = await reportStuckAgent(agent, now, launch);
    if (outcome === 'launched') summary.launched += 1;
    else if (outcome === 'failed') summary.failed += 1;
    else summary.claimLost += 1;
  }
  summary.capRemaining -= summary.launched;
  return summary;
}
