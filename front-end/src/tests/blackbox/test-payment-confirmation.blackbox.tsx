/**
 * Blackbox tests for the test-payment confirmation screen.
 *
 * Regression guard: the confirmation page used to show only the order id + total,
 * which left the agent verifier unable to ground `purchased_items` from the page
 * (it docked the score for "no itemized list on the confirmation page"). The
 * screen now renders the full receipt returned by the backend.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TestPaymentPage, {
  Confirmation,
  ReceiptSummary,
} from '@/features/test-payment/components/TestPaymentPage';
import { LIVE_LIFECYCLE_ITEM, TEST_PAYMENT_MERCHANT_NAME } from '@/features/test-payment/config';
import type { TestPaymentConfirmation } from '@/features/test-payment/types';

const startTestPaymentCheckout = vi.fn().mockResolvedValue({
  url: 'https://checkout.stripe.com/c/pay/cs_test',
});

vi.mock('@/features/test-payment/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/test-payment/hooks')>();
  return {
    ...actual,
    startTestPaymentCheckout: (...args: unknown[]) => startTestPaymentCheckout(...args),
  };
});

const CONFIRMATION: TestPaymentConfirmation = {
  orderId: 'tp_abc12345',
  status: 'succeeded',
  paymentIntentId: 'pi_test_123',
  receipt: {
    lineItems: [
      {
        id: 'aurora-notebook',
        name: 'Aurora Notebook',
        imageUrl: 'https://placehold.co/320x220/png?text=Aurora+Notebook',
        quantity: 1,
        unitPriceCents: 1200,
        lineTotalCents: 1200,
      },
      {
        id: 'ceramic-mug',
        name: 'Ceramic Mug',
        imageUrl: 'https://placehold.co/320x220/png?text=Ceramic+Mug',
        quantity: 1,
        unitPriceCents: 900,
        lineTotalCents: 900,
      },
      {
        id: 'canvas-tote',
        name: 'Canvas Tote',
        imageUrl: 'https://placehold.co/320x220/png?text=Canvas+Tote',
        quantity: 1,
        unitPriceCents: 1500,
        lineTotalCents: 1500,
      },
    ],
    totals: {
      subtotalCents: 3600,
      taxCents: 297,
      shippingCents: 499,
      totalCents: 4396,
    },
  },
};

describe('test-payment Confirmation receipt', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
    startTestPaymentCheckout.mockClear();
    startTestPaymentCheckout.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/pay/cs_test',
    });
  });

  it('shows a stable pre-submit checkout reference', () => {
    render(
      <ReceiptSummary
        items={CONFIRMATION.receipt.lineItems.map((line) => ({
          id: line.id,
          name: line.name,
          description: `${line.name} description`,
          imageUrl: line.imageUrl,
          priceCents: line.unitPriceCents,
        }))}
        selectedIds={CONFIRMATION.receipt.lineItems.map((line) => line.id)}
      />,
    );
    expect(screen.getByTestId('test-payment-checkout-reference')).toHaveTextContent('TP-CART-4396');
  });

  it('renders the bounded live lifecycle fixture without tax or shipping', () => {
    render(
      <ReceiptSummary
        items={[LIVE_LIFECYCLE_ITEM]}
        selectedIds={[LIVE_LIFECYCLE_ITEM.id]}
        includeFees={false}
      />,
    );
    expect(screen.getByText('Agent Card Lifecycle Probe x1')).toBeInTheDocument();
    expect(screen.getByTestId('test-payment-checkout-reference')).toHaveTextContent('TP-CART-100');
    expect(screen.queryByText('Tax')).not.toBeInTheDocument();
    expect(screen.queryByText('Shipping')).not.toBeInTheDocument();
  });

  it('keeps live Place order enabled without a merchant-form card number', () => {
    window.history.replaceState({}, '', '/test_payment?benchmark=agentcard-live-lifecycle');
    render(<TestPaymentPage />);

    expect(screen.getByRole('heading', { name: 'Test Payment' })).toBeInTheDocument();
    expect(screen.getByText('Agent Card Lifecycle Probe')).toBeInTheDocument();
    // Live authorization is on Stripe Checkout — gating Place order on this form's PAN left
    // fleet agents clicking a disabled button after only filling #card-name (zero checkout-session).
    expect(screen.getByRole('button', { name: 'Place order $1.00' })).toBeEnabled();
  });

  it('starts hosted checkout without last4 when the merchant card number is empty', async () => {
    window.history.replaceState({}, '', '/test_payment?benchmark=agentcard-live-lifecycle');
    render(<TestPaymentPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Place order $1.00' }));
    await waitFor(() => expect(startTestPaymentCheckout).toHaveBeenCalledTimes(1));
    expect(startTestPaymentCheckout).toHaveBeenCalledWith(['agentcard-lifecycle-probe'], undefined);
  });

  it('sends optional last4 on live Place order when the card number is filled', async () => {
    window.history.replaceState({}, '', '/test_payment?benchmark=agentcard-live-lifecycle');
    render(<TestPaymentPage />);

    fireEvent.change(screen.getByLabelText(/Card number/i), {
      target: { value: '4413696996398945' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Place order $1.00' }));
    await waitFor(() => expect(startTestPaymentCheckout).toHaveBeenCalledTimes(1));
    expect(startTestPaymentCheckout).toHaveBeenCalledWith(['agentcard-lifecycle-probe'], '8945');
  });

  it('issues cards without allowing merchant submission in the abandonment fixture', async () => {
    window.history.replaceState({}, '', '/test_payment?benchmark=agentcard-abandonment');
    render(<TestPaymentPage />);

    const payButton = await screen.findByRole('button', { name: 'Pay $43.96' });
    expect(payButton).toBeEnabled();
    fireEvent.click(payButton);
    expect(screen.getByText('This checkout is unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('payment-confirmation')).not.toBeInTheDocument();
  });

  it('shows the order id and total charged', () => {
    render(<Confirmation confirmation={CONFIRMATION} />);
    expect(screen.getByText(/Order tp_abc12345 was paid successfully/)).toBeInTheDocument();
    expect(screen.getByTestId('payment-confirmation-merchant')).toHaveTextContent(
      `Merchant: ${TEST_PAYMENT_MERCHANT_NAME}`,
    );
    expect(screen.getByTestId('payment-confirmation-total')).toHaveTextContent('$43.96');
  });

  it('keeps the exact merchant identity visible on the confirmation page', () => {
    render(<Confirmation confirmation={CONFIRMATION} />);
    expect(screen.getByTestId('payment-confirmation')).toHaveTextContent(
      `Merchant: ${TEST_PAYMENT_MERCHANT_NAME}`,
    );
  });

  it('renders every purchased item by name so the page is groundable', () => {
    render(<Confirmation confirmation={CONFIRMATION} />);
    const receipt = screen.getByTestId('payment-confirmation-receipt');
    for (const line of CONFIRMATION.receipt.lineItems) {
      expect(receipt).toHaveTextContent(line.name);
    }
    expect(screen.getByTestId('receipt-image-aurora-notebook')).toBeInTheDocument();
    expect(screen.getByTestId('receipt-image-ceramic-mug')).toBeInTheDocument();
    expect(screen.getByTestId('receipt-image-canvas-tote')).toBeInTheDocument();
  });

  it('exposes machine-readable line-item attributes for the verifier', () => {
    render(<Confirmation confirmation={CONFIRMATION} />);
    const aurora = document.querySelector('[data-line-item-id="aurora-notebook"]');
    expect(aurora).not.toBeNull();
    expect(aurora).toHaveAttribute('data-line-item-name', 'Aurora Notebook');
    expect(aurora).toHaveAttribute('data-line-total-cents', '1200');
  });

  it('itemizes the totals breakdown (subtotal, tax, shipping)', () => {
    render(<Confirmation confirmation={CONFIRMATION} />);
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('$36.00')).toBeInTheDocument();
    expect(screen.getByText('Tax')).toBeInTheDocument();
    expect(screen.getByText('$2.97')).toBeInTheDocument();
    expect(screen.getByText('Shipping')).toBeInTheDocument();
    expect(screen.getByText('$4.99')).toBeInTheDocument();
  });
});
