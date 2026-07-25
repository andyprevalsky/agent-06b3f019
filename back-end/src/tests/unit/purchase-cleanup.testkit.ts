import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  WalletFundingProviderError,
  type WalletFundingReclaimRequest,
  type WalletFundingResult,
} from '../../providers/wallet-funding';
import { FakeWalletFundingProvider } from '../blackbox/purchases.testkit';

export class ReclaimErrorWalletProvider extends FakeWalletFundingProvider {
  constructor(private readonly error: Error) {
    super();
  }

  async reclaimUserWalletFunding(
    request: WalletFundingReclaimRequest
  ): Promise<WalletFundingResult> {
    this.reclaimCalls.push(request);
    throw this.error;
  }
}

export class ConcurrentlyVoidedWalletProvider extends FakeWalletFundingProvider {
  async reclaimUserWalletFunding(
    request: WalletFundingReclaimRequest
  ): Promise<WalletFundingResult> {
    this.reclaimCalls.push(request);
    await prisma.$transaction([
      prisma.purchaseWalletFunding.update({
        where: { purchaseId: request.purchaseId },
        data: { status: PurchaseWalletFundingStatus.RECLAIMED },
      }),
      prisma.purchaseSpend.update({
        where: { id: request.purchaseId },
        data: { status: PurchaseSpendStatus.VOIDED },
      }),
    ]);
    throw new WalletFundingProviderError(
      'stale concurrent reclaim result',
      409,
      'agentcard_company_transfer_consumed_during_reclaim'
    );
  }
}
