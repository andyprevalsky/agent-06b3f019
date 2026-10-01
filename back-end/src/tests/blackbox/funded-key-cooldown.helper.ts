import { retryWithBackoff } from '../../providers/retry';

export type FundedKeyCooldownRoute = 'anthropic-key' | 'gpt-key';

const POLL_ATTEMPTS = 25;

/**
 * Tests that cool a shared funded key on the running backend must not hand the
 * next test a backend that still refuses it. The backend re-validates its cached
 * cooldown on a 15s recheck, so after restoring the row wait until the running
 * process reports the restored state.
 */
export async function waitForBackendFundedKeyCooldown(
  baseUrl: string,
  apiKey: string,
  route: FundedKeyCooldownRoute,
  expectedOnCooldown: boolean
): Promise<void> {
  const readStatus = async () => {
    const response = await fetch(`${baseUrl}/api/integrations/compute-code/${route}/cooldown`, {
      headers: { 'X-API-Key': apiKey },
    });
    return { status: response.status, body: (await response.json()) as { onCooldown?: unknown } };
  };
  const matches = (result: Awaited<ReturnType<typeof readStatus>>) =>
    result.status === 200 && result.body.onCooldown === expectedOnCooldown;
  const last = await retryWithBackoff(readStatus, {
    maxRetries: POLL_ATTEMPTS,
    fixedDelays: Array.from({ length: POLL_ATTEMPTS }, () => 1_000),
    shouldRetryResult: (result) => !matches(result),
    component: 'FundedKeyCooldownWait',
  });
  if (!matches(last)) {
    throw new Error(
      `backend ${route} cooldown never reported onCooldown=${String(expectedOnCooldown)}: HTTP ${last.status} ${JSON.stringify(last.body)}`
    );
  }
}
