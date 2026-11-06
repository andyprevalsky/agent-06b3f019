/**
 * Global switch for injecting the user's synced browser fingerprint.
 *
 * OFF by default (2026-11-04). Making a provider's browser claim the user's
 * device (UA + client hints, timezone, the navigator/WebGL/screen init script)
 * is detectable: a fresh Google sign-in on Tilion and Kernel was rejected with
 * "This browser or app may not be secure" in every injected run, and reached
 * the password page in every run on the provider's own fingerprint. Set
 * BROWSER_AGENT_FINGERPRINT_INJECTION_ENABLED=true to turn it back on.
 */
export function fingerprintInjectionEnabled(): boolean {
  const raw = process.env.BROWSER_AGENT_FINGERPRINT_INJECTION_ENABLED;
  if (raw === undefined) return false;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(raw.trim().toLowerCase());
}
