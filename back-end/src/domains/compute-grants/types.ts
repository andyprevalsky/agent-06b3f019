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
