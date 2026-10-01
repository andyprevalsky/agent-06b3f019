/**
 * Integrations upload service — passkeys.
 *
 * A passkey arrives with its raw PKCS#8 private key (already AES-encrypted in
 * transit by the request envelope). We re-encrypt the private key with the RSA
 * storage envelope (same as Apple passwords) so only agent workers holding
 * CLAUDE_CREDENTIAL_DECRYPTION_KEY can decrypt it, then upsert a
 * PasskeyCredential row keyed by (userId, rpId, credentialId).
 */

import { canonicalAuthRealm, hostnameFromRealmInput } from '../../providers/authRealm';
import { createLogger } from '../../providers/logger';
import { encryptPasswordForStorage } from '../../providers/credentialEnvelope';
import { IntegrationStatus, IntegrationType, type PasskeyPayload } from './types';
import * as repo from './repo';

const log = createLogger('Integrations');

interface PreparedPasskey {
  authRealm: string;
  rpId: string;
  credentialId: string;
  encryptedPrivateKey: string;
  userHandle: string | null;
  signCount: number;
  origin: string | null;
  browserSource: string;
}

/** Process a passkey upload: encrypt private keys at rest and upsert rows. */
export async function processPasskeysUpload(userId: string, payload: PasskeyPayload) {
  log.info('Received passkeys', { count: payload.passkeys.length, userId });

  if (payload.passkeys.length === 0) {
    return { passkeyCount: 0 };
  }

  const prepared = new Map<string, PreparedPasskey>();
  for (const pk of payload.passkeys) {
    if (
      typeof pk.rpId !== 'string' ||
      pk.rpId === '' ||
      typeof pk.credentialId !== 'string' ||
      pk.credentialId === '' ||
      typeof pk.privateKey !== 'string' ||
      pk.privateKey === ''
    ) {
      log.warn('Skipping malformed passkey entry', { rpId: pk.rpId, userId });
      continue;
    }
    const authRealm = canonicalAuthRealm(pk.authRealm ?? pk.rpId);
    const origin = pk.origin ?? `https://${hostnameFromRealmInput(pk.rpId)}`;
    // Dedupe by the same key as the DB unique constraint.
    prepared.set(`${pk.rpId}|${pk.credentialId}`, {
      authRealm,
      rpId: pk.rpId,
      credentialId: pk.credentialId,
      encryptedPrivateKey: encryptPasswordForStorage(pk.privateKey),
      userHandle: pk.userHandle ?? null,
      signCount: typeof pk.signCount === 'number' && pk.signCount >= 0 ? pk.signCount : 0,
      origin,
      browserSource: pk.browserSource ?? 'cdp_virtual',
    });
  }

  const passkeys = [...prepared.values()];
  if (passkeys.length === 0) {
    return { passkeyCount: 0 };
  }

  await bulkUpsertPreparedPasskeys(userId, passkeys);
  log.info('Upserted passkeys', { count: passkeys.length, userId });

  const browserSources = new Set(passkeys.map((p) => p.browserSource));
  for (const source of browserSources) {
    await repo.upsertIntegration({
      userId,
      name: `${source}_passkeys`,
      type: IntegrationType.DATA_SOURCE,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      lastSyncAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
      config: {
        browserSource: source,
        passkeyCount: passkeys.filter((p) => p.browserSource === source).length,
        uploadedAt: new Date().toISOString(),
      },
    });
  }

  return { passkeyCount: passkeys.length };
}

async function bulkUpsertPreparedPasskeys(userId: string, passkeys: PreparedPasskey[]) {
  const values = passkeys
    .map(
      (_, i) =>
        `(gen_random_uuid(), $${i * 9 + 1}, $${i * 9 + 2}, $${i * 9 + 3}, $${i * 9 + 4}, $${i * 9 + 5}, $${i * 9 + 6}, $${i * 9 + 7}::bigint, $${i * 9 + 8}, $${i * 9 + 9}, NOW(), NOW(), NULL, NULL)`
    )
    .join(', ');

  const params: (string | number | null)[] = [];
  for (const pk of passkeys) {
    params.push(
      userId,
      pk.authRealm,
      pk.rpId,
      pk.credentialId,
      pk.encryptedPrivateKey,
      pk.userHandle,
      pk.signCount,
      pk.origin,
      pk.browserSource
    );
  }

  await repo.bulkUpsertPasskeys(values, params);
}
