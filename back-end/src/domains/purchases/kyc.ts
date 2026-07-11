import { AgentCardProviderError } from '../../providers/card-provider';
import { PurchaseError } from './errors';

export const KYC_REQUIRED_CODE = 'kyc_required';
const KYC_REQUIRED_MESSAGE = 'Customer requires KYC before Rose can issue a payment card';

function errorText(error: unknown): string {
  if (error instanceof AgentCardProviderError) {
    return `${error.message} ${error.body ?? ''}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function providerErrorStatus(error: unknown): number | undefined {
  if (error instanceof AgentCardProviderError) return error.status;
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status;
  }
  return undefined;
}

export function isKycRequiredError(error: unknown): boolean {
  const status = providerErrorStatus(error);
  if (status !== undefined && ![400, 403, 409, 422].includes(status)) return false;
  const normalized = errorText(error).toLowerCase().replace(/[\s-]+/g, '_');
  return (
    normalized.includes('kyc_required') ||
    normalized.includes('customer_kyc_required') ||
    normalized.includes('customers_needed_kyc') ||
    normalized.includes('customer_needs_kyc') ||
    normalized.includes('cardholder_kyc_required')
  );
}

export function kycRequiredPurchaseError(): PurchaseError {
  return new PurchaseError(KYC_REQUIRED_MESSAGE, 422, KYC_REQUIRED_CODE);
}
