/**
 * Report Bug — launch a Cursor cloud agent to /rca a Rose agent failure.
 *
 * Flow:
 *   Agent Settings → Report Bug → description
 *     → POST /api/agents/:id/report-bug
 *     → Cursor Cloud Agents API
 *     → dashboard chat named "Bug | <short title>"
 */

import { isAdminUser } from '../../utils/adminAccess';
import { launchCursorCloudAgent } from '../../providers/cursorCloudAgents';
import { createLogger } from '../../providers/logger';
import { getCursorApiBaseUrl, getCursorApiKey, getCursorCloudEnvName } from './config';
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
    super('Cursor API is not configured');
    this.name = 'ReportBugNotConfiguredError';
  }
}

export interface ReportBugResult {
  success: true;
  name: string;
  url: string;
  cursor_agent_id: string;
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
  return `/rca the following bug for agent with ID: [${agentId}]\n\n${description.trim()}`;
}

export function buildBugReportChatName(description: string): string {
  return `Bug | ${buildBugReportTitle(description)}`;
}

export async function reportAgentBug(
  userId: string | undefined,
  agentId: string,
  description: unknown
): Promise<ReportBugResult> {
  if (!isAdminUser(userId)) {
    throw new ReportBugForbiddenError();
  }

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

  const agent = await repo.findAgentById(agentId);
  if (agent === null) {
    throw new ReportBugNotFoundError();
  }

  const apiKey = getCursorApiKey();
  if (apiKey === undefined) {
    throw new ReportBugNotConfiguredError();
  }

  const name = buildBugReportChatName(trimmed);
  const promptText = buildBugReportPrompt(agentId, trimmed);

  log.info('Submitting bug report to Cursor cloud agent', {
    rose_agent_id: agentId,
    chat_name: name,
    description_chars: trimmed.length,
  });

  const launched = await launchCursorCloudAgent({
    apiKey,
    baseUrl: getCursorApiBaseUrl(),
    name,
    promptText,
    envName: getCursorCloudEnvName(),
  });

  return {
    success: true,
    name: launched.name,
    url: launched.url,
    cursor_agent_id: launched.id,
  };
}
