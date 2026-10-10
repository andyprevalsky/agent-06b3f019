/**
 * Report Bug — run the boxes.dev "Bug Report" automation to /rca a Rose agent failure.
 *
 * Flow:
 *   Agent Settings → Report Bug → description
 *     → POST /api/agents/:id/report-bug
 *     → boxes.dev thread-automation API trigger (configurable request)
 *     → new devbox thread titled from the description, prompt `/rca … [id]\n<description>`
 *
 * No SMS and no auto-open: the FE keeps an explicit Open / Copy link after
 * launch. Texts and window.open were user-visible side effects of reporting.
 */

import { createHash } from 'node:crypto';
import { isAdminUser } from '../../utils/adminAccess';
import * as benchmarkHubLookup from '../../providers/benchmarkHubLookup';
import { runBoxesThreadAutomation } from '../../providers/boxesThreadAutomations';
import { createLogger } from '../../providers/logger';
import {
  getBoxesBugReportAppUrl,
  getBoxesBugReportRunUrl,
  getBoxesBugReportSecret,
} from './config';
import * as repo from './repo';

const log = createLogger('ReportBug');

const MAX_DESCRIPTION_CHARS = 8_000;
const MAX_TITLE_CHARS = 60;

export class ReportBugForbiddenError extends Error {
  constructor() {
    super('Report Bug is restricted to admin accounts');
    this.name = 'ReportBugForbiddenError';
  }
}

export class ReportBugNotFoundError extends Error {
  constructor() {
    super('Agent not found');
    this.name = 'ReportBugNotFoundError';
  }
}

export class ReportBugValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportBugValidationError';
  }
}

export class ReportBugNotConfiguredError extends Error {
  constructor() {
    super('boxes.dev bug report automation is not configured');
    this.name = 'ReportBugNotConfiguredError';
  }
}

export interface ReportBugResult {
  success: true;
  name: string;
  url: string;
  run_id: string;
}

export interface ReportBugLaunchArgs {
  name: string;
  promptText: string;
  idempotencyKey: string;
}

export interface ReportBugLaunch {
  run_id: string;
  name: string;
  url: string;
}

export interface ReportBugDeps {
  findAgentById?: typeof repo.findAgentById;
  findAgentAcrossRuns?: typeof benchmarkHubLookup.findAgentAcrossRuns;
  launch?: (args: ReportBugLaunchArgs) => Promise<ReportBugLaunch>;
}

/** Collapse whitespace and truncate at a word boundary for the chat title. */
export function buildBugReportTitle(description: string): string {
  const cleaned = description.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return 'Untitled';
  if (cleaned.length <= MAX_TITLE_CHARS) return cleaned;
  const sliced = cleaned.slice(0, MAX_TITLE_CHARS);
  const lastSpace = sliced.lastIndexOf(' ');
  const base = lastSpace > 20 ? sliced.slice(0, lastSpace) : sliced;
  return `${base.trimEnd()}…`;
}

export function buildBugReportPrompt(agentId: string, description: string): string {
  // Exact agent-facing prompt — no blank line, no footer, no title line.
  return `/rca the following bug for agent with ID: [${agentId}]\n${description.trim()}`;
}

/**
 * Report Bug only needs a stable Rose agent id for the /rca prompt. Live DB rows
 * and benchmark-hub archived runs both qualify — GET /agents/:id already serves
 * hub archives via findAgentAcrossRuns, but report-bug used to require a live row.
 */
export async function agentExistsForBugReport(
  agentId: string,
  deps: {
    findAgentById?: typeof repo.findAgentById;
    findAgentAcrossRuns?: typeof benchmarkHubLookup.findAgentAcrossRuns;
  } = {}
): Promise<boolean> {
  const findById = deps.findAgentById ?? repo.findAgentById;
  const findAcross = deps.findAgentAcrossRuns ?? benchmarkHubLookup.findAgentAcrossRuns;
  const live = await findById(agentId);
  if (live !== null) return true;
  const archived = await findAcross(agentId);
  return archived !== null;
}

export function buildBugReportChatName(description: string): string {
  // Plain title only — no Bug | / P0 prefix.
  return buildBugReportTitle(description);
}

/**
 * Same agent + description → same key, so a double submit or a retry after an
 * ambiguous timeout reuses the original boxes.dev run instead of a duplicate.
 */
export function buildBugReportIdempotencyKey(agentId: string, description: string): string {
  const digest = createHash('sha256').update(`${agentId}\n${description.trim()}`).digest('hex');
  return `rose-report-bug-${digest.slice(0, 48)}`;
}

function validateBugDescription(description: unknown): string {
  if (typeof description !== 'string') {
    throw new ReportBugValidationError('Description is required');
  }
  const trimmed = description.trim();
  if (trimmed === '') {
    throw new ReportBugValidationError('Description is required');
  }
  if (trimmed.length > MAX_DESCRIPTION_CHARS) {
    throw new ReportBugValidationError(
      `Description must be at most ${MAX_DESCRIPTION_CHARS} characters`
    );
  }
  return trimmed;
}

export async function reportAgentBug(
  userId: string | undefined,
  agentId: string,
  description: unknown,
  deps: ReportBugDeps = {}
): Promise<ReportBugResult> {
  if (!isAdminUser(userId)) {
    throw new ReportBugForbiddenError();
  }

  const trimmed = validateBugDescription(description);
  const exists = await agentExistsForBugReport(agentId, {
    findAgentById: deps.findAgentById,
    findAgentAcrossRuns: deps.findAgentAcrossRuns,
  });
  if (!exists) {
    throw new ReportBugNotFoundError();
  }

  const name = buildBugReportChatName(trimmed);
  const promptText = buildBugReportPrompt(agentId, trimmed);
  const idempotencyKey = buildBugReportIdempotencyKey(agentId, trimmed);
  const launch = deps.launch ?? defaultLaunch;

  // Do not log chat_name / description — they carry customer incident text.
  log.info('Submitting bug report to boxes.dev automation', {
    rose_agent_id: agentId,
    description_chars: trimmed.length,
  });

  const launched = await launch({ name, promptText, idempotencyKey });

  return {
    success: true,
    name: launched.name,
    url: launched.url,
    run_id: launched.run_id,
  };
}

async function defaultLaunch(args: ReportBugLaunchArgs): Promise<ReportBugLaunch> {
  const secret = getBoxesBugReportSecret();
  if (secret === undefined) {
    throw new ReportBugNotConfiguredError();
  }
  const run = await runBoxesThreadAutomation({
    runUrl: getBoxesBugReportRunUrl(),
    secret,
    prompt: args.promptText,
    threadTitle: args.name,
    idempotencyKey: args.idempotencyKey,
  });
  return { run_id: run.runId, name: run.threadTitle, url: getBoxesBugReportAppUrl() };
}
