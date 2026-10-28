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
 * then changes browser/proxy infrastructure to Steel and Browser Use. Browser
 * Use only has country-level proxy selection; a new session requests a new
 * residential exit but the provider does not guarantee a distinct IP.
 */
export function selectRotationStep(
  rotationsUsed: number,
  currentProvider: BrowserProviderName,
  browserUseAvailable = true
): RotationStep {
  if (!Number.isInteger(rotationsUsed) || rotationsUsed < 1 || rotationsUsed > ROTATION_CAP) {
    throw new RangeError(`Rotation position must be between 1 and ${ROTATION_CAP}`);
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
  return step.proxyType === 'mobile' ? 'rotate_kernel_mobile_ip' : 'rotate_kernel_residential_ip';
}

export class ProxyRotationExhaustedError extends Error {
  constructor(public readonly cap: number) {
    super(
      `PROXY_ROTATION_EXHAUSTED: rotated ${cap} times and the target is still blocking ` +
        `our proxy pool for this session. Do not rotate again — try a different approach ` +
        `or report the target as unreachable.`
    );
    this.name = 'ProxyRotationExhaustedError';
  }
}

export class RotationSessionNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Browser task not found: ${taskId}`);
    this.name = 'RotationSessionNotFoundError';
  }
}
