/**
 * Load back-end/.env with override so Cursor-truncated AgentCard secrets can
 * lose to full on-disk values — but preserve every other caller-owned binding.
 *
 * Isolated stacks inject PORT / DATABASE_URL / TEMPORAL_TASK_QUEUE; coverage
 * injects SLACK_* / AMPLITUDE_*="" / TRACE_ARCHIVE_*; production boot probes
 * set NODE_ENV=production. A blanket dotenv override was clobbering those and
 * breaking /health, Slack signature checks, and Amplitude capture matching.
 */
import dotenv from 'dotenv';

/**
 * Keys where a truncated/blank injected value may yield to a fuller .env value.
 *
 * Cursor Cloud and some Fly machine configs inject empty
 * AGENTCARD_ORG_OAUTH_CLIENT_ID/SECRET; restoreCallerOwnedRuntimeEnv would
 * otherwise clobber the decoded back-end/.env credentials and break AgentCard
 * Organization MCP cardholder resolution (502 Missing AGENTCARD_ORG_OAUTH_*).
 */
export const AGENTCARD_ENV_OVERRIDE_KEYS = [
  'BENCHMARK_AGENTCARD_ORG_ID',
  'BENCHMARK_AGENTCARD_CARDHOLDER_ID',
  'AGENTCARD_ORG_OAUTH_CLIENT_ID',
  'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
] as const;

/** Kept for contract tests / callers that pin the historical runtime set. */
export const CALLER_OWNED_RUNTIME_ENV_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'PORT',
  'TEMPORAL_TASK_QUEUE',
  'NODE_ENV',
] as const;

const AGENTCARD_MIN_ID_LENGTH = 20;

/**
 * Capture every string env binding the caller already set — including empty
 * strings (coverage intentionally blanks AMPLITUDE_* before bootstrap).
 */
export function captureCallerOwnedRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env
): Map<string, string> {
  const preserved = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      preserved.set(key, value);
    }
  }
  return preserved;
}

export function shouldKeepDotenvAgentCardValue(
  key: string,
  callerValue: string,
  dotenvValue: string | undefined
): boolean {
  if (!(AGENTCARD_ENV_OVERRIDE_KEYS as readonly string[]).includes(key)) {
    return false;
  }
  if (callerValue.trim().length >= AGENTCARD_MIN_ID_LENGTH) {
    return false;
  }
  return typeof dotenvValue === 'string' && dotenvValue.trim().length >= AGENTCARD_MIN_ID_LENGTH;
}

/**
 * Restore caller bindings. When Cursor truncated BENCHMARK_AGENTCARD_ORG_ID,
 * keep the dotenv org/cardholder pair together (foreign cardholder ids are
 * stale once the org falls back to the on-disk fixture).
 */
export function restoreCallerOwnedRuntimeEnv(
  env: NodeJS.ProcessEnv,
  preserved: Map<string, string>
): void {
  const callerOrg = preserved.get('BENCHMARK_AGENTCARD_ORG_ID');
  const orgYieldsToDotenv =
    typeof callerOrg === 'string' &&
    shouldKeepDotenvAgentCardValue(
      'BENCHMARK_AGENTCARD_ORG_ID',
      callerOrg,
      env.BENCHMARK_AGENTCARD_ORG_ID
    );
  const oauthIdYieldsToDotenv =
    typeof preserved.get('AGENTCARD_ORG_OAUTH_CLIENT_ID') === 'string' &&
    shouldKeepDotenvAgentCardValue(
      'AGENTCARD_ORG_OAUTH_CLIENT_ID',
      preserved.get('AGENTCARD_ORG_OAUTH_CLIENT_ID') ?? '',
      env.AGENTCARD_ORG_OAUTH_CLIENT_ID
    );
  const oauthSecretYieldsToDotenv =
    typeof preserved.get('AGENTCARD_ORG_OAUTH_CLIENT_SECRET') === 'string' &&
    shouldKeepDotenvAgentCardValue(
      'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
      preserved.get('AGENTCARD_ORG_OAUTH_CLIENT_SECRET') ?? '',
      env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET
    );

  for (const [key, callerValue] of preserved) {
    if (
      orgYieldsToDotenv &&
      (key === 'BENCHMARK_AGENTCARD_ORG_ID' || key === 'BENCHMARK_AGENTCARD_CARDHOLDER_ID')
    ) {
      continue;
    }
    if (oauthIdYieldsToDotenv && key === 'AGENTCARD_ORG_OAUTH_CLIENT_ID') {
      continue;
    }
    if (oauthSecretYieldsToDotenv && key === 'AGENTCARD_ORG_OAUTH_CLIENT_SECRET') {
      continue;
    }
    env[key] = callerValue;
  }
}

export function loadDotenvWithCallerOverrides(): void {
  const preserved = captureCallerOwnedRuntimeEnv(process.env);
  dotenv.config({ override: true });
  restoreCallerOwnedRuntimeEnv(process.env, preserved);
}
