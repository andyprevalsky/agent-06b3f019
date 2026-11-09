/**
 * Index 01 (Pebble) setup credentials: the exact values the user types into the
 * Index app's webhook screen. One dedicated Rose API key ("Index 01") per user,
 * created on first request and returned unchanged afterwards, so reopening the
 * setup guide never rotates a key already pasted into the app. Unlike the paid
 * completions API (POST /api/api-keys), no subscription is required: the key
 * only reaches POST /api/index01/webhook and /mcp.
 */

import { randomUUID } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';
import { getPublicApiBaseUrl } from './config';
import * as repo from './repoIndex01';

const log = createLogger('Index01Credentials');

export const INDEX01_KEY_NAME = 'Index 01';

export interface Index01Credentials {
  webhook_url: string;
  header_name: 'Authorization';
  header_value: string;
}

export async function getOrCreateIndex01Credentials(userId: string): Promise<Index01Credentials> {
  let apiKey = await repo.findIndex01ApiKey(userId, INDEX01_KEY_NAME);
  if (apiKey === null) {
    apiKey = randomUUID().replace(/-/g, '');
    await repo.createIndex01ApiKey(userId, apiKey, INDEX01_KEY_NAME);
    log.info('Minted Index 01 API key', { userId });
  }
  return {
    webhook_url: `${getPublicApiBaseUrl()}/api/index01/webhook`,
    header_name: 'Authorization',
    header_value: `Bearer ${apiKey}`,
  };
}
