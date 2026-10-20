/**
 * integration-progress — repo layer
 *
 * Sole HTTP boundary: POST one progress write to the backend. The service layer
 * never calls `fetch` directly. A 200 (applied) or 202 (coalesced) is success;
 * 409 (stale) and any other status are reported but not retried — a later write
 * in the same run supersedes a dropped one, and terminal writes always apply.
 *
 * Layer rule: repo imports its own types/config plus shared providers
 * (main/base/config for the apiUrl) only.
 */

import { config } from '../../base/config';
import { getErrorMessage } from '../../../shared/utils/error';
import { INTEGRATION_PROGRESS_LOG_PREFIX, progressEndpointPath } from './config';
import type { ProgressPostResult, ProgressWriteBody } from './types';

export async function postProgress(
  provider: string,
  accountId: string,
  body: ProgressWriteBody,
  accessToken: string
): Promise<ProgressPostResult> {
  const url = `${config.apiUrl}${progressEndpointPath(provider, accountId)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { ok: response.status === 200 || response.status === 202, status: response.status };
  } catch (error) {
    console.warn(
      `${INTEGRATION_PROGRESS_LOG_PREFIX} progress POST failed for ${provider}/${accountId}:`,
      getErrorMessage(error)
    );
    return { ok: false, status: 0 };
  }
}
