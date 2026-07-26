/**
 * Isolated RCA reproduction: outbound link SMS is carrier-filtered because we
 * let Surge shorten our link to a generic `srgv.co` URL.
 *
 * Confirmed root cause (Surge dashboard verdict for msg_01kydrrq2y…):
 *   Status: Failed — failure_reason: message_filtered
 *   "Carrier filtered message for appearing unwanted or malicious."
 *
 * Live A/B against the real Surge API proved the mechanism WE own:
 *   A (default)                  → body rewritten to https://srgv.co/4P0b   (shortened)
 *   B (settings.link_shortening: → body kept https://roselabs.ai/?agent-id  (branded)
 *      "disabled")
 * Surge only shortens when we DON'T pass settings.link_shortening="disabled".
 * Per Surge docs, links on a domain other than the campaign's registered
 * link_sample (ours is null) are "much more likely to be filtered by the
 * carriers" — and the srgv.co shortener domain is exactly such a domain.
 *
 * This repro exercises the OWNED boundary: our `sendSms` transport. It stubs
 * global.fetch, invokes the real send path, and asserts the outgoing Surge
 * request disables link shortening so our branded link is transmitted verbatim.
 * The carrier-filter itself is a third-party decision and is NOT asserted here
 * (it cannot be made deterministic in CI); we assert the compliant request we
 * are responsible for emitting.
 *
 * EXPECTED ON BUGGY CODE: FAIL — requestBody is `{to, body}` with no settings,
 * so Surge shortens the link and the carrier filters it.
 *
 * Run: SURGE_API_KEY=x SURGE_ACCOUNT_ID=y npx tsx back-end/scripts/repro-surge-link-shortening.ts
 */

import { sendSms } from '../src/providers/smsQueue';

process.env.SURGE_API_KEY = process.env.SURGE_API_KEY || 'test_key';
process.env.SURGE_ACCOUNT_ID = process.env.SURGE_ACCOUNT_ID || 'acct_test';

async function main(): Promise<void> {
  let capturedBody: Record<string, unknown> | null = null;

  // Intercept the Surge POST so we inspect exactly what we transmit — no real
  // send, no network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    return new Response(JSON.stringify({ id: 'msg_stub' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    await sendSms('+19729777432', 'View agent: https://roselabs.ai/?agent-id=ea85c175');
  } finally {
    globalThis.fetch = realFetch;
  }

  const failures: string[] = [];
  if (capturedBody === null) {
    failures.push('sendSms did not issue a Surge request');
  } else {
    const settings = capturedBody.settings as Record<string, unknown> | undefined;
    if (!settings || settings.link_shortening !== 'disabled') {
      failures.push(
        `Surge request does not disable link shortening. Expected ` +
          `settings.link_shortening="disabled", got: ${JSON.stringify(capturedBody.settings)}. ` +
          `Surge will rewrite our branded roselabs.ai link into a generic srgv.co ` +
          `shortlink, which the carrier filters (message_filtered).`
      );
    }
  }

  if (failures.length > 0) {
    console.error('❌ REPRO FAILED (link shortening not disabled):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✅ REPRO PASSED: Surge send disables link shortening; branded link transmitted.');
}

void main();
