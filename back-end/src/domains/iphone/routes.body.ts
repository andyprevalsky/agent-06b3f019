/** Shared validation for authenticated iPhone request bodies. */
import { IPhoneError } from './types';

export function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new IPhoneError(400, 'Request body must be an object');
  return body as Record<string, unknown>;
}
export function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512)
    throw new IPhoneError(400, `${key} must be a nonempty string of at most 512 characters`);
  return value;
}
