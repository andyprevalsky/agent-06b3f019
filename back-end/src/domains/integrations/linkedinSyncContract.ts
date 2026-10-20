/**
 * LinkedIn export sync: honest phases and account keys (plan row I4).
 *
 *   POST /linkedin/sync {agent_id, account_id?} ──► starting            agent launched, nothing requested
 *   POST /linkedin/sync/phase export_requested ──► export_requested    agent clicked "Request archive"
 *   POST /linkedin/sync/phase waiting_for_export ► waiting_for_export  agent checked: archive not ready yet
 *   POST /linkedin/upload?account_id=          ──► uploading           server counts received request bytes
 *                                              ──► parsing             server counts imported records
 *                                              ──► synced | failed     server, with final counts / lastError
 *   POST /linkedin/sync/phase failed           ──► failed              agent: export expired or failed
 *   export agent ends before uploading         ──► reads failed        (read-time settle, never stored)
 *
 * Only the agent can witness the first two events, so only they (and an agent
 * failure) are accepted from a report; every later phase is written by the
 * server when it actually happens. Each account (LinkedIn member URN or public
 * profile id) is its own Integration row + progress row; `''` is the default
 * account every pre-multi-account sync used.
 */

import { z } from 'zod';
import { InvalidAccountKeyError, MAX_ACCOUNT_ID_LENGTH } from './syncAccountsContract';

export const LINKEDIN_PROVIDER = 'linkedin';

/** Non-terminal phases, in the only order a run may move through them. */
export const LINKEDIN_PHASES = [
  'starting',
  'export_requested',
  'waiting_for_export',
  'uploading',
  'parsing',
] as const;
export type LinkedInPhase = (typeof LINKEDIN_PHASES)[number] | 'synced' | 'failed';

/** Phases an export agent may still be driving (no upload has begun). */
export const AGENT_PHASES: readonly LinkedInPhase[] = [
  'starting',
  'export_requested',
  'waiting_for_export',
];

export const isTerminalLinkedInPhase = (phase: LinkedInPhase): boolean =>
  phase === 'synced' || phase === 'failed';

export const UPLOAD_UNIT = 'bytes';
export const PARSE_UNIT = 'records';

/** One phase the run actually reached, with the counts known when it did. */
export interface LinkedInPhaseEntry {
  phase: LinkedInPhase;
  at: string;
  done?: number | null;
  total?: number | null;
  unit?: string;
  eta_sec?: number | null;
  error?: string;
}

export interface LinkedInImportCounts {
  /** Data rows read per CSV file present in the archive. */
  files: Record<string, number>;
  contacts: number;
  messages: number;
}

/** `config.linkedinSync` on the account's Integration row. */
export interface LinkedInRunState {
  runId: string;
  agentId: string | null;
  phase: LinkedInPhase;
  startedAt: string;
  /** This run created the row (so it holds no earlier import). */
  createdRow: boolean;
  /** Row status before this run began; restored if the run moves to another account. */
  previousStatus: string | null;
  /** When LinkedIn said the archive would be ready (only if it stated one). */
  readyBy: string | null;
  phases: LinkedInPhaseEntry[];
  counts: LinkedInImportCounts | null;
}

export const AGENT_REPORTED_PHASES = ['export_requested', 'waiting_for_export', 'failed'] as const;

/** Body of POST /api/integrations/linkedin/sync/phase (sent by the export agent). */
export const linkedinPhaseReportSchema = z
  .object({
    agent_id: z.string().trim().min(1).max(128),
    phase: z.enum(AGENT_REPORTED_PHASES),
    /** The LinkedIn account the browser is signed into (member URN, profile id or /in/ URL). */
    account_id: z.string().trim().min(1).max(MAX_ACCOUNT_ID_LENGTH).optional(),
    /** Seconds until LinkedIn said the archive is ready; only when LinkedIn states it. */
    eta_sec: z.number().int().nonnegative().max(31_536_000).nullable().optional(),
    error: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.phase === 'failed' && body.error === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'error is required when failed' });
    }
    if (body.phase !== 'failed' && body.error !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'error is only sent with failed' });
    }
  });

export type LinkedInPhaseReport = z.infer<typeof linkedinPhaseReportSchema>;

const PROFILE_URL = /linkedin\.com\/in\/([^/?#\s]+)/i;

/**
 * Storage key of a LinkedIn account: a public profile URL becomes its profile
 * id, ids are case-folded (both URNs and profile ids are case-insensitive), and
 * `default` names the legacy account (`''`).
 */
export function normalizeLinkedInAccountId(raw: string): string {
  const trimmed = raw.trim();
  const fromUrl = PROFILE_URL.exec(trimmed);
  let id = trimmed;
  if (fromUrl !== null) {
    try {
      id = decodeURIComponent(fromUrl[1]);
    } catch {
      throw new InvalidAccountKeyError('Invalid LinkedIn profile URL');
    }
  }
  id = id.toLowerCase();
  if (id.length > MAX_ACCOUNT_ID_LENGTH) {
    throw new InvalidAccountKeyError('Invalid LinkedIn account id');
  }
  return id === 'default' ? '' : id;
}

export const agentRunId = (agentId: string): string => `li-agent-${agentId}`;

/**
 * Prefix of every message externalId a named account imports. Hex keeps it free
 * of LIKE wildcards and separators, so one account's prefix can never match
 * another's. The default account keeps the unprefixed legacy ids, so archives
 * imported before accounts existed still deduplicate.
 */
export function messageIdPrefix(storageAccountId: string): string {
  if (storageAccountId === '') return '';
  return `li:${Buffer.from(storageAccountId, 'utf8').toString('hex')}:`;
}

export const LEGACY_MESSAGE_PREFIX = 'li:';
