import {
  AgentCardOrgRuntimeError,
  callOrgTool,
  orgRetryDeadlineAtMs,
  type AgentCardOrgToolCaller,
} from './agentcard/org-runtime';
import { orgPollWaitsMs } from './agentcard/org-poll-schedule';
import { recoverCardholderFunds } from './agentcard/fund-recovery';
import { getOrgManagedCardholderId } from './agentcard/store';
import { createLogger } from './logger';
import { AgentCardWalletFundingRouter } from './agentcard/wallet-v2';

const log = createLogger('WalletFunding');
const RELEASE_LOOKUP_ATTEMPTS = 20;
const RELEASE_LOOKUP_DELAY_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Organization backpressure that says nothing about one transfer: the provider's throttle, its
 * intermittent org-token 401 on a healthy secret (left after the runtime's read auth-flap window),
 * and a transient 503. Same set as the benchmark float's backpressure classification.
 */
function isOrgReleaseObservationBackpressure(error: unknown): boolean {
  if (
    error instanceof AgentCardOrgRuntimeError &&
    (error.code === 'agentcard_org_mcp_rate_limited' ||
      (error.code === 'agentcard_org_mcp_unauthorized' && error.status === 401) ||
      (error.code === 'agentcard_org_mcp_unavailable' && error.status === 503))
  ) {
    return true;
  }
  // The exact REST reader converts the same backpressure (AgentCardV2Request's final 401
  // `unauthorized`, 429 and default-code 503) into WalletFundingProviderError.
  if (
    error instanceof WalletFundingProviderError &&
    (error.status === 429 ||
      (error.status === 401 && error.code === 'unauthorized') ||
      (error.status === 503 && error.code === 'agentcard_v2_unavailable'))
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /too many requests|rate.?limit|\b429\b/i.test(message);
}

export interface WalletFundingRequest {
  userId: string;
  agentId?: string;
  purchaseId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}

export interface WalletFundingResult {
  providerTransferId?: string;
  metadata?: Record<string, unknown>;
}

export interface WalletFundingCollectionRequest extends WalletFundingRequest {
  providerTransferId: string;
  outcome: 'succeeded' | 'failed';
}

export interface WalletFundingReclaimRequest extends WalletFundingRequest {
  providerTransferId?: string;
  cardId?: string;
  reason: string;
}

export interface WalletFundingProvider {
  /**
   * Legacy hook retained for older call sites. Company-flow funding is now triggered by
   * AgentCard create_card; Rose only confirms collection once AgentCard returns transfer_id.
   */
  fundUserWallet(request: WalletFundingRequest): Promise<WalletFundingResult>;
  confirmCollection(request: WalletFundingCollectionRequest): Promise<WalletFundingResult>;
  reclaimUserWalletFunding(request: WalletFundingReclaimRequest): Promise<WalletFundingResult>;
}

export class WalletFundingProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'agentcard_wallet_funding_failed',
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'WalletFundingProviderError';
  }
}

export function isWalletFundingReleasePendingError(error: unknown): boolean {
  return (
    error instanceof WalletFundingProviderError &&
    error.code === 'agentcard_company_transfer_release_pending'
  );
}

export function isWalletFundingConsumedDuringReclaimError(error: unknown): boolean {
  return (
    error instanceof WalletFundingProviderError &&
    error.code === 'agentcard_company_transfer_consumed_during_reclaim'
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  return {};
}

function resultRecord(result: unknown): Record<string, unknown> {
  const envelope = asRecord(result);
  if (envelope.toolResult !== undefined) return asRecord(envelope.toolResult);
  if (envelope.structuredContent !== undefined) return asRecord(envelope.structuredContent);
  const content = envelope.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => asRecord(part))
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => String(part.text).trim())
      .filter(Boolean)
      .join('\n');
    if (text !== '') {
      try {
        const parsed = JSON.parse(text) as unknown;
        return asRecord(parsed);
      } catch {
        return { message: text };
      }
    }
  }
  return envelope;
}

function assertToolSuccess(toolName: string, result: unknown): Record<string, unknown> {
  const envelope = asRecord(result);
  const record = resultRecord(result);
  const status = record.status;
  const code = record.code ?? record.error;
  if (envelope.isError === true || status === 'error' || status === 'failed') {
    const message =
      typeof record.message === 'string'
        ? record.message
        : `AgentCard company wallet tool ${toolName} failed`;
    throw new WalletFundingProviderError(message, 502, 'agentcard_company_wallet_failed', {
      toolName,
      code,
    });
  }
  return record;
}

function transferMetadata(
  request: WalletFundingCollectionRequest | WalletFundingReclaimRequest,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    provider: 'agentcard',
    purchase_id: request.purchaseId,
    user_id: request.userId,
    amount_cents: request.amountCents,
    currency: request.currency,
    ...(request.agentId !== undefined ? { agent_id: request.agentId } : {}),
    ...(request.providerTransferId !== undefined
      ? { transfer_id: request.providerTransferId }
      : {}),
    ...extra,
  };
}

function maskId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Confirms AgentCard company-wallet collection through Organization MCP.
 *
 * Funds now move as part of AgentCard create_card(company_flow). Rose's responsibility is to
 * confirm that our Stripe hold succeeded for the returned transfer_id. Closing an unused card is
 * still handled by close_card; AgentCard emits transfer.released and keeps unused spending power as
 * headroom for that user.
 */
export class AgentCardCompanyWalletFundingProvider implements WalletFundingProvider {
  constructor(
    private readonly toolCaller: AgentCardOrgToolCaller = callOrgTool,
    private readonly releaseRetry: {
      attempts: number;
      delayMs: number;
    } = {
      attempts: RELEASE_LOOKUP_ATTEMPTS,
      delayMs: RELEASE_LOOKUP_DELAY_MS,
    },
    private readonly resolveCardholderId: (
      userId: string
    ) => Promise<string | undefined> = getOrgManagedCardholderId
  ) {}

  /** Override only the read boundary when an exact REST transfer lookup is available. */
  protected async readTransfer(
    transferId: string,
    retryDeadlineAtMs: number
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.toolCaller('list_transfers', { limit: 100 }, retryDeadlineAtMs);
    const record = assertToolSuccess('list_transfers', result);
    const transfers = Array.isArray(record.transfers) ? record.transfers : [];
    return transfers.map(asRecord).find((value) => value.id === transferId);
  }

  async fundUserWallet(request: WalletFundingRequest): Promise<WalletFundingResult> {
    log.info('Company-flow card creation will trigger AgentCard wallet funding', {
      user_id: maskId(request.userId),
      purchase_id: request.purchaseId,
      amount_cents: request.amountCents,
    });
    return {
      metadata: {
        provider: 'agentcard',
        funding_model: 'company_flow',
        status: 'awaiting_create_card_transfer',
      },
    };
  }

  async confirmCollection(request: WalletFundingCollectionRequest): Promise<WalletFundingResult> {
    log.info('Confirming AgentCard company-wallet collection', {
      user_id: maskId(request.userId),
      purchase_id: request.purchaseId,
      transfer_id: maskId(request.providerTransferId),
      outcome: request.outcome,
    });
    let result: unknown;
    try {
      result = await this.toolCaller('confirm_collection', {
        transfer_id: request.providerTransferId,
        outcome: request.outcome,
      });
    } catch (error) {
      if (error instanceof AgentCardOrgRuntimeError) {
        throw new WalletFundingProviderError(
          error.message,
          error.status,
          error.code,
          error.details
        );
      }
      throw error;
    }
    const record = assertToolSuccess('confirm_collection', result);
    return {
      providerTransferId: request.providerTransferId,
      metadata: transferMetadata(request, {
        status: 'collection_confirmed',
        outcome: request.outcome,
        agentcard_result: record,
      }),
    };
  }

  async reclaimUserWalletFunding(
    request: WalletFundingReclaimRequest
  ): Promise<WalletFundingResult> {
    log.info('Recording AgentCard company-wallet funding release request', {
      user_id: maskId(request.userId),
      purchase_id: request.purchaseId,
      transfer_id:
        request.providerTransferId !== undefined ? maskId(request.providerTransferId) : undefined,
      reason: request.reason,
    });
    if (request.providerTransferId === undefined) {
      throw new WalletFundingProviderError(
        'AgentCard company transfer id is required to confirm funding release',
        409,
        'agentcard_company_transfer_missing'
      );
    }

    // Back off exponentially instead of polling every `delayMs`: the observation window is
    // unchanged (sum of the waits equals the old fixed cadence's total) but it now costs 6
    // organization-MCP requests instead of 20, which keeps this one reclaim from draining the
    // org-wide 120-requests-per-minute window that every other AgentCard caller shares.
    const waits = orgPollWaitsMs(this.releaseRetry.attempts, this.releaseRetry.delayMs);
    const observations = waits.length + 1;
    // ONE rate-limit retry budget for the WHOLE observation window. The org runtime's budget bounds
    // a single `callTool`; re-arming it per observation would let this loop accumulate one budget
    // per read (6 x 30s = 180s) on top of its own ~57s schedule and overrun the caller's timeout.
    const retryDeadlineAtMs = orgRetryDeadlineAtMs();
    let cardholderId: string | undefined;
    let cardholderResolved = false;
    for (let attempt = 1; attempt <= observations; attempt += 1) {
      let transfer: Record<string, unknown> | undefined;
      try {
        transfer = await this.readTransfer(request.providerTransferId, retryDeadlineAtMs);
      } catch (error) {
        // Backpressure skips one observation; persisting it as a failed reclaim would turn a
        // still-pending release (the stalled RECLAIMING lease) into RECLAIM_FAILED.
        if (!isOrgReleaseObservationBackpressure(error)) throw error;
        if (attempt < observations) {
          await delay(waits[attempt - 1]);
          continue;
        }
        break;
      }
      const releasedCents = transfer?.released_cents;
      const status = transfer?.status;
      log.info('Observed AgentCard company-wallet funding release state', {
        purchase_id: request.purchaseId,
        transfer_id: maskId(request.providerTransferId),
        attempt,
        status: typeof status === 'string' ? status : undefined,
        transferred_cents:
          typeof transfer?.transferred_cents === 'number' ? transfer.transferred_cents : undefined,
        released_cents: typeof releasedCents === 'number' ? releasedCents : undefined,
      });
      if (
        typeof releasedCents === 'number' &&
        releasedCents >= request.amountCents &&
        (status === 'reclaimed' || status === 'released')
      ) {
        return {
          providerTransferId: request.providerTransferId,
          metadata: transferMetadata(request, {
            status: 'release_confirmed',
            reason: request.reason,
            release_attempt: attempt,
            agentcard_transfer: transfer,
          }),
        };
      }
      // AgentCard may leave the exact fully funded transfer `consumed` after close until its
      // released cardholder residual is recovered. Treasury-rails exercises this provider path.
      // The recovery is only an accelerator: its yield never substitutes for this transfer's
      // reclaimed/released status, and a partially spent or unrelated card is never swept here.
      if (
        attempt < observations &&
        request.cardId !== undefined &&
        transfer?.card_id === request.cardId &&
        transfer.amount_cents === request.amountCents &&
        transfer.transferred_cents === request.amountCents &&
        releasedCents === 0 &&
        status === 'consumed'
      ) {
        try {
          if (!cardholderResolved) {
            cardholderId = await this.resolveCardholderId(request.userId);
            cardholderResolved = true;
          }
          if (cardholderId !== undefined) {
            await recoverCardholderFunds(cardholderId, (toolName, args) =>
              this.toolCaller(toolName, args, retryDeadlineAtMs)
            );
          }
        } catch (error) {
          log.warn('Could not accelerate AgentCard transfer release through residual recovery', {
            purchase_id: request.purchaseId,
            transfer_id: maskId(request.providerTransferId),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (attempt < observations) await delay(waits[attempt - 1]);
    }

    throw new WalletFundingProviderError(
      'AgentCard company transfer release is still pending',
      409,
      'agentcard_company_transfer_release_pending',
      { transferId: request.providerTransferId }
    );
  }
}

export function createWalletFundingProvider(): WalletFundingProvider {
  return new AgentCardWalletFundingRouter();
}
