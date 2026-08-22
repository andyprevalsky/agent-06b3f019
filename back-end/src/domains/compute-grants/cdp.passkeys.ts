/**
 * CDP virtual-authenticator seeding for cloud-custody passkeys.
 *
 * A WebAuthn virtual authenticator is scoped to the TARGET (page/window) it is
 * added to. The connect flow seeds on the claude.ai tab, but a "Sign in with
 * Google" ceremony opens in a SEPARATE popup window -- a different target the
 * original authenticator never reached, so Google reported "No passkeys
 * available". This seeds every existing page target; cdp.ts also arms
 * browser-level auto-attach so a popup is seeded before its ceremony runs.
 */

import { createLogger } from '../../providers/logger';

const log = createLogger('ComputeGrants');

export interface PasskeySeed {
  credentialId: string;
  /** Decrypted PKCS8 private key, base64. */
  privateKey: string;
  rpId: string;
  signCount: number;
  userHandle?: string | null;
}

type CdpSend = (
  method: string,
  params?: unknown,
  opts?: { raw?: boolean; sessionId?: string }
) => Promise<Record<string, unknown>>;

/** Per-target seeding memo, so repeated ticks don't re-add the same authenticator. */
export type PasskeyTargetMemo = Set<string>;

export async function seedTargetSession(
  send: CdpSend,
  sessionId: string,
  passkeys: PasskeySeed[]
): Promise<boolean> {
  await send('WebAuthn.enable', { enableUI: false }, { sessionId });
  const created = (await send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
    { sessionId }
  )) as { result?: { authenticatorId?: string } };
  const authenticatorId = created.result?.authenticatorId;
  if (authenticatorId === undefined) return false;

  for (const pk of passkeys) {
    if (pk.credentialId === '' || pk.privateKey === '' || pk.rpId === '') continue;
    const hasHandle = typeof pk.userHandle === 'string' && pk.userHandle !== '';
    await send(
      'WebAuthn.addCredential',
      {
        authenticatorId,
        credential: {
          credentialId: pk.credentialId,
          privateKey: pk.privateKey,
          rpId: pk.rpId,
          signCount: pk.signCount,
          isResidentCredential: true,
          ...(hasHandle ? { userHandle: pk.userHandle } : {}),
        },
      },
      { sessionId }
    );
  }
  return true;
}

/**
 * Seed passkeys onto every page target not already seeded.
 *
 * Returns how many NEW targets were seeded this call. Pass the same `memo` across
 * calls so popups opened later (the Google window) get seeded on a subsequent
 * tick without re-seeding the ones already done.
 */
export async function seedVirtualPasskeys(
  send: CdpSend,
  passkeys: PasskeySeed[],
  memo: PasskeyTargetMemo = new Set()
): Promise<number> {
  if (passkeys.length === 0) return 0;
  const targetsRes = (await send('Target.getTargets', {}, { raw: true })) as {
    result?: { targetInfos?: Array<{ targetId: string; type: string }> };
  };
  const pages = (targetsRes.result?.targetInfos ?? []).filter((t) => t.type === 'page');
  let seeded = 0;
  for (const target of pages) {
    if (memo.has(target.targetId)) continue;
    const attached = (await send(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      { raw: true }
    )) as { result?: { sessionId?: string } };
    const sessionId = attached.result?.sessionId;
    if (sessionId === undefined) continue;
    try {
      if (await seedTargetSession(send, sessionId, passkeys)) {
        memo.add(target.targetId);
        seeded += 1;
      }
    } catch (error) {
      // A target can vanish mid-seed (popup closed), but authentication failures
      // look identical if this stays silent. Keep the connect best-effort while
      // making the failed boundary observable.
      log.warn('connect.passkey_target_seed_failed', {
        target_id: target.targetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return seeded;
}
