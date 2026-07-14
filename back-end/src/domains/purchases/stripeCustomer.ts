/**
 * Stripe customer helpers for the purchases domain — resolving the saved
 * payment method that backs a purchase-card hold. Split from service.ts to keep
 * that file within the max-lines budget.
 */

import { stripe } from '../../providers/stripe';
import { PurchaseError } from './errors';

/**
 * Resolve the customer's default payment method id, or throw a 402 PurchaseError
 * if the customer is deleted or has no default method on file.
 */
export async function getCustomerDefaultPaymentMethodId(customerId: string): Promise<string> {
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) {
    throw new PurchaseError('Stripe billing customer has been deleted', 402);
  }

  const defaultPaymentMethod = customer.invoice_settings?.default_payment_method;
  if (typeof defaultPaymentMethod === 'string' && defaultPaymentMethod.trim() !== '') {
    return defaultPaymentMethod;
  }
  if (
    defaultPaymentMethod !== null &&
    typeof defaultPaymentMethod === 'object' &&
    'id' in defaultPaymentMethod &&
    typeof defaultPaymentMethod.id === 'string' &&
    defaultPaymentMethod.id.trim() !== ''
  ) {
    return defaultPaymentMethod.id;
  }

  throw new PurchaseError('User does not have a default Stripe payment method', 402);
}
