/**
 * Fill the user's saved Google password while a human signs in.
 *
 * "Continue with Google" on ChatGPT/Claude lands on Google's account chooser
 * (SSO cookies are seeded), and picking an account often still asks for the
 * password. We hold the user's synced Google passwords, so once the password
 * challenge shows an account we have a saved password for, we type it and press
 * Next -- the user never does.
 *
 * MULTIPLE SAVED PASSWORDS: people keep several (an old one and a rotated one,
 * work vs personal on the same address). We try them one at a time, newest-used
 * first: each tick, if the challenge is still showing an empty field for that
 * account, we submit the next untried candidate. Google rejecting one re-renders
 * the empty field, so the next tick advances to the next password. When the list
 * is exhausted we stop and leave the field to the human.
 */

import { createLogger } from '../../providers/logger';
import { findGooglePasswordCandidates } from './repo.googlePassword';
import type { CdpClient } from './cdp';

/** Progress through one account's saved passwords, newest-used first. */
export interface GooglePasswordProgress {
  candidates: string[];
  tried: number;
}

/** What the autofill needs from a browser a human is signing in to. */
export interface GoogleAutofillTarget {
  cdp: CdpClient | null;
  userId: string;
  /** Log correlation id (connect id or auth-assistance request id). */
  connectId: string;
  provider: string;
  /** Per-account candidate list + how many have been submitted. */
  googlePassword?: Map<string, GooglePasswordProgress>;
}

const log = createLogger('ComputeGrants');

/** Shared in-page predicate: Google's password challenge with an empty field. */
const PASSWORD_FIELD = String.raw`(() => {
  if (location.hostname !== 'accounts.google.com') return null;
  const field = document.querySelector('input[type="password"][name="Passwd"], input[type="password"][name="password"]');
  if (field === null || field.value !== '' || field.offsetParent === null) return null;
  return field;
})()`;

/** Returns the account email shown on the password challenge, or ''. */
export const GOOGLE_PASSWORD_CHALLENGE_EMAIL = String.raw`(() => {
  const field = ${PASSWORD_FIELD};
  if (field === null) return '';
  const pick = (v) => (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim() : '');
  const chip = document.querySelector('[data-profile-identifier], #profileIdentifier');
  const tagged = document.querySelector('[data-email]');
  const hidden = document.querySelector('input[name="identifier"], input[type="email"]');
  return (
    pick(chip && chip.textContent) ||
    pick(tagged && tagged.getAttribute('data-email')) ||
    pick(hidden && hidden.value) ||
    pick((document.body.innerText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0])
  ).toLowerCase();
})()`;

/** Fill + submit, only on the target still showing `email`'s password challenge. */
export function googlePasswordFillScript(email: string, password: string): string {
  return String.raw`(() => {
  const field = ${PASSWORD_FIELD};
  if (field === null || (${GOOGLE_PASSWORD_CHALLENGE_EMAIL}) !== ${JSON.stringify(email)}) return '';
  field.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(field, ${JSON.stringify(password)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  const next = ['#passwordNext button', '#passwordNext', 'button[type="submit"]']
    .map((selector) => document.querySelector(selector))
    .find((el) => el !== null) || null;
  if (next !== null) next.click();
  else if (field.form) field.form.requestSubmit();
  return 'filled';
})()`;
}

/**
 * Enabled Google passwords for this account, newest-used first, decrypted +
 * deduped. `[]` means none are stored; `null` means the lookup itself failed
 * and should be retried on a later tick.
 */
export type GooglePasswordLookup = (userId: string, email: string) => Promise<string[] | null>;

export const lookupStoredGooglePasswords: GooglePasswordLookup = async (userId, email) => {
  try {
    return await findGooglePasswordCandidates(userId, email);
  } catch (error) {
    log.warn('connect.google_password_lookup_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

export async function autofillGooglePassword(
  entry: GoogleAutofillTarget,
  lookup: GooglePasswordLookup = lookupStoredGooglePasswords
): Promise<boolean> {
  const cdp = entry.cdp;
  if (cdp === null) return false;
  const email = await cdp.evaluateAnyTarget<string>(GOOGLE_PASSWORD_CHALLENGE_EMAIL);
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;

  const progressByEmail = (entry.googlePassword ??= new Map<string, GooglePasswordProgress>());
  let progress = progressByEmail.get(email);
  if (progress === undefined) {
    const candidates = await lookup(entry.userId, email);
    // A failed lookup is not "nothing stored": leave it uncached so the next
    // tick asks again instead of disabling autofill for the whole session.
    if (candidates === null) return false;
    progress = { candidates, tried: 0 };
    progressByEmail.set(email, progress);
  }
  if (progress.tried >= progress.candidates.length) {
    if (progress.candidates.length === 0) {
      log.info('connect.google_password_unavailable', { connect_id: entry.connectId });
    }
    return false; // nothing left to try for this account.
  }

  const password = progress.candidates[progress.tried]!;
  const filled = await cdp.evaluateAnyTarget<string>(googlePasswordFillScript(email, password));
  // Only a confirmed submit consumes the candidate: if the challenge changed
  // between the email read and the fill, keep it for the next tick.
  if (filled === 'filled') progress.tried += 1;
  log.info('connect.google_password_autofill', {
    connect_id: entry.connectId,
    provider: entry.provider,
    filled: filled === 'filled',
    attempt: progress.tried,
    candidates: progress.candidates.length,
  });
  return filled === 'filled';
}
