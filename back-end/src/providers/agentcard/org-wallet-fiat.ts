/** Demand-driven Brex-to-Coinbase funding, currently hard-disabled in production. */
import { createLogger } from '../logger';
import { createBrexTreasury, loadBrexConfig } from '../brex/treasury';
import type { CoinbaseTreasury } from '../coinbase/treasury';
import type { OrgWalletTopUpStore } from './org-wallet-topup';

const log = createLogger('AgentCardOrgWalletTopUp');

export interface FiatSource {
  /** Cents already wired to Coinbase but not yet settled. */
  pendingToCoinbaseCents(): Promise<number>;
  /** Wire `cents` from Brex to Coinbase. Returns the Brex transfer id. */
  wireToCoinbase(params: {
    cents: number;
    idempotencyKey: string;
  }): Promise<{ transferId: string }>;
}

export interface FiatDependencies {
  treasury: CoinbaseTreasury;
  store: OrgWalletTopUpStore;
  alert: (message: string) => Promise<void>;
  fiatSource?: FiatSource;
}

/**
 * Money already on its way to the org wallet.
 *
 * Two observable components, both read from the providers rather than an internal ledger so a
 * process restart cannot lose track of in-flight money:
 *  - Brex transfers to Coinbase that have not settled
 *  - USD sitting in Coinbase awaiting conversion (it arrived, but cannot be sent as USDC yet)
 *
 * A read failure must halt this evaluation. Zero would look like permission for a duplicate wire.
 */
export async function resolveInFlight(
  deps: FiatDependencies
): Promise<{ inFlightCents: number; strandedUsdCents: number }> {
  const [pending, unconverted] = await Promise.all([
    deps.fiatSource?.pendingToCoinbaseCents() ?? Promise.resolve(0),
    deps.fiatSource === undefined ? Promise.resolve(0) : deps.treasury.getUsdBalanceCents(),
  ]);
  if (
    !Number.isSafeInteger(pending) ||
    pending < 0 ||
    !Number.isSafeInteger(unconverted) ||
    unconverted < 0
  ) {
    throw new Error('Invalid in-flight treasury balance');
  }
  return {
    // ONLY wires still settling count as inbound. Unconverted USD deliberately does NOT:
    // USD -> USDC is not automatable on this account (see coinbase/treasury.ts), so that cash is
    // NOT on its way — it is stuck until a human converts it. Counting it as inbound made
    // `planOrgWalletTopUp` return `covered_by_inflight` on every mint once the stranded balance
    // exceeded the gap, which silently stopped the rail with no alert while the float stayed dry.
    // A $490 balance sat exactly like that for two weeks.
    inFlightCents: Math.max(0, pending),
    strandedUsdCents: Math.max(0, unconverted),
  };
}

/**
 * Wire the part of the gap the USDC float could not cover.
 *
 * Never throws: the USDC leg has already moved money, and a bank failure must not turn a partial
 * success into a caller-visible error. It alerts instead, which is the actionable outcome.
 */
export async function topUpFiatShortfall(
  deps: FiatDependencies,
  shortfallCents: number
): Promise<void> {
  if (deps.fiatSource === undefined || shortfallCents <= 0) return;
  const result = await wireFiat(deps, shortfallCents, 'to finish refilling').catch(
    (error: unknown) => ({
      status: 'halted' as const,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  if (result.status === 'halted') {
    // A failed remainder wire leaves the pool under-funded. Logging alone is invisible, so this
    // alerts like every other money-path failure rather than only appearing in a log search.
    await deps
      .alert(
        `Rose could NOT wire the $${(shortfallCents / 100).toFixed(2)} remainder from Brex after a ` +
          `partial top-up: ${result.error}. The AgentCard org wallet is still under target.`
      )
      .catch(() => undefined);
  }
}

/**
 * Wire fiat under a single-flight claim, using the claim id as the Brex idempotency key.
 *
 * `inFlightCents` alone cannot protect this: it is an ESTIMATE read from providers, so it can be
 * stale, mis-paged, or simply not yet reflect a wire sent seconds ago. Two concurrent issuances
 * would each compute the same shortfall and each wire it. The claim makes that impossible, and
 * keying Brex off the claim id makes even a retry of the same claim provider-deduplicated.
 */
export async function wireFiat(
  deps: FiatDependencies,
  cents: number,
  phrase: string
): Promise<
  | { status: 'wired'; transferId: string }
  | { status: 'contended' }
  | { status: 'halted'; error: string }
> {
  if (deps.fiatSource === undefined) return { status: 'halted', error: 'no fiat source' };
  const claim = await deps.store.claimFiatPull({ wireCents: cents });
  if (!claim.claimed) {
    log.info('Fiat pull already claimed; skipping to avoid a duplicate wire', {
      held_since: claim.heldSince?.toISOString(),
      wire_cents: cents,
    });
    return { status: 'contended' };
  }
  if (!claim.claimId) {
    await deps.store.releaseFiatClaim();
    return { status: 'halted', error: 'Fiat claim has no idempotency key' };
  }
  let transferId: string;
  try {
    ({ transferId } = await deps.fiatSource.wireToCoinbase({
      cents,
      // Claim-derived, NOT random: a fresh uuid per attempt defeats Brex's own dedup.
      idempotencyKey: claim.claimId,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only release when the wire definitively did NOT go out. `possiblySent` means Brex may have
    // accepted it, so the claim is RETAINED and the rail halts rather than wiring again.
    if ((error as { possiblySent?: boolean }).possiblySent === true) {
      log.error('Fiat wire is AMBIGUOUS; retaining the claim to prevent a duplicate', {
        wire_cents: cents,
        error: message,
      });
    } else {
      await deps.store.releaseFiatClaim().catch(() => undefined);
    }
    return { status: 'halted', error: message };
  }
  // Once Brex returns an id, no later failure may release the claim. A DB error or SMS outage
  // cannot prove the wire was rejected, and a fresh claim would permit a second bank transfer.
  try {
    await deps.store.recordFiatSuccess({ transferId, wireCents: cents });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Brex wire accepted but ledger write failed; retaining fiat claim', {
      wire_cents: cents,
      transfer_id: transferId,
      error: message,
    });
    return {
      status: 'halted',
      error: `Brex transfer ${transferId} accepted; ledger write failed: ${message}`,
    };
  }
  log.info('Wired fiat from Brex to Coinbase', { wire_cents: cents, transfer_id: transferId });
  await deps
    .alert(
      `Rose wired $${(cents / 100).toFixed(2)} from Brex to Coinbase ${phrase} the AgentCard org ` +
        `wallet (transfer ${transferId}). It arrives as USD — convert it to USDC at ` +
        `https://www.coinbase.com/assets so the top-up can complete.`
    )
    .catch((error: unknown) => {
      log.error('Brex wire succeeded but operator alert failed', {
        transfer_id: transferId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return { status: 'wired', transferId };
}

/**
 * Bind the Brex fiat leg only after its hard kill is deliberately removed.
 *
 * While the kill remains, the top-up keeps its alert-only behaviour on a dry float.
 */
/**
 * Independent kill switch for the BANK leg.
 *
 * The USDC leg (Coinbase -> org wallet) keeps its own flag, so fiat pulls can be disabled without
 * disabling top-ups from float we already hold. Exported so the disabled-by-default contract is
 * directly testable rather than only reachable through a live Brex client.
 */
export function fiatPullEnabled(): boolean {
  // Main hard-disabled Brex→Coinbase on 2026-08-24 after broken transfers burned cash. The
  // demand-driven path must share that kill; an environment flag alone cannot re-arm bank wires.
  return false;
}

export function resolveFiatSource(): { fiatSource: FiatSource } | undefined {
  if (!fiatPullEnabled()) return undefined;
  const brexConfig = loadBrexConfig();
  if (brexConfig === undefined) return undefined;
  const brex = createBrexTreasury(brexConfig);
  return {
    fiatSource: {
      pendingToCoinbaseCents: () => brex.pendingToCoinbaseCents(),
      wireToCoinbase: ({ cents, idempotencyKey }) =>
        brex.transferToCoinbase({
          cents,
          idempotencyKey,
          description: 'Rose AgentCard org wallet top-up',
        }),
    },
  };
}
