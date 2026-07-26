/**
 * RCA reproduction: Surge delivery-status observability gap.
 *
 * The link SMS `msg_01kydrrq2yfrh9db65pxdvdeyv` was carrier-filtered
 * (failure_reason `message_filtered`) but we never knew: Surge's read API
 * exposes no per-message status, and we ingest only `type:"message.received"`.
 * Surge's documented webhook catalog DOES include `message.sent` /
 * `message.delivered` / `message.failed` (the last carries `failure_reason`),
 * so delivery status IS retrievable programmatically — via the event stream we
 * were not consuming.
 *
 * This exercises the OWNED boundary: the inbound webhook must (1) classify a
 * Surge delivery-status event rather than misrouting our own outbound body to
 * the supervisor as inbound text, and (2) recognize/record it.
 *
 * PRE-FIX: FAIL — `parseSurgePayload` ignored `type` and misclassified the
 * receipt as inbound; no delivery-status parser/recorder existed.
 * POST-FIX: PASS — `parseSurgePayload` rejects delivery events,
 * `parseSurgeDeliveryEvent` extracts status + failure_reason, and
 * `recordSurgeDeliveryStatus` handles it.
 *
 * Run: npx tsx back-end/scripts/repro-surge-delivery-gap.ts
 */

import {
  parseSurgePayload,
  parseSurgeDeliveryEvent,
} from '../src/domains/sms-webhook/service.validation';
import { recordSurgeDeliveryStatus } from '../src/domains/sms-webhook/service';

// Real Surge message.failed envelope shape (docs.surge.app): account_id/id/
// timestamp/type + data.{ id, body, failure_reason, failed_at, conversation }.
const deliveryFailedWebhook: Record<string, unknown> = {
  account_id: 'acct_01kgdp7gfgfpdtr43g3fegh4ve',
  id: 'evt_delivery_01',
  timestamp: '2026-07-25T23:11:35.000Z',
  type: 'message.failed',
  data: {
    id: 'msg_01kydrrq2yfrh9db65pxdvdeyv',
    body: 'Started: "Order red socks…"\nView agent: https://srgv.co/4P01',
    failure_reason: 'message_filtered',
    failed_at: '2026-07-25T23:11:36.000Z',
    conversation: {
      contact: { phone_number: '+19729777432' },
      phone_number: { number: '+14154498072' },
    },
  },
};

function main(): void {
  const failures: string[] = [];

  // 1. A delivery receipt must NOT be parsed as an inbound user message.
  const asInbound = parseSurgePayload(deliveryFailedWebhook);
  if (asInbound !== null) {
    failures.push(
      `parseSurgePayload misclassified a "${deliveryFailedWebhook.type}" receipt as ` +
        `inbound text: ${JSON.stringify(asInbound)}`
    );
  }

  // 2. The delivery event must be classified and carry failure_reason.
  const event = parseSurgeDeliveryEvent(deliveryFailedWebhook);
  if (!event || event.type !== 'message.failed' || event.failureReason !== 'message_filtered') {
    failures.push(
      `parseSurgeDeliveryEvent did not extract the failed status: ${JSON.stringify(event)}`
    );
  }

  // 3. There must be a recorder for the status (throws if missing).
  if (typeof recordSurgeDeliveryStatus !== 'function') {
    failures.push('recordSurgeDeliveryStatus is not exported — delivery status has no sink');
  } else if (event) {
    recordSurgeDeliveryStatus(event);
  }

  if (failures.length > 0) {
    console.error('❌ REPRO FAILED (observability gap present):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✅ REPRO PASSED: Surge delivery receipts are classified and recorded.');
}

main();
