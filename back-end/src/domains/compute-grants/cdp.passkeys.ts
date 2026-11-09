/**
 * CDP virtual-authenticator seeding for cloud-custody passkeys.
 *
 * A WebAuthn virtual authenticator is scoped to the TARGET (page/window) it is
 * added to. The connect flow seeds on the claude.ai tab, but a "Sign in with
 * Google" ceremony opens in a SEPARATE popup window -- a different target the
 * original authenticator never reached, so Google reported "No passkeys
 * available". This seeds every existing page target and arms browser-level
 * auto-attach so a popup is seeded before its ceremony runs. Every seeded target
 * also records ceremony outcomes (see cdp.passkeyCeremonies).
 */

import { createLogger } from '../../providers/logger';
import { createPasskeyCeremonySync, observePasskeyCeremonies } from './cdp.passkeyCeremonies';

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
  // This target now answers WebAuthn silently; make what it cannot answer visible.
  await observePasskeyCeremonies(
    send,
    sessionId,
    passkeys.map((pk) => pk.rpId)
  );
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

/**
 * Seed passkeys the INSTANT a new page target attaches.
 *
 * A "Continue with Google" popup runs navigator.credentials.get() within ~1s of
 * opening -- faster than any poll -- so a 2s re-seed loses the race. Auto-attach
 * fires on target creation, before the page runs its ceremony. Returns a handle
 * to arm/replace the passkeys to seed onto future targets.
 */
function armAutoAttachSeeding(
  ws: WebSocket,
  send: CdpSend,
  memo: PasskeyTargetMemo
): { set: (p: PasskeySeed[]) => void } {
  const armed: { passkeys: PasskeySeed[] } = { passkeys: [] };
  ws.addEventListener('message', (e: MessageEvent) => {
    let msg: {
      method?: string;
      params?: { sessionId?: string; targetInfo?: { type?: string; targetId?: string } };
    };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.method !== 'Target.attachedToTarget') return;
    const sid = msg.params?.sessionId;
    const info = msg.params?.targetInfo;
    if (sid === undefined || info?.type !== 'page' || info.targetId === undefined) return;
    if (armed.passkeys.length === 0 || memo.has(info.targetId)) return;
    memo.add(info.targetId);
    void seedTargetSession(send, sid, armed.passkeys)
      .then((seeded) => {
        if (!seeded) memo.delete(info.targetId as string);
      })
      .catch(() => memo.delete(info.targetId as string));
  });
  return { set: (p) => (armed.passkeys = p) };
}

/**
 * Passkeys for one connect browser: seed the attached page, every other page and
 * every future target, and read back the ceremony they could not answer.
 * `evaluateMain` evaluates on the attached (main) page's existing session.
 */
export function createConnectPasskeys(
  ws: WebSocket,
  send: CdpSend,
  page: { sessionId: string | undefined; targetId: string | undefined },
  evaluateMain: (expression: string) => Promise<string | undefined>
): {
  seed: (passkeys: PasskeySeed[]) => Promise<number>;
  syncCeremonies: () => Promise<string | undefined>;
} {
  const memo: PasskeyTargetMemo = new Set();
  const armed = armAutoAttachSeeding(ws, send, memo);
  const ceremonies = createPasskeyCeremonySync(evaluateMain);
  return {
    async seed(passkeys) {
      // Seed current pages synchronously first. Enabling auto-attach can emit an
      // immediate attached event for those same pages; doing it first made the
      // handler reserve the target while seeding in the background, so this
      // method returned 0 before any credential was actually present.
      armed.set(passkeys);
      ceremonies.setHeld(passkeys.map((pk) => pk.rpId));
      let existing = 0;
      if (
        passkeys.length > 0 &&
        page.sessionId !== undefined &&
        page.targetId !== undefined &&
        !memo.has(page.targetId)
      ) {
        if (await seedTargetSession(send, page.sessionId, passkeys)) {
          memo.add(page.targetId);
          existing += 1;
        }
      }
      existing += await seedVirtualPasskeys(send, passkeys, memo);
      if (passkeys.length > 0) {
        // Browser-level (raw): catches future TOP-LEVEL popup windows too, not
        // just children of the current page. Google's sign-in can be either.
        await send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          { raw: true }
        );
      }
      return existing;
    },
    syncCeremonies: () => ceremonies.sync(),
  };
}
