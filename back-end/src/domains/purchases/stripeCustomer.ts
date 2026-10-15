/**
 * Stripe customer helpers for the purchases domain — resolving the saved
 * payment method that backs a purchase-card hold. Split from service.ts to keep
 * that file within the max-lines budget.
 */

import { getStripeClientForLivemode } from '../../providers/stripe';
import { PurchaseError } from './errors';

/** Resolve a payment method saved for this customer or its active subscription. */
export async function getCustomerDefaultPaymentMethodId(
  customerId: string,
  subscriptionId?: string,
  livemode = false
): Promise<string> {
  const stripe = getStripeClientForLivemode(livemode);
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

  // Hosted subscription Checkout saves the card on the Subscription, while the
  // Customer's invoice default can remain empty. The same customer owns both.
  if (subscriptionId !== undefined && subscriptionId.trim() !== '') {
    let subscription: Awaited<ReturnType<typeof stripe.subscriptions.retrieve>> | undefined;
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'resource_missing'
      ) {
        subscription = undefined;
      } else {
        throw error;
      }
    }
    if (subscription !== undefined) {
      const subscriptionCustomerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id;
      const subscriptionMethod = subscription.default_payment_method;
      if (
        subscriptionCustomerId === customerId &&
        (subscription.status === 'active' || subscription.status === 'trialing')
      ) {
        if (typeof subscriptionMethod === 'string' && subscriptionMethod.trim() !== '') {
          return subscriptionMethod;
        }
        if (
          subscriptionMethod !== null &&
          typeof subscriptionMethod === 'object' &&
          typeof subscriptionMethod.id === 'string' &&
          subscriptionMethod.id.trim() !== ''
        ) {
          return subscriptionMethod.id;
        }
      }
    }
  }

  throw new PurchaseError('User does not have a default Stripe payment method', 402);
}
