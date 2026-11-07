/**
 * WebAuthn ceremonies the connect browser's authenticator cannot answer.
 *
 * The seeded virtual authenticator runs with Chrome's UI off, so when a relying
 * party asks for a passkey Rose does not hold (OpenAI's MFA asks for an
 * openai.com one), Chrome rejects get() with NotAllowedError in milliseconds and
 * draws nothing: the user's "Use passkey" click looks dead. CDP's WebAuthn
 * domain only reports successes, so:
 *
 *   page on a host Rose holds NO passkey for (e.g. auth.openai.com)
 *     get() ──► observer wrapper ──NotAllowedError for an unheld rpId──► hidden record
 *                                                                          │ 2s watcher tick
 *   main page Runtime.evaluate(READ) ──► sticky `passkeyUnavailableFor` ──► connect poll
 *
 * Pages whose host Rose holds passkeys for (accounts.google.com, github.com) are
 * never patched, so SSO sign-in runs on native code. No Runtime.enable/binding:
 * an enabled Runtime domain is a well-known automation fingerprint on login pages.
 */

import { createLogger } from '../../providers/logger';

const log = createLogger('ComputeGrants');

type CdpSend = (
  method: string,
  params?: unknown,
  opts?: { raw?: boolean; sessionId?: string }
) => Promise<Record<string, unknown>>;

const CEREMONY_SLOT = `Symbol.for('rose.webauthn.unanswered')`;

function ceremonyObserver(heldRpIds: string[]): string {
  return String.raw`(() => {
  const held = ${JSON.stringify([...new Set(heldRpIds)])};
  const host = location.hostname;
  // A page Rose holds passkeys for can be answered: leave it entirely native.
  if (held.some((rp) => host === rp || host.endsWith('.' + rp))) return;
  const proto = globalThis.CredentialsContainer && CredentialsContainer.prototype;
  const slot = ${CEREMONY_SLOT};
  if (!proto || typeof proto.get !== 'function' || globalThis[slot]) return;
  const unanswered = [];
  Object.defineProperty(globalThis, slot, { value: unanswered });
  const original = proto.get;
  proto.get = function get(options) {
    const pending = Reflect.apply(original, this, arguments);
    const publicKey = options && options.publicKey;
    // Conditional (autofill) requests run in the background; only a ceremony
    // the user asked for can look like a dead button.
    if (!publicKey || options.mediation === 'conditional') return pending;
    const rpId = String(publicKey.rpId || host);
    if (held.includes(rpId)) return pending;
    pending.catch((error) => {
      if (error && error.name === 'NotAllowedError' && unanswered.length < 20) {
        unanswered.push(rpId);
      }
    });
    return pending;
  };
})()`;
}

/** Unanswered relying parties on the main page, or '' when there are none. */
const READ_UNANSWERED = String.raw`(() => {
  const unanswered = globalThis[${CEREMONY_SLOT}];
  return unanswered && unanswered.length > 0 ? unanswered[unanswered.length - 1] : '';
})()`;

/** Observe this target's user-initiated get() calls, on every future document too. */
export async function observePasskeyCeremonies(
  send: CdpSend,
  sessionId: string,
  heldRpIds: string[]
): Promise<void> {
  const source = ceremonyObserver(heldRpIds);
  await send('Page.addScriptToEvaluateOnNewDocument', { source }, { sessionId });
  await send('Runtime.evaluate', { expression: source }, { sessionId });
}

/**
 * The relying party the user is stuck on, read from the main page (the tab the
 * provider's own sign-in and MFA run in) through its existing session.
 *
 * Sticky for the rest of the connect: a later page without records (another
 * method, a redirect) does not make Rose start holding that passkey.
 */
export function createPasskeyCeremonySync(
  evaluateMain: (expression: string) => Promise<string | undefined>
): {
  setHeld: (rpIds: string[]) => void;
  sync: () => Promise<string | undefined>;
} {
  let held: string[] = [];
  let unavailable: string | undefined;
  return {
    setHeld: (rpIds) => (held = [...new Set(rpIds)]),
    async sync() {
      // No seeded authenticator means no silent rejections: Chrome shows its own UI.
      if (held.length === 0) return undefined;
      const rpId = await evaluateMain(READ_UNANSWERED);
      if (rpId === undefined || rpId === '' || rpId === unavailable) return unavailable;
      unavailable = rpId;
      log.warn('connect.passkey_unavailable', { rp_id: rpId, held_rp_ids: held });
      return unavailable;
    },
  };
}
