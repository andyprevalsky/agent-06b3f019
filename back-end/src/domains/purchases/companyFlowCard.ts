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

/**
 * Mint the company-funded single-use card, retrying while AgentCard reports the backing company
 * transfer is still settling. Confirms + archives each newly-observed transfer, and gives up with a
 * typed 409 once the max-wait deadline passes so the caller can ask the agent to retry shortly.
 */
export async function mintCompanyFlowCard(
  purchase: PurchaseSpend,
  input: MintPurchaseInput,
  cardProvider: CardProvider,
  walletFundingProvider: WalletFundingProvider
) {
  const cardRequest = {
    amountCents: input.totalCents,
    idempotencyKey: `purchase:${purchase.id}`,
    fundsSource: 'company_flow' as const,
  };
  const deadline = Date.now() + AGENTCARD_COMPANY_FLOW_MAX_WAIT_MS;
  let confirmedTransferId: string | undefined;

  for (;;) {
    try {
      return {
        cardRequest,
        minted: await cardProvider.mintCard(cardRequest),
        providerTransferId: confirmedTransferId,
      };
    } catch (error) {
      const funding = companyFundingInProgressDetails(error);
      if (funding === undefined) throw error;

      if (confirmedTransferId !== funding.transferId) {
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

      // Honor a provider-requested retry-after as the MINIMUM delay (never shorten it below the
      // default interval, which would hammer/throttle AgentCard). If we cannot wait that long
      // within the remaining deadline, give up now with the typed 409 instead of over-sleeping.
      const retryMs =
        funding.retryAfterSeconds !== undefined
          ? Math.max(AGENTCARD_COMPANY_FLOW_RETRY_MS, funding.retryAfterSeconds * 1000)
          : AGENTCARD_COMPANY_FLOW_RETRY_MS;
      if (Date.now() + retryMs >= deadline) {
        throw new PurchaseError(
          'AgentCard company funding is still in progress; retry this purchase shortly',
          409,
          'agentcard_company_funding_in_progress',
          { transferId: funding.transferId }
        );
      }
      await sleep(retryMs);
    }
  }
}
