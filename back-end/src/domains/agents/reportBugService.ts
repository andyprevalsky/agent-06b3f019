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
import { getUserPhone, sendSms } from '../../providers/smsQueue';
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

/** SMS body with the Cursor deep link — API agents skip the native mobile inbox. */
export function buildBugReportSms(name: string, url: string): string {
  return `Rose bug report launched: ${name}\n\nOpen in Cursor (API chats skip the phone rose inbox):\n${url}`;
}

/**
 * Best-effort SMS so the admin can tap the deep link on phone.
 * Never fails the report if SMS is unavailable.
 */
export async function notifyBugReportSms(
  userId: string,
  name: string,
  url: string,
  roseAgentId: string
): Promise<boolean> {
  try {
    const phone = await getUserPhone(userId);
    if (phone === null || phone === '') {
      log.warn('No phone for bug-report SMS', { userId });
      return false;
    }
    const result = await sendSms(phone, buildBugReportSms(name, url), {
      archiveRootAgentId: roseAgentId,
      archiveContext: { kind: 'report_bug_cursor_link' },
    });
    if (!result.success) {
      log.warn('Bug-report SMS failed', { error: result.error, userId });
      return false;
    }
    log.info('Bug-report SMS sent', { userId, messageSid: result.messageSid });
    return true;
  } catch (error) {
    log.warn('Bug-report SMS threw', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
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

  // Phone manageability: native Cursor iOS inbox often omits source:api agents.
  // SMS the deep link so the admin can open the chat without finding it in-list.
  if (userId !== undefined) {
    await notifyBugReportSms(userId, launched.name, launched.url, agentId);
  }

  return {
    success: true,
    name: launched.name,
    url: launched.url,
    cursor_agent_id: launched.id,
  };
}
