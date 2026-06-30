/**
 * Blackbox tests for the test-payment confirmation screen.
 *
 * Regression guard: the confirmation page used to show only the order id + total,
 * which left the agent verifier unable to ground `purchased_items` from the page
 * (it docked the score for "no itemized list on the confirmation page"). The
 * screen now renders the full receipt returned by the backend.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Confirmation } from '@/features/test-payment/components/TestPaymentPage';
import type { TestPaymentConfirmation } from '@/features/test-payment/types';

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
  it('shows the order id and total charged', () => {
    render(<Confirmation confirmation={CONFIRMATION} />);
    expect(screen.getByText(/Order tp_abc12345 was paid successfully/)).toBeInTheDocument();
    expect(screen.getByTestId('payment-confirmation-total')).toHaveTextContent('$43.96');
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
