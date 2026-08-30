/**
 * Report Bug — launch a Cursor cloud agent to /rca a Rose agent failure.
 *
 * Flow:
 *   Agent Settings → Report Bug → description
 *     → POST /api/agents/:id/report-bug
 *     → GitHub issue + @cursor (source:scm)  ← preferred for mobile inbox
 *     → fallback: Cursor Cloud Agents API (source:api, hidden by default)
 *     → dashboard chat titled from the description (no forced prefix)
 *
 * Why GitHub: Cursor staff document that source:api is hidden by default under
 * Filter → Source on web/Agents Window/mobile. GitHub mentions stamp source:scm
 * and show in the interactive inbox.
 * https://forum.cursor.com/t/cursor-cloud-agent-filtering-is-very-confusing/167363
 *
 * Platform limits on scm (not fixable from Rose):
 * - Cursor injects a "Using the context from GitHub…" wrapper around the prompt.
 * - Cursor auto-names the chat from the prompt; PATCH /v1/agents/:id → 404, so
 *   there is no post-create rename. Forced prefixes like "Bug |" are stripped.
 * We set the GitHub issue title from the description and keep the agent prompt
 * body to exactly `/rca … [id]\n<description>` (no Rose footer / title line).
 */

import { isAdminUser } from '../../utils/adminAccess';
import { launchCursorCloudAgent } from '../../providers/cursorCloudAgents';
import {
  launchCursorCloudAgentViaGithub,
  ScmDispatchUnknownError,
} from '../../providers/cursorGithubLaunch';
import { createLogger } from '../../providers/logger';
import { getUserPhone, sendSms } from '../../providers/smsQueue';
import {
  getCursorApiBaseUrl,
  getCursorApiKey,
  getCursorBugReportGithubRepo,
  getCursorCloudEnvName,
  hasGithubIssueLaunchToken,
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
    super('Cursor / GitHub launch is not configured');
    this.name = 'ReportBugNotConfiguredError';
  }
}

export interface ReportBugResult {
  success: true;
  name: string;
  url: string;
  cursor_agent_id: string;
  launch_source: 'scm' | 'api';
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

export function buildBugReportChatName(description: string): string {
  // No Bug | / P0 prefix — Cursor scm auto-naming strips those; plain title only.
  return buildBugReportTitle(description);
}

/** SMS body with the Cursor deep link. */
export function buildBugReportSms(name: string, url: string, launchSource: 'scm' | 'api'): string {
  if (launchSource === 'scm') {
    return `Rose bug report launched: ${name}\n\nShould appear in your Cursor mobile inbox (source:scm):\n${url}`;
  }
  return `Rose bug report launched: ${name}\n\nOpen in Cursor (API source — enable Filter → Source → API if missing):\n${url}`;
}

/**
 * Best-effort SMS so the admin can tap the deep link on phone.
 * Never fails the report if SMS is unavailable.
 */
export async function notifyBugReportSms(
  userId: string,
  name: string,
  url: string,
  roseAgentId: string,
  launchSource: 'scm' | 'api'
): Promise<boolean> {
  try {
    const phone = await getUserPhone(userId);
    if (phone === null || phone === '') {
      log.warn('No phone for bug-report SMS', { userId });
      return false;
    }
    const result = await sendSms(phone, buildBugReportSms(name, url, launchSource), {
      archiveRootAgentId: roseAgentId,
      archiveContext: { kind: 'report_bug_cursor_link', launch_source: launchSource },
    });
    if (!result.success) {
      log.warn('Bug-report SMS failed', { error: result.error, userId });
      return false;
    }
    log.info('Bug-report SMS sent', { userId, messageSid: result.messageSid, launchSource });
    return true;
  } catch (error) {
    log.warn('Bug-report SMS threw', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
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

async function launchViaApi(
  apiKey: string,
  name: string,
  promptText: string
): Promise<{ id: string; name: string; url: string; launch_source: 'api' }> {
  const api = await launchCursorCloudAgent({
    apiKey,
    baseUrl: getCursorApiBaseUrl(),
    name,
    promptText,
    envName: getCursorCloudEnvName(),
  });
  return { id: api.id, name: api.name, url: api.url, launch_source: 'api' };
}

async function launchViaScmOrApiFallback(
  name: string,
  promptText: string,
  apiKey: string | undefined
): Promise<{ id: string; name: string; url: string; launch_source: 'scm' | 'api' }> {
  try {
    const scm = await launchCursorCloudAgentViaGithub({
      name,
      promptText,
      repo: getCursorBugReportGithubRepo(),
    });
    return { id: scm.id, name: scm.name, url: scm.url, launch_source: 'scm' };
  } catch (error) {
    // After GitHub accepted the @cursor comment, Cursor may still finish after
    // our poll deadline. Falling back to the API would create a duplicate RCA.
    if (error instanceof ScmDispatchUnknownError) {
      log.warn('SCM @cursor dispatched but outcome unknown; not falling back to API', {
        error: error.message,
        github_issue_url: error.githubIssueUrl,
      });
      throw error;
    }
    log.warn('GitHub @cursor launch failed before dispatch; falling back to Cursor API', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (apiKey === undefined) throw error;
    return launchViaApi(apiKey, name, promptText);
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

  const trimmed = validateBugDescription(description);
  const agent = await repo.findAgentById(agentId);
  if (agent === null) {
    throw new ReportBugNotFoundError();
  }

  const canScm = hasGithubIssueLaunchToken();
  const apiKey = getCursorApiKey();
  if (!canScm && apiKey === undefined) {
    throw new ReportBugNotConfiguredError();
  }

  const name = buildBugReportChatName(trimmed);
  const promptText = buildBugReportPrompt(agentId, trimmed);

  // Prefer GitHub @cursor (source:scm) so the chat shows in the default mobile
  // inbox. Cloud Agents API can set an exact name, but source:api is hidden
  // under Filter → Source by default — including on phone.
  // Do not log chat_name / description — they carry customer incident text.
  log.info('Submitting bug report to Cursor cloud agent', {
    rose_agent_id: agentId,
    description_chars: trimmed.length,
    prefer_scm: canScm,
  });

  const launched = canScm
    ? await launchViaScmOrApiFallback(name, promptText, apiKey)
    : apiKey === undefined
      ? (() => {
          throw new ReportBugNotConfiguredError();
        })()
      : await launchViaApi(apiKey, name, promptText);

  if (userId !== undefined) {
    await notifyBugReportSms(userId, launched.name, launched.url, agentId, launched.launch_source);
  }

  return {
    success: true,
    name: launched.name,
    url: launched.url,
    cursor_agent_id: launched.id,
    launch_source: launched.launch_source,
  };
}
