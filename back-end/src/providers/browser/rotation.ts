import type { BrowserProviderName } from './types';
import type { KernelProxyType } from './kernelProxy';
import { browserProviderEnabled } from './config';
import { TilionApiError } from './tilionClient';
export {
  ProxyRotationExhaustedError,
  RotationSessionNotFoundError,
} from '../browserRotationErrors';

export const ROTATION_CAP = 4;

export type RotationRecoveryAction = 'ip_rotated' | 'provider_switched';

export interface RotationStep {
  provider: BrowserProviderName;
  proxyType: KernelProxyType;
  recoveryAction: RotationRecoveryAction;
}

/**
 * Deterministic rotate_ip recovery ladder.
 *
 * A Kernel run gets a fresh residential exit, then a mandatory mobile exit,
 * then changes browser/proxy infrastructure to Steel and Browser Use. Browser
 * Use only has country-level proxy selection; a new session requests a new
 * residential exit but the provider does not guarantee a distinct IP.
 *
 * A Tilion run gets a fresh Tilion residential exit (rotate-ip in place),
 * then Kernel mobile, then Steel, then Browser Use (Steel while Browser Use is
 * disabled). Tilion mobile exits are not served on our account (lane E live:
 * 409 proxy_type_unavailable in every variant), so the Tilion mobile rung
 * exists only behind TILION_MOBILE_ENABLED. The position is the run's rotation
 * count and the provider is the one the run is on now, so once a Tilion run has
 * switched its next step follows that provider's ladder. With the Tilion kill
 * switch off a Tilion run never rotates into another Tilion session: it leaves
 * for Kernel at the same tier.
 */
export function selectRotationStep(
  rotationsUsed: number,
  currentProvider: BrowserProviderName,
  browserUseAvailable = true,
  tilionAvailable = true,
  tilionMobileAvailable = tilionMobileEnabled()
): RotationStep {
  if (!Number.isInteger(rotationsUsed) || rotationsUsed < 1 || rotationsUsed > ROTATION_CAP) {
    throw new RangeError(`Rotation position must be between 1 and ${ROTATION_CAP}`);
  }

  if (currentProvider === 'tilion') {
    if (rotationsUsed <= 2) {
      const proxyType: KernelProxyType = rotationsUsed === 1 ? 'residential' : 'mobile';
      const tilionServes =
        tilionAvailable && (proxyType === 'residential' || tilionMobileAvailable);
      return tilionServes
        ? { provider: 'tilion', proxyType, recoveryAction: 'ip_rotated' }
        : { provider: 'kernel', proxyType, recoveryAction: 'provider_switched' };
    }
    return {
      provider: rotationsUsed === 4 && browserUseAvailable ? 'browser-use' : 'steel',
      proxyType: 'residential',
      recoveryAction: 'provider_switched',
    };
  }

  if (currentProvider === 'browser-use') {
    return {
      provider: browserUseAvailable ? 'browser-use' : 'steel',
      proxyType: 'residential',
      recoveryAction: browserUseAvailable ? 'ip_rotated' : 'provider_switched',
    };
  }
  if (currentProvider === 'steel') {
    return {
      provider: browserUseAvailable && rotationsUsed >= 3 ? 'browser-use' : 'steel',
      proxyType: 'residential',
      recoveryAction:
        browserUseAvailable && rotationsUsed >= 3 ? 'provider_switched' : 'ip_rotated',
    };
  }
  if (rotationsUsed === 1) {
    return {
      provider: 'kernel',
      proxyType: 'residential',
      recoveryAction: 'ip_rotated',
    };
  }
  if (rotationsUsed === 2) {
    return {
      provider: 'kernel',
      proxyType: 'mobile',
      recoveryAction: 'ip_rotated',
    };
  }
  return {
    provider: rotationsUsed === 3 || !browserUseAvailable ? 'steel' : 'browser-use',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  };
}

export function rotationStepLabel(step: RotationStep): string {
  if (step.recoveryAction === 'provider_switched')
    return `switch_provider_to_${step.provider.replace('-', '_')}`;
  if (step.provider === 'browser-use') return 'rotate_browser_use_residential_session';
  if (step.provider === 'steel') return 'rotate_steel_residential_ip';
  if (step.provider === 'tilion')
    return step.proxyType === 'mobile' ? 'rotate_tilion_mobile_ip' : 'rotate_tilion_residential_ip';
  return step.proxyType === 'mobile' ? 'rotate_kernel_mobile_ip' : 'rotate_kernel_residential_ip';
}

/** Tilion mobile exits are off until Tilion serves them on our account. */
export function tilionMobileEnabled(): boolean {
  return browserProviderEnabled('TILION_MOBILE_ENABLED', false);
}

/** Tilion slugs meaning "this exit type/rotation cannot be served now": advance a rung. */
export const TILION_EXIT_UNAVAILABLE_SLUGS = [
  'proxy_type_unavailable',
  'residential_rotation_unavailable',
  'exit_ladder_exhausted',
] as const;

/**
 * The rung after a Tilion step that Tilion could not serve, in the same
 * request (the reserved rotation still delivers a new IP, on another provider).
 */
export function rungAfterTilionUnavailable(
  rotationsUsed: number,
  browserUseAvailable = true
): RotationStep {
  const next = selectRotationStep(
    Math.min(rotationsUsed + 1, ROTATION_CAP),
    'tilion',
    browserUseAvailable,
    true,
    false
  );
  return next.provider === 'tilion'
    ? { provider: 'kernel', proxyType: next.proxyType, recoveryAction: 'provider_switched' }
    : { ...next, recoveryAction: 'provider_switched' };
}

/** A Tilion create/rotate refused because it cannot serve that exit now (typed, 409). */
export function isTilionExitUnavailableError(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(isTilionExitUnavailableError);
  return (
    error instanceof TilionApiError &&
    error.status === 409 &&
    (TILION_EXIT_UNAVAILABLE_SLUGS as readonly string[]).includes(error.slug ?? '')
  );
}

/**
 * Experiment knob (default OFF): recovery never leaves the session's current
 * provider. Used for provider-isolated anti-bot benchmarks; production keeps
 * the cross-provider ladder.
 */
export function recoverySameProviderOnly(): boolean {
  const raw = process.env.BROWSER_RECOVERY_SAME_PROVIDER_ONLY?.trim().toLowerCase();
  return raw !== undefined && ['1', 'true', 'yes', 'on', 'enabled'].includes(raw);
}

/**
 * The rung to take under BROWSER_RECOVERY_SAME_PROVIDER_ONLY: the ladder's own
 * step when it stays on `currentProvider`, otherwise that provider's fresh
 * residential exit (a new replacement session/IP), or null when the current
 * provider cannot serve another rung (disabled / kill switch).
 */
export function sameProviderRotationStep(
  step: RotationStep,
  currentProvider: BrowserProviderName,
  available: { browserUse: boolean; tilion: boolean }
): RotationStep | null {
  if (step.provider === currentProvider) return step;
  if (currentProvider === 'tilion' && !available.tilion) return null;
  if (currentProvider === 'browser-use' && !available.browserUse) return null;
  return { provider: currentProvider, proxyType: 'residential', recoveryAction: 'ip_rotated' };
}

/** Label of the rung the next rotation would take (provider-locked when the knob is on). */
export function nextRecoveryLabel(
  position: number,
  provider: BrowserProviderName,
  providerLocked: boolean,
  available: { browserUse: boolean; tilion: boolean }
): string {
  const ladder = selectRotationStep(position, provider, available.browserUse, available.tilion);
  if (!providerLocked) return rotationStepLabel(ladder);
  const locked = sameProviderRotationStep(ladder, provider, available);
  return locked ? rotationStepLabel(locked) : 'no_same_provider_rung_left';
}
