/**
 * STATE MACHINE: PhoneApp (UI ledger rows 58/66/86)
 *
 *   Rose Desktop flag off, or openApp !== 'phone' --> not rendered
 *   openApp === 'phone' --> [SHOWN] just the iPhone, floating 24px from the
 *                           window's right edge, vertically centered; no
 *                           header, background, card or controls
 *   [SHOWN] screen: a calm "Coming soon" waiting screen (the phone harness is
 *           built in its own devbox). It makes no requests at all.
 *   [SHOWN] --its icon again | Escape--> not rendered
 */

import { useRoseDesktop } from '@/hooks/roseDesktopContext';

import { PHONE_EDGE_GAP } from './roseAppsLayout';
import { useRoseApps } from './roseAppsState';

export const PHONE_COMING_SOON_TITLE = 'Coming soon';
export const PHONE_COMING_SOON_TEXT = 'Rose will be able to use your iPhone here.';

function ComingSoonScreen() {
  return (
    <div
      data-testid="phone-screen"
      className="relative flex h-full w-full flex-col items-center justify-center gap-2.5 overflow-hidden rounded-[36px] bg-[#0d0d0f] px-[34px] text-center"
    >
      <div className="absolute left-1/2 top-2.5 h-7 w-24 -translate-x-1/2 rounded-2xl bg-black" />
      <p className="text-[17px] font-semibold text-[#f2f2ef]">{PHONE_COMING_SOON_TITLE}</p>
      <p className="text-[13px] leading-[1.45] text-[#a3a39d]">{PHONE_COMING_SOON_TEXT}</p>
    </div>
  );
}

export function PhoneApp() {
  const apps = useRoseApps();
  const roseDesktop = useRoseDesktop();
  if (apps === null || !roseDesktop || apps.openApp !== 'phone') return null;
  return (
    <div
      data-testid="rose-phone"
      aria-label="Phone"
      role="dialog"
      className="fixed z-[66] hidden flex-col items-center md:flex"
      style={{ right: PHONE_EDGE_GAP, top: '50%', transform: 'translateY(-50%)' }}
    >
      <div
        data-testid="rose-phone-device"
        className="relative h-[630px] w-[300px] rounded-[46px] bg-[#1c1c1e] p-[11px]"
        style={{ boxShadow: '0 0 0 2px #2b2b2b, 0 30px 70px rgba(0,0,0,.35)' }}
      >
        <ComingSoonScreen />
      </div>
    </div>
  );
}
