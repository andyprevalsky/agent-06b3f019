/** Optional read-only profile probes; distinct from normal smoke capability gates. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getWhatsAppConfig } from '../../providers/whatsappCloud';
import { fetchWithTimeout } from './credential-probe-fetch';

interface ProfileProbe {
  provider: 'whatsapp' | 'elevenlabs';
  status: number | null;
  classification: string;
  profileAccess: boolean;
  mediaOperationVerified: false;
}

/** Never prints a profile, token, phone number, provider identity, or error body. */
export async function runWhatsAppMediaLiveCredentialChecks(): Promise<void> {
  const receiptDir = process.env.WHATSAPP_MEDIA_LIVE_RECEIPT_DIR;
  if (!receiptDir) throw new Error('Set WHATSAPP_MEDIA_LIVE_RECEIPT_DIR for private raw receipts');
  await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  const wa = getWhatsAppConfig();

  async function probe(
    provider: ProfileProbe['provider'],
    url: string | undefined,
    headers: Record<string, string> | undefined
  ): Promise<ProfileProbe> {
    if (!url || !headers) {
      return {
        provider,
        status: null,
        classification: 'configuration-missing',
        profileAccess: false,
        mediaOperationVerified: false,
      };
    }
    try {
      const response = await fetchWithTimeout(url, { method: 'GET', headers }, 15_000);
      const body = await response.text();
      await writeFile(
        join(receiptDir, `${provider}.private.json`),
        JSON.stringify(
          {
            observedAt: new Date().toISOString(),
            method: 'GET',
            url,
            status: response.status,
            body,
          },
          null,
          2
        ) + '\n',
        { mode: 0o600 }
      );
      let classification: string;
      let profileAccess = false;
      if (response.status === 200) {
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const profile = parsed as Record<string, unknown>;
            profileAccess =
              provider === 'whatsapp'
                ? profile.id === wa.phoneNumberId
                : typeof profile.user_id === 'string' && profile.user_id.trim() !== '';
          }
        } catch {
          // HTTP 200 alone cannot establish native profile access.
        }
        classification = profileAccess ? 'profile-access-accepted' : 'unexpected-profile-body';
      } else if (
        provider === 'elevenlabs' &&
        /missing[_ -]permissions|missing[_ -]user[_ -]read|permission[^\n]*user_read/i.test(body)
      ) {
        classification = 'profile-permission-missing-stt-auth-unproven';
      } else if (response.status === 401 || response.status === 403)
        classification = 'authentication-or-api-permission-rejected';
      else if (response.status >= 500) classification = 'provider-unavailable';
      else classification = 'unexpected-profile-response';
      return {
        provider,
        status: response.status,
        classification,
        profileAccess,
        mediaOperationVerified: false,
      };
    } catch {
      await writeFile(
        join(receiptDir, `${provider}.private.json`),
        JSON.stringify({
          observedAt: new Date().toISOString(),
          transportFailed: true,
        }) + '\n',
        { mode: 0o600 }
      );
      return {
        provider,
        status: null,
        classification: 'transport-unavailable',
        profileAccess: false,
        mediaOperationVerified: false,
      };
    }
  }

  const waConfigured = Boolean(
    wa.accessToken &&
    wa.phoneNumberId &&
    /^\d+$/.test(wa.phoneNumberId) &&
    /^v\d+\.\d+$/.test(wa.graphApiVersion)
  );
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  const results = await Promise.all([
    probe(
      'whatsapp',
      waConfigured
        ? `https://graph.facebook.com/${wa.graphApiVersion}/${wa.phoneNumberId}?fields=id`
        : undefined,
      waConfigured ? { Authorization: `Bearer ${wa.accessToken}` } : undefined
    ),
    probe(
      'elevenlabs',
      elevenLabsKey ? 'https://api.elevenlabs.io/v1/user' : undefined,
      elevenLabsKey ? { 'xi-api-key': elevenLabsKey } : undefined
    ),
  ]);
  await writeFile(
    join(receiptDir, 'summary.json'),
    JSON.stringify({ results, nativeUploadRoundTripVerified: false }, null, 2) + '\n',
    { mode: 0o600 }
  );
  for (const result of results) console.log(JSON.stringify(result));
  console.log(
    'Profile evidence only. Native media download, STT operation, and signed inbound upload remain unverified.'
  );
  // A missing user_read scope is not a verdict about a key's STT permission.
  if (
    results.some(
      (result) =>
        !['profile-access-accepted', 'profile-permission-missing-stt-auth-unproven'].includes(
          result.classification
        )
    )
  ) {
    process.exitCode = 1;
  }
}
