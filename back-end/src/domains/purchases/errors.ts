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

type AgentCardProviderErrorFields = {
  message: string;
  status?: number;
  code?: string;
  details: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function agentCardProviderErrorFields(error: unknown): AgentCardProviderErrorFields | undefined {
  if (error instanceof AgentCardProviderError) {
    return {
      message: error.message,
      status: error.status,
      code: error.code,
      details: error.details,
    };
  }

  const candidate = asRecord(error);
  if (candidate === undefined) return undefined;
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  const isAgentCardError =
    candidate.name === 'AgentCardProviderError' ||
    (code !== undefined && code.startsWith('agentcard_'));
  if (!isAgentCardError) return undefined;

  const status = candidate.status;
  const details = asRecord(candidate.details);
  return {
    message: typeof candidate.message === 'string' ? candidate.message : String(error),
    ...(typeof status === 'number' && Number.isFinite(status) ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    details: details ?? {},
  };
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
  const agentCardError = agentCardProviderErrorFields(error);
  if (agentCardError !== undefined) {
    const statusCode =
      agentCardError.status !== undefined &&
      agentCardError.status >= 400 &&
      agentCardError.status < 500
        ? agentCardError.status
        : 502;
    return new PurchaseError(
      agentCardError.message,
      statusCode,
      agentCardError.code,
      agentCardError.details
    );
  }
  if (error instanceof WalletFundingProviderError) {
    const statusCode = error.status >= 400 && error.status < 500 ? error.status : 502;
    return new PurchaseError(error.message, statusCode, error.code, error.details);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Extract the in-progress company-funding details from an AgentCard error, or `undefined` when the
 * error is not a retryable `agentcard_company_funding_in_progress` signal. Older provider responses
 * included a transfer id immediately; production can also return only retry timing while the
 * transfer/card is still materializing.
 */
export function companyFundingInProgressDetails(error: unknown):
  | {
      transferId?: string;
      retryAfterSeconds?: number;
      agentcardResult?: Record<string, unknown>;
    }
  | undefined {
  const agentCardError = agentCardProviderErrorFields(error);
  if (agentCardError === undefined) return undefined;
  if (agentCardError.code !== 'agentcard_company_funding_in_progress') return undefined;
  const details = agentCardError.details;
  const rawTransferId = details.transferId;
  const transferId =
    typeof rawTransferId === 'string' && rawTransferId.trim() !== ''
      ? rawTransferId.trim()
      : undefined;
  const retryAfterSeconds = details.retryAfterSeconds;
  const hasRetryAfter = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds);
  if (transferId === undefined && !hasRetryAfter) return undefined;
  const agentcardResult = details.agentcardResult;
  return {
    ...(transferId !== undefined ? { transferId } : {}),
    ...(hasRetryAfter ? { retryAfterSeconds } : {}),
    ...(typeof agentcardResult === 'object' && agentcardResult !== null
      ? { agentcardResult: agentcardResult as Record<string, unknown> }
      : {}),
  };
}
