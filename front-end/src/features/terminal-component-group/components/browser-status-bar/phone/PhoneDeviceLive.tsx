/**
 * STATE MACHINE: PhoneDeviceLive (view-only live screen of the account's iPhone)
 *
 *   [CONNECTING]  no /device read yet → "Connecting to the phone…"
 *   [UNAVAILABLE] /device failed before any read → "Phone view unavailable."
 *   [DISABLED]    device.enabled false → "Phone access requires the connected phone service."
 *   [FRAME]       live PNG (also kept while the frame endpoint answers busy)
 *   [PRIVATE]     frame 409 private → "Phone screen is private right now."
 *   [STARTING]    → "Booting the phone…"   [CLOSING] → "Phone is shutting down…"
 *   [IDLE]        → "Phone is idle"         [READY, no frame yet] → "Connecting to the phone…"
 *   [SETUP_START] settingUp (connection setting_up) and the phone is IDLE/CLOSING (setup
 *                 agent has no session yet) → "Starting the phone for setup…"; holder
 *                 label says "Starting" instead of "Idle". Never "idle" during setup.
 *
 * Never sends input: the ACTIVE-lease control path (PhoneOverlay) owns interaction.
 * Callers render it inside a replay-blocked (data-amp-block) subtree.
 */
import type { IPhoneDeviceHolder } from '@/lib/api/iphone';
import { shortAgentId, type PhoneDeviceModel } from './usePhoneDevice';

function stateCopy(model: PhoneDeviceModel, settingUp: boolean): string {
  const { device, frameState } = model;
  if (device === null) return model.error ? 'Phone view unavailable.' : 'Connecting to the phone…';
  if (!device.enabled) return 'Phone access requires the connected phone service.';
  if (frameState === 'private') return 'Phone screen is private right now.';
  const state =
    frameState === 'IDLE' || frameState === 'STARTING' || frameState === 'CLOSING'
      ? frameState
      : device.providerState;
  if (settingUp && (state === 'IDLE' || state === 'CLOSING'))
    return 'Starting the phone for setup…';
  if (state === 'STARTING') return 'Booting the phone…';
  if (state === 'CLOSING') return 'Phone is shutting down…';
  if (state === 'IDLE') return 'Phone is idle';
  return 'Connecting to the phone…';
}

export function PhoneDeviceLive({
  model,
  settingUp = false,
}: {
  model: PhoneDeviceModel;
  settingUp?: boolean;
}) {
  if (model.frame !== null)
    return (
      <img
        data-testid="phone-device-frame"
        data-frame-state={model.frameState ?? undefined}
        alt="Cloud iPhone screen"
        src={model.frame}
        draggable={false}
        className="block h-full min-h-0 max-w-full object-contain"
      />
    );
  return (
    <p
      role="status"
      data-testid="phone-device-state"
      className="px-6 text-center text-sm text-white/70"
    >
      {stateCopy(model, settingUp)}
    </p>
  );
}

/** "In use by agent <id>" (linking to that agent), "Starting" during setup, or "Idle". */
export function PhoneHolderLabel({
  holder,
  settingUp = false,
}: {
  holder: IPhoneDeviceHolder | null;
  settingUp?: boolean;
}) {
  if (holder === null)
    return <span data-testid="phone-device-holder">{settingUp ? 'Starting' : 'Idle'}</span>;
  return (
    <span data-testid="phone-device-holder">
      In use by{' '}
      <a
        className="font-medium text-white underline-offset-2 hover:underline"
        href={`/?agent-id=${encodeURIComponent(holder.agentId)}`}
      >
        agent {shortAgentId(holder.agentId)}
      </a>
      {holder.controlOwner === 'user' && ' · you have control'}
    </span>
  );
}
