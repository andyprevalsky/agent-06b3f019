/**
 * STATE MACHINE: PhoneApp (UI ledger rows 58/66)
 *
 *   openApp === 'phone' --> [SHOWN] just the iPhone + its Take control button,
 *                           floating 24px from the window's right edge,
 *                           vertically centered, drop shadow; no header,
 *                           background or card
 *   otherwise           --> not rendered
 *   [SHOWN] --Take control--> "not available yet" toast (the phone lane wires
 *                              the device session into the screen slot)
 *
 * The screen is a placeholder slot (`phone-screen`) for the phone lane.
 */

import { useToast } from '@/hooks/use-toast';

import { PHONE_EDGE_GAP } from './roseAppsLayout';
import { useRoseApps } from './roseAppsState';

export function PhoneApp() {
  const apps = useRoseApps();
  const { toast } = useToast();
  if (apps === null || apps.openApp !== 'phone') return null;
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
        <div
          data-testid="phone-screen"
          className="relative h-full w-full overflow-hidden rounded-[36px]"
          style={{
            background:
              'radial-gradient(120% 80% at 20% 10%, #ffd6e2 0%, #f7a8bf 35%, #8e7ad8 75%, #3d3b8e 100%)',
          }}
        >
          <div className="absolute left-1/2 top-2.5 h-7 w-24 -translate-x-1/2 rounded-2xl bg-black" />
        </div>
      </div>
      <button
        type="button"
        onClick={() => toast({ title: 'Take control is not available yet' })}
        className="mt-3.5 w-[300px] rounded-xl bg-[#0a84ff] py-[15px] text-base font-semibold text-white hover:bg-[#0077ed]"
      >
        Take control
      </button>
    </div>
  );
}
