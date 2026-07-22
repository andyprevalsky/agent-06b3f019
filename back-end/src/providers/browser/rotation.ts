import type { BrowserProviderName } from './types';
import type { KernelProxyType } from './kernelProxy';

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
 * then changes browser/proxy infrastructure to Steel. The fourth and final
 * recovery allocates another fresh Steel exit. Runs that already started on
 * Steel remain there because provider switching is intentionally one-way.
 */
export function selectRotationStep(
  rotationsUsed: number,
  currentProvider: BrowserProviderName
): RotationStep {
  if (!Number.isInteger(rotationsUsed) || rotationsUsed < 1 || rotationsUsed > ROTATION_CAP) {
    throw new RangeError(`Rotation position must be between 1 and ${ROTATION_CAP}`);
  }

  if (currentProvider === 'steel') {
    return {
      provider: 'steel',
      proxyType: 'residential',
      recoveryAction: 'ip_rotated',
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
    provider: 'steel',
    proxyType: 'residential',
    recoveryAction: 'provider_switched',
  };
}

export function rotationStepLabel(step: RotationStep): string {
  if (step.recoveryAction === 'provider_switched') return 'switch_provider_to_steel';
  if (step.provider === 'steel') return 'rotate_steel_residential_ip';
  return step.proxyType === 'mobile' ? 'rotate_kernel_mobile_ip' : 'rotate_kernel_residential_ip';
}
