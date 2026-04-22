import type { BrowserContext, ConsoleMessage, Page, Response } from '@playwright/test';

export const BACKEND_URL =
  process.env.BACKEND_URL ?? `http://localhost:${process.env.BACKEND_PORT ?? '3001'}`;
export const FRONTEND_URL =
  process.env.FRONTEND_URL ?? `http://localhost:${process.env.FRONTEND_PORT ?? '3002'}`;

/** Whether tests are running against production (set by run-semantic-tests.sh --prod). */
export const IS_PROD = process.env.SEMANTIC_PROD === '1';

/**
 * Pre-generated session JSON from back-end/scripts/generate-test-session.ts.
 * Set by the shell runner when --prod is active.
 */
const PROD_SESSION = process.env.PROD_SESSION ?? '';

// Dev-only test credentials. The default key is the shared local-backend
// dev key (also documented in CLAUDE.md "Test Credentials"); override via
// env for CI or alternate environments.
export const TEST_API_KEY =
  process.env.TEST_API_KEY ?? 'AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=';
export const TEST_USER_ID =
  process.env.TEST_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30';
export const TEST_PHONE_DIGITS = process.env.TEST_PHONE_DIGITS ?? '9729777432';
export const TEST_PHONE_E164 = process.env.TEST_PHONE_E164 ?? '+19729777432';
export const TEST_OTP = process.env.TEST_OTP ?? '181818';

export interface Recorder {
  console: { type: string; text: string }[];
  pageErrors: string[];
  authResponses: { url: string; status: number }[];
}

export function attachRecorder(page: Page): Recorder {
  const rec: Recorder = { console: [], pageErrors: [], authResponses: [] };
  page.on('console', (m: ConsoleMessage) => rec.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e: Error) => rec.pageErrors.push(String(e)));
  page.on('response', (r: Response) => {
    const u = r.url();
    if (u.includes('/api/auth/')) rec.authResponses.push({ url: u, status: r.status() });
  });
  return rec;
}

export async function clearAppSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('sb-') || k === 'rose-session' || k === 'app-user') {
        localStorage.removeItem(k);
      }
    }
  });
}

/**
 * Inject a pre-generated session into localStorage so the app boots as
 * an authenticated user. Used in --prod mode where dev auto-login is
 * unavailable.
 *
 * Must be called AFTER page.goto() (localStorage requires an origin) but
 * BEFORE the app's auth hook runs — so call it right after goto, then reload.
 */
export async function injectProdSession(page: Page): Promise<void> {
  if (!PROD_SESSION) throw new Error('PROD_SESSION env var not set — run with --prod flag');
  await page.evaluate((session) => {
    window.localStorage.setItem('rose-session', session);
  }, PROD_SESSION);
}

/**
 * Dev builds auto-login with test credentials. To exercise the logged-out
 * flow we block the auto-login endpoints before navigation, then unblock
 * before the real login attempt.
 */
export async function forceLoggedOut(context: BrowserContext): Promise<void> {
  await context.route('**/api/auth/verify-otp', (r) => r.abort());
  await context.route('**/api/auth/anonymous', (r) => r.abort());
  await context.route('**/auth/v1/signup**', (r) => r.abort());
}

export async function allowAuthEndpoints(context: BrowserContext): Promise<void> {
  await context.unroute('**/api/auth/verify-otp').catch(() => {});
  await context.unroute('**/api/auth/anonymous').catch(() => {});
  await context.unroute('**/auth/v1/signup**').catch(() => {});
}

export async function createAgent(goal: string, startPhase?: 'plan' | 'execute'): Promise<string> {
  // Omit start_phase entirely to start in chat mode (per CLAUDE.md).
  const body: Record<string, unknown> = { goal };
  if (startPhase) body.start_phase = startPhase;
  const res = await fetch(`${BACKEND_URL}/api/agents`, {
    method: 'POST',
    headers: {
      'X-API-Key': TEST_API_KEY,
      'X-User-Id': TEST_USER_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json: unknown = raw;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    // Non-JSON body (proxy HTML, empty, etc.) — keep raw text in the error.
  }
  const id =
    (json as { agent_id?: string; id?: string }).agent_id ??
    (json as { agent_id?: string; id?: string }).id;
  if (!res.ok || !id) {
    const body = typeof json === 'string' ? json.slice(0, 500) : JSON.stringify(json);
    throw new Error(`Agent creation failed: ${res.status} ${body}`);
  }
  return id;
}

interface BenchmarkTask {
  name: string;
  prompt: string;
  start_phase: 'plan' | 'execute' | null;
}

/** Load a benchmark task by name from agents/benchmarks/tasks.json so
 *  semantic tests stay in sync with the smoke suite's goals. */
export async function loadBenchmarkTask(name: string): Promise<BenchmarkTask> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const tasksPath = path.resolve(here, '../../agents/benchmarks/tasks.json');
  const raw = await fs.readFile(tasksPath, 'utf-8');
  const tasks = JSON.parse(raw) as BenchmarkTask[];
  const task = tasks.find((t) => t.name === name);
  if (!task) throw new Error(`Benchmark task not found: ${name}`);
  return task;
}

export async function deleteAgent(agentId: string): Promise<void> {
  // Cleanup helper: surface failures via console.warn so leaked agents are
  // visible in CI logs, but don't throw — test teardown must not mask the
  // real assertion failure that caused it to run.
  try {
    const res = await fetch(`${BACKEND_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': TEST_API_KEY, 'X-User-Id': TEST_USER_ID },
    });
    if (!res.ok) {
      console.warn(`deleteAgent(${agentId}) returned ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`deleteAgent(${agentId}) network failure:`, err);
  }
}

export function hasUncaughtErrors(rec: Recorder): string[] {
  const textErrors = rec.console
    .filter((m) => {
      if (m.type !== 'error' && m.type !== 'warning') return false;
      const t = m.text.toLowerCase();
      return (
        t.includes('uncaught') ||
        t.includes('unhandledrejection') ||
        t.includes('unhandled promise rejection')
      );
    })
    .map((m) => m.text);
  return [...rec.pageErrors, ...textErrors];
}

export function has5xxAuth(rec: Recorder): { url: string; status: number }[] {
  return rec.authResponses.filter((r) => r.status >= 500);
}
