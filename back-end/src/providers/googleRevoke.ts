import { readGoogleToken } from './googleCredentials';

/** Revoke the refresh grant before removing the local credential. */
export async function revokeGoogleGrant(
  storedRefreshToken: string | null,
  storedAccessToken: string | null,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const storedToken = storedRefreshToken ?? storedAccessToken;
  if (storedToken === null) return;

  const response = await fetcher('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: readGoogleToken(storedToken) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) return;
  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === 'invalid_token') return;
  }
  throw new Error(`Google token revocation failed (HTTP ${response.status})`);
}
