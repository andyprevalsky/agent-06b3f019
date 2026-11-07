/**
 * Shared types for the compute-grants domain.
 *
 * The FE only ever sees CONNECTIONS, never grants: token churn is an
 * implementation detail, and surfacing it would train users to react to
 * something the system already heals by itself.
 */

import { z } from 'zod';

/** What the FE chip renders. Mirrors the Gmail account-chip model. */
export interface ConnectedAccountDto {
  provider: string;
  accountId: string;
  accountEmail: string | null;
  /** "connected" | "needs_reconnect" -- the only user-actionable state. */
  state: string;
  /** Populated only when state is needs_reconnect, for the tooltip. */
  lastErrorReason: string | null;
  connectedAt: string;
  /** Last subscription usage an agent observed on this account's token; null until one is used. */
  usage: AccountUsageDto | null;
  /** Provider cooldown on this account's token: it serves nothing until this passes. */
  rateLimitedUntil: string | null;
}

/** One provider quota window; `usedPct` is 0-100 as of `AccountUsageDto.observedAt`. */
export interface UsageWindowDto {
  usedPct: number;
  resetsAt: string | null;
}

export interface AccountUsageDto {
  fiveHour: UsageWindowDto | null;
  sevenDay: UsageWindowDto | null;
  observedAt: string;
}

export interface ListConnectionsResponse {
  accounts: ConnectedAccountDto[];
}

/**
 * Validation for POST /api/compute-accounts.
 *
 * `session` carries the account cookies that let the cloud mint unattended. It
 * is optional so an account can be listed before a session is captured, but
 * without it the connection cannot self-heal -- `connectionCanMint` reports that
 * honestly rather than the system appearing healthy until the first failure.
 */
export const connectAccountSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  accountId: z.string().min(1),
  accountEmail: z.string().email().optional(),
  session: z.string().min(1).optional(),
  sessionExpiresAt: z.coerce.date().optional(),
});

export type ConnectAccountInput = z.infer<typeof connectAccountSchema>;
