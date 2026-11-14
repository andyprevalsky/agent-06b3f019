import { type CardProvider } from '../../providers/card-provider';
import { AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS, AGENTCARD_COMPANY_FLOW_RETRY_MS } from './config';
import { companyFundingInProgressDetails, PurchaseError } from './errors';
import { archivePurchaseBoundary } from './archive';
import { confirmPurchaseWalletCollection } from './walletFunding';
import type { WalletFundingProvider } from '../../providers/wallet-funding';
import type { MintPurchaseInput, PurchaseSpend } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fundingPendingError(retryMs: number, transferId?: string): PurchaseError {
  return new PurchaseError(
    'AgentCard company funding is still in progress; retry this purchase shortly',
    409,
    'agentcard_company_funding_in_progress',
    {
      retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
      ...(transferId !== undefined ? { transferId } : {}),
    }
  );
}

async function mintBeforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  retryMs: number,
  transferId?: string
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw fundingPendingError(retryMs, transferId);

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(fundingPendingError(retryMs, transferId)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Mint the company-funded single-use card, retrying while AgentCard reports the backing company
 * transfer is still settling. Confirms + archives each newly-observed transfer, and gives up with a
 * typed 409 once the max-wait deadline passes so the caller can ask the agent to retry shortly.
 */
export async function mintCompanyFlowCard(
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  cardProvider: CardProvider,
  walletFundingProvider: WalletFundingProvider,
  initialProviderTransferId?: string
) {
  const cardRequest = {
    amountCents: input.totalCents,
    idempotencyKey: `purchase:${purchase.id}`,
    fundsSource: 'company_flow' as const,
    expectedLivemode: purchase.stripeLivemode,
  };
  const deadline = Date.now() + AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS;
  let confirmedTransferId = initialProviderTransferId;

  for (;;) {
    try {
      return {
        cardRequest,
        // The MCP SDK's own timeout is as long as the old HTTP caller timeout. Bound the complete
        // backend operation here so the typed retry response always has transport headroom. The
        // provider request may finish after this boundary; replaying this exact idempotency key is
        // therefore mandatory and safe.
        minted: await mintBeforeDeadline(
          cardProvider.mintCard(cardRequest),
          deadline,
          AGENTCARD_COMPANY_FLOW_RETRY_MS,
          confirmedTransferId
        ),
        providerTransferId: confirmedTransferId,
      };
    } catch (error) {
      const funding = companyFundingInProgressDetails(error);
      if (funding === undefined) throw error;

      if (funding.transferId !== undefined && confirmedTransferId !== funding.transferId) {
        const walletFunding = await confirmPurchaseWalletCollection(
          purchase,
          'usd',
          funding.transferId,
          funding.agentcardResult,
          walletFundingProvider
        );
        confirmedTransferId = funding.transferId;
        await archivePurchaseBoundary(input.agentId, purchase.id, 'agentcard-company-funding', {
          funding_id: walletFunding.id,
          provider_transfer_id: walletFunding.providerTransferId,
          status: walletFunding.status,
        });
      }

      // Honor a provider-requested retry-after as the minimum delay. If it would overshoot this
      // HTTP attempt, return the durable retry state now; the workflow owns the longer retry window
      // and will replay this exact purchase/card key after the provider-requested delay.
      const retryMs =
        funding.retryAfterSeconds !== undefined
          ? Math.max(AGENTCARD_COMPANY_FLOW_RETRY_MS, funding.retryAfterSeconds * 1000)
          : AGENTCARD_COMPANY_FLOW_RETRY_MS;
      if (Date.now() + retryMs >= deadline) {
        throw fundingPendingError(retryMs, funding.transferId ?? confirmedTransferId);
      }
      await sleep(retryMs);
    }
  }
}
