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
  /** Last subscription usage observed on this account's token; null until one is measured (unknown). */
  usage: AccountUsageDto | null;
  /** Cooldown on this account's token: it serves nothing until this passes (kept for older clients). */
  rateLimitedUntil: string | null;
  /** The active cooldown and why; null when none is active at read time. */
  cooldown: CooldownDto | null;
  /**
   * Earliest future reset of a spent (100% used) window, else the end of an
   * authoritative cooldown; null when no provider-given reset applies. Never
   * Rose's own backoff.
   */
  nextResetAt: string | null;
}

/** One provider quota window; `usedPct` is 0-100 USED as of `AccountUsageDto.observedAt`. */
export interface UsageWindowDto {
  usedPct: number;
  resetsAt: string | null;
}

export type UsageSourceDto = 'response' | 'rate_limit' | 'usage_endpoint' | 'code_session';
export type UsageStatusDto = 'allowed' | 'allowed_warning' | 'rejected';

export interface AccountUsageDto {
  fiveHour: UsageWindowDto | null;
  sevenDay: UsageWindowDto | null;
  observedAt: string;
  /** Where this observation came from. */
  source: UsageSourceDto;
  /** The provider's unified status at that observation, when it said. */
  status: UsageStatusDto | null;
}

export type CooldownReasonDto =
  'usage_window_5h' | 'usage_window_7d' | 'usage_window' | 'rate_limit' | 'stall' | 'auth';

export interface CooldownDto {
  until: string;
  reason: CooldownReasonDto;
  /** true: the provider supplied this reset; false: Rose's default/stall backoff (not a spent quota). */
  authoritative: boolean;
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
