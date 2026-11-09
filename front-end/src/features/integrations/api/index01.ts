/**
 * Pebble Index 01 setup: POST /api/index01/credentials → the webhook URL and
 * Authorization header the user types into the Index app (mints the user's
 * dedicated "Index 01" key on first use; later calls return the same key).
 */

import { API_BASE_WITH_PATH } from '../config';
import { getAuthHeaders } from '../api';
import type { Index01Credentials } from '../types';

/** Webhook URL + Authorization header for Pebble Index 01 (mints the user's key on first use). */
export async function fetchIndex01CredentialsApi(): Promise<Index01Credentials> {
  const response = await fetch(`${API_BASE_WITH_PATH}/index01/credentials`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const body: { error?: string } = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Could not load Index 01 setup (${response.status})`);
  }
  return (await response.json()) as Index01Credentials;
}
