/** The rotate_ip tool's human-readable outcome line. */
import { ROTATION_CAP, type RotationStep } from './rotation';

const PROVIDER_DISPLAY_NAMES: Record<RotationStep['provider'], string> = {
  kernel: 'Kernel',
  steel: 'Steel',
  'browser-use': 'Browser Use',
  tilion: 'Tilion',
};

export function buildRotationMessage(
  step: RotationStep,
  used: number,
  remaining: number,
  previousProvider?: RotationStep['provider'] | 'local'
): string {
  const left = `${remaining} rotation${remaining === 1 ? '' : 's'} remaining.`;
  if (step.recoveryAction === 'provider_switched' && step.provider === 'browser-use') {
    return `Switched to Browser Use with a new country-level residential proxy session (${used}/${ROTATION_CAP}). Login and cookies preserved. ${left}`;
  }
  if (step.recoveryAction === 'provider_switched') {
    const from =
      previousProvider === undefined || previousProvider === 'local'
        ? 'Kernel'
        : PROVIDER_DISPLAY_NAMES[previousProvider];
    const to = PROVIDER_DISPLAY_NAMES[step.provider];
    const tier = step.proxyType === 'mobile' ? 'mobile-carrier' : step.proxyType;
    return (
      `Switched from ${from} to ${to} with a fresh ${to} ${tier} IP ` +
      `(${used}/${ROTATION_CAP}) — browser and proxy infrastructure changed, same region. ` +
      `Login and cookies preserved. ${left}`
    );
  }
  if (step.provider === 'steel') {
    return (
      `Rotated to another fresh Steel residential IP (${used}/${ROTATION_CAP}) — same region, ` +
      `login and cookies preserved. ${left}`
    );
  }
  if (step.provider === 'browser-use') {
    return `Started a new Browser Use residential proxy session (${used}/${ROTATION_CAP}) in the same country. Login and cookies preserved. ${left}`;
  }
  const provider = PROVIDER_DISPLAY_NAMES[step.provider];
  if (step.proxyType === 'mobile') {
    return (
      `Rotated to a fresh ${provider} mobile-carrier IP (${used}/${ROTATION_CAP}) — same region. ` +
      `Login and cookies preserved. ${left}`
    );
  }
  return (
    `Rotated to a fresh ${provider} residential IP (${used}/${ROTATION_CAP}) — same region, ` +
    `login and cookies preserved. ${left}`
  );
}
