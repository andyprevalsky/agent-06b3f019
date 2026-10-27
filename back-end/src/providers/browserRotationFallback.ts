import { browserUseEnabled } from './browser/config';
import {
  isTilionExitUnavailableError,
  ROTATION_CAP,
  rotationStepLabel,
  rungAfterTilionUnavailable,
  type RotationStep,
} from './browser/rotation';
import { SameProviderRotationExhaustedError } from './browserRotationErrors';
import { createLogger } from './logger';

const log = createLogger('BrowserSessionResume');

/**
 * Run one reserved rotation, advancing past Tilion exits Tilion cannot serve
 * now (409 proxy_type_unavailable, residential allowance used up, ...): the
 * reserved rotation still owes the agent a new IP, so the next rung is taken in
 * the same request. Unlocked, that is the ladder's next rung (residential
 * refused -> Tilion datacenter -> Kernel mobile); provider-locked, the other
 * Tilion exit class once, never another provider. Bounded: every refusal moves
 * a rung forward or ends with a typed result. Other errors propagate unchanged.
 */
export async function rotateWithTilionExitFallback<T>(options: {
  taskId: string;
  step: RotationStep;
  rotationsUsed: number;
  providerLocked: boolean;
  rotate: (attempt: RotationStep) => Promise<T>;
}): Promise<{ result: T; fallbackReason: string | null }> {
  const { taskId, rotationsUsed, providerLocked } = options;
  let attempt = options.step;
  let fallbackPosition = rotationsUsed;
  const triedTilionExits = new Set<string>();
  const reasons: string[] = [];
  for (;;) {
    try {
      const result = await options.rotate(attempt);
      return { result, fallbackReason: reasons.length > 0 ? reasons.join('; ') : null };
    } catch (error) {
      if (attempt.provider !== 'tilion' || !isTilionExitUnavailableError(error)) throw error;
      triedTilionExits.add(attempt.proxyType);
      let next: RotationStep | null;
      if (providerLocked) {
        const other = attempt.proxyType === 'direct' ? 'residential' : 'direct';
        next = triedTilionExits.has(other)
          ? null
          : { provider: 'tilion', proxyType: other, recoveryAction: 'ip_rotated' };
      } else {
        next = rungAfterTilionUnavailable(fallbackPosition, browserUseEnabled());
        fallbackPosition = Math.min(fallbackPosition + 1, ROTATION_CAP);
      }
      if (next === null) throw new SameProviderRotationExhaustedError('tilion', rotationsUsed);
      const reason = `tilion_${attempt.proxyType}_unavailable: ${
        error instanceof Error ? error.message.slice(0, 200) : String(error)
      }`;
      reasons.push(reason);
      log.warn('Tilion exit unavailable; advancing the rotation ladder', {
        taskId,
        rotationsUsed,
        from: rotationStepLabel(attempt),
        to: rotationStepLabel(next),
        reason,
      });
      attempt = next;
    }
  }
}
