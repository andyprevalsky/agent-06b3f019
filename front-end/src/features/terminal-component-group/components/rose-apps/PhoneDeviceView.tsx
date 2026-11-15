/**
 * STATE MACHINE: PhoneDeviceView (Phone app DEVICE VIEW — no agent, task or lease)
 *
 *   mount --> usePhoneDevice (GET /iphone/device ~3 s, /iphone/device/frame ~1 s)
 *           + useIPhoneConnection (GET /iphone/connection; every 2.5 s while setting_up)
 *   screen: PhoneDeviceLive (live PNG | Booting the phone… | Phone is idle | private …)
 *   footer: "In use by agent <id>" (link to that agent) | "Idle"
 *
 *   connection setting_up --> [SETUP] floating progress card at the top of the screen,
 *       fills by done steps / total, each step listed under it (✓ / spinner / ○ / ✕)
 *     --connection ready--> [CONNECTED] card shows "Connected" with every step ✓,
 *       then hides after CONNECTED_CARD_MS (fast /connection polling already stopped)
 *   connection never setting_up during this mount --> no card
 *   while setting_up and the phone is not yet booted (IDLE/CLOSING, no holder): screen
 *       "Starting the phone for setup…", footer "Starting" — never "idle"; once READY the
 *       live frames and holder show as usual
 *
 * The whole view is replay-blocked (data-amp-block/mask) like PhoneOverlay.
 */
import { useEffect, useState } from 'react';

import { IPhoneSetupProgress } from '@/components/iphone/IPhoneSetupProgress';
import { useIPhoneConnection } from '@/hooks/useIPhoneConnection';

import { PhoneDeviceLive, PhoneHolderLabel } from '../browser-status-bar/phone/PhoneDeviceLive';
import { usePhoneDevice } from '../browser-status-bar/phone/usePhoneDevice';

export const CONNECTED_CARD_MS = 5_000;

function useSetupCard() {
  const { status } = useIPhoneConnection();
  const [sawSetup, setSawSetup] = useState(false);
  const [connectedShown, setConnectedShown] = useState(true);
  const settingUp = status?.status === 'setting_up';
  const ready = status?.status === 'ready';
  useEffect(() => {
    if (settingUp) setSawSetup(true);
  }, [settingUp]);
  useEffect(() => {
    if (!ready || !sawSetup) return undefined;
    const timer = setTimeout(() => setConnectedShown(false), CONNECTED_CARD_MS);
    return () => clearTimeout(timer);
  }, [ready, sawSetup]);
  const show = settingUp || (ready && sawSetup && connectedShown);
  return show ? status : null;
}

export function PhoneDeviceView() {
  const model = usePhoneDevice();
  const setup = useSetupCard();
  const settingUp = setup?.status === 'setting_up';
  return (
    <section
      data-testid="phone-device-view"
      data-amp-block=""
      data-amp-mask=""
      role="region"
      aria-label="iPhone"
      className="absolute inset-0 flex min-h-0 flex-col text-white"
    >
      {setup !== null && <IPhoneSetupProgress connection={setup} variant="floating" />}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
        <PhoneDeviceLive model={model} settingUp={settingUp} />
      </div>
      {model.device !== null && model.device.enabled && (
        <p className="flex-none truncate px-4 pb-4 pt-1 text-center text-[11px] text-white/70">
          <PhoneHolderLabel holder={model.device.holder} settingUp={settingUp} />
        </p>
      )}
    </section>
  );
}
