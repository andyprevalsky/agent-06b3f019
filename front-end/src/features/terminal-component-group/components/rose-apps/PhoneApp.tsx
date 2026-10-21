/**
 * STATE MACHINE: PhoneApp (UI ledger rows 58/66/86)
 *
 *   Rose Desktop flag off, or openApp !== 'phone' --> not rendered
 *   openApp === 'phone' --> [SHOWN] just the iPhone, floating 24px from the
 *                           window's right edge, vertically centered; no
 *                           surrounding header, background or card
 *   [SHOWN] no owned phone interaction -> explicit empty state, no requests.
 *   [OWNED TASK] authenticated broker read -> private frame/control; API absence
 *           remains unavailable. Closing unmounts the reader and revokes frames.
 *   [SHOWN] --its icon again | Escape--> not rendered
 */

import { X } from 'lucide-react';

import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { useIsMobile } from '@/hooks/use-mobile';

import { PHONE_EDGE_GAP } from './roseAppsLayout';
import { useRoseApps } from './roseAppsState';
import { PhoneAppScreen } from './PhoneAppScreen';

export function PhoneApp() {
  const apps = useRoseApps();
  const roseDesktop = useRoseDesktop();
  const isMobile = useIsMobile();
  if (apps === null || !roseDesktop || apps.openApp !== 'phone') return null;
  return (
    <div
      data-testid="rose-phone"
      aria-label="Phone"
      role="dialog"
      data-mobile={isMobile}
      className={
        isMobile
          ? 'fixed inset-0 z-[66] flex flex-col items-center overflow-y-auto bg-white pb-6 pt-[calc(var(--safe-area-inset-top)+3.25rem)] dark:bg-[#262624]'
          : 'fixed z-[66] hidden flex-col items-center md:flex'
      }
      style={
        isMobile ? undefined : { right: PHONE_EDGE_GAP, top: '50%', transform: 'translateY(-50%)' }
      }
    >
      {isMobile && (
        <button
          type="button"
          aria-label="Close phone"
          onClick={apps.closeApp}
          className="absolute right-1.5 top-[calc(var(--safe-area-inset-top)+0.375rem)] grid h-10 w-10 place-items-center text-[hsl(240_8%_45%)] dark:text-[#a3a39d]"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <div
        data-testid="rose-phone-device"
        className="relative h-[min(630px,calc(100dvh-110px))] min-h-[360px] w-[min(300px,calc(100vw-24px))] rounded-[46px] bg-[#1c1c1e] p-[11px]"
        style={{ boxShadow: '0 0 0 2px #2b2b2b, 0 30px 70px rgba(0,0,0,.35)' }}
      >
        <PhoneAppScreen />
      </div>
    </div>
  );
}
