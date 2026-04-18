/**
 * Thin wrapper over Deno's Web Crypto API.
 *
 * Domain code must import from here instead of calling `crypto.*` directly so
 * the provider layer is the only place that depends on the underlying runtime
 * crypto surface (parallel to `back-end/src/providers/crypto.ts`).
 */

export function randomUUID(): string {
  return crypto.randomUUID();
}

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}
