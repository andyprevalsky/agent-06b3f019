import { AgentCardProviderError } from '../../providers/card-provider';
import { WalletFundingProviderError } from '../../providers/wallet-funding';

/** Canonical error for the purchases domain. `statusCode` is surfaced directly by the routes. */
export class PurchaseError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code?: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

function isStripeMissingCustomerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    param?: unknown;
    message?: unknown;
    raw?: { code?: unknown; param?: unknown };
  };
  const code = typeof candidate.code === 'string' ? candidate.code : candidate.raw?.code;
  const param = typeof candidate.param === 'string' ? candidate.param : candidate.raw?.param;
  return (
    (code === 'resource_missing' && param === 'customer') ||
    (typeof candidate.message === 'string' && candidate.message.includes('No such customer'))
  );
}

/** Map any thrown value onto the typed purchase-boundary error surfaced to callers. */
export function toPurchaseBoundaryError(error: unknown): Error {
  if (error instanceof PurchaseError) return error;
  if (isStripeMissingCustomerError(error)) {
    return new PurchaseError(
      'Stored Stripe billing customer does not exist for the current Stripe environment',
      402
    );
  }
  if (error instanceof AgentCardProviderError) {
    const statusCode =
      error.status !== undefined && error.status >= 400 && error.status < 500 ? error.status : 502;
    return new PurchaseError(error.message, statusCode, error.code, error.details);
  }
  if (error instanceof WalletFundingProviderError) {
    const statusCode = error.status >= 400 && error.status < 500 ? error.status : 502;
    return new PurchaseError(error.message, statusCode, error.code, error.details);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Extract the in-progress company-funding transfer details from an AgentCard error, or `undefined`
 * when the error is not a `agentcard_company_funding_in_progress` signal with a usable transfer id.
 */
export function companyFundingInProgressDetails(error: unknown):
  | {
      transferId: string;
      retryAfterSeconds?: number;
      agentcardResult?: Record<string, unknown>;
    }
  | undefined {
  if (!(error instanceof AgentCardProviderError)) return undefined;
  if (error.code !== 'agentcard_company_funding_in_progress') return undefined;
  const details = error.details ?? {};
  const transferId = details.transferId;
  if (typeof transferId !== 'string' || transferId.trim() === '') return undefined;
  const retryAfterSeconds = details.retryAfterSeconds;
  const agentcardResult = details.agentcardResult;
  return {
    transferId,
    ...(typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
      ? { retryAfterSeconds }
      : {}),
    ...(typeof agentcardResult === 'object' && agentcardResult !== null
      ? { agentcardResult: agentcardResult as Record<string, unknown> }
      : {}),
  };
}
