/**
 * messaging-telegram repo layer — backend HTTP for account registration and
 * sync progress. Message uploads go through the shared Uploader (impersonation
 * boundary); these two calls carry no machine data.
 *
 *   POST {apiUrl}/api/integrations/telegram/connect                     { accountId, label, claimLegacy? }
 *   POST {apiUrl}/api/integrations/telegram/accounts/:accountId/progress { runId, seq, state, done, total, unit }
 *        200 applied · 202 coalesced { retryAfterMs } · 409 stale
 */
import { config } from '../../base/config';
import { INTEGRATION_KEY } from './config';
import type { ProgressBody, ProgressSendResult } from './types';

export interface TelegramConnectBody {
  accountId: string;
  label?: string;
  claimLegacy?: true;
}

function jsonHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
}

/** Register (or refresh) one Telegram account. Resolves true on 2xx. */
export async function postTelegramConnect(
  accessToken: string,
  body: TelegramConnectBody
): Promise<boolean> {
  const response = await fetch(`${config.apiUrl}/api/integrations/${INTEGRATION_KEY}/connect`, {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(body),
  });
  return response.ok;
}

async function retryAfterOf(response: Response): Promise<number> {
  try {
    const parsed = (await response.json()) as { retryAfterMs?: unknown };
    const value = parsed.retryAfterMs;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 1_000;
  } catch {
    return 1_000;
  }
}

/** Write one progress observation for one account. */
export async function postTelegramProgress(
  accessToken: string,
  accountId: string,
  body: ProgressBody
): Promise<ProgressSendResult> {
  const url = `${config.apiUrl}/api/integrations/${INTEGRATION_KEY}/accounts/${encodeURIComponent(accountId)}/progress`;
  const response = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: JSON.stringify(body),
  });
  if (response.status === 202) {
    return { kind: 'coalesced', retryAfterMs: await retryAfterOf(response) };
  }
  if (response.ok) return { kind: 'applied' };
  return { kind: 'rejected', status: response.status };
}
