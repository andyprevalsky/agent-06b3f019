// Blackbox cases that cool a shared funded key (GPT_API_KEY / ANTHROPIC_API_KEY)
// mutate state the whole backend under test reads: the server caches the
// cooldown in memory and only re-reads the shared row once per recheck
// interval (15s). Restoring the DB row is therefore not enough — a later case
// (e.g. the Codex E2B smoke, which may have no credential but the funded key)
// would still see the key cooled. Cases must wait until the server itself
// reports the restored state before handing the backend to the next case.

import { retryWithBackoff } from '../../providers/retry';

type FundedKey = 'gpt' | 'anthropic';

const COOLDOWN_PATHS: Record<FundedKey, string> = {
  gpt: '/api/integrations/compute-code/gpt-key/cooldown',
  anthropic: '/api/integrations/compute-code/anthropic-key/cooldown',
};

// The server re-reads the shared row every 15s; 40 polls 500ms apart cover one
// full recheck interval plus slack.
const POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 500;

export function cooldownIsLive(row: { rateLimitedUntil: Date | null } | null): boolean {
  return row?.rateLimitedUntil instanceof Date && row.rateLimitedUntil.getTime() > Date.now();
}

export async function waitForServerFundedKeyCooldown(options: {
  baseUrl: string;
  apiKey: string;
  key: FundedKey;
  onCooldown: boolean;
}): Promise<void> {
  const reportsExpected = (state: { ok: boolean; onCooldown: unknown }) =>
    state.ok && state.onCooldown === options.onCooldown;
  const last = await retryWithBackoff(
    async () => {
      const res = await fetch(`${options.baseUrl}${COOLDOWN_PATHS[options.key]}`, {
        headers: { 'X-API-Key': options.apiKey },
      });
      const body = (await res.json().catch(() => null)) as { onCooldown?: unknown } | null;
      return { ok: res.ok, status: res.status, onCooldown: body?.onCooldown };
    },
    {
      maxRetries: POLL_ATTEMPTS,
      fixedDelays: Array.from({ length: POLL_ATTEMPTS }, () => POLL_INTERVAL_MS),
      shouldRetryResult: (state) => !reportsExpected(state),
      component: 'FundedKeyCooldownWait',
    }
  );
  if (!reportsExpected(last)) {
    throw new Error(
      `backend never reported ${options.key} funded key onCooldown=${options.onCooldown} after the shared row was restored (last: ${last.status} onCooldown=${String(last.onCooldown)})`
    );
  }
}
