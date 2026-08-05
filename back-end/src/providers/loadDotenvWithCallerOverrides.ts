/**
 * Load back-end/.env with override so Cursor-truncated AgentCard secrets lose
 * to the full on-disk values — but preserve caller-owned runtime bindings that
 * isolated stacks inject (PORT, DATABASE_URL, TEMPORAL_TASK_QUEUE, …).
 *
 * Without this, dotenv.config({ override: true }) rewrites PORT=3201 → 3001
 * from .env and the supervised health probe never sees a listener.
 */
import dotenv from 'dotenv';

export const CALLER_OWNED_RUNTIME_ENV_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'PORT',
  'TEMPORAL_TASK_QUEUE',
] as const;

export function captureCallerOwnedRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env
): Map<string, string> {
  const preserved = new Map<string, string>();
  for (const key of CALLER_OWNED_RUNTIME_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value !== '') {
      preserved.set(key, value);
    }
  }
  return preserved;
}

export function restoreCallerOwnedRuntimeEnv(
  env: NodeJS.ProcessEnv,
  preserved: Map<string, string>
): void {
  for (const [key, value] of preserved) {
    env[key] = value;
  }
}

export function loadDotenvWithCallerOverrides(): void {
  const preserved = captureCallerOwnedRuntimeEnv(process.env);
  dotenv.config({ override: true });
  restoreCallerOwnedRuntimeEnv(process.env, preserved);
}
