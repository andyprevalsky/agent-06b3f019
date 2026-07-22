#!/usr/bin/env tsx
/**
 * Black-box credential health checks for every external service that smoke
 * benchmarks depend on. Always runs — no skip-guards, no env-gated branches.
 *
 * Purpose: fail in ~3s before the deploy skill spends $$$ on smoke benchmarks
 * only to discover E2B credits are out or a Steel key was rotated.
 *
 * Each check:
 *   - Reads the real env var from the shell (same one the backend uses)
 *   - Hits the cheapest endpoint that proves the credential can perform the
 *     operation required by smoke (an auth-only endpoint is insufficient)
 *   - FAILS if the env var is missing, if the response is 401/402/403,
 *     or if the provider returns 5xx while probing a smoke-critical endpoint
 *   - PASSES on other non-auth statuses (200, 400 validation, 404, etc.)
 *
 * Failure messages include the exact env var name to refresh and the provider
 * dashboard URL so the human knows where to go.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/integration-health.blackbox.ts
 */

import { config } from 'dotenv';
config();

const CHECK_TIMEOUT_MS = 5000;
const STEEL_CHECK_TIMEOUT_MS = 15000;

interface CheckResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  overridden?: boolean;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authFailed(status: number): boolean {
  return status === 401 || status === 402 || status === 403;
}

function providerUnavailable(status: number): boolean {
  return status >= 500;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing env var ${name} — set it in back-end/.env or refresh from the provider dashboard`
    );
  }
  return value;
}

function hasGateOverride(gate: string): boolean {
  return (process.env.DEPLOY_GATE_OVERRIDES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .includes(gate);
}

async function runCheck(name: string, fn: () => Promise<void>): Promise<CheckResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ==================== CHECKS ====================

async function checkE2B(): Promise<void> {
  const key = requireEnv('E2B_API_KEY');
  const res = await fetchWithTimeout('https://api.e2b.app/sandboxes', {
    method: 'GET',
    headers: { 'X-API-Key': key },
  });
  if (authFailed(res.status)) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `E2B auth rejected (HTTP ${res.status}). Refresh E2B_API_KEY from https://e2b.dev/dashboard. Body: ${body.slice(0, 200)}`
    );
  }
  if (providerUnavailable(res.status)) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `E2B provisioning API unavailable (HTTP ${res.status}). Sandbox creation cannot run. Body: ${body.slice(0, 200)}`
    );
  }
}

async function checkSteel(): Promise<void> {
  const key = requireEnv('STEEL_API_KEY');
  const res = await fetchWithTimeout(
    'https://connect.steelbrowser.com/v1/sessions?limit=1',
    {
      method: 'GET',
      headers: { 'Steel-Api-Key': key },
    },
    STEEL_CHECK_TIMEOUT_MS
  );
  if (authFailed(res.status)) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Steel auth rejected (HTTP ${res.status}). Refresh STEEL_API_KEY from https://app.steel.dev/. Body: ${body.slice(0, 200)}`
    );
  }
}

async function checkParallel(): Promise<void> {
  const key = requireEnv('PARRALLEL_API_KEY');
  // Smallest possible search probe; any non-auth response proves the key works.
  const res = await fetchWithTimeout('https://api.parallel.ai/v1/search', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mode: 'turbo',
      objective: 'ping',
      search_queries: ['ping'],
      advanced_settings: { max_results: 1 },
    }),
  });
  if (authFailed(res.status)) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Parallel.ai auth rejected (HTTP ${res.status}). Refresh PARRALLEL_API_KEY from https://platform.parallel.ai/. Body: ${body.slice(0, 200)}`
    );
  }
}

async function checkAnthropic(): Promise<void> {
  const key = requireEnv('ANTHROPIC_API_KEY');
  // /v1/models proves only that the key authenticates. Anthropic returns 200
  // there even when the account has no credits, then rejects real completions
  // with HTTP 400. Spend one output token so this gate proves the exact
  // capability the Claude Code smoke requires before provisioning E2B.
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Reply OK' }],
    }),
  });
  const body = await res.text().catch(() => '');
  if (
    res.status === 400 &&
    /credit balance is too low|out of credits|purchase credits/i.test(body)
  ) {
    throw new Error(
      `Anthropic credits exhausted (HTTP ${res.status}). Add credits at https://console.anthropic.com/settings/billing. Body: ${body.slice(0, 200)}`
    );
  }
  if (authFailed(res.status)) {
    throw new Error(
      `Anthropic auth rejected (HTTP ${res.status}). Refresh ANTHROPIC_API_KEY from https://console.anthropic.com/. Body: ${body.slice(0, 200)}`
    );
  }
  if (providerUnavailable(res.status)) {
    throw new Error(
      `Anthropic messages API unavailable (HTTP ${res.status}). Completions cannot run. Body: ${body.slice(0, 200)}`
    );
  }
}

async function checkOpenRouter(): Promise<void> {
  const key = requireEnv('OPENROUTER_API_KEY');
  // /auth/key returns the credential's metadata; 401 on bad key, 200 on good.
  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/auth/key', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (authFailed(res.status)) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `OpenRouter auth rejected (HTTP ${res.status}). Refresh OPENROUTER_API_KEY from https://openrouter.ai/keys. Body: ${body.slice(0, 200)}`
    );
  }
}

async function checkSupabase(): Promise<void> {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetchWithTimeout(`${url.replace(/\/$/, '')}/auth/v1/health`, {
    method: 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (authFailed(res.status)) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Supabase auth rejected (HTTP ${res.status}). Refresh SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL from the Supabase dashboard. Body: ${body.slice(0, 200)}`
    );
  }
}

// ==================== RUNNER ====================

async function runAll(): Promise<void> {
  console.log('Integration Health Black-Box Checks\n');
  console.log('Validating external credentials used by smoke benchmarks...\n');

  const checks = [
    { name: 'E2B (sandboxes)', fn: checkE2B },
    { name: 'Steel (browser sessions)', fn: checkSteel },
    { name: 'Parallel.ai (web search)', fn: checkParallel, warnOnly: true },
    {
      name: 'Anthropic (Claude API)',
      fn: checkAnthropic,
      overridden: hasGateOverride('credential-health:anthropic'),
    },
    { name: 'OpenRouter (LLM judge)', fn: checkOpenRouter },
    { name: 'Supabase (auth/DB)', fn: checkSupabase },
  ];

  const results = await Promise.all(
    checks.map((check) =>
      check.overridden === true
        ? Promise.resolve<CheckResult>({
            name: check.name,
            passed: true,
            duration: 0,
            overridden: true,
          })
        : runCheck(check.name, check.fn)
    )
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const isWarn = !r.passed && checks[i].warnOnly === true;
    const icon =
      r.overridden === true ? '  SKIP' : r.passed ? '  PASS' : isWarn ? '  WARN' : '  FAIL';
    const detail =
      r.overridden === true
        ? ' -- explicitly overridden by DEPLOY_GATE_OVERRIDES'
        : r.passed
          ? ''
          : ` -- ${r.error}`;
    console.log(`${icon}  ${r.name}${detail} (${r.duration}ms)`);
  }

  const hardFailures = results.filter((r, i) => !r.passed && checks[i].warnOnly !== true);
  const warnings = results.filter((r, i) => !r.passed && checks[i].warnOnly === true);
  const overrides = results.filter((r) => r.overridden === true);
  const passed = results.filter((r) => r.passed && r.overridden !== true).length;

  console.log('\n' + '='.repeat(50));
  console.log(
    `\nResults: ${passed} passed, ${warnings.length} warnings, ${overrides.length} overrides, ${hardFailures.length} failed, ${results.length} total`
  );

  if (hardFailures.length > 0) {
    console.log('\nFAILURES:');
    hardFailures.forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log(
    overrides.length > 0
      ? `\nINTEGRATION-HEALTH CHECKS COMPLETE WITH ${overrides.length} EXPLICIT OVERRIDE(S)\n`
      : '\nALL INTEGRATION-HEALTH CHECKS PASSED\n'
  );
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nIntegration-health check suite crashed:', error);
  process.exit(1);
});
