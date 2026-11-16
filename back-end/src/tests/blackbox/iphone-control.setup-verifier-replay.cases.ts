/** Real rose-1-mini setup verifier on recorded prod screen.text OCR (agent 1772a64a, 2026-11-15).
 *
 *   recorded OCR ──► verifyPhoneSetup(target) ──► rose-1-mini ──► status
 *
 * Positives are screens that showed the proof (unknown in prod before the fix, or confirmed in the
 * live retry after it); negatives are the
 * neighbouring screens that must stay unproven (no app identity, no checkmark, wrong account,
 * typed-but-unsigned identifier). */
import assert from 'node:assert/strict';
import fixture from '../fixtures/iphone-setup-verifier-replay.json';
import { verifyPhoneSetup } from '../../providers/phoneSetupVerifier';
import type { SetupTarget } from '../../providers/phoneSetupVerification';
import type { Case } from './iphone-control.cases';

type Ocr = (typeof fixture.observations)[keyof typeof fixture.observations];

function uncheckFirstPhoneRow(ocr: Ocr): Ocr {
  const index = ocr.findIndex((row) => row.text.includes('977-7432'));
  return ocr.map((row, i) =>
    i === index ? { ...row, text: row.text.replace(/^[Vv/]\s*/, '') } : row
  );
}

function rewrite(ocr: Ocr, edit: (text: string) => string): Ocr {
  return ocr.map((row) => ({ ...row, text: edit(row.text) }));
}

async function verify(target: SetupTarget, ocr: Ocr) {
  const result = await verifyPhoneSetup({
    agentId: 'iphone-setup-verifier-replay',
    expectedAppleIdentity: fixture.expectedAppleIdentity,
    expectedGoogleIdentity: fixture.expectedGoogleIdentity,
    expectedReceiveAddress: fixture.expectedReceiveAddress,
    verificationTarget: target,
    evidence: [{ operationId: 'recorded-screen-text', cursor: 1, result: ocr }],
  });
  return `${result.status}:${result.usage.model}`;
}

async function recordedProofScreensVerify(): Promise<void> {
  const o = fixture.observations;
  const signInForm = rewrite(o.gmail_settings_cursor119.slice(0, 7), (text) =>
    text === 'Settings'
      ? 'Sign in'
      : text === 'Account'
        ? 'Email or phone'
        : text === 'Andy Prevalsky'
          ? 'Next'
          : text
  );
  const checks: Array<[string, SetupTarget, Ocr, 'confirmed' | 'not_confirmed' | 'unknown']> = [
    ['Gmail account Settings', 'gmail', o.gmail_settings_cursor119, 'confirmed'],
    [
      'Send & Receive receive address',
      'receive_address',
      o.imessage_send_receive_cursor4,
      'confirmed',
    ],
    ['Send & Receive iMessage', 'imessage', o.imessage_send_receive_cursor4, 'confirmed'],
    [
      'inbox under a notification dialog',
      'gmail',
      o.gmail_inbox_notification_dialog_cursor101,
      'not_confirmed',
    ],
    ['Google Account page alone', 'gmail', o.google_account_page_cursor9, 'not_confirmed'],
    ['typed Google sign-in form', 'gmail', signInForm, 'not_confirmed'],
    [
      'wrong Gmail account',
      'gmail',
      rewrite(o.gmail_settings_cursor119, (t) => t.replace('a@roselabs.ai', 'other@roselabs.ai')),
      'not_confirmed',
    ],
    [
      'receive phone row without checkmark',
      'receive_address',
      rewrite(o.imessage_send_receive_cursor4, (t) =>
        t.includes('977-7432') ? t.replace(/^[Vv/]\s*/, '') : t
      ),
      'not_confirmed',
    ],
    [
      'Send & Receive wrong Apple Account',
      'imessage',
      rewrite(o.imessage_send_receive_cursor4, (t) =>
        t.replace('Apple Account: andyprevalsky@yahoo.com', 'Apple Account: someone@icloud.com')
      ),
      'not_confirmed',
    ],
    [
      'receive phone unchecked only under Receive',
      'receive_address',
      uncheckFirstPhoneRow(o.imessage_send_receive_cursor4),
      'not_confirmed',
    ],
    [
      'iMessage waiting for activation',
      'imessage',
      [
        ...o.imessage_send_receive_cursor4.slice(0, 4),
        { ...o.imessage_send_receive_cursor4[4], text: 'Waiting for activation...' },
        ...o.imessage_send_receive_cursor4.slice(4),
      ],
      'not_confirmed',
    ],
    [
      'Contacts Accounts: iCloud services line lists Contacts',
      'icloud_contacts',
      o.contacts_accounts_cursor9,
      'confirmed',
    ],
    [
      'iCloud See All: Contacts switch row has no text',
      'icloud_contacts',
      o.icloud_see_all_cursor14,
      'not_confirmed',
    ],
    [
      'iCloud See All (second capture): Contacts switch row',
      'icloud_contacts',
      o.icloud_see_all_cursor38,
      'not_confirmed',
    ],
    [
      'Contacts Accounts: iCloud services line without Contacts',
      'icloud_contacts',
      rewrite(o.contacts_accounts_cursor9, (t) =>
        t === 'iCloud Drive, iCloud Mail, Contacts, and'
          ? 'iCloud Drive, iCloud Mail, Calendars, and'
          : t
      ),
      'not_confirmed',
    ],
    [
      'Contacts Accounts: Contacts only under another account',
      'icloud_contacts',
      [
        ...rewrite(o.contacts_accounts_cursor9, (t) =>
          t === 'iCloud Drive, iCloud Mail, Contacts, and'
            ? 'iCloud Drive, iCloud Mail, Calendars, and'
            : t
        ),
        { ...o.contacts_accounts_cursor9[5], text: 'Gmail', y: 700 },
        { ...o.contacts_accounts_cursor9[6], text: 'Mail, Contacts, Calendars', y: 740 },
      ],
      'not_confirmed',
    ],
    [
      'real FaceTime page sent as imessage',
      'imessage',
      o.facetime_settings_cursor71,
      'not_confirmed',
    ],
    [
      'FaceTime page with another Apple Account is not evidence',
      'imessage',
      rewrite(o.facetime_settings_cursor71, (t) =>
        t.replace('Apple Account: andyprevalsky@yahoo.com', 'Apple Account: someone@icloud.com')
      ),
      'unknown',
    ],
    [
      'real FaceTime page sent as receive_address',
      'receive_address',
      o.facetime_settings_cursor71,
      'not_confirmed',
    ],
    [
      'Saved to iCloud: Messages in iCloud On',
      'icloud_messages',
      o.icloud_saved_to_icloud_cursor54,
      'confirmed',
    ],
    [
      'Saved to iCloud: Passwords & Keychain On',
      'icloud_keychain',
      o.icloud_saved_to_icloud_cursor54,
      'confirmed',
    ],
    [
      'Saved to iCloud without a Contacts row',
      'icloud_contacts',
      o.icloud_saved_to_icloud_cursor54,
      'not_confirmed',
    ],
  ];
  const statuses = await Promise.all(checks.map(([, target, ocr]) => verify(target, ocr)));
  const wrong = checks
    .map(([name, , , expected], index) => ({ name, expected, status: statuses[index] }))
    .filter(({ expected, status }) =>
      expected === 'unknown'
        ? !status.startsWith('unknown:')
        : (expected === 'confirmed') !== status.startsWith('confirmed:')
    );
  assert.deepEqual(wrong, [], 'recorded setup screens must verify exactly as expected');
}

export const setupVerifierReplayCases: Case[] = [
  ['live setup verifier: recorded proof screens and controls', recordedProofScreensVerify],
];
