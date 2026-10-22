/** Typed rotate_ip outcomes (re-exported by browserSessionResume). */
import { ROTATION_CAP } from './browser/rotation';

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

/** BROWSER_RECOVERY_SAME_PROVIDER_ONLY: the current provider has no rung left; never switch. */
export class SameProviderRotationExhaustedError extends ProxyRotationExhaustedError {
  constructor(
    public readonly provider: string,
    public readonly rotationsUsed: number
  ) {
    super(ROTATION_CAP);
    this.message =
      `NO_SAME_PROVIDER_RUNG_LEFT: recovery is locked to ${provider} ` +
      `(BROWSER_RECOVERY_SAME_PROVIDER_ONLY) and ${provider} cannot serve another rotation ` +
      `(${rotationsUsed}/${ROTATION_CAP}). Do not rotate again — try a different approach ` +
      `or report the target as unreachable.`;
    this.name = 'SameProviderRotationExhaustedError';
  }
}

export class RotationSessionNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Browser task not found: ${taskId}`);
    this.name = 'RotationSessionNotFoundError';
  }
}
