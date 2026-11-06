/**
 * Report Bug — run the boxes.dev "Bug Report" automation to /rca a Rose agent failure.
 *
 * Flow:
 *   Agent Settings → Report Bug → description
 *     → POST /api/agents/:id/report-bug
 *     → boxes.dev thread-automation API trigger (configurable request)
 *     → new devbox thread titled from the description, prompt
 *       `/goal … finish the /deploy …\n/rca … [id]\n<description>`
 *
 * Screenshots (the automation API accepts only prompt text):
 *   drag / paste image → POST /api/agents/:id/report-bug/screenshots
 *     → Supabase Storage under the admin's user id → 7-day signed URL
 *     → FE inserts `![name](url)` into the description the admin submits
 *
 * No SMS and no auto-open: the FE keeps an explicit Open / Copy link after
 * launch. Texts and window.open were user-visible side effects of reporting.
 */

import { createHash } from 'node:crypto';
import { isAdminUser } from '../../utils/adminAccess';
import * as benchmarkHubLookup from '../../providers/benchmarkHubLookup';
import { runBoxesThreadAutomation } from '../../providers/boxesThreadAutomations';
import { createLogger } from '../../providers/logger';
import { type FilePointer, getSignedUrl, processUploadedFile } from '../../providers/storage';
import {
  getBoxesBugReportAppUrl,
  getBoxesBugReportRunUrl,
  getBoxesBugReportSecret,
} from './config';
import * as repo from './repo';
import { recordManualAgentBugReport } from './repoAgentBugReports';

const log = createLogger('ReportBug');

const MAX_DESCRIPTION_CHARS = 8_000;
const MAX_TITLE_CHARS = 60;
/** The investigating agent may first open a screenshot days later, on resume. */
export const BUG_REPORT_SCREENSHOT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

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
  recordReport?: typeof recordManualAgentBugReport;
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

// Leads the FE Report Bug prompt so the thread's active goal carries the fix
// through /deploy instead of stopping at the diagnosis. The 24h stuck-agent job
// keeps the plain /rca prompt.
export const BUG_REPORT_GOAL_LINE =
  '/goal once you finish the /rca, finish the /deploy - be relentlessly resourceful';

export function buildManualBugReportPrompt(agentId: string, description: string): string {
  return `${BUG_REPORT_GOAL_LINE}\n${buildBugReportPrompt(agentId, description)}`;
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
  const promptText = buildManualBugReportPrompt(agentId, trimmed);
  const idempotencyKey = buildBugReportIdempotencyKey(agentId, trimmed);
  const launch = deps.launch ?? launchBugReportAutomation;
  const recordReport = deps.recordReport ?? recordManualAgentBugReport;

  // Do not log chat_name / description — they carry customer incident text.
  log.info('Submitting bug report to boxes.dev automation', {
    rose_agent_id: agentId,
    description_chars: trimmed.length,
  });

  const launched = await launch({ name, promptText, idempotencyKey });

  // Marks the agent reported so the 24h stuck-agent job skips it. The run already
  // exists, so a failed write must not turn this launch into an error response.
  try {
    await recordReport(agentId, launched.run_id);
  } catch (error) {
    log.error('Failed to record manual bug report claim', {
      rose_agent_id: agentId,
      run_id: launched.run_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    success: true,
    name: launched.name,
    url: launched.url,
    run_id: launched.run_id,
  };
}

export function isBugReportAutomationConfigured(): boolean {
  return getBoxesBugReportSecret() !== undefined;
}

export async function launchBugReportAutomation(
  args: ReportBugLaunchArgs
): Promise<ReportBugLaunch> {
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

/** Leading bytes for each accepted screenshot type. */
const SCREENSHOT_SIGNATURES = new Map<string, (head: Buffer) => boolean>([
  ['image/png', (head) => head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
  ['image/jpeg', (head) => head.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))],
  ['image/gif', (head) => head.subarray(0, 4).toString('latin1') === 'GIF8'],
  [
    'image/webp',
    (head) =>
      head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP',
  ],
]);

export interface BugReportScreenshotFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

export interface BugReportScreenshotResult {
  success: true;
  name: string;
  url: string;
  expires_in: number;
}

export interface BugReportScreenshotDeps {
  findAgentById?: typeof repo.findAgentById;
  findAgentAcrossRuns?: typeof benchmarkHubLookup.findAgentAcrossRuns;
  store?: (
    userId: string,
    buffer: Buffer,
    filename: string,
    mimeType: string
  ) => Promise<FilePointer>;
  sign?: (storagePath: string, expiresIn: number) => Promise<string>;
}

/** Report Bug and its screenshot uploads are admin-only. */
export function assertReportBugAdmin(userId: string | undefined): asserts userId is string {
  if (userId === undefined || !isAdminUser(userId)) {
    throw new ReportBugForbiddenError();
  }
}

function validateScreenshot(file: BugReportScreenshotFile | undefined): BugReportScreenshotFile {
  if (file === undefined) {
    throw new ReportBugValidationError('Screenshot file is required');
  }
  const matchesSignature = SCREENSHOT_SIGNATURES.get(file.mimetype);
  if (matchesSignature === undefined || !matchesSignature(file.buffer)) {
    throw new ReportBugValidationError('Screenshot must be a PNG, JPEG, GIF or WebP image');
  }
  return file;
}

/**
 * Store one Report Bug screenshot and return a signed URL the admin's
 * description can embed. Same admin and agent gates as reportAgentBug.
 */
export async function uploadBugReportScreenshot(
  userId: string | undefined,
  agentId: string,
  file: BugReportScreenshotFile | undefined,
  deps: BugReportScreenshotDeps = {}
): Promise<BugReportScreenshotResult> {
  assertReportBugAdmin(userId);
  const screenshot = validateScreenshot(file);
  const exists = await agentExistsForBugReport(agentId, {
    findAgentById: deps.findAgentById,
    findAgentAcrossRuns: deps.findAgentAcrossRuns,
  });
  if (!exists) {
    throw new ReportBugNotFoundError();
  }

  const store = deps.store ?? processUploadedFile;
  const sign = deps.sign ?? getSignedUrl;
  const pointer = await store(
    userId,
    screenshot.buffer,
    screenshot.originalname,
    screenshot.mimetype
  );
  const url = await sign(pointer.storage_path, BUG_REPORT_SCREENSHOT_URL_TTL_SECONDS);
  log.info('Stored bug report screenshot', {
    rose_agent_id: agentId,
    size_bytes: pointer.size_bytes,
  });
  return {
    success: true,
    name: pointer.original_filename,
    url,
    expires_in: BUG_REPORT_SCREENSHOT_URL_TTL_SECONDS,
  };
}
