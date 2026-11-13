import assert from 'node:assert/strict';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
} from '../../providers/agentcard/org-runtime';

/**
 * Regression (production Render, 2026-11-12 23:06:00-23:08:28Z and 23:49:42-23:50:57Z; PR #1987
 * deploy smoke get_cardholder_kyc_status ~23:58Z): AgentCard first answered the organization
 * client with HTTP 429 "Too many requests" (23:06:00.652Z recover_funds; 23:49:42.712Z
 * list_transfers) and then rejected the SAME static `acs_` secret with HTTP 401 "Invalid or expired
 * organization token" on every replica for minutes. Over three days of Render logs the 401 never
 * occurred without a 429 in the same window, so the provider's 401 is its throttle answer, not a
 * dead credential (no env update or deploy occurred; the secret is static and never refreshed).
 *
 * The runtime replayed each 401 immediately: 3 in-call attempts 250 ms apart, then a full
 * immediate re-call, i.e. 6 HTTP requests in ~1.5 s per logical call, from every concurrent caller
 * on every replica, all inside the throttled window. Invariant: a provider 401 is never replayed
 * before a backoff sleep on the runtime clock, for reads and mutations alike.
 */
export async function assertProviderUnauthorizedIsNeverReplayedWithoutBackoff(): Promise<void> {
  for (const toolName of ['get_card', 'close_card'] as const) {
    let nowMs = 1_000_000;
    const sleeps: number[] = [];
    const sentAtMs: number[] = [];
    const runtime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        sentAtMs.push(nowMs);
        return new Response(JSON.stringify({ error: 'Invalid or expired organization token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      },
      {
        now: () => nowMs,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      }
    );
    await assert.rejects(
      () => runtime.callTool(toolName, { card_id: 'card-1' }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 401 &&
        error.code === 'agentcard_org_mcp_unauthorized',
      `${toolName}: a sustained provider 401 must still surface once its backoff is spent`
    );
    for (let i = 1; i < sentAtMs.length; i += 1) {
      assert.ok(
        sentAtMs[i] - sentAtMs[i - 1] >= 1_000,
        `${toolName}: request ${i + 1} replayed a provider 401 ${sentAtMs[i] - sentAtMs[i - 1]} ms ` +
          `after the previous one (sent at ${JSON.stringify(sentAtMs.map((t) => t - sentAtMs[0]))}); ` +
          'a throttled provider must get at least 1 s of backoff before each replay'
      );
    }
    assert.ok(
      sentAtMs.length >= 2,
      `${toolName}: a single provider 401 must still be replayed once`
    );
  }
  console.log('PASS AgentCard org runtime backs off before replaying a provider 401');
}
