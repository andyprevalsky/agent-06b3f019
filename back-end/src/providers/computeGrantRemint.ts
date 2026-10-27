/**
 * Re-mint orchestration for compute grants.
 *
 * Closes the loop that starts on the Rose completion path: a live agent uses a
 * grant, the provider says it is revoked, and a replacement is minted from the
 * ACCOUNT CONNECTION so the agent can retry without ever surfacing a failure.
 *
 * DESIGN CONSTRAINTS THAT SHAPE THIS FILE
 * ---------------------------------------
 * - Minting depends ONLY on the account connection, never on the dead grant.
 *   A dead token must never be able to block its own replacement.
 *
 * - SINGLE-FLIGHT PER ACCOUNT, and per account only. When a grant dies, every
 *   in-flight agent on that account fails at roughly the same moment. Minting
 *   once per failure would issue hundreds of grants and hammer the consent
 *   endpoint; a single GLOBAL lock would instead serialise every user in the
 *   system behind one mint. At the 10k-agent design target the key must be the
 *   account, so unrelated users never contend and one account's storm collapses
 *   to exactly one mint.
 *
 * - BOUNDED. A grant that dies immediately after minting (revoked upstream,
 *   subscription lapsed) must not spin. Re-mint is attempted once per call and
 *   the account is cooled down on failure, so the failure surfaces instead of
 *   becoming an infinite mint loop.
 *
 * - The connection, not the grant, is the thing that can truly fail. When
 *   minting fails because the session is dead, the account is marked
 *   `needs_reconnect` -- the only user-visible state in the whole system.
 */

import { classifyComputeGrantFailure } from './computeGrantFailure';

export type AccountConnectionState = 'connected' | 'needs_reconnect';

export interface ComputeGrantRecord {
  grantId: string;
  userId: string;
  provider: 'claude' | 'codex';
  accountId: string;
  accessToken: string;
}

/**
 * Persistence seam. Kept abstract so the orchestrator is testable without a DB
 * and so the storage migration can land independently of this logic.
 */
export interface GrantStore {
  /** Currently-usable grant for an account, if any. */
  getActiveGrant(
    userId: string,
    provider: string,
    accountId: string
  ): Promise<ComputeGrantRecord | null>;
  /** Mark a grant unusable. Must be idempotent. */
  markGrantDead(grantId: string, reason: string): Promise<void>;
  /** Persist a freshly minted grant and make it active. */
  saveGrant(record: Omit<ComputeGrantRecord, 'grantId'>): Promise<ComputeGrantRecord>;
  /** Flip the account connection state (drives the FE chip). */
  setConnectionState(
    userId: string,
    provider: string,
    accountId: string,
    state: AccountConnectionState
  ): Promise<void>;
}

/** Mints a grant from the stored account connection. Never sees a dead token. */
export interface GrantMinter {
  mint(userId: string, provider: string, accountId: string): Promise<{ accessToken: string }>;
}

/** Cross-instance coordination; in-process defaults keep tests DB-free. */
export interface RemintCoordination {
  /** Run `fn` while no other instance re-mints the same account. */
  serialize<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Epoch ms until which the account must not be re-minted, if cooling down. */
  cooldownUntil(key: string): Promise<number | undefined>;
  startCooldown(key: string, until: number, ttlMs: number): Promise<void>;
}

function inProcessCoordination(): RemintCoordination {
  const until = new Map<string, number>();
  return {
    serialize: (_key, fn) => fn(),
    cooldownUntil: async (key) => until.get(key),
    startCooldown: async (key, value) => {
      until.set(key, value);
    },
  };
}

export interface RemintDeps {
  store: GrantStore;
  minter: GrantMinter;
  coordination?: RemintCoordination;
  /** Injectable for tests; never call Date.now() directly here. */
  now?: () => number;
  /** How long to refuse further mints for an account after a mint failure. */
  cooldownMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface RemintOutcome {
  /** A usable token, when recovery succeeded. */
  accessToken?: string;
  /** What happened, for the caller's retry decision and the ledger. */
  status: 'reminted' | 'not_revoked' | 'coalesced' | 'cooldown' | 'needs_reconnect' | 'mint_failed';
  reason: string;
}

const DEFAULT_COOLDOWN_MS = 60_000;

/** Body markers meaning the CONNECTION (not the grant) is what died. */
const CONNECTION_DEAD = /session|cookie|login|consent screen never rendered|not authenticated/i;

export class ComputeGrantReminter {
  private readonly inflight = new Map<string, Promise<RemintOutcome>>();
  private readonly coordination: RemintCoordination;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;

  constructor(private readonly deps: RemintDeps) {
    this.now = deps.now ?? Date.now;
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.log = deps.log ?? (() => {});
    this.coordination = deps.coordination ?? inProcessCoordination();
  }

  /** Keyed per account: unrelated users must never serialise behind each other. */
  private key(userId: string, provider: string, accountId: string): string {
    return `${userId}:${provider}:${accountId}`;
  }

  /**
   * Handle a failed completion. Safe to call on ANY failure -- it classifies
   * first and does nothing unless the grant was genuinely revoked.
   */
  async onCompletionFailure(params: {
    userId: string;
    provider: 'claude' | 'codex';
    accountId: string;
    grantId?: string;
    status: number;
    body?: string;
  }): Promise<RemintOutcome> {
    const verdict = classifyComputeGrantFailure({ status: params.status, body: params.body });
    if (!verdict.shouldRemint) {
      // Covers 429, 402 and unrecognised auth errors. Deliberately the common
      // path: a throttle must never cost a grant.
      return { status: 'not_revoked', reason: verdict.reason };
    }

    const key = this.key(params.userId, params.provider, params.accountId);

    const cooling = await this.cooldownOutcome(key);
    if (cooling !== null) return cooling;

    // Single-flight: every agent that fell over on this grant awaits ONE mint.
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      const shared = await existing;
      return shared.status === 'reminted'
        ? { ...shared, status: 'coalesced', reason: 'joined an in-flight re-mint' }
        : shared;
    }

    const run = this.coordination.serialize(`compute-grant-remint:${key}`, () =>
      this.remintUnlessDone(params, key, verdict.reason)
    );
    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async cooldownOutcome(key: string): Promise<RemintOutcome | null> {
    const until = await this.coordination.cooldownUntil(key);
    if (until === undefined || this.now() >= until) return null;
    return {
      status: 'cooldown',
      reason: `re-mint cooling down for ${Math.ceil((until - this.now()) / 1000)}s after a failed attempt`,
    };
  }

  /**
   * Runs inside the per-account lock. A peer instance that held the lock first
   * may already have replaced the dead grant (or failed and cooled the account
   * down); re-check both before minting again.
   */
  private async remintUnlessDone(
    params: { userId: string; provider: 'claude' | 'codex'; accountId: string; grantId?: string },
    key: string,
    deathReason: string
  ): Promise<RemintOutcome> {
    const cooling = await this.cooldownOutcome(key);
    if (cooling !== null) return cooling;
    if (params.grantId !== undefined) {
      const active = await this.deps.store.getActiveGrant(
        params.userId,
        params.provider,
        params.accountId
      );
      if (active !== null && active.grantId !== params.grantId) {
        return {
          accessToken: active.accessToken,
          status: 'coalesced',
          reason: 'another instance already re-minted this account',
        };
      }
    }
    return this.performRemint(params, key, deathReason);
  }

  private async performRemint(
    params: { userId: string; provider: 'claude' | 'codex'; accountId: string; grantId?: string },
    key: string,
    deathReason: string
  ): Promise<RemintOutcome> {
    if (params.grantId !== undefined) {
      await this.deps.store.markGrantDead(params.grantId, deathReason);
    }
    this.log('compute_grant.revoked', { key, reason: deathReason });

    try {
      // Note: mint takes the ACCOUNT, never the dead grant.
      const minted = await this.deps.minter.mint(params.userId, params.provider, params.accountId);
      const saved = await this.deps.store.saveGrant({
        userId: params.userId,
        provider: params.provider,
        accountId: params.accountId,
        accessToken: minted.accessToken,
      });
      await this.deps.store.setConnectionState(
        params.userId,
        params.provider,
        params.accountId,
        'connected'
      );
      this.log('compute_grant.reminted', { key, grantId: saved.grantId });
      return {
        accessToken: saved.accessToken,
        status: 'reminted',
        reason: 'minted a replacement grant from the account connection',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Cool down regardless of cause: without this, a permanently broken
      // connection turns every agent failure into another mint attempt.
      await this.coordination.startCooldown(key, this.now() + this.cooldownMs, this.cooldownMs);

      if (CONNECTION_DEAD.test(message)) {
        await this.deps.store.setConnectionState(
          params.userId,
          params.provider,
          params.accountId,
          'needs_reconnect'
        );
        this.log('compute_grant.needs_reconnect', { key, error: message });
        return {
          status: 'needs_reconnect',
          reason: `account connection is dead, user must reconnect: ${message}`,
        };
      }

      this.log('compute_grant.mint_failed', { key, error: message });
      return { status: 'mint_failed', reason: `re-mint failed: ${message}` };
    }
  }
}
