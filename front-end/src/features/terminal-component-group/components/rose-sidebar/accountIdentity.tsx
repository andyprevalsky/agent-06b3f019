/**
 * Account row identity for the Rose left bar (UI ledger row 63).
 *
 * Signed in: the first letter of the user's name as a cursive capital in the
 * self-hosted Pinyon Script face (OFL, src/assets/fonts), ~27px, current text
 * color, no circle or background. Signed out / anonymous: the member icon.
 */

import type { User } from '@supabase/supabase-js';
import { User as MemberIcon } from 'lucide-react';

import pinyonScriptUrl from '@/assets/fonts/pinyon-script-latin-400-normal.woff2';

import { accountDisplayName } from './accountDisplayName';

const FONT_FACE = `@font-face{font-family:'Pinyon Script';font-style:normal;font-weight:400;font-display:swap;src:url(${pinyonScriptUrl}) format('woff2');}`;

export function AccountGlyph({ user }: { user: User | null }) {
  const initial = user === null ? '' : accountDisplayName(user).charAt(0).toUpperCase();
  if (initial === '' || !/\p{L}/u.test(initial)) {
    return (
      <MemberIcon data-testid="rose-account-member-icon" className="h-5 w-5" strokeWidth={1.7} />
    );
  }
  return (
    <span
      data-testid="rose-account-initial"
      aria-hidden="true"
      className="inline-flex h-5 w-5 items-center justify-center leading-none"
      style={{ fontFamily: "'Pinyon Script', cursive", fontSize: 27 }}
    >
      <style>{FONT_FACE}</style>
      {initial}
    </span>
  );
}
