/** Bounded submitted-value vault. Never evict on lease/session expiry or handback. */
import { openPhoneValue, sealPhoneValue } from './phoneHarnessCredentials';
import { PhoneInteractionError as IPhoneError } from './phoneInteractionError';
import type { IPhoneOperation } from '@prisma/client';

export interface PhonePrivacy {
  version: 1;
  active: boolean;
  values: string[];
  joined?: string;
  /** Lease whose user (typing or native attention) opened the active phase; only that lease's
   * user-grace expiry may end it. Agent-opened and legacy phases carry none. */
  leaseId?: string;
}
export function privacyState(encrypted: string | null): PhonePrivacy {
  if (encrypted === null) return { version: 1, active: false, values: [] };
  let value: PhonePrivacy;
  try {
    value = openPhoneValue<PhonePrivacy>(encrypted);
    if (
      typeof value !== 'object' ||
      value === null ||
      value.version !== 1 ||
      typeof value.active !== 'boolean' ||
      !Array.isArray(value.values) ||
      value.values.some((item) => typeof item !== 'string' || item.length === 0) ||
      value.values.length > 64 ||
      Buffer.byteLength(value.values.join(''), 'utf8') > 16_384 ||
      (value.joined !== undefined &&
        (typeof value.joined !== 'string' || !value.values.includes(value.joined))) ||
      (value.leaseId !== undefined && typeof value.leaseId !== 'string')
    )
      throw new Error('Invalid privacy envelope');
  } catch {
    throw new IPhoneError(409, 'Phone privacy state is unavailable');
  }
  return value;
}
export function rememberPrivate(encrypted: string | null, text: unknown, leaseId?: string): string {
  if (typeof text !== 'string' || text.length === 0)
    throw new IPhoneError(400, 'Private phone input must contain text');
  if (Buffer.byteLength(text, 'utf8') > 16_384)
    throw new IPhoneError(409, 'Phone private input capacity reached');
  const state = privacyState(encrypted);
  const joined = state.active && state.joined !== undefined ? state.joined + text : text;
  for (const value of [text, joined]) if (!state.values.includes(value)) state.values.push(value);
  if (state.values.length > 64 || Buffer.byteLength(state.values.join(''), 'utf8') > 16_384)
    throw new IPhoneError(409, 'Phone private input capacity reached');
  return sealPhoneValue({ ...openedBy(state, leaseId), joined, active: true });
}
/** An already-active phase keeps its opener; a successor can never adopt an inherited phase. */
export function openedBy(state: PhonePrivacy, leaseId: string | undefined): PhonePrivacy {
  return state.active ? state : { ...state, leaseId };
}
export function resumedPrivacy(encrypted: string | null): string | null {
  return encrypted === null
    ? null
    : sealPhoneValue({
        ...privacyState(encrypted),
        joined: undefined,
        leaseId: undefined,
        active: false,
      });
}
/** Ends the phase only when the expiring lease's user opened it; otherwise null (unchanged). */
export function expiredPrivacy(encrypted: string | null, leaseId: string): string | null {
  if (encrypted === null) return null;
  const state = privacyState(encrypted);
  return state.active && state.leaseId === leaseId ? resumedPrivacy(encrypted) : null;
}
export function isModelMedia(operation: string): boolean {
  return operation === 'screen.capture' || operation === 'screen.frame';
}
const MEDIA_KEYS = new Set(['png_b64']); // screen.capture documented wire payload
export function privateResult(
  command: Pick<IPhoneOperation, 'operation' | 'actor' | 'state'>,
  value: unknown,
  encrypted: string | null
): unknown {
  return redactResult(command, value, privacyState(encrypted));
}

/** Internal screen-text evidence may retain only identifiers already supplied by trusted profile. */
export function internalPhoneObservation(
  command: Pick<IPhoneOperation, 'operation' | 'actor' | 'state'>,
  value: unknown,
  encrypted: string | null,
  profile: { expectedAppleIdentity?: string; expectedGoogleIdentity?: string }
): unknown {
  const privacy = privacyState(encrypted);
  if (
    command.operation !== 'screen.text' ||
    command.actor !== 'agent' ||
    command.state !== 'SUCCEEDED' ||
    privacy.active
  )
    return redactResult(command, value, privacy);
  const identifiers = [profile.expectedAppleIdentity, profile.expectedGoogleIdentity].filter(
    (identity): identity is string =>
      typeof identity === 'string' && identity.length > 0 && identity.length <= 512
  );
  return redactResult(command, value, {
    ...privacy,
    values: privacy.values.filter((secret) => !identifiers.includes(secret)),
  });
}
function redactResult(
  command: Pick<IPhoneOperation, 'operation' | 'actor' | 'state'>,
  value: unknown,
  privacy: PhonePrivacy
): unknown {
  if (command.operation === 'credentials.fill_device_passcode') {
    const stage =
      value !== null && typeof value === 'object'
        ? (value as { passcodeStatus?: unknown }).passcodeStatus
        : undefined;
    return {
      success: command.state === 'SUCCEEDED',
      private: true,
      passcodeStatus:
        command.state === 'SUCCEEDED' &&
        (stage === 'created' || stage === 'confirmed' || stage === 'acknowledged')
          ? stage
          : command.state === 'UNKNOWN'
            ? 'unknown'
            : ['CONNECTING', 'RUNNING'].includes(command.state)
              ? 'pending'
              : 'unavailable',
    };
  }
  if (command.operation === 'credentials.fill_saved')
    return {
      success: command.state === 'SUCCEEDED',
      private: true,
      credentialStatus:
        command.state === 'SUCCEEDED'
          ? 'filled'
          : command.state === 'UNKNOWN'
            ? 'unknown'
            : ['CONNECTING', 'RUNNING'].includes(command.state)
              ? 'pending'
              : 'unavailable',
    };
  if (command.actor === 'user' && command.operation === 'input.text')
    return { success: command.state === 'SUCCEEDED', private: true };
  if (isModelMedia(command.operation)) return { private: true };
  if (privacy.active && command.operation !== 'screen.bounds') return { private: true };
  const values = [...privacy.values].sort((a, b) => b.length - a.length);
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 32) return '[omitted]';
    if (typeof item === 'string') {
      if (/^data:(?:image|video)\//i.test(item)) return '[private media]';
      for (const secret of values) item = (item as string).split(secret).join('[private]');
      return item;
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (typeof item === 'object' && item !== null)
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          String(visit(key, depth + 1)),
          MEDIA_KEYS.has(key) ? '[private media]' : visit(child, depth + 1),
        ])
      );
    return item;
  };
  return visit(value, 0);
}
