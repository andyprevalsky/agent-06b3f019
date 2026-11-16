/**
 * Reviewless item parity cases for purchases-fingerprint.blackbox.ts: the stored fingerprint of a
 * one-line receipt must equal the Python normalize_payment_payload hash (kept here for max-lines).
 */
import { canonicalStoredPurchaseFingerprint } from '../../domains/purchases/fingerprint';
import { assert } from './purchases.testkit';

export async function testReviewlessItemParity(): Promise<void> {
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    [
      'King room, 1 night',
      { productUrl: 'https://example.test/hotels/king-room' },
      30800,
      '489240d7ed3996a8db136ab77034810ec1652fa8349c05f9a91759e5a896d65c',
    ],
    ['Resort fee', {}, 4500, 'e7a65a3af733400db0f71a9724d03e278de9ebfb36d29d3e6f23ba7284963e2b'],
  ];
  for (const [name, extra, cents, expected] of cases) {
    const image = `https://example.test/${name === 'Resort fee' ? 'fee' : 'room'}.png`;
    const item = {
      name,
      imageUrl: image,
      ...extra,
      unitPriceCents: cents,
      quantity: 1,
      lineTotalCents: cents,
    };
    const receipt = {
      currency: 'USD',
      lineItems: [item],
      fees: [],
      subtotalCents: cents,
      totalCents: cents,
    };
    const fingerprint = canonicalStoredPurchaseFingerprint({
      userId: 'fixture-user',
      merchant: 'Hotel Example',
      lineItemsJson: receipt,
      totalCents: cents,
    });
    assert(
      fingerprint === expected,
      `${name}: fingerprint must match Python normalize_payment_payload`
    );
  }
}
