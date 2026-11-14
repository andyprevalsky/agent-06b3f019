import { agentCardV2Request, AgentCardV2Error, type AgentCardV2Request } from './api-v2';
import { getOrgManagedCardholderId, getV2ConnectedUserId } from './store';
import { orgPollWaitsMs } from './org-poll-schedule';
import * as repo from './repo';
import {
  AgentCardCompanyWalletFundingProvider,
  WalletFundingProviderError,
  type WalletFundingProvider,
  type WalletFundingRequest,
  type WalletFundingResult,
  type WalletFundingCollectionRequest,
  type WalletFundingReclaimRequest,
} from '../wallet-funding';

type ResolveUser = (userId: string) => Promise<string | undefined>;
const TRANSFERS = '/api/v2/company_wallet/transfers/';

/** Retained ownership survives disconnect; only this credential's binding authorizes cleanup. */
export async function getV2WalletOwnerId(
  userId: string,
  deps: Pick<typeof repo, 'findTokenConfig'> = repo,
  clientId: string | undefined = process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim()
): Promise<string | undefined> {
  const scope = clientId?.trim();
  if (!scope) return undefined;
  const config = await deps.findTokenConfig(userId);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  const bindings = (config as Record<string, unknown>).v2Bindings;
  if (
    typeof bindings !== 'object' ||
    bindings === null ||
    Array.isArray(bindings) ||
    !Object.hasOwn(bindings, scope)
  )
    return undefined;
  const id = (bindings as Record<string, unknown>)[scope];
  return typeof id === 'string' && id.trim() !== '' ? id : undefined;
}

function transferPath(id: string): string {
  return `${TRANSFERS}${encodeURIComponent(id)}`;
}

function walletError(error: unknown): never {
  if (error instanceof AgentCardV2Error) {
    throw new WalletFundingProviderError(error.message, error.status, error.code, error.details);
  }
  throw error;
}

function pending(transferId: string): WalletFundingProviderError {
  return new WalletFundingProviderError(
    'AgentCard company transfer release is still pending',
    409,
    'agentcard_company_transfer_release_pending',
    { transferId }
  );
}

function assertOwnedTransfer(
  transfer: Record<string, unknown>,
  request: WalletFundingCollectionRequest | WalletFundingReclaimRequest,
  ownerUserId: string | undefined
): void {
  if (
    !Number.isSafeInteger(request.amountCents) ||
    request.amountCents <= 0 ||
    !ownerUserId ||
    transfer.id !== request.providerTransferId ||
    transfer.user_id !== ownerUserId ||
    transfer.amount_cents !== request.amountCents ||
    ('cardId' in request && request.cardId !== undefined && transfer.card_id !== request.cardId)
  ) {
    throw new WalletFundingProviderError(
      'AgentCard transfer does not match the purchase funding owner and intent',
      409,
      'agentcard_company_transfer_owner_mismatch',
      { transferId: request.providerTransferId }
    );
  }
}

function result(
  request: WalletFundingCollectionRequest | WalletFundingReclaimRequest,
  transfer: Record<string, unknown>,
  status: string
): WalletFundingResult {
  return {
    providerTransferId: request.providerTransferId,
    metadata: {
      provider: 'agentcard',
      funding_model: 'company_flow_v2',
      api_version: 'v2',
      purchase_id: request.purchaseId,
      user_id: request.userId,
      agentcard_user_id: transfer.user_id,
      transfer_id: request.providerTransferId,
      amount_cents: request.amountCents,
      currency: request.currency,
      status,
      agentcard_transfer: transfer,
    },
  };
}

/** Company REST wallet rail. Card creation owns funding; this rail never creates another card. */
export class AgentCardV2WalletFundingProvider implements WalletFundingProvider {
  constructor(
    private readonly api: AgentCardV2Request = agentCardV2Request,
    private readonly resolveUser: ResolveUser = getV2WalletOwnerId,
    private readonly retry = { attempts: 20, delayMs: 3_000 },
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now
  ) {}

  async fundUserWallet(_request: WalletFundingRequest): Promise<WalletFundingResult> {
    return {
      metadata: {
        provider: 'agentcard',
        funding_model: 'company_flow_v2',
        api_version: 'v2',
        status: 'awaiting_create_card_transfer',
      },
    };
  }

  async confirmCollection(request: WalletFundingCollectionRequest): Promise<WalletFundingResult> {
    try {
      const userId = await this.resolveUser(request.userId);
      const transfer = await this.api('GET', transferPath(request.providerTransferId));
      assertOwnedTransfer(transfer, request, userId);
      const confirmed = await this.api(
        'POST',
        `${transferPath(request.providerTransferId)}/collection`,
        { outcome: request.outcome },
        request.idempotencyKey
      );
      assertOwnedTransfer(confirmed, request, userId);
      const confirmedResult = result(
        request,
        confirmed,
        request.outcome === 'succeeded' ? 'collection_confirmed' : 'collection_failed'
      );
      return {
        ...confirmedResult,
        metadata: { ...confirmedResult.metadata, outcome: request.outcome },
      };
    } catch (error) {
      return walletError(error);
    }
  }

  async reclaimUserWalletFunding(
    request: WalletFundingReclaimRequest
  ): Promise<WalletFundingResult> {
    if (!request.providerTransferId) {
      throw new WalletFundingProviderError(
        'AgentCard company transfer id is required to confirm funding release',
        409,
        'agentcard_company_transfer_missing'
      );
    }
    try {
      const userId = await this.resolveUser(request.userId);
      const waits = orgPollWaitsMs(this.retry.attempts, this.retry.delayMs);
      // Shared by all reads in this observation window; no per-poll retry budget multiplication.
      const deadlineAtMs = this.now() + 30_000;
      let recoveryRequested = false;
      for (let attempt = 0; attempt <= waits.length; attempt += 1) {
        if (this.now() >= deadlineAtMs) throw pending(request.providerTransferId);
        let transfer: Record<string, unknown> | undefined;
        try {
          transfer = await this.api(
            'GET',
            transferPath(request.providerTransferId),
            undefined,
            undefined,
            deadlineAtMs
          );
        } catch (error) {
          if (
            this.now() >= deadlineAtMs &&
            error instanceof DOMException &&
            (error.name === 'TimeoutError' || error.name === 'AbortError')
          )
            throw pending(request.providerTransferId);
          if (
            !(error instanceof AgentCardV2Error) ||
            !(error.status === 429 || (error.status === 404 && error.code === 'transfer_not_found'))
          )
            throw error;
        }
        if (transfer) {
          assertOwnedTransfer(transfer, request, userId);
          const released = transfer.released_cents;
          if (
            transfer.status === 'reclaimed' &&
            typeof released === 'number' &&
            Number.isSafeInteger(released) &&
            released >= request.amountCents
          ) {
            return result(request, transfer, 'release_confirmed');
          }
          // Consumed alone only means the card holds the funds. A terminal partial release
          // proves the full unused amount did not return; never invent a full refund.
          if (
            transfer.status === 'reclaimed' &&
            typeof released === 'number' &&
            Number.isSafeInteger(released) &&
            released >= 0 &&
            released < request.amountCents
          ) {
            throw new WalletFundingProviderError(
              'AgentCard transfer was only partially released',
              409,
              'agentcard_company_transfer_consumed_during_reclaim',
              { transferId: request.providerTransferId, releasedCents: released }
            );
          }
          if (
            !recoveryRequested &&
            attempt < waits.length &&
            request.cardId &&
            request.idempotencyKey.trim() &&
            transfer.status === 'consumed' &&
            transfer.transferred_cents === request.amountCents &&
            released === 0 &&
            Number.isSafeInteger(request.amountCents) &&
            request.amountCents > 0
          ) {
            recoveryRequested = true;
            try {
              // Explicit amount prevents sweeping this user's unrelated card residual. The
              // transfer's user_id is authoritative; cardholder ids are never v2 user ids.
              await this.api(
                'POST',
                '/api/v2/company_wallet/recoveries',
                { user_id: transfer.user_id, amount_cents: request.amountCents },
                `${request.idempotencyKey}:recovery:${request.providerTransferId}`,
                deadlineAtMs
              );
            } catch (error) {
              if (
                !(error instanceof AgentCardV2Error) ||
                ![
                  'nothing_to_recover',
                  'insufficient_funds_to_recover',
                  'balance_unavailable',
                ].includes(error.code)
              )
                throw error;
            }
            // Even completed recovery is not evidence this transfer released. Read it again.
          }
        }
        if (attempt < waits.length) {
          const remainingMs = deadlineAtMs - this.now();
          if (remainingMs <= 0) throw pending(request.providerTransferId);
          await this.sleep(Math.min(waits[attempt], remainingMs));
        }
      }
      throw pending(request.providerTransferId);
    } catch (error) {
      return walletError(error);
    }
  }
}

/** Keep the legacy recovery semantics and constructor; replace only its bounded-history read. */
function createExactLegacy(api: AgentCardV2Request): WalletFundingProvider {
  class LegacyWalletWithExactTransfer extends AgentCardCompanyWalletFundingProvider {
    constructor(private readonly api: AgentCardV2Request) {
      super();
    }
    protected async readTransfer(id: string, deadline: number): Promise<Record<string, unknown>> {
      try {
        return await this.api('GET', transferPath(id), undefined, undefined, deadline);
      } catch (error) {
        return walletError(error);
      }
    }
  }
  return new LegacyWalletWithExactTransfer(api);
}

/** Resolve per intent, so connecting v2 cannot re-fund or strand an older legacy transfer. */
export class AgentCardWalletFundingRouter implements WalletFundingProvider {
  constructor(
    private readonly api: AgentCardV2Request = agentCardV2Request,
    private readonly resolveUser: ResolveUser = getV2ConnectedUserId,
    private readonly legacy: WalletFundingProvider = new AgentCardCompanyWalletFundingProvider(),
    private readonly v2: WalletFundingProvider = new AgentCardV2WalletFundingProvider(api),
    private readonly exactLegacy: WalletFundingProvider = createExactLegacy(api),
    private readonly resolveLegacyCardholder: ResolveUser = getOrgManagedCardholderId,
    private readonly resolveOwner: ResolveUser = getV2WalletOwnerId
  ) {}

  async fundUserWallet(request: WalletFundingRequest): Promise<WalletFundingResult> {
    return ((await this.resolveUser(request.userId)) ? this.v2 : this.legacy).fundUserWallet(
      request
    );
  }

  private async provider(
    request: WalletFundingCollectionRequest | WalletFundingReclaimRequest
  ): Promise<WalletFundingProvider> {
    if (!request.providerTransferId) return this.legacy;
    let transfer: Record<string, unknown>;
    try {
      transfer = await this.api('GET', transferPath(request.providerTransferId));
    } catch (error) {
      // These are migration boundaries, not outage fallbacks. A legacy MCP transfer may predate
      // the REST rail, and legacy-only installations have no platform credentials yet.
      if (
        error instanceof AgentCardV2Error &&
        ((error.code === 'agentcard_setup_required' &&
          !(await this.resolveOwner(request.userId))) ||
          (error.status === 404 && error.code === 'transfer_not_found'))
      )
        return this.legacy;
      return walletError(error);
    }
    if (transfer.id !== request.providerTransferId) {
      throw new WalletFundingProviderError(
        'AgentCard returned a different transfer',
        502,
        'agentcard_company_transfer_owner_mismatch'
      );
    }
    if (transfer.user_id === null) return this.exactLegacy;
    const ownerUserId = await this.resolveOwner(request.userId);
    // A migrated user can still own an old transfer. An exact legacy cardholder match is
    // positive legacy identity evidence; neither id prefixes nor the new enrollment decide it.
    if (
      transfer.user_id !== ownerUserId &&
      typeof transfer.cardholder_id === 'string' &&
      transfer.cardholder_id === (await this.resolveLegacyCardholder(request.userId))
    ) {
      return this.exactLegacy;
    }
    assertOwnedTransfer(transfer, request, ownerUserId);
    return this.v2;
  }

  async confirmCollection(request: WalletFundingCollectionRequest): Promise<WalletFundingResult> {
    return (await this.provider(request)).confirmCollection(request);
  }
  async reclaimUserWalletFunding(
    request: WalletFundingReclaimRequest
  ): Promise<WalletFundingResult> {
    return (await this.provider(request)).reclaimUserWalletFunding(request);
  }
}
